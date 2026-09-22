import { TEST_SET } from "./test-set";

/**
 * The cases the agent and the fixed workflow race on.
 *
 * The week 6 test set is reused as-is: it is the app's everyday traffic, one
 * contract and one clause per question. The multi-step cases are the kind of
 * task an agent exists for — two contracts, an amendment to apply, and some
 * arithmetic on top — so the race covers both sides of the decision.
 */
export interface RaceCase {
  id: string;
  type: string;
  question: string;
  /** All must appear in the answer; `|` separates acceptable wordings. */
  answerMustInclude: string[];
  answerMustNotInclude?: string[];
  expectRefusal?: boolean;
  note: string;
}

const MULTI_STEP: RaceCase[] = [
  {
    id: "M01",
    type: "multi-step",
    question:
      "Who has the longer termination notice period today, Rohan Sharma or Dinesh Mendis, and what is each one's period?",
    answerMustInclude: ["sharma", "90 days", "30 days"],
    note: "Two contracts, and Sharma's 60 days was amended to 90 — the original clause makes the comparison come out the same way but with the wrong number.",
  },
  {
    id: "M02",
    type: "multi-step",
    question: "What is the combined current annual retainer of Rohan Sharma and Dinesh Mendis?",
    answerMustInclude: ["20000000|2 crore|20 million|20.0 million"],
    answerMustNotInclude: ["15500000|15.5 million|1.55 crore"],
    note: "13,500,000 (amended) + 6,500,000. Forgetting the amendment gives 15,500,000.",
  },
  {
    id: "M03",
    type: "multi-step",
    question:
      "Rohan Sharma is named in the playing eleven for 10 matches this season. What does he earn in total from his retainer and match fees?",
    answerMustInclude: ["15000000|1.5 crore|15 million|15.0 million"],
    answerMustNotInclude: ["10500000|10.5 million|1.05 crore"],
    note: "13,500,000 amended retainer + 10 × 150,000. The original retainer gives 10,500,000.",
  },
  {
    id: "M04",
    type: "multi-step",
    question:
      "Under the AlphaTech and BetaWorks service arrangement, how much notice is needed to terminate, and how long does BetaWorks have to pay an invoice?",
    answerMustInclude: ["60 days", "30 days"],
    note: "Termination is in SA-2026-001 (amended from 30 to 60 days); payment is in a separate document, PT-2026-001.",
  },
  {
    id: "M05",
    type: "multi-step",
    question:
      "If Arjun Kale is transferred again 12 months later for 50,000,000 rupees, how much does Deccan Falcons receive?",
    answerMustInclude: ["2250000|22.5 lakh|2.25 million"],
    note: "Name → TRF-2026-008; the sell-on clause (§7) never names the player. 15% of the 15,000,000 above 35,000,000.",
  },
];

export const RACE_SET: RaceCase[] = [
  ...TEST_SET.map((testCase) => ({
    id: testCase.id,
    type: testCase.type,
    question: testCase.question,
    answerMustInclude: testCase.answerMustInclude,
    answerMustNotInclude: testCase.answerMustNotInclude,
    expectRefusal: testCase.expectRefusal,
    note: testCase.note,
  })),
  ...MULTI_STEP,
];
