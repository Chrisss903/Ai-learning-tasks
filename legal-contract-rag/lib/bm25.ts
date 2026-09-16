import { loadChunks, type Chunk } from "./chunking";

const K1 = 1.5;
const B = 0.75;

const STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "by", "for", "from", "has",
  "have", "in", "is", "it", "its", "of", "on", "or", "that", "the", "this",
  "to", "was", "were", "what", "which", "will", "with",
]);

/**
 * Splits on punctuation but also keeps identifiers whole, so a query for
 * "SOW-2024-017" matches both the full token and its parts.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];

  for (const raw of text.toLowerCase().split(/[^a-z0-9.\-_]+/)) {
    const token = raw.replace(/^[.\-_]+|[.\-_]+$/g, "");
    if (!token) continue;

    if (!STOPWORDS.has(token)) tokens.push(token);

    if (/[.\-_]/.test(token)) {
      for (const part of token.split(/[.\-_]+/)) {
        if (part && !STOPWORDS.has(part)) tokens.push(part);
      }
    }
  }

  return tokens;
}

interface Bm25Index {
  chunks: Chunk[];
  termFrequencies: Map<string, number>[];
  lengths: number[];
  averageLength: number;
  documentFrequencies: Map<string, number>;
}

let index: Bm25Index | null = null;

async function buildIndex(): Promise<Bm25Index> {
  if (index) return index;

  const chunks = await loadChunks();
  const termFrequencies: Map<string, number>[] = [];
  const lengths: number[] = [];
  const documentFrequencies = new Map<string, number>();

  for (const chunk of chunks) {
    const tokens = tokenize(`${chunk.section}\n${chunk.text}`);
    const frequencies = new Map<string, number>();

    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }

    for (const term of frequencies.keys()) {
      documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1);
    }

    termFrequencies.push(frequencies);
    lengths.push(tokens.length);
  }

  const averageLength =
    lengths.reduce((total, length) => total + length, 0) / (lengths.length || 1);

  index = {
    chunks,
    termFrequencies,
    lengths,
    averageLength,
    documentFrequencies,
  };

  return index;
}

export interface KeywordResult {
  chunk: Chunk;
  score: number;
}

export async function searchKeywords(
  query: string,
  limit: number,
): Promise<KeywordResult[]> {
  const { chunks, termFrequencies, lengths, averageLength, documentFrequencies } =
    await buildIndex();

  const queryTerms = tokenize(query);
  const total = chunks.length;
  const scored: KeywordResult[] = [];

  for (let i = 0; i < total; i++) {
    let score = 0;

    for (const term of queryTerms) {
      const frequency = termFrequencies[i].get(term);
      if (!frequency) continue;

      const documentFrequency = documentFrequencies.get(term) ?? 0;
      const idf = Math.log(
        1 + (total - documentFrequency + 0.5) / (documentFrequency + 0.5),
      );
      const normalisation =
        K1 * (1 - B + (B * lengths[i]) / (averageLength || 1));

      score += idf * ((frequency * (K1 + 1)) / (frequency + normalisation));
    }

    if (score > 0) scored.push({ chunk: chunks[i], score });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
