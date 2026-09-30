import type { TrajectoryExpectation } from "./trajectory";

/**
 * The batch the agent is judged on, and what a sound path looks like for each.
 *
 * Twelve cases from the week 6/7 sets, chosen to cover every problem type:
 * sibling contracts, orphaned clauses, amended values, unanswerable questions,
 * plain lookups, and multi-contract questions.
 */
export const TRAJECTORY_BATCH: TrajectoryExpectation[] = [
  // Sibling contracts — the id is in the question, so every search can be scoped.
  { caseId: "T01", targets: ["PC-2026-027"], mustCheckAmendments: [], maxSteps: 4 },
  { caseId: "T02", targets: ["PC-2026-027"], mustCheckAmendments: [], maxSteps: 4 },

  // Orphaned clauses — the name has to be turned into an id first.
  { caseId: "T04", targets: ["PC-2026-027"], mustCheckAmendments: [], maxSteps: 5 },
  { caseId: "T05", targets: ["TRF-2026-008"], mustCheckAmendments: [], maxSteps: 4 },

  // Amended values — answering without checking the amendment is the wrong path.
  { caseId: "T07", targets: ["PC-2026-011"], mustCheckAmendments: ["PC-2026-011"], maxSteps: 5 },
  { caseId: "T08", targets: ["PC-2026-011"], mustCheckAmendments: ["PC-2026-011"], maxSteps: 5 },
  { caseId: "T09", targets: ["SA-2026-001"], mustCheckAmendments: ["SA-2026-001"], maxSteps: 5 },

  // Unanswerable — the corpus has no answer, so it may look anywhere for one.
  { caseId: "T10", targets: [], mustCheckAmendments: [], maxSteps: 5 },
  { caseId: "T12", targets: [], mustCheckAmendments: [], maxSteps: 5 },

  // Plain lookup, no id in the question: a corpus-wide search is the right move.
  { caseId: "T13", targets: [], mustCheckAmendments: [], maxSteps: 4 },

  // Multi-contract, with an amendment on one side.
  { caseId: "M01", targets: ["PC-2026-011", "PC-2026-027"], mustCheckAmendments: ["PC-2026-011"], maxSteps: 7 },
  { caseId: "M03", targets: ["PC-2026-011"], mustCheckAmendments: ["PC-2026-011"], maxSteps: 6 },
];
