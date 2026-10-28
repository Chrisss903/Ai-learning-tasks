/**
 * Week 11: last week's traffic, replayed — the haystack for the support drill.
 *
 *   npm run traffic -- --from 2026-10-19 --to 2026-10-27 --seed 11
 *
 * Every request is a real run of the app's pipeline: real retrieval, a real
 * model call, real tokens, latency and cost. Only two things are simulated —
 * who asked (lib/team.ts) and when (office hours, IST, across the date range)
 * — and every record says so with clock: "simulated".
 *
 * The schedule is drawn from the seed, so a run can be resumed: requests
 * already in the log are skipped.
 */
import "./env.mts";
import { mkdirSync, readdirSync, readFileSync } from "fs";
import path from "path";

const { askQuestion } = await import("../lib/rag");
const { TEAM } = await import("../lib/team");
const { classifyInput } = await import("../lib/input-type");
const { QUESTION_POOL } = await import("../lib/trace-questions");
const { TEST_SET } = await import("../lib/test-set");
const { logDirFor } = await import("../lib/telemetry");

const args = process.argv.slice(2);
const value = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const from = value("from", "2026-10-19");
const to = value("to", "2026-10-27");
const seed = Number(value("seed", "11"));
const promptVersion = value("prompt", "rag-answer@1");
const dryRun = args.includes("--dry-run");

/** More of what a legal team actually asks, on top of the week 5 pool and the test set. */
const MORE_QUESTIONS = [
  "How much notice does Dinesh Mendis have to give to terminate?",
  "Can the franchise terminate Mendis if he doesn't get his no objection certificate?",
  "On what grounds can the League terminate the franchise agreement?",
  "How much notice must BetaWorks give to end the AlphaTech agreement?",
  "Can Chennai Chargers terminate Rohan Sharma immediately for a Level 4 offence?",
  "What notice does the sponsor need to give to walk away from the deal?",
  "If Mendis wants to leave mid-season, what notice period applies?",
  "When are Dinesh Mendis's retainer instalments paid?",
  "Which law governs Rohan Sharma's contract?",
  "Where would a dispute with Mendis be arbitrated?",
  "How many social media posts does the sponsor get each season?",
  "What is the broadcast rights fee per season?",
  "How long does BetaWorks have to raise an invoice dispute?",
  "What is the late payment charge on overdue invoices?",
  "When is the transfer fee for Arjun Kale due?",
  "Does the sponsor pay a bonus if we win the final?",
  "How long do demerit points stay on a player's record?",
  "Who owns software developed for BetaWorks?",
  "How long is the service agreement valid?",
  "What happens if Arjun Kale fails the medical?",
  "Is the match fee payable when a player is only named as a reserve?",
  "How many seasons does the broadcast deal cover?",
];

const QUESTIONS = [...new Set([...QUESTION_POOL, ...TEST_SET.map((c) => c.question), ...MORE_QUESTIONS])];
const BY_TYPE = new Map<string, string[]>();
for (const question of QUESTIONS) {
  const type = classifyInput(question);
  BY_TYPE.set(type, [...(BY_TYPE.get(type) ?? []), question]);
}

/** Same PRNG as the week 5 sampler: a seed reproduces the week exactly. */
function mulberry32(state: number) {
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(seed);
const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)];

/** Office hours in IST with a lunch dip, and the odd late evening. */
function arrival(day: string): Date {
  const evening = random() < 0.08;
  let minutes = evening ? 20 * 60 + random() * 150 : 9 * 60 + 15 + random() * 630;
  if (!evening && minutes > 13 * 60 && minutes < 14 * 60 && random() < 0.6) minutes += 60;
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(Math.floor(minutes % 60)).padStart(2, "0");
  const ss = String(Math.floor(random() * 60)).padStart(2, "0");
  return new Date(`${day}T${hh}:${mm}:${ss}+05:30`);
}

const schedule: { at: Date; user: (typeof TEAM)[number]; question: string }[] = [];

for (let day = new Date(`${from}T00:00:00Z`); day <= new Date(`${to}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
  const date = day.toISOString().slice(0, 10);
  const weekend = [0, 6].includes(day.getUTCDay());

  for (const user of TEAM) {
    const count = weekend
      ? random() < 0.15 ? 1 : 0
      : Math.max(0, user.load + Math.floor(random() * 3) - 1);

    for (let i = 0; i < count; i++) {
      const own = BY_TYPE.get(pick(user.interests)) ?? [];
      const question = own.length && random() < 0.7 ? pick(own) : pick(QUESTIONS);
      schedule.push({ at: arrival(date), user, question });
    }
  }
}

schedule.sort((a, b) => a.at.getTime() - b.at.getTime());

const directory = logDirFor("web");
mkdirSync(directory, { recursive: true });
const done = new Set<string>();
for (const file of readdirSync(directory, { withFileTypes: true }).filter((f) => f.name.endsWith(".jsonl"))) {
  for (const line of readFileSync(path.join(directory, file.name), "utf-8").split("\n").filter(Boolean)) {
    const record = JSON.parse(line);
    done.add(`${record.ts}|${record.user.id}`);
  }
}

console.log(`\ntraffic ${from} → ${to} · seed ${seed} · ${promptVersion} · ${schedule.length} requests, ${QUESTIONS.length} distinct questions`);

let ran = 0;
for (const [index, entry] of schedule.entries()) {
  if (done.has(`${entry.at.toISOString()}|${entry.user.id}`)) continue;

  const stamp = entry.at.toLocaleString("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  if (dryRun) {
    console.log(`  ${stamp}  ${entry.user.id.padEnd(9)} ${classifyInput(entry.question).padEnd(12)} ${entry.question}`);
    continue;
  }

  try {
    const result = await askQuestion(entry.question, "hybrid", {
      channel: "web",
      user: { id: entry.user.id, role: entry.user.role },
      promptVersion,
      at: entry.at,
    });
    ran++;
    console.log(`  ${String(index + 1).padStart(3)}/${schedule.length}  ${stamp}  ${entry.user.id.padEnd(9)} ${result.traceId.slice(0, 8)}  ${entry.question.slice(0, 60)}`);
  } catch (error) {
    // The trace is already logged with status "error"; a failed request is traffic too.
    console.log(`  ${String(index + 1).padStart(3)}/${schedule.length}  ${stamp}  ${entry.user.id.padEnd(9)} ERROR ${error instanceof Error ? error.message : error}`);
  }
}

console.log(`\n${dryRun ? "planned" : "ran"} ${dryRun ? schedule.length : ran} request(s) → ${path.relative(process.cwd(), directory)}/`);
