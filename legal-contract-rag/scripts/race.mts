/**
 * Contenders race on the same questions, with the same tools and model:
 *
 *   npm run race                                week 7: fixed workflow vs agent
 *   npm run race -- --contenders agent,squad    week 10: single agent vs squad
 *   npm run race -- --contenders lean           week 10 control: the single agent, lean prompt
 *   npm run race -- --only M01,T07              a subset
 *   npm run race -- --repeat 2                  run each case twice, to measure consistency
 *   npm run race -- --label v2                  save as evals/race-v2.json
 *   npm run race -- --label v2 --resume         keep what that file already scored; run the rest
 */
import "./env.mts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

const { LEAN_AGENT, runAgent } = await import("../lib/agent");
const { closeTools, discoverTools } = await import("../lib/mcp-client");
const { runWorkflow } = await import("../lib/workflow");
const { runSquad, SPECIALISTS } = await import("../lib/squad");
const { checkAnswer } = await import("../lib/assertions");
const { RACE_SET } = await import("../lib/race-set");
const { resolveGenerator } = await import("../lib/generator");

const CONTENDERS = ["workflow", "agent", "squad", "lean"] as const;
type Contender = (typeof CONTENDERS)[number];

const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const only = value("only")?.split(",").map((id) => id.trim().toUpperCase());
const repeat = Number(value("repeat") ?? 1);
const label = value("label") ?? "run";
const cases = only ? RACE_SET.filter((c) => only.includes(c.id)) : RACE_SET;
const contenders = (value("contenders") ?? "workflow,agent").split(",").map((name) => name.trim()) as Contender[];

const unknown = contenders.filter((name) => !CONTENDERS.includes(name));
if (unknown.length) {
  console.error(`Unknown contender(s): ${unknown.join(", ")}. Choose from ${CONTENDERS.join(", ")}.`);
  process.exit(1);
}

// Free-tier calls cost nothing, so dollars are priced at the paid list rate.
// Overridable, because rates change and differ by model.
const PRICE_IN = Number(process.env.LLM_PRICE_IN_PER_M ?? 0.5);
const PRICE_OUT = Number(process.env.LLM_PRICE_OUT_PER_M ?? 3.0);
const dollars = (input: number, output: number) => (input * PRICE_IN + output * PRICE_OUT) / 1e6;

type RoleUsage = Record<string, { calls: number; inputTokens: number; outputTokens: number }>;

interface Result {
  caseId: string;
  type: string;
  group: "single-clause" | "multi-step";
  contender: Contender;
  attempt: number;
  answer: string | null;
  passed: boolean;
  failures: string[];
  stopReason: string;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** Time on the critical path, excluding throttle waits. */
  activeMs: number;
  /** Model and tool time summed; above activeMs only when work overlapped. */
  busyMs: number;
  /** Clock time, free-tier throttle waits included. */
  wallMs: number;
  byRole: RoleUsage | null;
  steps: unknown[];
  squad: unknown;
}

async function race(contender: Contender, testCase: (typeof cases)[number], attempt: number): Promise<Result> {
  const base = {
    caseId: testCase.id,
    type: testCase.type,
    group: testCase.type === "multi-step" ? ("multi-step" as const) : ("single-clause" as const),
    contender,
    attempt,
  };

  try {
    const run =
      contender === "agent"
        ? await runAgent(testCase.question)
        : contender === "lean"
          ? await runAgent(testCase.question, { role: LEAN_AGENT })
          : contender === "squad"
            ? await runSquad(testCase.question)
            : await runWorkflow(testCase.question);
    const stopReason = "stopReason" in run ? run.stopReason : "finished";
    const checks = run.answer ? checkAnswer(testCase, run.answer) : [];
    // Week 10: "[SA-2026-001 §5, AMD-2026-001 §2]" is two citations in one
    // bracket, and the week 7 pattern, which wanted "]" straight after the
    // number, failed it.
    const cited = run.answer ? /\[[A-Z]{2,4}[A-Z0-9-]*\s*§\s*\d+\s*[\],;]/.test(run.answer) : false;

    const failures = [
      ...(run.answer ? [] : [`no answer (${stopReason})`]),
      ...checks.filter((check) => !check.passed).map((check) => `${check.name}: ${check.detail}`),
      ...(run.answer && !testCase.expectRefusal && !cited ? ["no [ID §N] citation"] : []),
    ];

    return {
      ...base,
      answer: run.answer,
      passed: failures.length === 0,
      failures,
      stopReason,
      llmCalls: run.llmCalls,
      inputTokens: run.usage.inputTokens,
      outputTokens: run.usage.outputTokens,
      cost: dollars(run.usage.inputTokens, run.usage.outputTokens),
      activeMs: run.activeMs,
      busyMs: "busyMs" in run ? run.busyMs : run.activeMs,
      wallMs: run.wallMs,
      byRole: "byRole" in run ? run.byRole : null,
      steps: "steps" in run ? run.steps : [],
      squad: "tasks" in run ? { thought: run.thought, manager: run.manager, tasks: run.tasks } : null,
    };
  } catch (error) {
    return {
      ...base,
      answer: null,
      passed: false,
      failures: [`error: ${error instanceof Error ? error.message : String(error)}`],
      stopReason: "error",
      llmCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      activeMs: 0,
      busyMs: 0,
      wallMs: 0,
      byRole: null,
      steps: [],
      squad: null,
    };
  }
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "n/a");
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * An errored run is the provider failing, not the contender, so it is left out
 * of every number and counted on its own; --resume runs it again.
 */
