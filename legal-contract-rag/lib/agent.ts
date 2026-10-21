import { findAmendments, listContracts } from "./contracts";
import {
  asUntrustedData,
  citationsIn,
  DATA_RULE,
  invalidCitations,
  NO_DEFENCES,
  scanDocumentText,
  type Defences,
} from "./defences";
import { resolveGenerator, type Usage } from "./generator";
import { discoverTools, type DiscoveredTool, type InputSchema } from "./mcp-client";

/**
 * The week 7 contract agent, built by hand: a ReAct loop.
 *
 *   think → pick a tool → run it → read the result → repeat, until `finish`
 *
 * Each turn the model sees the question and everything it has done so far, and
 * replies with one JSON action. The loop runs the tool, records what came back,
 * and asks again. Every step is kept, so a run can be replayed and debugged.
 *
 * Week 9: the tools are no longer listed here. They are discovered over MCP
 * from the servers in mcp.config.json, and the prompt is built from whatever
 * tools/list returned — so a new server is a config change, not a code change.
 *
 * Week 10: the loop can work as someone else. A squad specialist is this same
 * loop with a narrower brief and only the tools its job needs (lib/squad.ts).
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
  /** The MCP server that ran the tool; null when no tool ran. */
  server: string | null;
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
  /** Every tool the agent discovered for this run. */
  tools: string[];
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

/** Not a real tool — the action that ends the loop. Described alongside the others. */
const FINISH = {
  name: "finish",
  description:
    "Ends the task with your final answer. Cite every clause you relied on as [CONTRACT-ID §N]. " +
    "If the documents do not contain the answer, say \"I don't know\" and what is missing — never borrow a clause from a different contract.",
  inputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } as InputSchema,
};

type PropertySchema = { type?: string | string[]; description?: string };

/** One tool as the model sees it: its name, input shape and description, from tools/list. */
function renderTool(tool: { name: string; description: string; inputSchema: InputSchema }): string {
  const properties = Object.entries((tool.inputSchema.properties ?? {}) as Record<string, PropertySchema>);
  const required = new Set(tool.inputSchema.required ?? []);
  const type = (schema: PropertySchema) => [schema.type ?? "any"].flat().join(" | ");

  const shape = `{${properties
    .map(([key, schema]) => `"${key}"${required.has(key) ? "" : "?"}: ${type(schema)}`)
    .join(", ")}}`;
  const notes = properties
    .filter(([, schema]) => schema.description)
    .map(([key, schema]) => `\n    ${key}: ${schema.description}`)
    .join("");

  return `- ${tool.name} ${shape}\n  ${tool.description.replace(/\n/g, "\n  ")}${notes}`;
}

/** Who the loop works as: the opening of its prompt, its rules, and its tools. */
export interface AgentRole {
  brief: string;
  rules: string[];
  /** Discovered tools this role may call, by name. Every one when absent. */
  tools?: string[];
}

/** The week 7 agent. It is the default, so every earlier run is unchanged. */
export const SINGLE_AGENT: AgentRole = {
  brief:
    "You are a research agent for the legal team of a cricket franchise. You answer questions about the contracts in a document store, working one step at a time with tools.",
  rules: [
    "Find the right contract id before searching; scope searches to it.",
    "Before answering with a value from a contract, check that contract's amendments.",
    "If a question involves two contracts, research each one.",
    "Use only what the tools return. Do arithmetic yourself when asked.",
    "Older tool results are trimmed from your memory, so write every fact you will need later into your thought.",
  ],
};

/**
 * Week 10 control. The squad beat the single agent on citation format and on
 * tokens, and both look like prompt effects: its manager is told the bracket
 * format right before it answers, and each specialist re-sends a 2–3 tool
 * prompt where the single agent re-sends 7. This is the single agent with
 * those two things and nothing else — week 8's four tools, one citation rule.
 */
export const LEAN_AGENT: AgentRole = {
  ...SINGLE_AGENT,
  rules: [
    ...SINGLE_AGENT.rules,
    'In your final answer, put every citation in square brackets — [PC-2026-011 §6] — never a bare "PC-2026-011 §6" or "(PC-2026-011 §6)".',
  ],
  tools: ["list_contracts", "search_clauses", "read_section", "find_amendments"],
};

const systemPrompt = (tools: DiscoveredTool[], role: AgentRole) => `${role.brief}

Tools:
${[...tools, FINISH].map(renderTool).join("\n")}

How to work:
${role.rules.map((rule) => `- ${rule}`).join("\n")}

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
    role?: AgentRole;
    onStep?: (step: AgentStep) => void;
  } = {},
): Promise<AgentRun> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const defences = { ...NO_DEFENCES, ...options.defences };
  const role = options.role ?? SINGLE_AGENT;
  const generator = resolveGenerator();
  const started = Date.now();
  const tools = (await discoverTools()).filter((tool) => !role.tools || role.tools.includes(tool.name));
  const prompt = systemPrompt(tools, role);

  const steps: AgentStep[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
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
    tools: tools.map((tool) => tool.name),
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
          `Your answer relies on ${contract.id}, which has amendments you never checked. Check the amendments of ${contract.id} before finishing.`,
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
        content: defences.sanitiseDocuments ? `${prompt}\n\n${DATA_RULE}` : prompt,
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
      server: string | null = null,
    ) => {
      const step: AgentStep = {
        step: steps.length + 1,
        ...fields,
        server,
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

    const tool = tools.find((candidate) => candidate.name === parsed.action);
    if (!tool) {
      record({
        ...parsed,
        observation: `There is no tool "${parsed.action}". Tools: ${[...tools, FINISH].map((t) => t.name).join(", ")}.`,
      });
      continue;
    }

    const toolStarted = Date.now();
    const result = await tool.call(parsed.input);
    const toolMs = Date.now() - toolStarted;
    activeMs += toolMs;

    // Clause labels are read from the text itself, whichever server sent it.
    for (const label of citationsIn(result.text)) labels.add(label);

    // Tools are discovered, so no name is fixed: any amendment tool counts.
    if (/amendment/i.test(tool.name)) {
      amendmentsChecked.add(String(parsed.input.contract_id ?? "").trim().toUpperCase());
    }

    // What a tool returns is document text: scanned, stripped, and fenced off
    // as data before the model ever sees it.
    let observation = result.isError ? `Tool error: ${result.text}` : result.text;
    let stepRedactions: string[] = [];

    if (defences.sanitiseDocuments) {
      const scan = scanDocumentText(observation);
      stepRedactions = scan.hits;
      scan.hits.forEach((hit) => redactions.add(hit));
      observation = asUntrustedData(scan.clean);
    }

    record({ ...parsed, observation }, toolMs, stepRedactions, tool.server);
  }
}
