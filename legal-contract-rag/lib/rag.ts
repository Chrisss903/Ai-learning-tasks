import { createHash } from "node:crypto";
import type { SearchMode, SearchResult } from "./search";
import { resolveGenerator, type Completion } from "./generator";
import { EMBEDDING_LABEL } from "./embeddings";
import { looksLikeRefusal } from "./assertions";
import { resolveContracts } from "./contracts";
import { classifyInput } from "./input-type";
import { generationCost } from "./pricing";
import { getPrompt, promptVersionFor, type Excerpt } from "./prompts";
import { newTraceId, recordRequest, span, type Channel, type RequestDraft } from "./telemetry";

export interface RagAnswer {
  answer: string;
  /** The excerpts the model read, in order — the answer's [n] is sources[n-1]. */
  sources: Excerpt[];
  /** The excerpts exactly as the model saw them, for the judge. */
  context: string;
  mode: SearchMode;
  generator: string;
  promptVersion: string;
  traceId: string;
}

/**
 * Split out from askQuestion so the evaluator can reuse one retrieval pass for
 * both the retrieval metrics and the answer it grades. Always the week 3–10
 * prompt: the week 4 inspector and the week 5 traces route compare against it.
 */
export async function generateAnswer(
  question: string,
  sources: SearchResult[],
): Promise<string> {
  const prompt = getPrompt("rag-answer@1");
  const rendered = await prompt.render(sources.map((source) => ({ ...source, label: "", via: "search" })));
  return resolveGenerator().complete(prompt.messages(question, rendered));
}

export interface AskOptions {
  user?: { id: string; role: string };
  channel?: Channel;
  /** Pin a version; otherwise the user's version from PROMPT_VERSION / PROMPT_CANARY. */
  promptVersion?: string;
  /** Stamp the request with this arrival time instead of now — replayed traffic. */
  at?: Date;
}

/**
 * Week 11 cost cut: an exact-match answer cache.
 *
 * 58% of last week's requests repeated a question already asked. The key is
 * everything that decides the answer — prompt version, model, the question,
 * and the id and full text of every clause shown — so a prompt bump or an
 * edited document can only miss, never serve a stale answer. Deliberately not
 * a semantic cache: "notice period in PC-2026-011" and "… in PC-2026-027" are
 * near-identical to an embedding and need different answers (week11/cost_by_stage.md).
 *
 * In-process, which is all this app has; a deployment with more than one
 * process would put the same key in Redis. ANSWER_CACHE=off disables it.
 */
const answerCache = new Map<string, Completion>();

function answerKey(promptId: string, model: string, question: string, sources: Excerpt[]): string {
  const normalised = question.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256")
    .update(JSON.stringify([promptId, model, normalised, sources.map((source) => [source.id, source.text])]))
    .digest("hex");
}

/** `[2]` and `[1, 3]` in an answer → [2, 1, 3]. */
function citedExcerpts(answer: string): number[] {
  return [...answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((match) =>
    match[1].split(",").map((n) => Number(n.trim())),
  );
}

/**
 * Week 11: one request, one trace. Retrieval, any lookups and the model call
 * are spans with their own time, tokens and cost; the trace is written to
 * logs/requests/ with who asked, what about, under which prompt version, and
 * which clauses the model was shown.
 */
export async function askQuestion(
  question: string,
  mode: SearchMode = "vector",
  options: AskOptions = {},
): Promise<RagAnswer> {
  const user = options.user ?? { id: "anonymous", role: "unknown" };
  const prompt = getPrompt(options.promptVersion ?? promptVersionFor(user.id));
  const generator = resolveGenerator();

  const draft: RequestDraft = {
    trace_id: newTraceId(),
    ts: (options.at ?? new Date()).toISOString(),
    ...(options.at ? { clock: "simulated" as const } : {}),
    channel: options.channel ?? "web",
    user,
    input: {
      question,
      type: classifyInput(question),
      contracts: (await resolveContracts(question)).map((contract) => contract.id),
    },
    prompt_version: prompt.id,
    model: generator.label,
    embedding_model: EMBEDDING_LABEL,
    retrieval: { mode, top_k: 3, context: [] },
    output: null,
  };

  return recordRequest(draft, async () => {
    const sources = await prompt.context(question, mode);
    draft.retrieval.context = sources.map((source, index) => ({
      n: index + 1,
      chunk_id: source.id,
      label: source.label,
      source: source.source,
      section: source.section,
      via: source.via,
      vector_rank: source.vectorRank,
      keyword_rank: source.keywordRank,
    }));

    const context = await prompt.render(sources);

    const completion = await span("generation.answer", "generation", async (handle) => {
      const key = answerKey(prompt.id, generator.label, question, sources);
      const cached = process.env.ANSWER_CACHE === "off" ? undefined : answerCache.get(key);

      if (cached) {
        handle.tokens({ input: 0, output: 0 });
        handle.set({ "gen_ai.request.model": generator.label, prompt_version: prompt.id, cache: "hit" });
        return cached;
      }

      const result = await generator.run(prompt.messages(question, context));
      answerCache.set(key, result);
      handle.tokens({
        input: result.usage.inputTokens,
        output: result.usage.outputTokens,
        thinking: result.usage.thinkingTokens,
      });
      handle.cost(generationCost(generator.label, result.usage));
      handle.set({
        "gen_ai.request.model": generator.label,
        prompt_version: prompt.id,
        cache: "miss",
        provider_ms: result.ms,
        queue_ms: result.waitMs ?? 0,
        attempts: result.attempts ?? 1,
        throttled: result.throttled ?? 0,
      });
      return result;
    });

    draft.output = {
      answer: completion.text,
      cited_excerpts: citedExcerpts(completion.text),
      refused: looksLikeRefusal(completion.text),
    };

    return {
      answer: completion.text,
      sources,
      context,
      mode,
      generator: generator.label,
      promptVersion: prompt.id,
      traceId: draft.trace_id,
    };
  });
}
