/**
 * Week 8: score the agent's path, not just its answer.
 *
 *   npm run trajectory                     baseline — no defences
 *   npm run trajectory -- --defended       with the week 8 gates on
 *   npm run trajectory -- --only T07,M01   a subset
 *   npm run trajectory -- --label after    saves evals/trajectory-after.json
 */
import "./env.mts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

const { runAgent } = await import("../lib/agent");
const { ALL_DEFENCES, NO_DEFENCES } = await import("../lib/defences");
const { checkAnswer } = await import("../lib/assertions");
const { RACE_SET } = await import("../lib/race-set");
const { TRAJECTORY_BATCH } = await import("../lib/trajectory-set");
const { scoreTrajectory, toolChoiceAccuracy } = await import("../lib/trajectory");
const { resolveGenerator } = await import("../lib/generator");

const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const defended = args.includes("--defended");
const only = value("only")?.split(",").map((id) => id.trim().toUpperCase());
const label = value("label") ?? (defended ? "defended" : "baseline");
const defences = defended ? ALL_DEFENCES : NO_DEFENCES;

interface Result {
  caseId: string;
  type: string;
  question: string;
  answer: string | null;
  outcomePassed: boolean;
  trajectoryPassed: boolean;
  gap: boolean;
  outcomeFailures: string[];
  trajectoryFailures: string[];
  toolChoiceAccuracy: number | null;
  stopReason: string;
  steps: unknown[];
  path: string;
  llmCalls: number;
  tokens: number;
  cost: number;
  activeMs: number;
  gateRejections: string[];
  redactions: string[];
}

let batch = TRAJECTORY_BATCH.filter((e) => !only || only.includes(e.caseId));

// A batch is a long chain of network calls; --resume keeps the cases that
// already ran rather than paying for them again.
const outfile = path.join(process.cwd(), "evals", `trajectory-${label}.json`);
const previous: Result[] =
  args.includes("--resume") && existsSync(outfile)
    ? JSON.parse(readFileSync(outfile, "utf-8")).results
    : [];

if (previous.length) {
  const done = new Set(previous.map((r) => r.caseId));
  batch = batch.filter((e) => !done.has(e.caseId));
  console.log(`\n  resuming: ${previous.length} case(s) already scored`);
}

function save(current: Result[]) {
  mkdirSync(path.join(process.cwd(), "evals"), { recursive: true });
  writeFileSync(
    outfile,
    JSON.stringify(
      {
        label,
        ranAt: new Date().toISOString(),
        generator: resolveGenerator().label,
        defences,
        summary: summarise(current),
        results: current,
      },
      null,
      2,
    ),
  );
}

function summarise(current: Result[]) {
  const failureCounts: Record<string, number> = {};
  for (const result of current) {
    for (const failure of result.trajectoryFailures) {
      const name = failure.split(":")[0];
      failureCounts[name] = (failureCounts[name] ?? 0) + 1;
    }
  }

  const costs = current.map((r) => r.cost).sort((a, b) => a - b);

  return {
    total: current.length,
    outcomePassed: current.filter((r) => r.outcomePassed).length,
    trajectoryPassed: current.filter((r) => r.trajectoryPassed).length,
    gaps: current.filter((r) => r.gap).map((r) => r.caseId),
    failureCounts,
    meanCost: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 0,
    p99Cost: costs[Math.min(costs.length - 1, Math.ceil(0.99 * costs.length) - 1)] ?? 0,
  };
}

console.log(`\nTrajectory eval · ${resolveGenerator().label} · defences ${defended ? "ON" : "OFF"}`);
console.log(`  ${batch.length} cases\n`);

const results: Result[] = [...previous];

