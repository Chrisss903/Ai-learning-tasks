import type { Chunk } from "./chunking";
import { resolveGenerator, type Usage } from "./generator";
import { FINISH, TOOLS } from "./tools";

/**
 * The week 7 contract agent, built by hand: a ReAct loop.
 *
 *   think → pick a tool → run it → read the result → repeat, until `finish`
 *
 * Each turn the model sees the question and everything it has done so far, and
 * replies with one JSON action. The loop runs the tool, records what came back,
 * and asks again. Every step is kept, so a run can be replayed and debugged.
 */
export interface AgentLimits {
  /** Model turns, including the one that calls finish. */
  maxSteps: number;
  /** Input + output tokens across every turn. */
  maxTokens: number;
  /** Wall-clock time for the whole run. */
  maxMs: number;
}

export const DEFAULT_LIMITS: AgentLimits = {
  maxSteps: 8,
  maxTokens: 40_000,
  maxMs: 180_000,
};

export type StopReason =
  | "finished"
  | "max-steps"
  | "token-budget"
  | "time-budget"
  | "repeating"
  | "bad-output";

export interface AgentStep {
  step: number;
  thought: string;
  action: string;
  input: Record<string, unknown>;
  observation: string;
  usage: Usage;
  modelMs: number;
  toolMs: number;
}

export interface AgentRun {
  question: string;
  answer: string | null;
  stopReason: StopReason;
  steps: AgentStep[];
  llmCalls: number;
  usage: Usage;
  /** Time in model calls and tools — excludes free-tier throttle waits. */
  activeMs: number;
  wallMs: number;
  clauses: Chunk[];
}

/**
 * Short-term memory. The transcript is the agent's memory, but it grows every
 * step, and every step re-sends all of it. Only the latest results are kept in
 * full; older ones are cut to a stub, so the agent is told to write down what it
 * needs in its thought — which is never trimmed.
 */
const KEEP_FULL_OBSERVATIONS = 4;
const TRIMMED_LENGTH = 200;

/** Two in a row, or two repeats in total, and the run is going nowhere. */
const MAX_BAD_OUTPUTS = 2;
const MAX_REPEATS = 2;

const SYSTEM_PROMPT = `You are a research agent for the legal team of a cricket franchise. You answer questions about the contracts in a document store, working one step at a time with tools.

Tools:
${[...TOOLS, FINISH].map((tool) => `- ${tool.name} ${tool.input}\n  ${tool.description}`).join("\n")}

How to work:
- Find the right contract id before searching; scope searches to it.
- Before answering with a value from a contract, check find_amendments for that contract.
- If a question involves two contracts, research each one.
- Use only what the tools return. Do arithmetic yourself when asked.
- Older tool results are trimmed from your memory, so write every fact you will need later into your thought.

Reply with exactly one JSON object and nothing else:
{"thought": "what you know so far and what to do next", "action": "<tool name>", "input": { ... }}`;

function renderTranscript(question: string, steps: AgentStep[]): string {
  const lines = [`Question: ${question}`];

  steps.forEach((step, index) => {
    const recent = index >= steps.length - KEEP_FULL_OBSERVATIONS;
    const observation =
      recent || step.observation.length <= TRIMMED_LENGTH
        ? step.observation
        : `${step.observation.slice(0, TRIMMED_LENGTH)}… [trimmed from memory]`;

    lines.push(
      `\nStep ${step.step}`,
      `Thought: ${step.thought}`,
      `Action: ${step.action} ${JSON.stringify(step.input)}`,
      `Observation: ${observation}`,
    );
  });

  lines.push(`\nStep ${steps.length + 1} — reply with one JSON action.`);
  return lines.join("\n");
}

function parseAction(
  reply: string,
): { thought: string; action: string; input: Record<string, unknown> } | null {
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.action !== "string") return null;

    return {
      thought: String(parsed.thought ?? ""),
      action: parsed.action.trim(),
      input:
        parsed.input && typeof parsed.input === "object" ? parsed.input : {},
    };
  } catch {
    return null;
  }
}

export async function runAgent(
  question: string,
  options: {
    limits?: Partial<AgentLimits>;
    onStep?: (step: AgentStep) => void;
  } = {},
): Promise<AgentRun> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const generator = resolveGenerator();
  const started = Date.now();

  const steps: AgentStep[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const clauses = new Map<number, Chunk>();
  const seen = new Set<string>();
  let activeMs = 0;
  let badOutputs = 0;
  let repeats = 0;

  const finish = (stopReason: StopReason, answer: string | null = null): AgentRun => ({
    question,
    answer,
    stopReason,
    steps,
    llmCalls: steps.length,
    usage,
    activeMs,
    wallMs: Date.now() - started,
    clauses: [...clauses.values()],
  });

  while (true) {
    // Stop conditions are checked before spending on another turn.
    if (steps.length >= limits.maxSteps) return finish("max-steps");
    if (usage.inputTokens + usage.outputTokens >= limits.maxTokens) return finish("token-budget");
    if (Date.now() - started >= limits.maxMs) return finish("time-budget");

    const completion = await generator.run([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: renderTranscript(question, steps) },
    ]);

    usage.inputTokens += completion.usage.inputTokens;
    usage.outputTokens += completion.usage.outputTokens;
    activeMs += completion.ms;

    const record = (
      fields: Pick<AgentStep, "thought" | "action" | "input" | "observation">,
      toolMs = 0,
    ) => {
      const step: AgentStep = {
        step: steps.length + 1,
        ...fields,
        usage: completion.usage,
        modelMs: completion.ms,
        toolMs,
      };
      steps.push(step);
      options.onStep?.(step);
    };

    const parsed = parseAction(completion.text);

    if (!parsed) {
      record({
        thought: "",
        action: "(invalid reply)",
        input: {},
        observation: `Your reply was not a JSON action. It began: ${completion.text.slice(0, 120)}. Reply with one JSON object.`,
      });
      if (++badOutputs >= MAX_BAD_OUTPUTS) return finish("bad-output");
      continue;
    }
    badOutputs = 0;

    if (parsed.action === FINISH.name) {
      const answer = String(parsed.input.answer ?? "").trim();
      record({ ...parsed, observation: "(done)" });
      return finish("finished", answer || null);
    }

    const signature = `${parsed.action} ${JSON.stringify(parsed.input)}`;
    if (seen.has(signature)) {
      record({
        ...parsed,
        observation: "You already ran this exact action; its result is above. Try something different, or finish.",
      });
      if (++repeats >= MAX_REPEATS) return finish("repeating");
      continue;
    }
    seen.add(signature);

    const tool = TOOLS.find((candidate) => candidate.name === parsed.action);
    if (!tool) {
      record({
        ...parsed,
        observation: `There is no tool "${parsed.action}". Tools: ${[...TOOLS, FINISH].map((t) => t.name).join(", ")}.`,
      });
      continue;
    }

    const toolStarted = Date.now();
    const result = await tool.execute(parsed.input);
    const toolMs = Date.now() - toolStarted;
    activeMs += toolMs;

    for (const clause of result.clauses) clauses.set(clause.id, clause);
    record({ ...parsed, observation: result.observation }, toolMs);
  }
}
