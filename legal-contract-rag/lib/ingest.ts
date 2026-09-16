import { qdrant } from "./qdrant";
import { createEmbeddings } from "./embeddings";
import { loadChunks } from "./chunking";
import { createCollection } from "./qdarnt-collections";

const COLLECTION_NAME = "legal_documents";

export async function ingestDocuments() {
  // Recreates the collection if the embedding provider changed its size.
  await createCollection();

  const chunks = await loadChunks();
  const embeddings = await createEmbeddings(chunks.map((chunk) => chunk.text));

  const points = chunks.map((chunk, index) => ({
    id: chunk.id,
    vector: embeddings[index],
    payload: {
      text: chunk.text,
      source: chunk.source,
      section: chunk.section,
    },
  }));

  // Chunk ids are positional, so a shrinking corpus would otherwise leave
  // orphaned points behind and quietly pollute the evaluation.
  await qdrant.delete(COLLECTION_NAME, { wait: true, filter: {} });

  await qdrant.upsert(COLLECTION_NAME, {
    wait: true,
    points,
  });

  const sources = new Set(chunks.map((chunk) => chunk.source));

  return `Ingested ${points.length} chunks from ${sources.size} documents`;
}
