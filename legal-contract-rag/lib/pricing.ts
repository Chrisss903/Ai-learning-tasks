import type { Usage } from "./generator";

/**
 * Week 11: what a request costs, in dollars, at the paid list rate.
 *
 * The app runs on free tiers, so every call actually costs $0. Pricing at the
 * list rate is what makes "cost per query" a number that can be compared
 * between versions and scaled to 10x — a free tier has a rate limit, not a
 * price, and that limit is handled separately (week11/tenx.md).
 *
 * Sources, read 2026-10-28:
 *   gemini-3.5-flash-lite  $0.30 / 1M input, $2.50 / 1M output (thinking is
 *                          billed as output) — ai.google.dev/gemini-api/docs/pricing
 *   gemini-embedding-001   $0.15 / 1M input — developers.googleblog.com,
 *                          "Gemini Embedding now generally available"
 *   Qdrant Cloud free tier $0 per query; the cluster is a fixed cost, not a
 *                          per-request one.
 *
 * Week 10's race priced at $0.50 / $3.00 (its env default). These are the
 * published rates for the model the runs use; override with the env vars.
 */
const GENERATION: Record<string, { inputPerM: number; outputPerM: number }> = {
  "gemini-3.5-flash-lite": { inputPerM: 0.3, outputPerM: 2.5 },
  "gemini-3.6-flash": { inputPerM: 0.5, outputPerM: 3.0 },
};

const EMBEDDING_PER_M: Record<string, number> = {
  "gemini-embedding-001": 0.15,
};

/** "gemini:gemini-3.5-flash-lite" → its price, or the env/default rate. */
export function generationRate(label: string) {
  const model = label.split(":").pop() ?? label;
  const listed = GENERATION[model];

  return {
    inputPerM: Number(process.env.LLM_PRICE_IN_PER_M ?? listed?.inputPerM ?? 0.5),
    outputPerM: Number(process.env.LLM_PRICE_OUT_PER_M ?? listed?.outputPerM ?? 3.0),
  };
}

export function generationCost(label: string, usage: Usage): number {
  const rate = generationRate(label);
  return (usage.inputTokens * rate.inputPerM + usage.outputTokens * rate.outputPerM) / 1e6;
}

/**
 * The embedding API does not report token counts, so they are estimated at
 * four characters a token — the figure Google gives for English text. Logged
 * as an estimate wherever it is used.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function embeddingCost(label: string, tokens: number): number {
  const model = label.split(":").pop() ?? label;
  return (tokens * (EMBEDDING_PER_M[model] ?? 0)) / 1e6;
}
