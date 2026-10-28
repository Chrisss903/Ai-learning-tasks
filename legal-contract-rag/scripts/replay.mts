/**
 * Week 11: replay logged production requests under another prompt version —
 * the shadow step of a canary. Nobody sees these answers; they are logged to
 * logs/eval/ and compared with what production actually said.
 *
 *   npm run replay -- --prompt rag-answer@3 --type termination
 *   npm run replay -- --prompt rag-answer@3 --from 2026-10-19 --to 2026-10-27
 *
 * Requests run in their original order in one process, so the answer cache
 * sees the same repeats production would.
 */
import "./env.mts";
import { readdirSync, readFileSync } from "fs";
import path from "path";
import type { RequestLog } from "../lib/telemetry";

const { askQuestion } = await import("../lib/rag");
const { looksLikeRefusal } = await import("../lib/assertions");

const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const promptVersion = value("prompt") ?? "rag-answer@3";
const type = value("type");
const from = value("from");
const to = value("to");

const directory = path.join(process.cwd(), "logs", "requests");
const records = readdirSync(directory)
  .filter((file) => file.endsWith(".jsonl") && (!from || file >= from) && (!to || file.slice(0, 10) <= to))
  .flatMap((file) => readFileSync(path.join(directory, file), "utf-8").split("\n").filter(Boolean))
  .map((line) => JSON.parse(line) as RequestLog)
  .filter((record) => record.status === "ok" && (!type || record.input.type === type))
  .sort((a, b) => a.ts.localeCompare(b.ts));

/** What an answer cited, as clause labels: [3] → "PC-2026-011 §8". */
const citedLabels = (answer: string, labels: string[]) =>
  [...new Set([...answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) => m[1].split(",").map((n) => labels[Number(n) - 1]).filter(Boolean)))];

console.log(`\nreplaying ${records.length} logged request(s) under ${promptVersion}${type ? ` · type ${type}` : ""}\n`);

let cost = 0;
let hits = 0;
let refusedBefore = 0;
let refusedAfter = 0;

for (const record of records) {
  const result = await askQuestion(record.input.question, "hybrid", {
    channel: "eval",
    user: { id: `replay:${record.user.id}`, role: record.user.role },
    promptVersion,
  });

  // The replay's own trace, read back for its cost and cache outcome.
  const traces = readFileSync(path.join(process.cwd(), "logs", "eval", `${new Date().toISOString().slice(0, 10)}.jsonl`), "utf-8")
    .split("\n")
    .filter(Boolean);
  const trace = JSON.parse(traces.findLast((line) => line.includes(result.traceId))!) as RequestLog;
  const hit = trace.spans.some((s) => s.name === "generation.answer" && s.attributes.cache === "hit");
  cost += trace.totals.cost_usd;
  if (hit) hits++;

  const before = record.output!.answer;
  const beforeCited = citedLabels(before, record.retrieval.context.map((c) => c.label));
  const afterCited = citedLabels(result.answer, result.sources.map((s) => s.label));
  if (looksLikeRefusal(before)) refusedBefore++;
  if (looksLikeRefusal(result.answer)) refusedAfter++;

  console.log(`${record.trace_id.slice(0, 8)}  ${record.user.id} · ${record.input.question}`);
  console.log(`   ${record.prompt_version}: ${looksLikeRefusal(before) ? "REFUSED" : `cites ${beforeCited.join(", ") || "nothing"}`} — ${before.replace(/\s+/g, " ").slice(0, 110)}`);
  console.log(`   ${promptVersion}: ${looksLikeRefusal(result.answer) ? "REFUSED" : `cites ${afterCited.join(", ") || "nothing"}`}${hit ? " (cache hit)" : ""} — ${result.answer.replace(/\s+/g, " ").slice(0, 110)}\n`);
}

const n = records.length || 1;
console.log(`refused: ${refusedBefore}/${records.length} before → ${refusedAfter}/${records.length} under ${promptVersion}`);
console.log(`answer cache: ${hits}/${records.length} hits (${Math.round((hits / n) * 100)}%) · mean cost per request $${(cost / n).toFixed(6)}`);
