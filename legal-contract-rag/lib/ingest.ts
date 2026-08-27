import { promises as fs } from "fs";
import path from "path";
import { qdrant } from "./qdrant";
import { createEmbedding } from "./embeddings";

const COLLECTION_NAME = "legal_documents";
const DOCUMENTS_DIR = path.join(process.cwd(), "documents");

interface Chunk {
  text: string;
  source: string;
  section: string;
}

function chunkDocument(text: string, source: string): Chunk[] {
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

export async function ingestDocuments() {
  const files = (await fs.readdir(DOCUMENTS_DIR)).filter((file) =>
    file.endsWith(".txt"),
  );

  const chunks: Chunk[] = [];
  for (const file of files) {
    const text = await fs.readFile(path.join(DOCUMENTS_DIR, file), "utf-8");
    chunks.push(...chunkDocument(text, file));
  }

  const points = [];
  for (const [index, chunk] of chunks.entries()) {
    const embedding = await createEmbedding(chunk.text);
    points.push({
      id: index + 1,
      vector: embedding,
      payload: {
        text: chunk.text,
        source: chunk.source,
        section: chunk.section,
      },
    });
  }

  await qdrant.upsert(COLLECTION_NAME, {
    wait: true,
    points,
  });

  return `Ingested ${points.length} chunks from ${files.length} documents`;
}
