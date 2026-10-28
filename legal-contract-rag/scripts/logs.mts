/**
 * Week 11: the support-drill tool. Reads logs/requests/*.jsonl.
 *
 *   npm run logs -- slices                         where the traffic is: by day, role, user, type, version
 *   npm run logs -- find --day thu --role lawyer --type termination
 *   npm run logs -- find --a "60 days"             search the ANSWERS (the complaint describes an output)
 *   npm run logs -- find --q "sharma"              search the questions
 *   npm run logs -- find --ctx "PC-2026-011 §8"    requests whose model was shown that clause
 *   npm run logs -- find --cost-outlier            cost over 2x the median request
 *   npm run logs -- show <trace-id-prefix>         one request: context, answer, every span
 *   npm run logs -- export <id> week11/trace.json  the raw trace, pretty-printed
 *   npm run logs -- cost <id>                      cost by stage for one request
 *   npm run logs -- cost [filters]                 mean cost by stage across requests
 *   npm run logs -- to-case <id> --id T17          draft a regression case from a trace
 *
 * Filters: --day <mon..sun|YYYY-MM-DD> --since/--until <date or datetime>
 *          --user --role --type --prompt --channel --status
 *          --q <question text> --a <answer text> --text <either> --ctx <clause label>
 *          --cost-outlier --slow --limit N --eval (read logs/eval instead)
 * Times are shown and filtered in LOG_TZ (default: this machine's zone).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { RequestLog, Span, Stage } from "../lib/telemetry";

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("--") ? args.shift()! : "find";
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const BOOLEAN_FLAGS = new Set(["--cost-outlier", "--slow", "--eval"]);
const positional = args.filter(
  (arg, index) => !arg.startsWith("--") && !(args[index - 1]?.startsWith("--") && !BOOLEAN_FLAGS.has(args[index - 1])),
);

const TZ = process.env.LOG_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const root = path.join(process.cwd(), "logs", flag("eval") ? "eval" : "requests");

function load(): RequestLog[] {
  const files = (() => {
    try {
      return readdirSync(root).filter((file) => file.endsWith(".jsonl")).sort();
    } catch {
      return [];
    }
  })();

  return files
    .flatMap((file) => readFileSync(path.join(root, file), "utf-8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as RequestLog)
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Local date, weekday and time of a record, in LOG_TZ. */
function local(ts: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(ts))
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday.toLowerCase(),
    label: `${parts.weekday} ${parts.day}/${parts.month} ${parts.hour}:${parts.minute}`,
    full: `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${TZ}`,
  };
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0;
};

const has = (haystack: string | undefined, needle: string) =>
  (haystack ?? "").toLowerCase().includes(needle.toLowerCase());

/** How far LOG_TZ is ahead of UTC at a moment, in ms. */
function zoneOffset(at: number): number {
  const shown = new Date(at).toLocaleString("sv-SE", { timeZone: TZ }); // "2026-10-22 14:00:00"
  return new Date(`${shown.replace(" ", "T")}Z`).getTime() - at;
}

/** "2026-10-22" or "2026-10-22 14:00", read in LOG_TZ → epoch ms. */
function localTime(text: string): number {
  const [date, time = "00:00"] = text.split(/[ T]/);
  const guess = new Date(`${date}T${time.length === 5 ? `${time}:00` : time}Z`).getTime();
  return guess - zoneOffset(guess);
}

function filter(records: RequestLog[]): RequestLog[] {
  const costLine = 2 * median(records.map((r) => r.totals.cost_usd));
  const slowLine = percentile(records.map((r) => r.totals.latency_ms), 95);

  const day = value("day")?.toLowerCase();
  const since = value("since");
  const until = value("until");

  const matched = records.filter((r) => {
    const when = local(r.ts);
    if (day && !(day.length === 3 ? when.weekday === day : when.date === day)) return false;
    if (since && new Date(r.ts).getTime() < localTime(since)) return false;
    if (until && new Date(r.ts).getTime() > localTime(until)) return false;
    if (value("user") && r.user.id !== value("user")) return false;
    if (value("role") && r.user.role !== value("role")) return false;
    if (value("type") && r.input.type !== value("type")) return false;
    if (value("prompt") && r.prompt_version !== value("prompt")) return false;
    if (value("channel") && r.channel !== value("channel")) return false;
    if (value("status") && r.status !== value("status")) return false;
    if (value("q") && !has(r.input.question, value("q")!)) return false;
    if (value("a") && !has(r.output?.answer, value("a")!)) return false;
    if (value("text") && !has(r.input.question, value("text")!) && !has(r.output?.answer, value("text")!)) return false;
    if (value("ctx") && !r.retrieval.context.some((c) => has(c.label, value("ctx")!))) return false;
    if (flag("cost-outlier") && r.totals.cost_usd <= costLine) return false;
    if (flag("slow") && r.totals.latency_ms <= slowLine) return false;
    return true;
  });

  if (flag("cost-outlier")) console.log(`  cost outlier = over 2x the median request = $${costLine.toFixed(6)}`);
  if (flag("slow")) console.log(`  slow = over p95 latency = ${slowLine} ms`);
  return matched;
}

