import type { Chunk } from "./chunking";
import { findAmendments, listContracts, resolveContracts, sectionsOf } from "./contracts";
import { resolveGenerator, type Usage } from "./generator";
import { searchDocuments } from "./search";
import { formatClause } from "./tools";

/**
 * The same job as the agent, as a fixed sequence. Every question takes the
 * same four steps, decided in code, and the model is called exactly once:
 *
 *   1. resolve the contract(s) named in the question   (code)
 *   2. search clauses, scoped to each of them           (search)
 *   3. attach every amendment of every contract touched (code)
 *   4. answer from those clauses                        (one model call)
 */
export interface WorkflowStep {
  name: string;
  detail: string;
  ms: number;
}

export interface WorkflowRun {
  question: string;
  answer: string;
  steps: WorkflowStep[];
  llmCalls: number;
  usage: Usage;
  /** Time in the model call and lookups — excludes free-tier throttle waits. */
  activeMs: number;
  wallMs: number;
  clauses: Chunk[];
}

const SYSTEM_PROMPT =
  "You are a legal contract assistant for a cricket franchise. Answer the question using ONLY the contract clauses provided. " +
  "Each clause is labelled [CONTRACT-ID §N]; cite the labels you relied on. " +
  "An amendment replaces the value it amends — use the amended value. " +
  "If the question involves more than one contract, answer for each. Do arithmetic when asked. " +
  "If the clauses do not contain the answer, say \"I don't know\" and what is missing — never borrow a clause from a different contract.";

export async function runWorkflow(
  question: string,
  options: { onStep?: (step: WorkflowStep) => void } = {},
): Promise<WorkflowRun> {
  const started = Date.now();
  const steps: WorkflowStep[] = [];

  const timed = async <T>(name: string, work: () => Promise<T>, describe: (value: T) => string) => {
    const stepStarted = Date.now();
    const value = await work();
    const step = { name, detail: describe(value), ms: Date.now() - stepStarted };
    steps.push(step);
    options.onStep?.(step);
    return value;
  };

  // 1. Which contracts does the question name?
  const contracts = await timed(
    "resolve-contracts",
    () => resolveContracts(question),
    (found) => (found.length ? found.map((c) => c.id).join(", ") : "none named — searching everything"),
  );

  // 2. Scoped search per contract, or one corpus-wide search if none was named.
  const retrieved = await timed(
    "search",
    async () => {
      if (!contracts.length) return searchDocuments(question, 3, "hybrid");
      const perContract = await Promise.all(
        contracts.map((c) => searchDocuments(question, 3, "hybrid", c.source)),
      );
      return perContract.flat();
    },
    (results) => `${results.length} clauses`,
  );

  // 3. Amendments of every contract the clauses came from.
  const catalog = await listContracts();
  const touched = new Set([
    ...contracts.map((c) => c.id),
    ...retrieved
      .map((chunk) => catalog.find((c) => c.source === chunk.source))
      .filter((c) => c && !c.isAmendment)
      .map((c) => c!.id),
  ]);

  const amendmentClauses = await timed(
    "attach-amendments",
    async () => {
      const amendments = (await Promise.all([...touched].map(findAmendments))).flat();
      return (await Promise.all(amendments.map((a) => sectionsOf(a.source)))).flat();
    },
    (clauses) => `${clauses.length} amendment clauses for ${[...touched].join(", ") || "nothing"}`,
  );

  const clauses = [...new Map([...retrieved, ...amendmentClauses].map((c) => [c.id, c])).values()];

  // 4. One model call.
  const context = (await Promise.all(clauses.map(formatClause))).join("\n\n");
  const completion = await timed(
    "answer",
    () =>
      resolveGenerator().run([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Contract clauses:\n\n${context}\n\nQuestion: ${question}` },
      ]),
    (c) => `${c.usage.inputTokens} in / ${c.usage.outputTokens} out tokens`,
  );

  const lookupMs = steps.filter((s) => s.name !== "answer").reduce((total, s) => total + s.ms, 0);

  return {
    question,
    answer: completion.text,
    steps,
    llmCalls: 1,
    usage: completion.usage,
    activeMs: lookupMs + completion.ms,
    wallMs: Date.now() - started,
    clauses,
  };
}
