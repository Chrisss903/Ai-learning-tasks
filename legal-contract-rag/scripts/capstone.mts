/**
 * Week 12 — the one entry point.
 *
 *   npm run capstone -- ask "How much notice must Rohan Sharma give?"
 *   npm run capstone -- eval [--label x] [--only T07,C03] [--no-judge]
 *   npm run capstone -- trajectory                  the week 8 trajectory eval, integrated agent
 *   npm run capstone -- trace <trace_id>            spans + the MCP server's audit line, one id
 *   npm run capstone -- agreement [--label x]       judge vs hand labels (evals/capstone-labels.json)
 *   npm run capstone -- all                         eval + trajectory + agreement, one go
 */
import "./env.mts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [command = "help", ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(`--${name}`);
const value = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
};

const { askCapstone, closeTools } = await import("../lib/capstone");
const { adviceHits, mentionsCounsel } = await import("../lib/counsel-guard");
const { checkAnswer } = await import("../lib/assertions");
const { CAPSTONE_CASES } = await import("../lib/capstone-set");
const { judgeAnswer } = await import("../lib/judge");
const { generationCost } = await import("../lib/pricing");
const { resolveGenerator } = await import("../lib/generator");

const clip = (text: string, n = 300) => (text.length > n ? `${text.slice(0, n)}…` : text);

async function ask(question: string) {
  const r = await askCapstone(question);
  console.log(`\ntrace ${r.traceId}`);
  for (const s of r.run.steps) {
    console.log(`  step ${s.step}  ${s.action} ${JSON.stringify(s.input)}${s.server ? `  [mcp: ${s.server}]` : ""}`);
  }
  if (r.guard.intervened) console.log(`\n  counsel guard intervened: ${r.guard.reason}\n  draft was: ${clip(r.draft ?? "")}`);
  console.log(`\n${r.answer}\n`);
  console.log(`${r.run.llmCalls} model calls · ${r.totals.tokens} tokens · $${generationCost(resolveGenerator().label, r.run.usage).toFixed(6)} · ${(r.totals.latencyMs / 1000).toFixed(1)}s`);
  console.log(`inspect: npm run capstone -- trace ${r.traceId}\n`);
}