function byId(records: RequestLog[], id: string | undefined): RequestLog {
  if (!id || id.length < 6) throw new Error("Give a trace id, or at least its first 6 characters.");
  const found = records.filter((r) => r.trace_id.startsWith(id));
  if (found.length !== 1) throw new Error(found.length ? `"${id}" matches ${found.length} traces` : `no trace starts with "${id}"`);
  return found[0];
}

const usd = (n: number) => `$${n.toFixed(6)}`;
const oneLine = (text: string, width: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
};

function row(r: RequestLog) {
  const head = [
    local(r.ts).label,
    r.trace_id.slice(0, 8),
    `${r.user.id} (${r.user.role})`.padEnd(22),
    r.input.type.padEnd(11),
    r.prompt_version,
    usd(r.totals.cost_usd),
    `${(r.totals.latency_ms / 1000).toFixed(1)}s`,
    r.status === "ok" ? "" : "ERROR",
  ];
  console.log(`\n${head.join("  ")}`);
  console.log(`    Q   ${oneLine(r.input.question, 110)}`);
  console.log(`    A   ${r.output ? oneLine(r.output.answer, 110) : `(no answer) ${r.error ?? ""}`}`);
  console.log(`    ctx ${r.retrieval.context.map((c) => `[${c.n}] ${c.label}`).join("  ")}`);
}

