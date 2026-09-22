import { qdrant } from "./qdrant";
import { createEmbedding } from "./embeddings";
import { loadChunks } from "./chunking";
import { searchKeywords } from "./bm25";

const COLLECTION_NAME = "legal_documents";

/** How many candidates each retriever contributes before fusion. */
const CANDIDATE_LIMIT = 20;

/** RRF damping constant. 60 is the value from the original RRF paper. */
const RRF_K = 60;

export type SearchMode = "vector" | "hybrid";

export interface SearchResult {
  id: number;
  text: string;
  source: string;
  section: string;
  score: number;
  /** Rank this chunk held in each retriever's own list, for the inspector. */
  vectorRank: number | null;
  keywordRank: number | null;
}

async function vectorCandidates(query: string, limit: number) {
  const embedding = await createEmbedding(query);

  const response = await qdrant.query(COLLECTION_NAME, {
    query: embedding,
    limit,
    with_payload: true,
  });

  return response.points.map((point) => ({
    id: Number(point.id),
    text: String(point.payload?.text ?? ""),
    source: String(point.payload?.source ?? ""),
    section: String(point.payload?.section ?? ""),
    score: point.score,
  }));
}

async function vectorSearch(
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const candidates = await vectorCandidates(query, limit);

  return candidates.map((candidate, index) => ({
    ...candidate,
    vectorRank: index + 1,
    keywordRank: null,
  }));
}

/**
 * Reciprocal Rank Fusion of semantic and keyword results. A chunk found by
 * both retrievers outranks one found by either alone, and only ranks matter,
 * so the two incomparable score scales never have to be normalised.
 */
async function hybridSearch(
  query: string,
  limit: number,
  source?: string,
): Promise<SearchResult[]> {
  const chunks = await loadChunks();

  // Scoped to one document, every chunk is a candidate — a document has about
  // a dozen, so ranking all of them costs nothing and none can be crowded out.
  const candidateLimit = source ? chunks.length : CANDIDATE_LIMIT;
  const inScope = (chunkSource: string) => !source || chunkSource === source;

  const [semantic, keyword] = await Promise.all([
    vectorCandidates(query, candidateLimit).then((list) =>
      list.filter((candidate) => inScope(candidate.source)),
    ),
    searchKeywords(query, candidateLimit).then((list) =>
      list.filter((result) => inScope(result.chunk.source)),
    ),
  ]);

  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));

  const fused = new Map<
    number,
    { score: number; vectorRank: number | null; keywordRank: number | null }
  >();

  const record = (
    id: number,
    rank: number,
    retriever: "vectorRank" | "keywordRank",
  ) => {
    const entry = fused.get(id) ?? {
      score: 0,
      vectorRank: null,
      keywordRank: null,
    };

    entry.score += 1 / (RRF_K + rank);
    entry[retriever] = rank;
    fused.set(id, entry);
  };

  semantic.forEach((candidate, index) => record(candidate.id, index + 1, "vectorRank"));
  keyword.forEach((result, index) => record(result.chunk.id, index + 1, "keywordRank"));

  return [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .map(([id, entry]) => {
      const chunk = byId.get(id);

      return {
        id,
        text: chunk?.text ?? "",
        source: chunk?.source ?? "",
        section: chunk?.section ?? "",
        score: entry.score,
        vectorRank: entry.vectorRank,
        keywordRank: entry.keywordRank,
      };
    });
}

/** `source` restricts a hybrid search to one document file. */
export async function searchDocuments(
  query: string,
  limit = 3,
  mode: SearchMode = "vector",
  source?: string,
): Promise<SearchResult[]> {
  if (source) return hybridSearch(query, limit, source);

  return mode === "hybrid"
    ? hybridSearch(query, limit)
    : vectorSearch(query, limit);
}
