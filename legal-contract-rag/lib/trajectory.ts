import type { AgentRun, AgentStep } from "./agent";
import { citationsIn } from "./defences";
import { TOOLS } from "./tools";

/**
 * Week 8: scoring the path, not the answer.
 *
 * An answer can be right for the wrong reason — the value was quoted from a
 * clause the agent never checked for amendments, or it was found by a search
 * that happened to land on the right contract. That path gives a wrong answer
 * the moment a detail changes, so it is scored separately here.
 */
export interface TrajectoryExpectation {
  caseId: string;
  /** Contracts a sound answer comes from. Empty when the question is corpus-wide. */
  targets: string[];
  /** Contracts whose amendments must be consulted before answering. */
  mustCheckAmendments: string[];
  /** The longest path that is still a sensible one. */
  maxSteps: number;
}

export interface TrajectoryCheck {
  name: string;
  passed: boolean;
  detail: string;
}

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

const isToolCall = (step: AgentStep) => TOOL_NAMES.has(step.action);

/** A tool call the store rejected: a contract or section that does not exist. */
function isBadInput(step: AgentStep): boolean {
  return (
    /^No contract has id/.test(step.observation) ||
    /has no section \d/.test(step.observation) ||
    /needs a "query"/.test(step.observation)
  );
}

function contractIdOf(step: AgentStep): string | null {
  const value = step.input.contract_id;
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : null;
}

export function scoreTrajectory(
  run: AgentRun,
  expectation: TrajectoryExpectation,
): TrajectoryCheck[] {
  const checks: TrajectoryCheck[] = [];
  const toolCalls = run.steps.filter(isToolCall);
  const targets = expectation.targets.map((id) => id.toUpperCase());

  // 1. Did it finish under its own power, rather than run out or give up quietly?
  checks.push({
    name: "completed",
    passed: run.stopReason === "finished" && Boolean(run.answer),
    detail: run.answer ? `stopped: ${run.stopReason}` : `no answer (${run.stopReason})`,
  });

  // 2. Loops: the same action twice is the loop the limits exist to catch.
  const repeated = run.steps.filter((step) => step.observation.startsWith("You already ran this"));
  checks.push({
    name: "no-loop",
    passed: repeated.length === 0,
    detail: repeated.length ? `${repeated.length} repeated action(s)` : "no repeated actions",
  });

  // 3. Wrong tool or invented input.
  const unknownTool = run.steps.filter(
    (step) => step.action !== "finish" && !TOOL_NAMES.has(step.action),
  );
  const badInputs = toolCalls.filter(isBadInput);
  checks.push({
    name: "valid-tool-calls",
    passed: unknownTool.length === 0 && badInputs.length === 0,
    detail:
      unknownTool.length || badInputs.length
        ? `${unknownTool.length} unknown tool/invalid reply, ${badInputs.length} rejected input(s)`
        : `${toolCalls.length} tool calls, all accepted`,
  });

  // 4. Scoped search. Once the contract is known, an unscoped search is the
  //    path that fetches the sibling contract's clause and gets lucky.
  if (targets.length) {
    const unscoped = toolCalls.filter(
      (step) => step.action === "search_clauses" && !contractIdOf(step),
    );
    checks.push({
      name: "scoped-search",
      passed: unscoped.length === 0,
      detail: unscoped.length
        ? `${unscoped.length} search(es) across the whole corpus`
        : "searches scoped to a contract",
    });
  }

  // 5. Amendments consulted where an amendment exists.
  if (expectation.mustCheckAmendments.length) {
    const checked = new Set(
      toolCalls
        .filter((step) => step.action === "find_amendments")
        .map(contractIdOf)
        .filter((id): id is string => Boolean(id)),
    );
    const missing = expectation.mustCheckAmendments
      .map((id) => id.toUpperCase())
      .filter((id) => !checked.has(id));

    checks.push({
      name: "checked-amendments",
      passed: missing.length === 0,
      detail: missing.length ? `never checked ${missing.join(", ")}` : "amendments checked",
    });
  }

  // 6. Stayed on the contracts the question is about.
  if (targets.length) {
    const strayed = toolCalls
      .map(contractIdOf)
      .filter((id): id is string => Boolean(id))
      .filter((id) => !targets.includes(id) && !id.startsWith("AMD"));

    checks.push({
      name: "stayed-in-scope",
      passed: strayed.length === 0,
      detail: strayed.length ? `also opened ${[...new Set(strayed)].join(", ")}` : "no stray contracts",
    });
  }

  // 7. Citations that point at clauses a tool actually returned.
  const invented = run.answer
    ? [...new Set(citationsIn(run.answer))].filter((citation) => !run.observedLabels.includes(citation))
    : [];
  checks.push({
    name: "grounded-citations",
    passed: invented.length === 0,
    detail: invented.length ? `cited unread ${invented.join(", ")}` : "citations were all read",
  });

  // 8. Wasted work: the budget it burned beyond a sensible path.
  checks.push({
    name: "no-wasted-steps",
    passed: run.steps.length <= expectation.maxSteps,
    detail: `${run.steps.length} steps (sensible ≤ ${expectation.maxSteps})`,
  });

  return checks;
}

/** Share of tool calls that were a real tool with inputs the store accepted. */
export function toolChoiceAccuracy(run: AgentRun): number | null {
  const attempts = run.steps.filter((step) => step.action !== "finish");
  if (!attempts.length) return null;

  const good = attempts.filter((step) => isToolCall(step) && !isBadInput(step));
  return good.length / attempts.length;
}
