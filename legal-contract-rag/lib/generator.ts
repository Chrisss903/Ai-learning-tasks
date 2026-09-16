import { InferenceClient } from "@huggingface/inference";

/**
 * The answer-generating model, behind one interface.
 *
 * Week 3 used Hugging Face. Its free inference allowance runs out, so the
 * provider is selectable — retrieval is what this week measures, and the
 * before/after comparison stays valid as long as both retrieval modes are
 * scored with the same generator.
 */
export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface Generator {
  label: string;
  complete(messages: ChatMessage[]): Promise<string>;
}

// Generous, because Gemini counts its thinking tokens against this budget and
// a truncated response would come back with no text at all.
const MAX_TOKENS = 1500;

const MAX_ATTEMPTS = 6;

/** Thrown on 429 so the retry loop can tell throttling from a real failure. */
class RateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Free tiers cap requests per minute, and an evaluation run is a tight loop of
 * them. Spacing calls out keeps the run under the cap instead of relying on
 * retries to dig it back out.
 */
function createThrottle(intervalMs: number) {
  let nextSlot = 0;

  return async () => {
    if (intervalMs <= 0) return;

    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + intervalMs;

    if (wait > 0) await sleep(wait);
  };
}

function withRateLimiting(generator: Generator, intervalMs: number): Generator {
  const throttle = createThrottle(intervalMs);

  return {
    label: generator.label,
    async complete(messages) {
      let backoff = 5000;

      for (let attempt = 1; ; attempt++) {
        await throttle();

        try {
          return await generator.complete(messages);
        } catch (error) {
          if (!(error instanceof RateLimitError) || attempt >= MAX_ATTEMPTS) {
            throw error;
          }

          await sleep(error.retryAfterMs ?? backoff);
          backoff *= 2;
        }
      }
    },
  };
}

/** Parses Google's "23s" / "1.5s" retryDelay and Retry-After seconds. */
function parseDelay(value: string | null | undefined): number | null {
  if (!value) return null;

  const seconds = Number(value.replace(/s$/, ""));
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : null;
}

function openAiCompatible(
  provider: string,
  baseUrl: string,
  apiKey: string,
  model: string,
): Generator {
  return {
    label: `${provider}:${model}`,
    async complete(messages) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, messages, max_tokens: MAX_TOKENS }),
      });

      const body = await response.json();

      if (response.status === 429) {
        throw new RateLimitError(
          `${provider} rate limited`,
          parseDelay(response.headers.get("retry-after")),
        );
      }

      if (!response.ok) {
        throw new Error(
          `${provider} error: ${body?.error?.message ?? response.statusText}`,
        );
      }

      return body.choices?.[0]?.message?.content ?? "";
    },
  };
}

function gemini(apiKey: string, model: string): Generator {
  return {
    label: `gemini:${model}`,
    async complete(messages) {
      const system = messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n");

      const contents = messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: "user",
          parts: [{ text: message.content }],
        }));

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "x-goog-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ...(system
              ? { system_instruction: { parts: [{ text: system }] } }
              : {}),
            contents,
            generationConfig: { maxOutputTokens: MAX_TOKENS },
          }),
        },
      );

      const body = await response.json();

      if (response.status === 429) {
        const retryInfo = body?.error?.details?.find((detail: { "@type"?: string }) =>
          detail["@type"]?.includes("RetryInfo"),
        );

        throw new RateLimitError(
          "Gemini rate limited",
          parseDelay(retryInfo?.retryDelay),
        );
      }

      if (!response.ok) {
        throw new Error(
          `Gemini error: ${body?.error?.message ?? response.statusText}`,
        );
      }

      // Thinking models emit several parts; only some carry the answer text.
      const parts = body.candidates?.[0]?.content?.parts ?? [];
      const text = parts
        .map((part: { text?: string }) => part.text ?? "")
        .join("")
        .trim();

      if (!text) {
        throw new Error(
          `Gemini returned no text (finishReason: ${body.candidates?.[0]?.finishReason ?? "unknown"})`,
        );
      }

      return text;
    },
  };
}

/** The SDK's message type carries an index signature that ours does not. */
type HuggingFaceMessages = Parameters<
  InferenceClient["chatCompletion"]
>[0]["messages"];

function huggingFace(model: string): Generator {
  const client = new InferenceClient(process.env.HF_TOKEN);

  return {
    label: `huggingface:${model}`,
    async complete(messages) {
      const response = await client.chatCompletion({
        model,
        messages: messages as unknown as HuggingFaceMessages,
        max_tokens: MAX_TOKENS,
      });

      return response.choices[0].message.content ?? "";
    },
  };
}

/**
 * Picks a provider from the environment. An explicit LLM_PROVIDER wins;
 * otherwise the first key present is used, with Hugging Face as the week 3
 * default. OpenAI is never auto-selected — a key for it is often present but
 * out of credit.
 */
function buildGenerator(): Generator {
  const provider = process.env.LLM_PROVIDER?.toLowerCase();

  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  const groqModel = process.env.GROQ_MODEL ?? "openai/gpt-oss-20b";
  // 2.5-flash is listed by the API but closed to new accounts.
  const geminiModel = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
  const openaiModel = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const hfModel = process.env.HF_MODEL ?? "meta-llama/Llama-3.1-8B-Instruct";

  // Overridable, but defaulted per provider to sit under its free-tier RPM.
  const interval = (fallback: number) =>
    Number(process.env.LLM_MIN_INTERVAL_MS ?? fallback);

  if (provider === "groq" || (!provider && groqKey)) {
    if (!groqKey) throw new Error("LLM_PROVIDER=groq but GROQ_API_KEY is unset");
    return withRateLimiting(
      openAiCompatible(
        "groq",
        "https://api.groq.com/openai/v1",
        groqKey,
        groqModel,
      ),
      interval(2000),
    );
  }

  if (provider === "gemini" || (!provider && geminiKey)) {
    if (!geminiKey) {
      throw new Error("LLM_PROVIDER=gemini but GEMINI_API_KEY is unset");
    }
    return withRateLimiting(gemini(geminiKey, geminiModel), interval(6500));
  }

  if (provider === "openai") {
    if (!openaiKey) {
      throw new Error("LLM_PROVIDER=openai but OPENAI_API_KEY is unset");
    }
    return withRateLimiting(
      openAiCompatible(
        "openai",
        "https://api.openai.com/v1",
        openaiKey,
        openaiModel,
      ),
      interval(0),
    );
  }

  return withRateLimiting(huggingFace(hfModel), interval(0));
}

// Memoised so the throttle's spacing survives across calls — a fresh generator
// per question would reset it and defeat the pacing entirely.
let cached: Generator | null = null;

export function resolveGenerator(): Generator {
  if (!cached) cached = buildGenerator();
  return cached;
}
