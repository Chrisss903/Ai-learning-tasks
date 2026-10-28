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

export interface Usage {
  inputTokens: number;
  /** Includes thinking tokens — they are billed as output. */
  outputTokens: number;
  /** Week 11: the thinking share of outputTokens, where the provider reports it. */
  thinkingTokens?: number;
}

/** A completion with what it cost, for the week 7 agent-vs-workflow race. */
export interface Completion {
  text: string;
  usage: Usage;
  /** Time in the provider call itself, excluding free-tier throttle waits. */
  ms: number;
  /**
   * Week 11: time spent queued behind the throttle and in retry backoff. It is
   * zero on a quiet day and is the first thing a busier one turns into latency.
   */
  waitMs?: number;
  /** Provider calls made, counting retries. */
  attempts?: number;
  /** How many of those attempts came back rate limited. */
  throttled?: number;
}

export interface Generator {
  label: string;
  complete(messages: ChatMessage[]): Promise<string>;
  run(messages: ChatMessage[]): Promise<Completion>;
}

/** Providers implement `run`; `complete` is the text-only view of it. */
function fromRun(
  label: string,
  run: (messages: ChatMessage[]) => Promise<Completion>,
): Generator {
  return {
    label,
    run,
    async complete(messages) {
      return (await run(messages)).text;
    },
  };
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

  return fromRun(generator.label, async (messages) => {
    let backoff = 5000;
    let waitMs = 0;
    let throttled = 0;

    for (let attempt = 1; ; attempt++) {
      const queued = Date.now();
      await throttle();
      waitMs += Date.now() - queued;

      try {
        const completion = await generator.run(messages);
        return { ...completion, waitMs, attempts: attempt, throttled };
      } catch (error) {
        if (error instanceof RateLimitError) throttled++;

        // A dropped connection is as temporary as a 429, and losing a whole
        // evaluation batch to one is worse than waiting a few seconds. So is
        // Gemini's 503 "experiencing high demand".
        const transient =
          error instanceof RateLimitError ||
          (error instanceof Error &&
            /fetch failed|network|timeout|ECONNRESET|returned no text|high demand|overloaded|unavailable/i.test(
              error.message,
            ));

        if (!transient || attempt >= MAX_ATTEMPTS) throw error;

        const delay = error instanceof RateLimitError ? (error.retryAfterMs ?? backoff) : backoff;
        await sleep(delay);
        waitMs += delay;
        backoff *= 2;
      }
    }
  });
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
  return fromRun(`${provider}:${model}`, async (messages) => {
    const started = Date.now();
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

    return {
      text: body.choices?.[0]?.message?.content ?? "",
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      },
      ms: Date.now() - started,
    };
  });
}

function gemini(apiKey: string, model: string): Generator {
  return fromRun(`gemini:${model}`, async (messages) => {
    const started = Date.now();
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

    const call = (version: string) =>
      fetch(
        `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent`,
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

    // Models released after v1beta was frozen answer only on v1, and the older
    // ones answer on both, so a 404 is a version mismatch rather than a typo.
    let response = await call(process.env.GEMINI_API_VERSION ?? "v1beta");
    if (response.status === 404) response = await call("v1");

    const body = await response.json().catch(() => ({}));

    if (response.status === 429) {
      const details: { "@type"?: string; retryDelay?: string; violations?: { quotaId?: string; quotaValue?: string }[] }[] =
        body?.error?.details ?? [];
      const retryInfo = details.find((detail) => detail["@type"]?.includes("RetryInfo"));
      // Week 11: the quota that tripped, e.g. "...PerMinute...-FreeTier = 15" —
      // the free-tier limits are not published anywhere else.
      const quota = details
        .find((detail) => detail["@type"]?.includes("QuotaFailure"))
        ?.violations?.map((violation) => `${violation.quotaId} = ${violation.quotaValue}`)
        .join("; ");

      throw new RateLimitError(
        quota ? `Gemini rate limited (${quota})` : "Gemini rate limited",
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

    const usage = body.usageMetadata ?? {};

    return {
      text,
      usage: {
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens:
          (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
        thinkingTokens: usage.thoughtsTokenCount ?? 0,
      },
      ms: Date.now() - started,
    };
  });
}

/** The SDK's message type carries an index signature that ours does not. */
type HuggingFaceMessages = Parameters<
  InferenceClient["chatCompletion"]
>[0]["messages"];

function huggingFace(model: string): Generator {
  const client = new InferenceClient(process.env.HF_TOKEN);

  return fromRun(`huggingface:${model}`, async (messages) => {
    const started = Date.now();
    const response = await client.chatCompletion({
      model,
      messages: messages as unknown as HuggingFaceMessages,
      max_tokens: MAX_TOKENS,
    });

    return {
      text: response.choices[0].message.content ?? "",
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      ms: Date.now() - started,
    };
  });
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
