/**
 * The test set.
 *
 * Every case is tagged with a problem type, so a change can be scored per
 * problem type rather than as one blended number that hides regressions.
 *
 * Cases marked `regression: true` are failures this app actually produced, not
 * hypotheticals — they are pinned here so they cannot come back unnoticed.
 */

export type ProblemType =
  | "wrong-contract"
  | "orphaned-clause"
  | "superseded-value"
  | "unanswerable"
  | "straightforward";

export const PROBLEM_TYPES: Record<ProblemType, string> = {
  "wrong-contract":
    "Fetched the right kind of clause from the wrong contract — sibling agreements share clause wording, so only the contract id separates them.",
  "orphaned-clause":
    "The answering clause never names its own contract or party, so a question phrased with a name cannot reach it.",
  "superseded-value":
    "An amendment replaced a value; the answer must use the amended one, not the original sitting next to it.",
  unanswerable:
    "The corpus does not contain the answer. The app must refuse rather than invent one.",
  straightforward:
    "A plain lookup with no trap. These exist to catch regressions caused by fixing the others.",
};

export interface GoldChunk {
  source: string;
  /** Section number as it appears at the start of the chunk, e.g. "4". */
  section: string;
}

export interface TestCase {
  id: string;
  type: ProblemType;
  question: string;
  /** Empty for unanswerable cases — nothing in the corpus should match. */
  gold: GoldChunk[];
  /** All must appear in the answer; `|` separates acceptable wordings. */
  answerMustInclude: string[];
  /** The answer must NOT contain these — used to catch superseded values. */
  answerMustNotInclude?: string[];
  /** True when the correct behaviour is to decline to answer. */
  expectRefusal?: boolean;
  /** A failure this app actually produced, pinned as a permanent test. */
  regression?: boolean;
  note: string;
}

export const TEST_SET: TestCase[] = [
  // ---- wrong-contract -----------------------------------------------------
  {
    id: "T01",
    type: "wrong-contract",
    question: "What is the termination notice period in PC-2026-027?",
    gold: [{ source: "player-contract-mendis.txt", section: "8" }],
    answerMustInclude: ["30 days"],
    answerMustNotInclude: ["90 days"],
    regression: true,
    note: "Week 4 failure: retrieved the amendment to PC-2026-011 and answered about the wrong player's contract.",
  },
  {
    id: "T02",
    type: "wrong-contract",
    question: "What is the match fee in PC-2026-027?",
    gold: [{ source: "player-contract-mendis.txt", section: "5" }],
    answerMustInclude: ["110000|1.1 lakh"],
    answerMustNotInclude: ["150000"],
    regression: true,
    note: "Week 4 failure: the correct clause never entered the top 3; sibling contract clauses outranked it.",
  },
  {
    id: "T03",
    type: "wrong-contract",
    question: "How many days before the first match must the player report under PC-2026-011?",
    gold: [{ source: "player-contract-sharma.txt", section: "6" }],
    answerMustInclude: ["14 days"],
    answerMustNotInclude: ["7 days"],
    note: "The sibling contract says 7 days, so a near miss produces a plausible wrong number.",
  },

  // ---- orphaned-clause ----------------------------------------------------
  {
    id: "T04",
    type: "orphaned-clause",
    question: "Where are disputes under Dinesh Mendis's player contract resolved?",
    gold: [{ source: "player-contract-mendis.txt", section: "11" }],
    answerMustInclude: ["singapore"],
    regression: true,
    note: "Week 4 failure under vector-only: the governing law clause never contains the player's name.",
  },
  {
    id: "T05",
    type: "orphaned-clause",
    question: "What is the transfer fee under TRF-2026-008?",
    gold: [{ source: "player-transfer.txt", section: "2" }],
    answerMustInclude: ["35000000|3.5 crore|35 million"],
    regression: true,
    note: "Week 4 failure under vector-only: only the header chunk carries the agreement id.",
  },
  {
    id: "T06",
    type: "orphaned-clause",
    question: "How is Rohan Sharma's retainer paid out across the year?",
    gold: [{ source: "player-contract-sharma.txt", section: "4" }],
    answerMustInclude: ["three|3"],
    note: "The instalment schedule clause names neither the player nor the contract id.",
  },

  // ---- superseded-value ---------------------------------------------------
  {
    id: "T07",
    type: "superseded-value",
    question: "What is Rohan Sharma's current annual retainer?",
    gold: [{ source: "amendment-pc-2026-011-01.txt", section: "2" }],
    answerMustInclude: ["13500000|1.35 crore|13.5 million"],
    note: "The original 9,000,000 clause is usually retrieved alongside the amendment.",
  },
  {
    id: "T08",
    type: "superseded-value",
    question: "What is the current termination notice period for PC-2026-011?",
    gold: [{ source: "amendment-pc-2026-011-01.txt", section: "3" }],
    answerMustInclude: ["90 days"],
    note: "The original contract says 60 days; the amendment replaced it with 90.",
  },
  {
    id: "T09",
    type: "superseded-value",
    question: "How much written notice is needed to terminate the AlphaTech service agreement?",
    gold: [{ source: "contract-amendment.txt", section: "2" }],
    answerMustInclude: ["60 days"],
    regression: true,
    note: "Observed generation failure: the amendment clause was retrieved at rank 1 and the model still refused it, because that clause never names AlphaTech.",
  },

  // ---- unanswerable -------------------------------------------------------
  {
    id: "T10",
    type: "unanswerable",
    question: "What is the notice period to end the stadium agreement?",
    gold: [],
    answerMustInclude: [],
    expectRefusal: true,
    note: "VEN-2026-005 has a cancellation clause but no termination clause. The app must not borrow one from another contract.",
  },
  {
    id: "T11",
    type: "unanswerable",
    question: "Can Meridian Sports Network show matches in Australia?",
    gold: [],
    answerMustInclude: [],
    expectRefusal: true,
    note: "BRD-2026-002 defers other territories to Annex I, which is not in the corpus.",
  },
  {
    id: "T12",
    type: "unanswerable",
    question: "What is the buyout clause in Rohan Sharma's contract?",
    gold: [],
    answerMustInclude: [],
    expectRefusal: true,
    note: "No buyout clause exists anywhere in the corpus. Termination clauses are the tempting near miss.",
  },

  // ---- straightforward ----------------------------------------------------
  {
    id: "T13",
    type: "straightforward",
    question: "How many overseas players may appear in the playing eleven?",
    gold: [{ source: "franchise-agreement.txt", section: "7" }],
    answerMustInclude: ["4|four"],
    note: "Plain lookup. The same clause also caps squad size, so the right number must be picked.",
  },
  {
    id: "T14",
    type: "straightforward",
    question: "A player has just reached 8 demerit points. How many matches is he suspended for?",
    gold: [{ source: "code-of-conduct.txt", section: "6" }],
    answerMustInclude: ["two matches|2 matches"],
    note: "Reasoning over a retrieved threshold table.",
  },
  {
    id: "T15",
    type: "straightforward",
    question: "How quickly must a player report to doping control after being selected?",
    gold: [{ source: "anti-doping-policy.txt", section: "5" }],
    answerMustInclude: ["60 minutes"],
    note: "Distinctive vocabulary appearing in only one clause.",
  },
  {
    id: "T16",
    type: "straightforward",
    question: "What share of net ticket revenue does the club keep for a home match?",
    gold: [{ source: "stadium-agreement.txt", section: "4" }],
    answerMustInclude: ["80"],
    note: "Plain lookup with a competing 20 percent in the same sentence.",
  },
];
