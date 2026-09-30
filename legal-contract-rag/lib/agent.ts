import type { Chunk } from "./chunking";
import { findAmendments, listContracts } from "./contracts";
import {
  asUntrustedData,
  DATA_RULE,
  invalidCitations,
  NO_DEFENCES,
  scanDocumentText,
  type Defences,
} from "./defences";
import { resolveGenerator, type Usage } from "./generator";
import { clauseLabel, FINISH, TOOLS } from "./tools";

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
  | "bad-output"
  /** Finished, but its answer never satisfied a defence gate. */
  | "validation-failed";

export interface AgentStep {
  step: number;
  thought: string;
  action: string;
  input: Record<string, unknown>;
  observation: string;
  /** Injection patterns found in what this step read, when sanitising. */
  redactions: string[];
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
  /** Clause labels the tools returned, for checking the answer's citations. */
  observedLabels: string[];
  defences: Defences;
  /** Injection patterns the run read, and gates it tripped. */
  redactions: string[];
  gateRejections: string[];
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

/** A gate sends the answer back to be corrected; it does not argue forever. */
const MAX_GATE_REJECTIONS = 2;

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

/**
 * The first complete JSON object in a reply, found by counting braces rather
 * than matching to the last one in the string.
 *
 * Week 8: this was the agent's commonest failure. The model reliably produced
 * a correct action and then added a stray closing brace — `…"PC-2026-027"}}}`
 * — and a greedy match swallowed it, so a perfectly good step was thrown away
 * as unparseable. Counting braces (and ignoring any inside strings) stops at
 * the end of the object and lets the trailing junk fall away.
 */
export function extractJsonObject(reply: string): string | null {
  const text = reply.replace(/```(?:json)?/gi, "");
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index++) {
    const character = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (character === "{") depth++;
    if (character === "}" && --depth === 0) return text.slice(start, index + 1);
  }

  return null;
}

function parseAction(
  reply: string,
): { thought: string; action: string; input: Record<string, unknown> } | null {
  const json = extractJsonObject(reply);
  if (!json) return null;

  try {
    const parsed = JSON.parse(json);
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
    defences?: Partial<Defences>;
    onStep?: (step: AgentStep) => void;
  } = {},
): Promise<AgentRun> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const defences = { ...NO_DEFENCES, ...options.defences };
  const generator = resolveGenerator();
  const started = Date.now();

  const steps: AgentStep[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const clauses = new Map<number, Chunk>();
  const seen = new Set<string>();
  const labels = new Set<string>();
  const amendmentsChecked = new Set<string>();
  const redactions = new Set<string>();
  const gateRejections: string[] = [];
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
    observedLabels: [...labels],
    defences,
    redactions: [...redactions],
    gateRejections,
  });

  /**
   * The gates. A final answer has to survive them: its citations must be
   * clauses a tool actually returned, and a value from an amended contract
   * must have been checked against that contract's amendments.
   */
  const gateProblems = async (answer: string): Promise<string[]> => {
    const problems: string[] = [];

    if (defences.validateCitations) {
      const invalid = invalidCitations(answer, [...labels]);
      if (invalid.length) {
        problems.push(
          `You cited ${invalid.join(", ")}, which no tool returned in this run. Cite only clauses you actually read, then finish again.`,
        );
      }
    }

    if (defences.requireAmendmentCheck) {
      const catalog = await listContracts();
      const mentioned = catalog.filter(
        (contract) => !contract.isAmendment && answer.toUpperCase().includes(contract.id.toUpperCase()),
      );

      for (const contract of mentioned) {
        if (amendmentsChecked.has(contract.id.toUpperCase())) continue;
        if (!(await findAmendments(contract.id)).length) continue;

        problems.push(
          `Your answer relies on ${contract.id}, which has amendments you never checked. Call find_amendments for ${contract.id} before finishing.`,
        );
      }
    }

    return problems;
  };

  while (true) {
    // Stop conditions are checked before spending on another turn.
    if (steps.length >= limits.maxSteps) return finish("max-steps");
    if (usage.inputTokens + usage.outputTokens >= limits.maxTokens) return finish("token-budget");
    if (Date.now() - started >= limits.maxMs) return finish("time-budget");

    const completion = await generator.run([
      {
        role: "system",
        content: defences.sanitiseDocuments ? `${SYSTEM_PROMPT}\n\n${DATA_RULE}` : SYSTEM_PROMPT,
      },
      { role: "user", content: renderTranscript(question, steps) },
    ]);

    usage.inputTokens += completion.usage.inputTokens;
    usage.outputTokens += completion.usage.outputTokens;
    activeMs += completion.ms;

    const record = (
      fields: Pick<AgentStep, "thought" | "action" | "input" | "observation">,
      toolMs = 0,
      stepRedactions: string[] = [],
    ) => {
      const step: AgentStep = {
        step: steps.length + 1,
        ...fields,
        redactions: stepRedactions,
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
      const problems = answer ? await gateProblems(answer) : [];

      if (problems.length && gateRejections.length < MAX_GATE_REJECTIONS) {
        gateRejections.push(...problems);
        record({ ...parsed, observation: `Answer rejected. ${problems.join(" ")}` });
        continue;
      }

      record({ ...parsed, observation: "(done)" });
      return finish(problems.length ? "validation-failed" : "finished", answer || null);
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

    for (const clause of result.clauses) {
      clauses.set(clause.id, clause);
      labels.add(await clauseLabel(clause));
    }

    if (parsed.action === "find_amendments") {
      amendmentsChecked.add(String(parsed.input.contract_id ?? "").trim().toUpperCase());
    }

    // What a tool returns is document text: scanned, stripped, and fenced off
    // as data before the model ever sees it.
    let observation = result.observation;
    let stepRedactions: string[] = [];

    if (defences.sanitiseDocuments) {
      const scan = scanDocumentText(observation);
      stepRedactions = scan.hits;
      scan.hits.forEach((hit) => redactions.add(hit));
      observation = asUntrustedData(scan.clean);
    }

    record({ ...parsed, observation }, toolMs, stepRedactions);
  }
}
