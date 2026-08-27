import { qdrant } from "./qdrant";

const COLLECTION_NAME = "legal_documents";

export async function createCollection() {
  const collections = await qdrant.getCollections();

  const exists = collections.collections.some(
    (collection) => collection.name === COLLECTION_NAME,
  );

  if (exists) {
    return "Collection already exists";
  }

  await qdrant.createCollection(COLLECTION_NAME, {
    vectors: {
      size: 384,
      distance: "Cosine",
    },
  });

  return "Collection created";
}
