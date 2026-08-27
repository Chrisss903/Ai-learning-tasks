import { qdrant } from "./qdrant";
import { createEmbedding } from "./embeddings";

const COLLECTION_NAME = "legal_documents";

export interface SearchResult {
  text: string;
  source: string;
  section: string;
  score: number;
}

export async function searchDocuments(
  query: string,
  limit = 3,
): Promise<SearchResult[]> {
  const embedding = await createEmbedding(query);

  const response = await qdrant.query(COLLECTION_NAME, {
    query: embedding,
    limit,
    with_payload: true,
  });

  return response.points.map((result) => ({
    text: String(result.payload?.text ?? ""),
    source: String(result.payload?.source ?? ""),
    section: String(result.payload?.section ?? ""),
    score: result.score,
  }));
}
