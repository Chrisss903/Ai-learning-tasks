/**
 * Agent vs fixed workflow, on the same questions, with the same tools and model:
 *
 *   npm run race                      every case, once each
 *   npm run race -- --only M01,T07    a subset
 *   npm run race -- --repeat 2        run each case twice, to measure consistency
 *   npm run race -- --label v2        save as evals/race-v2.json
 */
import "./env.mts";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";

const { runAgent } = await import("../lib/agent");
const { runWorkflow } = await import("../lib/workflow");
const { checkAnswer } = await import("../lib/assertions");
const { RACE_SET } = await import("../lib/race-set");
const { resolveGenerator } = await import("../lib/generator");

type Contender = "workflow" | "agent";

const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const only = value("only")?.split(",").map((id) => id.trim().toUpperCase());
const repeat = Number(value("repeat") ?? 1);
const label = value("label") ?? "run";
const cases = only ? RACE_SET.filter((c) => only.includes(c.id)) : RACE_SET;

// Free-tier calls cost nothing, so dollars are priced at the paid list rate.
// Overridable, because rates change and differ by model.
const PRICE_IN = Number(process.env.LLM_PRICE_IN_PER_M ?? 0.5);
const PRICE_OUT = Number(process.env.LLM_PRICE_OUT_PER_M ?? 3.0);
const dollars = (input: number, output: number) => (input * PRICE_IN + output * PRICE_OUT) / 1e6;

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
  activeMs: number;
  wallMs: number;
  steps: unknown[];
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
    const run = contender === "agent" ? await runAgent(testCase.question) : await runWorkflow(testCase.question);
    const stopReason = "stopReason" in run ? run.stopReason : "finished";
    const checks = run.answer ? checkAnswer(testCase, run.answer) : [];
    const cited = run.answer ? /\[[A-Z]{2,4}[A-Z0-9-]*\s*§\s*\d+\]/.test(run.answer) : false;

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
      wallMs: run.wallMs,
      steps: run.steps,
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
      wallMs: 0,
      steps: [],
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

console.log(`\nAgent vs fixed workflow · ${resolveGenerator().label}`);
console.log(`  cases ${cases.length} × ${repeat} · priced at $${PRICE_IN}/M in, $${PRICE_OUT}/M out\n`);

const results: Result[] = [];

for (let attempt = 1; attempt <= repeat; attempt++) {
  for (const testCase of cases) {
    for (const contender of ["workflow", "agent"] as Contender[]) {
      const result = await race(contender, testCase, attempt);
      results.push(result);

      console.log(
        `  ${result.passed ? "PASS" : "FAIL"}  ${testCase.id}  ${contender.padEnd(8)}  ` +
          `${String(result.llmCalls).padStart(2)} calls  ${String(result.inputTokens + result.outputTokens).padStart(6)} tok  ` +
          `${secs(result.activeMs).padStart(6)}  ${result.stopReason === "finished" ? "" : result.stopReason}`,
      );
      if (!result.passed) console.log(`         ↳ ${result.failures.join("; ")}`);
    }
  }
}

function summarise(subset: Result[]) {
  const passed = subset.filter((r) => r.passed).length;
  const finished = subset.filter((r) => r.stopReason === "finished").length;
  return {
    runs: subset.length,
    passed,
    passRate: subset.length ? passed / subset.length : 0,
    finishedRate: subset.length ? finished / subset.length : 0,
    meanCalls: mean(subset.map((r) => r.llmCalls)),
    meanTokens: mean(subset.map((r) => r.inputTokens + r.outputTokens)),
    meanCost: mean(subset.map((r) => r.cost)),
    meanActiveMs: mean(subset.map((r) => r.activeMs)),
    p95ActiveMs: percentile(subset.map((r) => r.activeMs), 95),
    meanWallMs: mean(subset.map((r) => r.wallMs)),
  };
}

const groups = ["all", "single-clause", "multi-step"] as const;
const summary: Record<string, Record<Contender, ReturnType<typeof summarise>>> = {};

for (const group of groups) {
  const inGroup = results.filter((r) => group === "all" || r.group === group);
  if (!inGroup.length) continue;
  summary[group] = {
    workflow: summarise(inGroup.filter((r) => r.contender === "workflow")),
    agent: summarise(inGroup.filter((r) => r.contender === "agent")),
  };
}

for (const [group, both] of Object.entries(summary)) {
  console.log(`\n  ${group}`);
  console.log(`  ${"".padEnd(10)} ${"passed".padEnd(12)} ${"calls".padEnd(7)} ${"tokens".padEnd(8)} ${"$/question".padEnd(12)} ${"mean time".padEnd(10)} p95 time`);
  for (const contender of ["workflow", "agent"] as Contender[]) {
    const s = both[contender];
    console.log(
      `  ${contender.padEnd(10)} ${`${s.passed}/${s.runs} ${pct(s.passed, s.runs)}`.padEnd(12)} ${s.meanCalls.toFixed(1).padEnd(7)} ` +
        `${Math.round(s.meanTokens).toString().padEnd(8)} ${`$${s.meanCost.toFixed(5)}`.padEnd(12)} ${secs(s.meanActiveMs).padEnd(10)} ${secs(s.p95ActiveMs)}`,
    );
  }
}

const agentStops: Record<string, number> = {};
for (const r of results.filter((r) => r.contender === "agent")) {
  agentStops[r.stopReason] = (agentStops[r.stopReason] ?? 0) + 1;
}
console.log(`\n  agent stop reasons: ${Object.entries(agentStops).map(([k, v]) => `${k} ${v}`).join(", ")}`);

// With repeats, a case is consistent when every attempt got the same verdict.
let consistency: Record<Contender, string> | null = null;
if (repeat > 1) {
  consistency = { workflow: "", agent: "" };
  for (const contender of ["workflow", "agent"] as Contender[]) {
    const stable = cases.filter((c) => {
      const verdicts = results.filter((r) => r.caseId === c.id && r.contender === contender).map((r) => r.passed);
      return verdicts.every((v) => v === verdicts[0]);
    }).length;
    consistency[contender] = `${stable}/${cases.length}`;
  }
  console.log(`  same verdict on every attempt: workflow ${consistency.workflow}, agent ${consistency.agent}`);
}

mkdirSync(path.join(process.cwd(), "evals"), { recursive: true });
const outfile = path.join(process.cwd(), "evals", `race-${label}.json`);
writeFileSync(
  outfile,
  JSON.stringify(
    {
      label,
      ranAt: new Date().toISOString(),
      generator: resolveGenerator().label,
      pricing: { inputPerMillion: PRICE_IN, outputPerMillion: PRICE_OUT },
      repeat,
      summary,
      agentStops,
      consistency,
      results,
    },
    null,
    2,
  ),
);
console.log(`\n  saved → evals/${path.basename(outfile)}\n`);
