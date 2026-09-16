import { promises as fs } from "fs";
import path from "path";

const DOCUMENTS_DIR = path.join(process.cwd(), "documents");

export interface Chunk {
  id: number;
  text: string;
  source: string;
  section: string;
}

function chunkDocument(text: string, source: string): Omit<Chunk, "id">[] {
  const parts = text.split(/\n\s*\n(?=\d+\.\s)/);

  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => ({
      text: part,
      source,
      section: part.split("\n")[0].trim(),
    }));
}

let cached: Chunk[] | null = null;

/**
 * The single source of truth for chunks. Ingestion and the keyword index both
 * read from here so a chunk has the same id in Qdrant and in BM25 — that is
 * what lets the two result lists be fused by id.
 */
export async function loadChunks(): Promise<Chunk[]> {
  if (cached) return cached;

  const files = (await fs.readdir(DOCUMENTS_DIR))
    .filter((file) => file.endsWith(".txt"))
    .sort();

  const chunks: Chunk[] = [];
  for (const file of files) {
    const text = await fs.readFile(path.join(DOCUMENTS_DIR, file), "utf-8");
    for (const chunk of chunkDocument(text, file)) {
      chunks.push({ id: chunks.length + 1, ...chunk });
    }
  }

  cached = chunks;
  return chunks;
}
