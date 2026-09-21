/**
 * One-command evaluation: `npm run eval`
 *
 *   npm run eval                    assertions + LLM judge, hybrid retrieval
 *   npm run eval -- --no-judge      rule-based checks only, no LLM spend
 *   npm run eval -- --mode vector   score the pre-week-4 retrieval for comparison
 *   npm run eval -- --retrieval     retrieval assertions only, no answers at all
 *   npm run eval -- --validate      check the judge against the human labels
 *   npm run eval -- --label before  tag the saved run, for before/after deltas
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import path from "path";

// Loaded by hand because this runs outside Next, which normally does it.
for (const file of [".env", ".env.local"]) {
  try {
    for (const line of readFileSync(path.join(process.cwd(), file), "utf-8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // A missing env file is fine; the next one may have what is needed.
  }
}

const { searchDocuments } = await import("../lib/search");
const { generateAnswer } = await import("../lib/rag");
const { runAssertions, goldRank, looksLikeRefusal } = await import("../lib/assertions");
const { judgeAnswer, HUMAN_LABELS } = await import("../lib/judge");
const { TEST_SET, PROBLEM_TYPES } = await import("../lib/test-set");
const { resolveGenerator } = await import("../lib/generator");
const { EMBEDDING_LABEL } = await import("../lib/embeddings");

type ProblemType = keyof typeof PROBLEM_TYPES;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const mode = value("mode") === "vector" ? "vector" : "hybrid";
const retrievalOnly = flag("retrieval");
const useJudge = !flag("no-judge") && !retrievalOnly;
const label = value("label") ?? "run";

function percent(passed: number, total: number) {
  return total === 0 ? "n/a" : `${Math.round((passed / total) * 100)}%`;
}

async function validateJudge() {
  console.log("\nJudge validation — does it agree with my own grading?\n");

  let agreed = 0;
  for (const human of HUMAN_LABELS) {
    // Replay the graded answer against the clauses that produced it.
    const retrieved = await searchDocuments(human.question, 3, mode);
    const judged = await judgeAnswer(human.question, retrieved, human.answerSummary);

    const match = judged.verdict === human.verdict;
    if (match) agreed++;

    console.log(
      `  ${match ? "agree   " : "DISAGREE"}  ${human.traceId.padEnd(12)} human=${human.verdict.padEnd(11)} judge=${judged.verdict.padEnd(11)} ${match ? "" : `— judge said: ${judged.reason}`}`,
    );
  }

  const rate = agreed / HUMAN_LABELS.length;
  console.log(
    `\n  agreement: ${agreed}/${HUMAN_LABELS.length} = ${Math.round(rate * 100)}%`,
  );
  console.log(
    rate >= 0.8
      ? "  Judge agrees closely enough with human grading to quote its scores.\n"
      : "  Below 80% — do NOT quote this judge's scores until it is fixed.\n",
  );

  return { agreed, total: HUMAN_LABELS.length, rate };
}

async function main() {
  console.log(`\nLegal contract RAG — test set`);
  console.log(`  retrieval : ${mode}`);
  console.log(`  embeddings: ${EMBEDDING_LABEL}`);
  console.log(`  generator : ${retrievalOnly ? "(not called)" : resolveGenerator().label}`);
  console.log(`  cases     : ${TEST_SET.length}\n`);

  const results = [];

  for (const testCase of TEST_SET) {
    const retrieved = await searchDocuments(testCase.question, 3, mode);

    if (retrievalOnly) {
      const rank = testCase.gold.length ? goldRank(retrieved, testCase.gold) : null;
      const passed = testCase.gold.length === 0 ? true : rank !== null;

      results.push({
        ...testCase,
        retrieved,
        answer: null,
        assertions: [
          {
            name: "retrieved-gold",
            passed,
            detail: testCase.gold.length === 0 ? "no gold expected" : `rank ${rank ?? "absent"}`,
          },
        ],
        judgement: null,
        passed,
      });

      console.log(`  ${passed ? "PASS" : "FAIL"}  ${testCase.id}  ${testCase.type.padEnd(16)} ${testCase.question.slice(0, 58)}`);
      continue;
    }

    const answer = await generateAnswer(testCase.question, retrieved);
    const assertions = runAssertions(testCase, retrieved, answer);
    const judgement = useJudge
      ? await judgeAnswer(testCase.question, retrieved, answer)
      : null;

    const assertionsPassed = assertions.every((a) => a.passed);

    // The judge can only fail a case, never rescue one the rules failed.
    const judgeOk =
      !judgement ||
      (testCase.expectRefusal
        ? judgement.verdict === "refused"
        : judgement.verdict === "supported" && judgement.answersQuestion);

    const passed = assertionsPassed && judgeOk;

    results.push({ ...testCase, retrieved, answer, assertions, judgement, passed });

    const failed = assertions.filter((a) => !a.passed).map((a) => a.name);
    console.log(
      `  ${passed ? "PASS" : "FAIL"}  ${testCase.id}  ${testCase.type.padEnd(16)} ${testCase.question.slice(0, 50)}`,
    );
    if (failed.length) console.log(`         ↳ ${failed.join(", ")}`);
    if (judgement && !judgeOk) console.log(`         ↳ judge: ${judgement.verdict} — ${judgement.reason}`);
  }

  console.log("\n  Score by problem type\n");
  console.log(`  ${"problem type".padEnd(18)} ${"passed".padEnd(8)} rate`);
  console.log(`  ${"-".repeat(38)}`);

  const byType: Record<string, { passed: number; total: number }> = {};
  for (const result of results) {
    byType[result.type] ??= { passed: 0, total: 0 };
    byType[result.type].total++;
    if (result.passed) byType[result.type].passed++;
  }

  for (const [type, counts] of Object.entries(byType)) {
    console.log(
      `  ${type.padEnd(18)} ${`${counts.passed}/${counts.total}`.padEnd(8)} ${percent(counts.passed, counts.total)}`,
    );
  }

  const totalPassed = results.filter((r) => r.passed).length;
  console.log(`  ${"-".repeat(38)}`);
  console.log(
    `  ${"OVERALL".padEnd(18)} ${`${totalPassed}/${results.length}`.padEnd(8)} ${percent(totalPassed, results.length)}\n`,
  );

  const regressions = results.filter((r) => r.regression);
  console.log(
    `  Regression tests (real past failures): ${regressions.filter((r) => r.passed).length}/${regressions.length} passing\n`,
  );

  const validation = flag("validate") ? await validateJudge() : null;

  mkdirSync(path.join(process.cwd(), "evals"), { recursive: true });
  // Named by label alone, so a "before" run on one retrieval mode can be
  // compared with an "after" run on another — which is the usual case.
  const outfile = path.join(process.cwd(), "evals", `${label}.json`);
  writeFileSync(
    outfile,
    JSON.stringify(
      {
        label,
        mode,
        ranAt: new Date().toISOString(),
        embeddingModel: EMBEDDING_LABEL,
        generator: retrievalOnly ? null : resolveGenerator().label,
        judgeUsed: useJudge,
        judgeValidation: validation,
        byType,
        overall: { passed: totalPassed, total: results.length },
        results,
      },
      null,
      2,
    ),
  );
  console.log(`  saved → evals/${path.basename(outfile)}`);

  // If a counterpart run exists, print the delta straight away.
  const other = label === "after" ? "before" : "after";
  const counterpart = path.join(process.cwd(), "evals", `${other}.json`);
  if (readdirSync(path.join(process.cwd(), "evals")).includes(path.basename(counterpart))) {
    const previous = JSON.parse(readFileSync(counterpart, "utf-8"));
    console.log(`\n  Delta vs ${other} (${previous.mode} retrieval → ${mode})\n`);
    console.log(`  ${"problem type".padEnd(18)} ${other.padEnd(8)} ${label.padEnd(8)} change`);
    console.log(`  ${"-".repeat(50)}`);

    for (const [type, counts] of Object.entries(byType)) {
      const was = previous.byType?.[type];
      const wasRate = was ? was.passed / was.total : 0;
      const nowRate = counts.passed / counts.total;
      const arrow = nowRate > wasRate ? "improved" : nowRate < wasRate ? "REGRESSED" : "same";
      console.log(
        `  ${type.padEnd(18)} ${(was ? `${was.passed}/${was.total}` : "-").padEnd(8)} ${`${counts.passed}/${counts.total}`.padEnd(8)} ${arrow}`,
      );
    }
    console.log();
  }
}

main().catch((error) => {
  console.error("\neval failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
