import {
  extractJsonObject,
  runAgent,
  type AgentLimits,
  type AgentRole,
  type AgentRun,
  type AgentStep,
} from "./agent";
import { resolveGenerator, type Usage } from "./generator";
import { discoverTools } from "./mcp-client";

/**
 * Week 10: the contract squad — a manager and two specialists — built to race
 * the single agent on the same questions, with the same tools and model.
 *
 *   1. plan      the manager reads the question, the contract catalog and the
 *                specialists' agent cards, and writes the tasks   (one model call)
 *   2. delegate  every task runs at once; a specialist is the week 7 loop with a
 *                narrower brief and only the tools its job needs
 *   3. answer    the manager answers from the reports             (one model call)
 *
 * They share nothing but text. A specialist starts from its own prompt and the
 * task it was handed; the manager sees the reports, never the clauses. Every
 * hand-off is a fresh prompt, and that re-sent context is what a team costs.
 */

/**
 * How an agent describes itself under A2A (Agent2Agent): who it is, what it
 * can do, and where to reach it. tools/list tells an agent what tools it has;
 * an agent card tells a manager what colleagues it has, and the manager's
 * prompt is built from these cards the way the single agent's is built from
 * tools/list. Here a hand-off is a function call in one process, so nothing
 * listens at `url` — it is where a specialist would be served if split out.
 */
export interface AgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: { streaming: boolean; pushNotifications: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: { id: string; name: string; description: string; tags: string[]; examples: string[] }[];
}

/** A2A's task lifecycle, as far as a one-shot task goes. */
export type TaskState = "submitted" | "working" | "completed" | "failed";

export interface Specialist {
  card: AgentCard;
  role: AgentRole;
}

function card(name: string, description: string, skill: AgentCard["skills"][number]): AgentCard {
  return {
    protocolVersion: "0.3.0",
    name,
    description,
    url: `http://localhost:41241/${name}`,
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [skill],
  };
}

export const SPECIALISTS: Specialist[] = [
  {
    card: card(
      "clause-researcher",
      "Finds the clause in one contract that answers a question and reports it as executed, with its [CONTRACT-ID §N] label. Does not check amendments.",
      {
        id: "find-clause",
        name: "Find a clause",
        description:
          "Given a contract id and a topic, returns the clause that covers it and the exact value it states, or says the contract has no such clause. Given no id, first finds the document that covers the topic.",
        tags: ["contracts", "clauses", "search"],
        examples: [
          "Contract PC-2026-027: what is the termination notice period?",
          "Which document caps overseas players in the playing eleven, and at how many?",
        ],
      },
    ),
    role: {
      brief:
        "You are the clause researcher on the legal team of a cricket franchise. A manager hands you one task about one contract. You find the clause that answers it and report what the clause says, as executed, working one step at a time with tools.",
      rules: [
        "Scope every search to the contract id in your task. If the task names none, first find the document that covers the topic.",
        "Report the exact value the clause states — amount, number of days, place — and cite it as [CONTRACT-ID §N].",
        "If the clause refers to another section, read that section too.",
        "If the contract has no clause that answers the task, say so plainly. Never borrow a clause from a different contract.",
        "Amendments are another specialist's job: report the clause as executed, and do not look for them.",
      ],
      tools: ["list_contracts", "search_clauses", "read_section"],
    },
  },
  {
    card: card(
      "amendment-checker",
      "Reports what the amendments to one contract changed: the sections they replace, the old and new values, and the [AMENDMENT-ID §N] label of each change. Does not search the contract itself.",
      {
        id: "check-amendments",
        name: "Check amendments",
        description:
          "Given a contract id and a topic, returns every amendment that changes that topic, with the replacing value, or says that no amendment changes it.",
        tags: ["contracts", "amendments"],
        examples: ["Contract PC-2026-011: has the termination notice period been amended, and to what?"],
      },
    ),
    role: {
      brief:
        "You are the amendment checker on the legal team of a cricket franchise. A manager hands you one contract and a topic. You find out whether any amendment changed that topic and report exactly what it changed, working one step at a time with tools.",
      rules: [
        "Check the amendments of the contract in your task only.",
        "For each change to the topic, report the section replaced, the old value, the new value, and cite the amendment clause as [AMENDMENT-ID §N].",
        "If no amendment changes the topic, say so: the contract's own clause is current.",
        "Finding the original clause is another specialist's job: do not search the contract itself.",
      ],
      tools: ["find_amendments", "get_amendment_chain"],
    },
  },
];

