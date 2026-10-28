import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InputType } from "./input-type";

/**
 * Week 11: every request leaves a trace.
 *
 * A trace is one request; a span is one step inside it — an embedding call, a
 * vector query, a lookup, a model call — with its own time, tokens and cost.
 * One finished trace is written as one JSON line, so a single grep or a single
 * `npm run logs` query reaches everything that request did.
 *
 * Hand-built, like the week 7 agent and the week 10 squad, so every number in
 * it is ours. Field names follow OpenTelemetry (trace_id, span_id, parent_id,
 * gen_ai.* attributes), so the same records could be shipped to Phoenix or
 * any OTel collector later without renaming anything.
 *
 * Spans are carried by AsyncLocalStorage: lib/search.ts and lib/embeddings.ts
 * open spans without any trace being passed to them, and outside a request
 * (an ingest, a script) `span` simply runs the work.
 */
export type Stage = "retrieval" | "generation" | "tools";

export interface Span {
  span_id: string;
  parent_id: string | null;
  name: string;
  stage: Stage;
  /** Milliseconds from the start of the request. */
  start_ms: number;
  duration_ms: number;
  status: "ok" | "error";
  error?: string;
  /** Only on spans that called a model, so the totals never double count. */
  tokens?: { input: number; output: number; thinking?: number; estimated?: boolean };
  cost_usd: number;
  attributes: Record<string, unknown>;
}

/** One excerpt the model was shown. `n` is the number it cites it by. */
export interface ContextRef {
  n: number;
  /** The chunk id — the same id in Qdrant and in the BM25 index. */
  chunk_id: number;
  /** "PC-2026-011 §8" */
  label: string;
  source: string;
  section: string;
  /** How it got into the context: found by search, or attached by a lookup. */
  via: "search" | "amendment";
  vector_rank: number | null;
  keyword_rank: number | null;
}

export type Channel = "web" | "cli" | "eval";

export interface RequestLog {
  trace_id: string;
  /** When the request arrived, ISO 8601 UTC. */
  ts: string;
  /** Present when `ts` came from a replayed or simulated clock, not the wall clock. */
  clock?: "simulated";
  channel: Channel;
  user: { id: string; role: string };
  input: {
    question: string;
    /** What the question is about — the input-type slice. */
    type: InputType;
    /** Contract ids the question names, resolved in code. */
    contracts: string[];
  };
  prompt_version: string;
  model: string;
  embedding_model: string;
  retrieval: { mode: string; top_k: number; context: ContextRef[] };
  output: { answer: string; cited_excerpts: number[]; refused: boolean } | null;
  spans: Span[];
  totals: {
    latency_ms: number;
    /** Of latency_ms, the time spent waiting on the rate limiter. */
    queue_ms: number;
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
    cost_by_stage: Record<Stage, number>;
  };
  status: "ok" | "error";
  error?: string;
}

export type RequestDraft = Omit<RequestLog, "spans" | "totals" | "status" | "error">;

export interface SpanHandle {
  set(attributes: Record<string, unknown>): void;
  tokens(tokens: NonNullable<Span["tokens"]>): void;
  cost(usd: number): void;
}

interface ActiveTrace {
  started: number;
  spans: Span[];
}

const storage = new AsyncLocalStorage<{ trace: ActiveTrace; parent: string | null }>();

const NOOP: SpanHandle = { set() {}, tokens() {}, cost() {} };

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/** 32 hex characters, the OpenTelemetry trace id format. */
export const newTraceId = () => hex(16);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Runs `work` as a span of the current request, or plainly if there is none. */
export async function span<T>(
  name: string,
  stage: Stage,
  work: (handle: SpanHandle) => Promise<T> | T,
): Promise<T> {
  const context = storage.getStore();
  if (!context) return work(NOOP);

  const started = Date.now();
  const record: Span = {
    span_id: hex(8),
    parent_id: context.parent,
    name,
    stage,
    start_ms: started - context.trace.started,
    duration_ms: 0,
    status: "ok",
    cost_usd: 0,
    attributes: {},
  };
  context.trace.spans.push(record);

  const handle: SpanHandle = {
    set: (attributes) => Object.assign(record.attributes, attributes),
    tokens: (tokens) => {
      record.tokens = tokens;
    },
    cost: (usd) => {
      record.cost_usd = usd;
    },
  };

  try {
    return await storage.run({ trace: context.trace, parent: record.span_id }, () => work(handle));
  } catch (error) {
    record.status = "error";
    record.error = message(error);
    throw error;
  } finally {
    record.duration_ms = Date.now() - started;
  }
}

function totalsOf(spans: Span[], latencyMs: number): RequestLog["totals"] {
  const byStage: Record<Stage, number> = { retrieval: 0, generation: 0, tools: 0 };
  let tokensIn = 0;
  let tokensOut = 0;
  let queueMs = 0;

  for (const entry of spans) {
    byStage[entry.stage] += entry.cost_usd;
    tokensIn += entry.tokens?.input ?? 0;
    tokensOut += entry.tokens?.output ?? 0;
    queueMs += Number(entry.attributes.queue_ms ?? 0);
  }

  return {
    latency_ms: latencyMs,
    queue_ms: queueMs,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: byStage.retrieval + byStage.generation + byStage.tools,
    cost_by_stage: byStage,
  };
}

/**
 * Runs one request as a trace and writes it when it ends — failed requests
 * included, because "it errored" is a complaint too. `work` fills in the
 * draft's context and output as it learns them.
 */
export async function recordRequest<T>(draft: RequestDraft, work: () => Promise<T>): Promise<T> {
  const trace: ActiveTrace = { started: Date.now(), spans: [] };
  let failure: string | null = null;

  try {
    return await storage.run({ trace, parent: null }, work);
  } catch (error) {
    failure = message(error);
    throw error;
  } finally {
    writeRequestLog({
      ...draft,
      spans: trace.spans,
      totals: totalsOf(trace.spans, Date.now() - trace.started),
      status: failure ? "error" : "ok",
      ...(failure ? { error: failure } : {}),
    });
  }
}

export const LOG_ROOT = path.join(process.cwd(), "logs");

/** Production traffic and suite runs are kept apart, so a drill never trips over an eval. */
export function logDirFor(channel: Channel): string {
  return path.join(LOG_ROOT, channel === "eval" ? "eval" : "requests");
}

/**
 * One file per UTC day. A record stamped earlier than the file's last line —
 * a simulated clock — is put back in time order, so file position never gives
 * away when a record was really written.
 */
function writeRequestLog(record: RequestLog) {
  if (process.env.REQUEST_LOG === "off") return;

  const directory = logDirFor(record.channel);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${record.ts.slice(0, 10)}.jsonl`);
  const line = JSON.stringify(record);

  if (!existsSync(file)) {
    writeFileSync(file, `${line}\n`);
    return;
  }

  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const last = lines.length ? (JSON.parse(lines[lines.length - 1]) as RequestLog).ts : "";

  if (record.ts >= last) {
    appendFileSync(file, `${line}\n`);
    return;
  }

  const sorted = [...lines, line].sort(
    (a, b) => (JSON.parse(a) as RequestLog).ts.localeCompare((JSON.parse(b) as RequestLog).ts),
  );
  writeFileSync(file, `${sorted.join("\n")}\n`);
}