function summarise(subset: Result[]) {
  const errors = subset.filter((r) => r.stopReason === "error").length;
  const scored = subset.filter((r) => r.stopReason !== "error");
  const passed = scored.filter((r) => r.passed).length;
  const finished = scored.filter((r) => r.stopReason === "finished").length;

  const roles = [...new Set(scored.flatMap((r) => Object.keys(r.byRole ?? {})))];
  const meanByRole = Object.fromEntries(
    roles.map((role) => [
      role,
      {
        calls: mean(scored.map((r) => r.byRole?.[role]?.calls ?? 0)),
        tokens: mean(scored.map((r) => (r.byRole?.[role]?.inputTokens ?? 0) + (r.byRole?.[role]?.outputTokens ?? 0))),
      },
    ]),
  );

  return {
    runs: scored.length,
    errors,
    passed,
    passRate: scored.length ? passed / scored.length : 0,
    finishedRate: scored.length ? finished / scored.length : 0,
    meanCalls: mean(scored.map((r) => r.llmCalls)),
    meanInputTokens: mean(scored.map((r) => r.inputTokens)),
    meanOutputTokens: mean(scored.map((r) => r.outputTokens)),
    meanTokens: mean(scored.map((r) => r.inputTokens + r.outputTokens)),
    meanCost: mean(scored.map((r) => r.cost)),
    meanActiveMs: mean(scored.map((r) => r.activeMs)),
    p95ActiveMs: percentile(scored.map((r) => r.activeMs), 95),
    meanBusyMs: mean(scored.map((r) => r.busyMs)),
    meanWallMs: mean(scored.map((r) => r.wallMs)),
    meanByRole: roles.length ? meanByRole : null,
  };
}

const groups = ["all", "single-clause", "multi-step"] as const;

function summariseAll(results: Result[]) {
  const summary: Record<string, Partial<Record<Contender, ReturnType<typeof summarise>>>> = {};
  for (const group of groups) {
    const inGroup = results.filter((r) => group === "all" || r.group === group);
    if (!inGroup.length) continue;
    summary[group] = Object.fromEntries(
      contenders.map((contender) => [contender, summarise(inGroup.filter((r) => r.contender === contender))]),
    );
  }
  return summary;
}

const usesTools = contenders.some((contender) => contender !== "workflow");
const tools = usesTools ? (await discoverTools()).map((tool) => `${tool.server}/${tool.name}`) : [];

const outfile = path.join(process.cwd(), "evals", `race-${label}.json`);
const key = (r: Pick<Result, "caseId" | "contender" | "attempt">) => `${r.caseId}|${r.contender}|${r.attempt}`;

// A full race is a long chain of free-tier calls; --resume keeps what already
// scored and runs only what is missing or errored.
const previous: Result[] =
  args.includes("--resume") && existsSync(outfile)
    ? (JSON.parse(readFileSync(outfile, "utf-8")).results as Result[]).filter((r) => r.stopReason !== "error")
    : [];
const done = new Set(previous.map(key));

function save(results: Result[]) {
  mkdirSync(path.dirname(outfile), { recursive: true });
  writeFileSync(
    outfile,
    JSON.stringify(
      {
        label,
        ranAt: new Date().toISOString(),
        generator: resolveGenerator().label,
        pricing: { inputPerMillion: PRICE_IN, outputPerMillion: PRICE_OUT },
        contenders,
        repeat,
        tools,
        cards: contenders.includes("squad") ? SPECIALISTS.map((specialist) => specialist.card) : undefined,
        summary: summariseAll(results),
        consistency: consistencyOf(results),
        results,
      },
      null,
      2,
    ),
  );
}

/** With repeats, a case is consistent when every attempt got the same verdict. */
function consistencyOf(results: Result[]) {
  if (repeat <= 1) return null;
  return Object.fromEntries(
    contenders.map((contender) => {
      const stable = cases.filter((c) => {
        const verdicts = results.filter((r) => r.caseId === c.id && r.contender === contender).map((r) => r.passed);
        return verdicts.every((v) => v === verdicts[0]);
      }).length;
      return [contender, `${stable}/${cases.length}`];
    }),
  );
}