function counts(records: RequestLog[], key: (r: RequestLog) => string) {
  const tally = new Map<string, number>();
  for (const r of records) tally.set(key(r), (tally.get(key(r)) ?? 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ");
}

/** The spans that carry a stage's own time: no parent, or a parent in another stage. */
function stageRoots(trace: RequestLog): Span[] {
  const stageOf = new Map(trace.spans.map((s) => [s.span_id, s.stage]));
  return trace.spans.filter((s) => !s.parent_id || stageOf.get(s.parent_id) !== s.stage);
}

const STAGES: Stage[] = ["retrieval", "generation", "tools"];

function costTable(trace: RequestLog): string {
  const roots = stageRoots(trace);
  const lines = [
    `| Stage | Spans | Latency | Tokens in / out | Cost | Share |`,
    `|---|---|---|---|---|---|`,
  ];
  for (const stage of STAGES) {
    const spans = trace.spans.filter((s) => s.stage === stage);
    const ms = roots.filter((s) => s.stage === stage).reduce((t, s) => t + s.duration_ms, 0);
    const tokensIn = spans.reduce((t, s) => t + (s.tokens?.input ?? 0), 0);
    const tokensOut = spans.reduce((t, s) => t + (s.tokens?.output ?? 0), 0);
    const cost = trace.totals.cost_by_stage[stage];
    const share = trace.totals.cost_usd ? `${((cost / trace.totals.cost_usd) * 100).toFixed(1)}%` : "–";
    lines.push(
      `| ${stage} | ${spans.length ? spans.map((s) => s.name).join(", ") : "none called"} | ${ms} ms | ${tokensIn} / ${tokensOut} | ${usd(cost)} | ${share} |`,
    );
  }
  lines.push(`| **total** | ${trace.spans.length} | ${trace.totals.latency_ms} ms wall | ${trace.totals.tokens_in} / ${trace.totals.tokens_out} | **${usd(trace.totals.cost_usd)}** | 100% |`);
  return lines.join("\n");
}

function spanTree(trace: RequestLog) {
  const children = new Map<string | null, Span[]>();
  for (const s of trace.spans) children.set(s.parent_id, [...(children.get(s.parent_id) ?? []), s]);

  const walk = (parent: string | null, depth: number) => {
    for (const s of (children.get(parent) ?? []).sort((a, b) => a.start_ms - b.start_ms)) {
      const tokens = s.tokens ? `${s.tokens.input} in / ${s.tokens.output} out${s.tokens.estimated ? " (est)" : ""}` : "";
      const notes = Object.entries(s.attributes)
        .filter(([key]) => ["cache", "queue_ms", "attempts", "throttled", "returned", "scope", "found"].includes(key))
        .map(([key, v]) => `${key}=${v}`)
        .join(" ");
      console.log(
        `  ${`${"  ".repeat(depth)}${s.name}`.padEnd(30)} ${s.stage.padEnd(10)} +${String(s.start_ms).padStart(5)}ms ${String(s.duration_ms).padStart(6)}ms  ${tokens.padEnd(20)} ${usd(s.cost_usd)}  ${s.status === "ok" ? "" : `ERROR ${s.error}`}${notes}`,
      );
      walk(s.span_id, depth + 1);
    }
  };
  walk(null, 0);
}

const records = load();

switch (command) {
  case "find": {
    const matched = filter(records);
    const limit = Number(value("limit") ?? 50);
    matched.slice(-limit).forEach(row);
    console.log(`\n${matched.length} of ${records.length} requests matched${matched.length > limit ? ` (showing the last ${limit})` : ""}`);
    break;
  }

  case "slices": {
    const matched = filter(records);
    const costs = matched.map((r) => r.totals.cost_usd);
    const latencies = matched.map((r) => r.totals.latency_ms);
    console.log(`\n${matched.length} requests, ${matched[0] ? local(matched[0].ts).full : "-"} → ${matched.at(-1) ? local(matched.at(-1)!.ts).full : "-"}\n`);
    console.log(`  day      ${counts(matched, (r) => `${local(r.ts).weekday} ${local(r.ts).date.slice(5)}`)}`);
    console.log(`  role     ${counts(matched, (r) => r.user.role)}`);
    console.log(`  user     ${counts(matched, (r) => r.user.id)}`);
    console.log(`  type     ${counts(matched, (r) => r.input.type)}`);
    console.log(`  prompt   ${counts(matched, (r) => r.prompt_version)}`);
    console.log(`  status   ${counts(matched, (r) => r.status)}`);
    // The canary watches these two between versions: a fix that makes the app
    // refuse more is not a fix, and the cache is where the cost cut comes from.
    const refused = matched.filter((r) => r.output?.refused).length;
    const hits = matched.filter((r) => r.spans.some((s) => s.name === "generation.answer" && s.attributes.cache === "hit")).length;
    console.log(`  refused  ${refused}/${matched.length} (${Math.round((refused / (matched.length || 1)) * 100)}%) · answer cache hits ${hits}/${matched.length}`);
    console.log(`  cost     median ${usd(median(costs))} · p95 ${usd(percentile(costs, 95))} · max ${usd(Math.max(...costs, 0))} · outliers (>2x median) ${costs.filter((c) => c > 2 * median(costs)).length}`);
    // Busiest windows, for the 10x question: a rate limit is per minute, not per day.
    const times = matched.map((r) => new Date(r.ts).getTime());
    const busiest = (windowMs: number) => {
      let best = 0;
      for (let i = 0, j = 0; i < times.length; i++) {
        while (times[i] - times[j] >= windowMs) j++;
        best = Math.max(best, i - j + 1);
      }
      return best;
    };
    console.log(`  peak     ${busiest(60_000)} in any minute · ${busiest(3_600_000)} in any hour`);
    console.log(`  latency  median ${median(latencies)} ms · p95 ${percentile(latencies, 95)} ms · max ${Math.max(...latencies, 0)} ms`);
    // Latency minus time queued behind the rate limiter: what the request costs
    // when nobody else is asking. The gap between the two is load, not code.
    const service = matched.map((r) => r.totals.latency_ms - r.totals.queue_ms);
    const queued = matched.map((r) => r.totals.queue_ms);
    console.log(`  service  median ${median(service)} ms · p95 ${percentile(service, 95)} ms   (latency minus rate-limit queue)`);
    console.log(`  queued   median ${median(queued)} ms · p95 ${percentile(queued, 95)} ms · requests that queued ${queued.filter((q) => q > 100).length}/${matched.length} · throttled ${matched.filter((r) => r.spans.some((s) => Number(s.attributes.throttled ?? 0) > 0)).length}`);
    break;
  }

  case "show": {
    const r = byId(records, positional[0]);
    console.log(`\ntrace     ${r.trace_id}`);
    console.log(`time      ${local(r.ts).full}${r.clock ? `  (clock: ${r.clock})` : ""}`);
    console.log(`user      ${r.user.id} (${r.user.role}) · channel ${r.channel} · status ${r.status}${r.error ? ` — ${r.error}` : ""}`);
    console.log(`question  ${r.input.question}`);
    console.log(`type      ${r.input.type} · contracts named: ${r.input.contracts.join(", ") || "none"}`);
    console.log(`prompt    ${r.prompt_version} · ${r.model} · embeddings ${r.embedding_model} · ${r.retrieval.mode} top-${r.retrieval.top_k}`);
    console.log(`context`);
    for (const c of r.retrieval.context) {
      console.log(`  [${c.n}] chunk #${String(c.chunk_id).padEnd(4)} ${c.label.padEnd(18)} ${c.section.padEnd(28)} via ${c.via}${c.vector_rank || c.keyword_rank ? ` (vector rank ${c.vector_rank ?? "-"}, keyword rank ${c.keyword_rank ?? "-"})` : ""}`);
    }
    console.log(`answer    ${r.output?.answer.replace(/\n/g, "\n          ") ?? "(none)"}`);
    console.log(`cited     ${r.output?.cited_excerpts.map((n) => `[${n}]`).join(" ") || "nothing"}${r.output?.refused ? " · refused" : ""}`);
    console.log(`spans`);
    spanTree(r);
    const t = r.totals;
    console.log(`totals    ${t.latency_ms} ms (queued ${t.queue_ms} ms) · ${t.tokens_in} in / ${t.tokens_out} out · ${usd(t.cost_usd)} = retrieval ${usd(t.cost_by_stage.retrieval)} + generation ${usd(t.cost_by_stage.generation)} + tools ${usd(t.cost_by_stage.tools)}\n`);
    break;
  }

  case "export": {
    const r = byId(records, positional[0]);
    const file = positional[1] ?? "week11/trace.json";
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
    console.log(`wrote ${file} (trace ${r.trace_id})`);
    break;
  }

  case "cost": {
    if (positional[0]) {
      const r = byId(records, positional[0]);
      console.log(`\nCost of trace ${r.trace_id} · ${local(r.ts).full} · ${r.prompt_version}\n`);
      console.log(costTable(r));
      console.log();
      break;
    }

    const matched = filter(records).filter((r) => r.status === "ok");
    const mean = (pick: (r: RequestLog) => number) => matched.reduce((t, r) => t + pick(r), 0) / (matched.length || 1);
    const total = mean((r) => r.totals.cost_usd);
    console.log(`\nMean cost per query over ${matched.length} requests\n`);
    console.log(`| Stage | Mean cost / query | Share | Mean latency | Per 1,000 queries |`);
    console.log(`|---|---|---|---|---|`);
    for (const stage of STAGES) {
      const cost = mean((r) => r.totals.cost_by_stage[stage]);
      const ms = mean((r) => stageRoots(r).filter((s) => s.stage === stage).reduce((t, s) => t + s.duration_ms, 0));
      console.log(`| ${stage} | ${usd(cost)} | ${total ? ((cost / total) * 100).toFixed(1) : "0.0"}% | ${Math.round(ms)} ms | $${(cost * 1000).toFixed(4)} |`);
    }
    const costs = matched.map((r) => r.totals.cost_usd);
    console.log(`| **total** | **${usd(total)}** | 100% | ${Math.round(mean((r) => r.totals.latency_ms))} ms | **$${(total * 1000).toFixed(4)}** |`);
    console.log(`\np50 ${usd(median(costs))} · p95 ${usd(percentile(costs, 95))} · max ${usd(Math.max(...costs, 0))}\n`);
    break;
  }

  case "to-case": {
    const r = byId(records, positional[0]);
    const id = value("id") ?? "T__";
    const slug = r.input.question.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/-$/, "");
    const file = path.join(process.cwd(), "evals", "cases", `${id}-${slug}.json`);
    const draft = {
      id,
      type: "TODO: a problem type from lib/test-set.ts",
      question: r.input.question,
      gold: [{ source: "TODO", section: "TODO" }],
      answerMustInclude: ["TODO: the fact a correct answer states"],
      citeGold: true,
      regression: true,
      fromTrace: r.trace_id,
      note: "TODO: what went wrong, in one sentence",
      observed: {
        ts: r.ts,
        user: r.user,
        prompt_version: r.prompt_version,
        context: r.retrieval.context.map((c) => `[${c.n}] ${c.label}`),
        answer: r.output?.answer ?? null,
      },
    };
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(draft, null, 2)}\n`);
    console.log(`drafted ${path.relative(process.cwd(), file)} — fill in the TODOs; a human decides what correct is.`);
    break;
  }

  default:
    console.error(`Unknown command "${command}". Commands: find, slices, show, export, cost, to-case.`);
    process.exit(1);
}