/** One narrow job each, so fewer steps than the single agent's 8. */
const SPECIALIST_LIMITS: Partial<AgentLimits> = { maxSteps: 6 };

/** Beyond this, a plan is fanning out for its own sake. */
const MAX_TASKS = 6;

function renderCard(agent: AgentCard): string {
  const skills = agent.skills
    .map((skill) => `\n  ${skill.name}: ${skill.description} For example: ${skill.examples.map((e) => `"${e}"`).join("; ")}`)
    .join("");
  return `- ${agent.name} — ${agent.description}${skills}`;
}

const planPrompt = (catalog: string) => `You manage a small research team for the legal team of a cricket franchise. You do not read contracts yourself: you split a question into tasks for your specialists, and once they report back you write the answer.

Specialists, from their agent cards:
${SPECIALISTS.map(({ card }) => renderCard(card)).join("\n")}

Contracts in the store:
${catalog}

How to plan:
- Use the catalog to turn names, venues and topics into contract ids.
- Give the clause-researcher one task for each contract the answer depends on.
- When the catalog lists an amendment to one of those contracts, also give the amendment-checker a task on the same topic, naming the original contract's id.
- The tasks run at the same time and cannot see each other or the question, so each must stand on its own: say exactly what to find.

Reply with exactly one JSON object and nothing else:
{"thought": "which contracts the answer depends on, who or what each one covers, and why", "tasks": [{"to": "<specialist>", "contract_id": "<id, or null if no contract fits>", "task": "what to find"}]}`;

const ANSWER_PROMPT = `You manage a small research team for the legal team of a cricket franchise. Your specialists have reported back on a question. Answer it from their reports alone.

- An amendment replaces the value it amends: where the amendment-checker reports a new value, use it, not the original clause.
- Cite every clause you rely on as [CONTRACT-ID §N], exactly as the reports cite it.
- If the question involves more than one contract, answer for each. Do arithmetic yourself when asked.
- If the reports do not contain the answer, say "I don't know" and what is missing. Never borrow a clause from a different contract.

Reply with the answer and nothing else.`;

export interface PlannedTask {
  /** The specialist's card name. */
  to: string;
  contractId: string | null;
  task: string;
}

export interface SquadTask extends PlannedTask {
  id: string;
  states: { state: TaskState; at: string }[];
  /** The specialist's finish answer — the task's only artifact. */
  report: string | null;
  run: AgentRun | null;
}

export interface ManagerCall {
  name: "plan" | "answer";
  text: string;
  usage: Usage;
  ms: number;
}

export interface SquadRun {
  question: string;
  answer: string | null;
  stopReason: "finished" | "bad-plan";
  thought: string;
  tasks: SquadTask[];
  manager: ManagerCall[];
  llmCalls: number;
  usage: Usage;
  /** Calls and tokens per member: the manager, and each specialist summed over its tasks. */
  byRole: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
  /**
   * The critical path — catalog, plan, the slowest task, answer — which is what
   * a run takes when the tasks really do run at once. Excludes throttle waits.
   */
  activeMs: number;
  /** Model and tool time summed over everyone, as if nothing overlapped. */
  busyMs: number;
  wallMs: number;
}

function parsePlan(reply: string): { thought: string; tasks: PlannedTask[] } | null {
  const json = extractJsonObject(reply);
  if (!json) return null;

  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed.tasks)) return null;

    const names = SPECIALISTS.map((specialist) => specialist.card.name);
    const tasks = (parsed.tasks as { to?: unknown; contract_id?: unknown; task?: unknown }[])
      .filter((task) => task && names.includes(String(task.to)) && String(task.task ?? "").trim())
      .slice(0, MAX_TASKS)
      .map((task) => {
        const id = typeof task.contract_id === "string" ? task.contract_id.trim() : "";
        return { to: String(task.to), contractId: id && id !== "null" ? id : null, task: String(task.task).trim() };
      });

    return { thought: String(parsed.thought ?? ""), tasks };
  } catch {
    return null;
  }
}

function renderReport(task: SquadTask): string {
  const lastNote = task.run?.steps.at(-1)?.thought;
  const report =
    task.report ??
    `(no report — the specialist stopped: ${task.run?.stopReason ?? "unknown"})${lastNote ? ` Its last note: ${lastNote}` : ""}`;

  return `[${task.id}] ${task.to} · ${task.contractId ?? "no contract named"} · ${task.states.at(-1)?.state}\nTask: ${task.task}\nReport: ${report}`;
}