console.log(`\n${contenders.join(" vs ")} · ${resolveGenerator().label}`);
console.log(`  cases ${cases.length} × ${repeat} · priced at $${PRICE_IN}/M in, $${PRICE_OUT}/M out`);
if (tools.length) console.log(`  tools ${tools.length}: ${tools.join(", ")}`);
if (previous.length) console.log(`  resuming: ${previous.length} run(s) already scored in ${path.basename(outfile)}`);
console.log();

const results: Result[] = [...previous];

for (let attempt = 1; attempt <= repeat; attempt++) {
  for (const testCase of cases) {
    // Contenders take turns on each case, so a slow hour at the provider
    // lands on both rather than on whichever ran later.
    for (const contender of contenders) {
      if (done.has(key({ caseId: testCase.id, contender, attempt }))) continue;

      const result = await race(contender, testCase, attempt);
      results.push(result);
      save(results);

      console.log(
        `  ${result.passed ? "PASS" : "FAIL"}  ${testCase.id}  ${contender.padEnd(8)}  ` +
          `${String(result.llmCalls).padStart(2)} calls  ${String(result.inputTokens + result.outputTokens).padStart(6)} tok  ` +
          `${secs(result.activeMs).padStart(6)}  ${result.stopReason === "finished" ? "" : result.stopReason}`,
      );
      if (!result.passed) console.log(`         ↳ ${result.failures.join("; ")}`);
    }
  }
}

const summary = summariseAll(results);

for (const [group, byContender] of Object.entries(summary)) {
  console.log(`\n  ${group}`);
  console.log(
    `  ${"".padEnd(10)} ${"passed".padEnd(12)} ${"calls".padEnd(7)} ${"tokens".padEnd(8)} ${"$/question".padEnd(12)} ` +
      `${"mean time".padEnd(10)} ${"p95 time".padEnd(10)} wall`,
  );
  for (const contender of contenders) {
    const s = byContender[contender]!;
    console.log(
      `  ${contender.padEnd(10)} ${`${s.passed}/${s.runs} ${pct(s.passed, s.runs)}`.padEnd(12)} ${s.meanCalls.toFixed(1).padEnd(7)} ` +
        `${Math.round(s.meanTokens).toString().padEnd(8)} ${`$${s.meanCost.toFixed(5)}`.padEnd(12)} ` +
        `${secs(s.meanActiveMs).padEnd(10)} ${secs(s.p95ActiveMs).padEnd(10)} ${secs(s.meanWallMs)}`,
    );
  }
}

for (const contender of contenders) {
  const s = summary.all?.[contender];
  if (!s?.meanByRole) continue;
  const roles = Object.entries(s.meanByRole).map(
    ([role, use]) => `${role} ${use.calls.toFixed(1)} calls / ${Math.round(use.tokens)} tok`,
  );
  console.log(`\n  ${contender} per question, by member: ${roles.join(" · ")}`);
}

for (const contender of contenders.filter((c) => c !== "workflow")) {
  const stops: Record<string, number> = {};
  for (const r of results.filter((r) => r.contender === contender)) stops[r.stopReason] = (stops[r.stopReason] ?? 0) + 1;
  console.log(`  ${contender} stop reasons: ${Object.entries(stops).map(([k, v]) => `${k} ${v}`).join(", ")}`);
}

// Two contenders: where did they disagree? The blended pass rate hides it.
if (contenders.length === 2) {
  const [a, b] = contenders;
  const passRate = (contender: Contender, caseId: string) => {
    const runs = results.filter((r) => r.contender === contender && r.caseId === caseId && r.stopReason !== "error");
    return runs.length ? runs.filter((r) => r.passed).length / runs.length : null;
  };
  const split = cases
    .map((c) => ({ id: c.id, a: passRate(a, c.id), b: passRate(b, c.id) }))
    .filter((c) => c.a !== null && c.b !== null && c.a !== c.b);
  console.log(
    `\n  cases where ${a} and ${b} differ: ${split.length ? split.map((c) => `${c.id} (${a} ${pct(c.a!, 1)}, ${b} ${pct(c.b!, 1)})`).join(", ") : "none"}`,
  );
}

const consistency = consistencyOf(results);
if (consistency) {
  console.log(`  same verdict on every attempt: ${Object.entries(consistency).map(([k, v]) => `${k} ${v}`).join(", ")}`);
}

const errors = results.filter((r) => r.stopReason === "error").length;
if (errors) {
  console.log(`\n  ${errors} run(s) errored at the provider and are left out of the numbers above.`);
  console.log(`  Run again with --label ${label} --resume before quoting them.`);
}

save(results);
console.log(`\n  saved → evals/${path.basename(outfile)}\n`);

// The MCP servers are child processes; the script cannot exit while they run.
await closeTools();