for (const expectation of batch) {
  const testCase = RACE_SET.find((c) => c.id === expectation.caseId);
  if (!testCase) throw new Error(`No case ${expectation.caseId} in the race set`);

  let run;
  try {
    run = await runAgent(testCase.question, { defences });
  } catch (error) {
    // One case dying must not throw away the cases that already ran.
    console.log(`  ${testCase.id}  ERROR  ${error instanceof Error ? error.message : error}`);
    save(results);
    continue;
  }

  const outcomeChecks = run.answer ? checkAnswer(testCase, run.answer) : [];
  const outcomePassed = Boolean(run.answer) && outcomeChecks.every((check) => check.passed);

  const trajectoryChecks = scoreTrajectory(run, expectation);
  const trajectoryPassed = trajectoryChecks.every((check) => check.passed);

  const gap = outcomePassed && !trajectoryPassed;

  results.push({
    caseId: testCase.id,
    type: testCase.type,
    question: testCase.question,
    answer: run.answer,
    outcomePassed,
    trajectoryPassed,
    gap,
    outcomeFailures: outcomeChecks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`),
    trajectoryFailures: trajectoryChecks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`),
    toolChoiceAccuracy: toolChoiceAccuracy(run),
    stopReason: run.stopReason,
    steps: run.steps.map((step) => ({
      step: step.step,
      action: step.action,
      input: step.input,
      thought: step.thought,
      observation: step.observation,
      redactions: step.redactions,
    })),
    path: run.steps.map((step) => step.action).join(" → "),
    llmCalls: run.llmCalls,
    tokens: run.usage.inputTokens + run.usage.outputTokens,
    cost: (run.usage.inputTokens * 0.5 + run.usage.outputTokens * 3) / 1e6,
    activeMs: run.activeMs,
    gateRejections: run.gateRejections,
    redactions: run.redactions,
  });

  const verdict = `${outcomePassed ? "answer OK " : "answer BAD"}  ${trajectoryPassed ? "path OK " : "path BAD"}`;
  console.log(`  ${testCase.id}  ${verdict}${gap ? "  ← GAP" : ""}`);
  console.log(`        ${results.at(-1)!.path}`);
  for (const failure of results.at(-1)!.trajectoryFailures) console.log(`        ↳ path: ${failure}`);
  for (const failure of results.at(-1)!.outcomeFailures) console.log(`        ↳ answer: ${failure}`);

  save(results);
}

const total = results.length;
const outcomePassed = results.filter((r) => r.outcomePassed).length;
const trajectoryPassed = results.filter((r) => r.trajectoryPassed).length;
const gaps = results.filter((r) => r.gap);

const failureCounts: Record<string, number> = {};
for (const result of results) {
  for (const failure of result.trajectoryFailures) {
    const name = failure.split(":")[0];
    failureCounts[name] = (failureCounts[name] ?? 0) + 1;
  }
}

const costs = results.map((r) => r.cost).sort((a, b) => a - b);
const p99 = costs[Math.min(costs.length - 1, Math.ceil(0.99 * costs.length) - 1)] ?? 0;
const pct = (n: number) => `${Math.round((n / total) * 100)}%`;

console.log(`\n  outcome pass    ${outcomePassed}/${total} = ${pct(outcomePassed)}`);
console.log(`  trajectory pass ${trajectoryPassed}/${total} = ${pct(trajectoryPassed)}`);
console.log(`  right answer, wrong path: ${gaps.length}/${total}${gaps.length ? ` — ${gaps.map((g) => g.caseId).join(", ")}` : ""}`);
console.log(
  `  tool-choice accuracy ${Math.round(
    (results.reduce((sum, r) => sum + (r.toolChoiceAccuracy ?? 1), 0) / total) * 100,
  )}%`,
);
console.log(
  `  cost per task: mean $${(costs.reduce((a, b) => a + b, 0) / total).toFixed(5)}, p99 $${p99.toFixed(5)}`,
);

console.log(`\n  path failures by kind`);
for (const [name, count] of Object.entries(failureCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${name.padEnd(20)} ${count}`);
}

save(results);
console.log(`\n  saved → evals/${path.basename(outfile)}\n`);
