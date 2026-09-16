import { InferenceClient } from "@huggingface/inference";

/**
 * The embedding model.
 *
 * Week 3 used Hugging Face's all-MiniLM-L6-v2 (384 dimensions). Its free
 * allowance runs out, so the provider is selectable. The vector size differs
 * per provider, which is why DIMENSIONS is exported — the Qdrant collection is
 * created from it, so the index can never silently disagree with the encoder.
 */
const PROVIDER = (process.env.EMBEDDING_PROVIDER ?? "huggingface").toLowerCase();

const HF_MODEL =
  process.env.EMBEDDING_MODEL ?? "sentence-transformers/all-MiniLM-L6-v2";
const GEMINI_MODEL = process.env.EMBEDDING_MODEL ?? "gemini-embedding-001";

/** Gemini supports several output sizes; 768 matches common vector stores. */
const GEMINI_DIMENSIONS = 768;
const HF_DIMENSIONS = 384;

export const DIMENSIONS =
  PROVIDER === "gemini" ? GEMINI_DIMENSIONS : HF_DIMENSIONS;

export const EMBEDDING_LABEL =
  PROVIDER === "gemini" ? `gemini:${GEMINI_MODEL}` : `huggingface:${HF_MODEL}`;

/**
 * An evaluation run asks the same question once per retrieval mode, so caching
 * keeps the comparison to one embedding call per question.
 */
const cache = new Map<string, number[]>();

let client: InferenceClient | null = null;

async function embedWithHuggingFace(text: string): Promise<number[]> {
  client ??= new InferenceClient(process.env.HF_TOKEN);

  const result = await client.featureExtraction({
    model: HF_MODEL,
    inputs: text,
  });

  return Array.from(result as number[]);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The free tier counts each text in a batch against a per-minute request cap,
 * so a full ingest will trip it. Google says how long to wait; obey that rather
 * than guessing.
 */
async function embedWithGemini(
  texts: string[],
  attempt = 1,
): Promise<number[][]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("EMBEDDING_PROVIDER=gemini but GEMINI_API_KEY is unset");
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:batchEmbedContents`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${GEMINI_MODEL}`,
          content: { parts: [{ text }] },
          outputDimensionality: GEMINI_DIMENSIONS,
        })),
      }),
    },
  );

  const body = await response.json();

  if (response.status === 429 && attempt <= 6) {
    const retryInfo = body?.error?.details?.find(
      (detail: { "@type"?: string }) => detail["@type"]?.includes("RetryInfo"),
    );
    const seconds = Number(String(retryInfo?.retryDelay ?? "").replace(/s$/, ""));

    await sleep(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 + 1000 : 30000);
    return embedWithGemini(texts, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(
      `Gemini embedding error: ${body?.error?.message ?? response.statusText}`,
    );
  }

  return body.embeddings.map(
    (embedding: { values: number[] }) => embedding.values,
  );
}

export async function createEmbedding(text: string): Promise<number[]> {
  const hit = cache.get(text);
  if (hit) return hit;

  const embedding =
    PROVIDER === "gemini"
      ? (await embedWithGemini([text]))[0]
      : await embedWithHuggingFace(text);

  cache.set(text, embedding);
  return embedding;
}

/**
 * Ingestion embeds every chunk at once. Gemini takes them in batches, which is
 * both faster and far kinder to a free tier's per-minute request cap.
 */
export async function createEmbeddings(texts: string[]): Promise<number[][]> {
  if (PROVIDER !== "gemini") {
    const embeddings: number[][] = [];
    for (const text of texts) embeddings.push(await createEmbedding(text));
    return embeddings;
  }

  const BATCH_SIZE = 50;
  const embeddings: number[][] = [];

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);
    const batchEmbeddings = await embedWithGemini(batch);

    batch.forEach((text, index) => cache.set(text, batchEmbeddings[index]));
    embeddings.push(...batchEmbeddings);
  }

  return embeddings;
}
