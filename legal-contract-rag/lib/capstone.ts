import { CAPSTONE_AGENT, runAgent, type AgentRun } from "./agent";
import { enforceCounselLine } from "./counsel-guard";
import { closeTools } from "./mcp-client";
import { resolveGenerator } from "./generator";
import { newTraceId, recordRequest, type Channel } from "./telemetry";
import { classifyInput } from "./input-type";
import { resolveContracts } from "./contracts";

/**
 * Week 12: the one entry point. A question goes in, one trace id comes out,
 * and the same id is on the host's spans, in the MCP request metadata, and in
 * the clause-search server's own audit line.
 *
 *   question → agent loop (week 7) → tools discovered over MCP (week 9)
 *            → clause search = the week 3–4 hybrid RAG retriever
 *            → counsel guard → answer
 */
export interface CapstoneAnswer {
  traceId: string;
  answer: string;
  /** What the agent said before the guard, kept when the guard changed it. */
  draft: string | null;
  guard: { intervened: boolean; reason: string | null };
  run: AgentRun;
  totals: { latencyMs: number; costUsd: number; tokens: number };
}

export async function askCapstone(
  question: string,
  options: { user?: { id: string; role: string }; channel?: Channel } = {},
): Promise<CapstoneAnswer> {
  const traceId = newTraceId();
  const generator = resolveGenerator();
  const started = Date.now();
  const contracts = (await resolveContracts(question)).map((c) => c.id);
  const draft = {
    trace_id: traceId,
    ts: new Date().toISOString(),
    channel: options.channel ?? ("agent" as Channel),
    user: options.user ?? { id: "cli", role: "unknown" },
    input: { question, type: classifyInput(question), contracts },
    prompt_version: "agent@12",
    model: generator.label,
    embedding_model: "gemini-embedding-001",
    retrieval: { mode: "agent→mcp→hybrid", top_k: 3, context: [] },
    output: null as null | { answer: string; cited_excerpts: number[]; refused: boolean },
  };

  let result!: CapstoneAnswer;
  await recordRequest(draft, async () => {
    const run = await runAgent(question, { role: CAPSTONE_AGENT });
    const raw = run.answer ?? "I could not complete this lookup. Please refer the question to counsel.";
    const guarded = enforceCounselLine(question, raw);
    draft.output = { answer: guarded.answer, cited_excerpts: [], refused: run.answer === null };
    result = {
      traceId,
      answer: guarded.answer,
      draft: guarded.intervened ? raw : null,
      guard: { intervened: guarded.intervened, reason: guarded.reason },
      run,
      totals: { latencyMs: Date.now() - started, costUsd: 0, tokens: run.usage.inputTokens + run.usage.outputTokens },
    };
  });
  return result;
}

export { closeTools };