export async function runSquad(
  question: string,
  options: {
    onPlan?: (thought: string, tasks: PlannedTask[]) => void;
    onTask?: (task: SquadTask) => void;
    onStep?: (task: SquadTask, step: AgentStep) => void;
  } = {},
): Promise<SquadRun> {
  const generator = resolveGenerator();
  const started = Date.now();
  const manager: ManagerCall[] = [];
  let tasks: SquadTask[] = [];

  const ask = async (name: ManagerCall["name"], system: string, user: string) => {
    const completion = await generator.run([
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
    manager.push({ name, text: completion.text, usage: completion.usage, ms: completion.ms });
    return completion.text;
  };

  // The catalog comes from the same MCP tool the single agent can call.
  const listContracts = (await discoverTools()).find((tool) => tool.name === "list_contracts");
  if (!listContracts) throw new Error("The squad needs list_contracts, and no MCP server offered it");

  const catalogStarted = Date.now();
  const catalog = (await listContracts.call({})).text;
  const catalogMs = Date.now() - catalogStarted;

  const finish = (stopReason: SquadRun["stopReason"], thought: string, answer: string | null): SquadRun => {
    const byRole: SquadRun["byRole"] = {};
    const add = (who: string, calls: number, usage: Usage) => {
      const entry = (byRole[who] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
      entry.calls += calls;
      entry.inputTokens += usage.inputTokens;
      entry.outputTokens += usage.outputTokens;
    };
    for (const call of manager) add("manager", 1, call.usage);
    for (const task of tasks) if (task.run) add(task.to, task.run.llmCalls, task.run.usage);

    const members = Object.values(byRole);
    const managerMs = manager.reduce((total, call) => total + call.ms, 0);
    const taskMs = tasks.map((task) => task.run?.activeMs ?? 0);

    return {
      question,
      answer,
      stopReason,
      thought,
      tasks,
      manager,
      llmCalls: members.reduce((total, member) => total + member.calls, 0),
      usage: {
        inputTokens: members.reduce((total, member) => total + member.inputTokens, 0),
        outputTokens: members.reduce((total, member) => total + member.outputTokens, 0),
      },
      byRole,
      activeMs: catalogMs + managerMs + Math.max(0, ...taskMs),
      busyMs: catalogMs + managerMs + taskMs.reduce((total, ms) => total + ms, 0),
      wallMs: Date.now() - started,
    };
  };

  // 1. Plan. One second chance for a reply that is not a JSON plan, as the
  // single agent gets for a reply that is not a JSON action.
  const planInput = `Question: ${question}`;
  const plan =
    parsePlan(await ask("plan", planPrompt(catalog), planInput)) ??
    parsePlan(await ask("plan", planPrompt(catalog), `${planInput}\n\nYour last reply was not a JSON plan. Reply with one JSON object.`));

  if (!plan) return finish("bad-plan", "", null);
  options.onPlan?.(plan.thought, plan.tasks);

  // 2. Delegate. Every task at once; a specialist never sees the question,
  // only the task it was handed.
  tasks = plan.tasks.map((planned, index) => ({ ...planned, id: `t${index + 1}`, states: [], report: null, run: null }));

  const enter = (task: SquadTask, state: TaskState) => {
    task.states.push({ state, at: new Date().toISOString() });
    options.onTask?.(task);
  };

  const settled = await Promise.allSettled(
    tasks.map(async (task) => {
      const specialist = SPECIALISTS.find((candidate) => candidate.card.name === task.to)!;
      enter(task, "submitted");
      enter(task, "working");

      task.run = await runAgent(task.contractId ? `Contract ${task.contractId}: ${task.task}` : task.task, {
        role: specialist.role,
        limits: SPECIALIST_LIMITS,
        onStep: (step) => options.onStep?.(task, step),
      });
      task.report = task.run.answer;
      enter(task, task.report ? "completed" : "failed");
    }),
  );

  // A provider outage is not the squad's mistake, so it fails the run the way
  // it would fail the single agent's, rather than becoming a missing report.
  const outage = settled.find((result) => result.status === "rejected");
  if (outage) throw outage.reason;

  // 3. Answer, from the reports alone. The answer call is a fresh context, so
  // the manager is handed its own plan back: reports name contract ids, the
  // question names people, and only the plan connects the two. Without it the
  // first version answered M01 "I don't know" over three correct reports.
  const reports = tasks.map(renderReport).join("\n\n") || "(none — no task was planned)";
  const answer = (
    await ask("answer", ANSWER_PROMPT, `Question: ${question}\n\nYour plan: ${plan.thought}\n\nReports:\n\n${reports}`)
  ).trim();

  return finish("finished", plan.thought, answer || null);
}
