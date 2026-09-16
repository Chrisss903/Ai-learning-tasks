import { qdrant } from "./qdrant";
import { DIMENSIONS } from "./embeddings";

const COLLECTION_NAME = "legal_documents";

export async function createCollection() {
  const collections = await qdrant.getCollections();

  const exists = collections.collections.some(
    (collection) => collection.name === COLLECTION_NAME,
  );

  if (exists) {
    const existing = await qdrant.getCollection(COLLECTION_NAME);
    const vectors = existing.config?.params?.vectors;
    const size = typeof vectors === "object" ? vectors?.size : undefined;

    if (size === DIMENSIONS) {
      return "Collection already exists";
    }

    // Switching embedding provider changes the vector size, and Qdrant cannot
    // resize in place — the old vectors are unusable anyway.
    await qdrant.deleteCollection(COLLECTION_NAME);
  }

  await qdrant.createCollection(COLLECTION_NAME, {
    vectors: {
      size: DIMENSIONS,
      distance: "Cosine",
    },
  });

  return `Collection created with ${DIMENSIONS} dimensions`;
}
