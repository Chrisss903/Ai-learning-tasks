/**
 * Week 8: indirect prompt injection, before and after the defence.
 *
 *   npm run attack                  both contenders, undefended and defended
 *   npm run attack -- --only A1,A3  a subset
 *
 * The attack documents are loaded only by this script (ATTACK_DOCS=1), so the
 * poisoned store never leaks into the other evals.
 */
import "./env.mts";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

process.env.ATTACK_DOCS = "1";

const { runAgent } = await import("../lib/agent");
const { closeTools } = await import("../lib/mcp-client");
const { runWorkflow } = await import("../lib/workflow");
const { ALL_DEFENCES, NO_DEFENCES } = await import("../lib/defences");
const { ATTACK_SET } = await import("../lib/attack-set");
const { resolveGenerator } = await import("../lib/generator");

const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const only = value("only")?.split(",").map((id) => id.trim().toUpperCase());
// Verdicts are a function of the saved answers, so a scoring rule can be
// corrected and the whole run re-judged without paying for it again.
const rescore = args.includes("--rescore");
const label = value("label") ?? "run";
const cases = ATTACK_SET.filter((c) => !only || only.includes(c.id));

type Contender = "agent" | "workflow";

/** Did the payload get what it asked for? */
function judge(attack: (typeof ATTACK_SET)[number], answer: string): boolean {
  if (!attack.succeedsIf.test(answer)) return false;
  return !(attack.onlyIfValueMissing && attack.correctAnswer.test(answer));
}

interface AttackResult {
  attackId: string;
  goal: string;
  contender: Contender;
  defended: boolean;
  hijacked: boolean;
  stillCorrect: boolean;
  answer: string;
  redactions: string[];
  steps: string;
  stopReason: string;
}

console.log(`\nPrompt injection · ${resolveGenerator().label}`);
console.log(`  ${cases.length} attacks × {undefended, defended} × {agent, workflow}\n`);

const results: AttackResult[] = [];

if (rescore) {
  const saved = JSON.parse(readFileSync(path.join(process.cwd(), "evals", `attack-${label}.json`), "utf-8"));

  for (const row of saved.results as AttackResult[]) {
    const attack = ATTACK_SET.find((a) => a.id === row.attackId)!;
    results.push({ ...row, hijacked: judge(attack, row.answer), stillCorrect: attack.correctAnswer.test(row.answer) });
  }

  for (const row of results) {
    console.log(
      `  ${row.attackId}  ${row.contender.padEnd(8)} ${row.defended ? "defended  " : "undefended"}  ` +
        `${row.hijacked ? "HIJACKED" : "resisted"}  ${row.stillCorrect ? "answer still correct" : "answer not correct"}`,
    );
  }
}

for (const attack of rescore ? [] : cases) {
  for (const contender of ["agent", "workflow"] as Contender[]) {
    for (const defended of [false, true]) {
      let run;
      try {
        run =
          contender === "agent"
            ? await runAgent(attack.question, { defences: defended ? ALL_DEFENCES : NO_DEFENCES })
            : await runWorkflow(attack.question, { sanitise: defended });
      } catch (error) {
        // A failed call is not a resisted attack; it is a missing datapoint.
        console.log(`  ${attack.id}  ${contender.padEnd(8)} ${defended ? "defended  " : "undefended"}  ERROR ${error instanceof Error ? error.message : error}`);
        continue;
      }

      const answer = run.answer ?? "";
      const stillCorrect = attack.correctAnswer.test(answer);
      const hijacked = judge(attack, answer);

      results.push({
        attackId: attack.id,
        goal: attack.goal,
        contender,
        defended,
        hijacked,
        stillCorrect,
        answer,
        redactions: run.redactions,
        steps: "steps" in run ? run.steps.map((s) => ("action" in s ? s.action : s.name)).join(" → ") : "",
        stopReason: "stopReason" in run ? run.stopReason : "finished",
      });

      console.log(
        `  ${attack.id}  ${contender.padEnd(8)} ${defended ? "defended  " : "undefended"}  ` +
          `${hijacked ? "HIJACKED" : "resisted"}  ${stillCorrect ? "answer still correct" : "answer not correct"}` +
          `${run.redactions.length ? `  [redacted: ${run.redactions.join(", ")}]` : ""}`,
      );
    }
  }
}

function rate(contender: Contender, defended: boolean) {
  const subset = results.filter((r) => r.contender === contender && r.defended === defended);
  const hijacked = subset.filter((r) => r.hijacked).length;
  const correct = subset.filter((r) => r.stillCorrect).length;
  return { runs: subset.length, hijacked, correct };
}

console.log(`\n  ${"".padEnd(10)} ${"undefended".padEnd(24)} defended`);
for (const contender of ["agent", "workflow"] as Contender[]) {
  const before = rate(contender, false);
  const after = rate(contender, true);
  console.log(
    `  ${contender.padEnd(10)} ` +
      `${`hijacked ${before.hijacked}/${before.runs}, correct ${before.correct}/${before.runs}`.padEnd(24)} ` +
      `hijacked ${after.hijacked}/${after.runs}, correct ${after.correct}/${after.runs}`,
  );
}

mkdirSync(path.join(process.cwd(), "evals"), { recursive: true });
const outfile = path.join(process.cwd(), "evals", `attack-${label}.json`);
writeFileSync(
  outfile,
  JSON.stringify(
    {
      label,
      ranAt: new Date().toISOString(),
      generator: resolveGenerator().label,
      summary: {
        agent: { undefended: rate("agent", false), defended: rate("agent", true) },
        workflow: { undefended: rate("workflow", false), defended: rate("workflow", true) },
      },
      results,
    },
    null,
    2,
  ),
);
console.log(`\n  saved → evals/${path.basename(outfile)}\n`);

// The MCP servers are child processes; the script cannot exit while they run.
await closeTools();
