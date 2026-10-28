/**
 * Week 11: one real request through the app's pipeline, logged like any other.
 *
 *   npm run ask -- "What is the match fee in PC-2026-027?"
 *   npm run ask -- --as s.khan "How much notice ..."         role looked up from lib/team.ts
 *   npm run ask -- --as s.khan --at 2026-10-22T15:41:00+05:30 --prompt rag-answer@1 "…"
 *
 * --at stamps the request with a past arrival time, so a squadmate can plant
 * a request into last week's traffic; the record is filed in time order and
 * carries clock: "simulated", exactly like the replayed traffic around it.
 * --quiet prints only the trace id, so the planter can keep the answer to themselves.
 */
import "./env.mts";

const { askQuestion } = await import("../lib/rag");
const { findMember } = await import("../lib/team");

const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const [found] = args.splice(index, 2).slice(1);
  return found;
};
const quiet = args.includes("--quiet") ? (args.splice(args.indexOf("--quiet"), 1), true) : false;

const userId = value("as") ?? "cli";
const role = value("role") ?? findMember(userId)?.role ?? "unknown";
const at = value("at");
const promptVersion = value("prompt");
const mode = value("mode") === "vector" ? "vector" : "hybrid";
const question = args.join(" ").trim();

if (!question) {
  console.error('Usage: npm run ask -- [--as user] [--role r] [--at ISO] [--prompt id] [--quiet] "question"');
  process.exit(1);
}

const result = await askQuestion(question, mode, {
  channel: at ? "web" : "cli",
  user: { id: userId, role },
  promptVersion,
  at: at ? new Date(at) : undefined,
});

if (quiet) {
  console.log(result.traceId);
} else {
  console.log(`\ntrace ${result.traceId} · ${result.promptVersion} · ${result.generator}\n`);
  result.sources.forEach((source, index) => console.log(`  [${index + 1}] ${source.label}  (${source.via})`));
  console.log(`\n${result.answer}\n`);
}
