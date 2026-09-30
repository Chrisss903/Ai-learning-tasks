import { promises as fs } from "fs";
import path from "path";

const DOCUMENTS_DIR = path.join(process.cwd(), "documents");

/**
 * Week 8: documents an attacker got into the store. They are loaded only when
 * ATTACK_DOCS is set, and always after the real ones, so every existing chunk
 * keeps the id it has in Qdrant and the keyword and vector lists still fuse.
 * Being absent from Qdrant, they are reached through BM25 and through
 * find_amendments — which is exactly how a freshly uploaded file behaves.
 */
const ATTACK_DIR = path.join(process.cwd(), "attack-documents");

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

async function readDirectory(directory: string): Promise<[string, string][]> {
  const files = (await fs.readdir(directory).catch(() => []))
    .filter((file) => file.endsWith(".txt"))
    .sort();

  return Promise.all(
    files.map(
      async (file) =>
        [file, await fs.readFile(path.join(directory, file), "utf-8")] as [string, string],
    ),
  );
}

const cached = new Map<string, Chunk[]>();

/**
 * The single source of truth for chunks. Ingestion and the keyword index both
 * read from here so a chunk has the same id in Qdrant and in BM25 — that is
 * what lets the two result lists be fused by id.
 */
export async function loadChunks(): Promise<Chunk[]> {
  const withAttack = process.env.ATTACK_DOCS === "1";
  const key = withAttack ? "attack" : "clean";

  const hit = cached.get(key);
  if (hit) return hit;

  const files = [
    ...(await readDirectory(DOCUMENTS_DIR)),
    ...(withAttack ? await readDirectory(ATTACK_DIR) : []),
  ];

  const chunks: Chunk[] = [];
  for (const [file, text] of files) {
    for (const chunk of chunkDocument(text, file)) {
      chunks.push({ id: chunks.length + 1, ...chunk });
    }
  }

  cached.set(key, chunks);
  return chunks;
}