function readJsonl(dir: string): Record<string, any>[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).flatMap((f) =>
    readFileSync(path.join(dir, f), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

function trace(id: string) {
  const host = readJsonl("logs/agent").find((r) => r.trace_id.startsWith(id));
  if (!host) return console.error(`No agent trace starting ${id} in logs/agent.`);
  const server = readJsonl("logs/mcp").filter((r) => r.trace_id === host.trace_id);
  console.log(`\ntrace ${host.trace_id} · ${host.model} · ${host.status}\nQ: ${host.input.question}`);
  console.log(`\n  ${"span".padEnd(26)} ${"start".padStart(7)} ${"ms".padStart(7)} ${"tokens".padStart(11)} ${"usd".padStart(10)}`);
  for (const s of host.spans) {
    const tok = s.tokens ? `${s.tokens.input}/${s.tokens.output}` : "";
    console.log(`  ${s.name.padEnd(26)} ${String(s.start_ms).padStart(7)} ${String(s.duration_ms).padStart(7)} ${tok.padStart(11)} ${s.cost_usd ? s.cost_usd.toFixed(6).padStart(10) : "".padStart(10)}`);
  }
  console.log(`\n  host total: ${host.totals.latency_ms} ms · $${host.totals.cost_usd.toFixed(6)} (${JSON.stringify(host.totals.cost_by_stage)})`);
  console.log(`\n  MCP server audit lines carrying this trace id: ${server.length}`);
  for (const s of server) console.log(`    ${s.tool.padEnd(22)} ${String(s.duration_ms).padStart(6)} ms · ${s.bytes} bytes · contract ${s.contract_id ?? "-"}`);
  const hostTools = host.spans.filter((s: any) => s.name.startsWith("tool.")).length;
  console.log(`\n  hop check: ${hostTools} host tool spans, ${server.length} server lines → ${hostTools === server.length ? "trace id survived every hop" : "MISMATCH"}\n`);
}

type Row = Record<string, any>;

async function evaluate() {
  const only = value("only")?.split(",");
  const cases = CAPSTONE_CASES.filter((c) => !only || only.includes(c.id));
  const label = value("label") ?? "run";
  const useJudge = !flag("no-judge");
  const rows: Row[] = [];
  const out = `evals/capstone-${label}.json`;
  mkdirSync("evals", { recursive: true });

  console.log(`\nCapstone eval · ${resolveGenerator().label} · ${cases.length} cases through the integrated agent\n`);
  for (const c of cases) {
    let r;
    try { r = await askCapstone(c.question, { channel: "eval" }); }
    catch (e) { console.log(`  ${c.id}  ERROR ${e instanceof Error ? e.message : e}`); rows.push({ id: c.id, group: c.group, type: c.type, error: String(e), passed: false, failures: [`error: ${String(e)}`] }); continue; }

    const answer = r.draft ?? r.answer;           // grade what the model said, and separately what shipped
    const checks = checkAnswer(c, answer);
    const called = new Set(r.run.steps.map((s) => s.action));
    for (const tool of c.mustCall ?? []) checks.push({ name: `called:${tool}`, passed: called.has(tool), detail: called.has(tool) ? "called" : "never called" });
    const shippedHits = adviceHits(r.answer);
    checks.push({ name: "shipped-no-advice-language", passed: shippedHits.length === 0, detail: shippedHits.join(",") || "clean" });
    if (c.expectCounsel) checks.push({ name: "refers-to-counsel", passed: mentionsCounsel(r.answer), detail: mentionsCounsel(r.answer) ? "referral present" : "no referral" });
    if (c.amendmentChain) {
      const cites = /\bAMD-[A-Z0-9-]+/.test(answer);
      checks.push({ name: "cites-amending-document", passed: cites, detail: cites ? "amendment cited" : "only the base document cited" });
    }
    for (const doc of c.chainDocs ?? []) {
      const hit = answer.toUpperCase().includes(doc.toUpperCase());
      checks.push({ name: `cites-chain:${doc}`, passed: hit, detail: hit ? "cited" : "chain link not cited" });
    }
    const labels = new Set(r.run.observedLabels.map((l) => l.toUpperCase()));
    const cited = [...answer.matchAll(/\b([A-Z]{2,4}(?:-[A-Z]{2})?-\d{3,4}(?:-\d{2,3})*) §(\d+)/g)].map((m) => `${m[1]} §${m[2]}`.toUpperCase());
    const ungrounded = cited.filter((x) => !labels.has(x));
    checks.push({ name: "citations-grounded", passed: ungrounded.length === 0, detail: ungrounded.join(",") || `${cited.length} cited, all returned by a tool` });
    if (!c.expectRefusal) checks.push({ name: "cites-a-clause", passed: cited.length > 0, detail: `${cited.length}` });

    let judgement = null;
    if (useJudge && answer) {
      const shown = r.run.steps.filter((s) => s.server).map((s) => s.observation).join("\n\n");
      try { judgement = await judgeAnswer(c.question, [], answer, shown || "(no tool output)"); } catch { judgement = null; }
    }
    const passed = checks.every((x) => x.passed) && (!judgement || judgement.verdict !== "unsupported");
    rows.push({
      id: c.id, group: c.group, type: c.type, question: c.question, traceId: r.traceId, answer: r.answer, draft: r.draft,
      passed, failures: checks.filter((x) => !x.passed).map((x) => `${x.name}: ${x.detail}`), judgement,
      path: r.run.steps.map((s) => s.action).join(" → "), llmCalls: r.run.llmCalls,
      tokens: r.totals.tokens, costUsd: generationCost(resolveGenerator().label, r.run.usage), latencyMs: r.totals.latencyMs,
      amendmentChain: Boolean(c.amendmentChain), counsel: Boolean(c.expectCounsel),
    });
    console.log(`  ${c.id.padEnd(4)} ${passed ? "PASS" : "FAIL"}  ${rows.at(-1)!.path}`);
    for (const f of rows.at(-1)!.failures) console.log(`        ↳ ${f}`);
    writeFileSync(out, JSON.stringify({ label, ranAt: new Date().toISOString(), model: resolveGenerator().label, rows }, null, 2));
  }

  const pct = (rs: Row[]) => (rs.length ? `${rs.filter((x) => x.passed).length}/${rs.length} = ${Math.round((rs.filter((x) => x.passed).length / rs.length) * 100)}%` : "n/a (0 cases)");
  console.log(`\n  overall            ${pct(rows)}`);
  for (const t of [...new Set(rows.map((x) => x.type))]) console.log(`  ${String(t).padEnd(18)} ${pct(rows.filter((x) => x.type === t))}`);
  console.log(`  live amendment chain ${pct(rows.filter((x) => x.amendmentChain))}`);
  console.log(`  judgement→counsel    ${pct(rows.filter((x) => x.counsel))}`);
  console.log(`  indemnity / liability: 0 cases — the store has no such clauses (see EVAL-REPORT.md non-coverage)`);
  const cost = rows.reduce((s, x) => s + (x.costUsd ?? 0), 0) / Math.max(rows.length, 1);
  console.log(`  mean cost / question $${cost.toFixed(6)} · saved → ${out}\n`);
}

function agreement() {
  const file = `evals/capstone-${value("label") ?? "run"}.json`;
  const labelFile = "evals/capstone-labels.json";
  if (!existsSync(file)) return console.error(`Run the eval first (${file} missing).`);
  if (!existsSync(labelFile)) {
    const rows = JSON.parse(readFileSync(file, "utf-8")).rows as Row[];
    const sheet = Object.fromEntries(rows.filter((r) => r.answer).map((r) => [r.id, null]));
    writeFileSync(labelFile, JSON.stringify(sheet, null, 2));
    console.log(`Wrote ${labelFile}. Read each answer in ${file} and set each id to "supported" | "unsupported" | "refused" — your own grade, before looking at the judge's. Then re-run.`);
    return;
  }
  const labels = JSON.parse(readFileSync(labelFile, "utf-8")) as Record<string, string | null>;
  const rows = JSON.parse(readFileSync(file, "utf-8")).rows as Row[];
  const graded = rows.filter((r) => labels[r.id] && r.judgement);
  const agree = graded.filter((r) => labels[r.id] === r.judgement.verdict);
  console.log(`\njudge vs hand labels on integrated outputs: ${agree.length}/${graded.length} = ${graded.length ? Math.round((agree.length / graded.length) * 100) : 0}%  (bar: 85%)`);
  for (const r of graded.filter((x) => labels[x.id] !== x.judgement.verdict)) console.log(`  DISAGREE ${r.id}: human=${labels[r.id]} judge=${r.judgement.verdict} — ${r.judgement.reason}`);
  console.log(`  unlabelled: ${rows.filter((r) => r.answer && !labels[r.id]).length}\n`);
}

try {
  if (command === "ask") await ask(rest.filter((a) => !a.startsWith("--")).join(" "));
  else if (command === "eval") await evaluate();
  else if (command === "trace") trace(rest[0] ?? "");
  else if (command === "agreement") agreement();
  else if (command === "trajectory") {
    await closeTools();
    spawnSync("npx", ["tsx", "scripts/trajectory.mts", ...rest], { stdio: "inherit" });
  } else if (command === "all") {
    await evaluate(); agreement(); await closeTools();
    spawnSync("npx", ["tsx", "scripts/trajectory.mts", "--label", value("label") ?? "capstone"], { stdio: "inherit" });
  } else console.log(readFileSync("scripts/capstone.mts", "utf-8").split("*/")[0].replace("/**", "").replace(/^ \* ?/gm, ""));
} finally {
  await closeTools();
}
