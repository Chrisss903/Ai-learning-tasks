import { TEST_SET, type TestCase } from "./test-set";

/**
 * Week 12: the integrated suite. The 17 week 6/11 cases, now graded on what the
 * agent answers through MCP, plus five cases that only exist because of the
 * capstone brief: a defined term, undefined terms, and judgement questions
 * that must be referred to counsel.
 */
export interface CapstoneCase extends TestCase {
  /** Tools the run must have called, e.g. the defined-term resolver. */
  mustCall?: string[];
  /** The question asks for a judgement; the answer must refer it to counsel. */
  expectCounsel?: boolean;
  /** A live amendment chain: the answer must cite the amending document too. */
  amendmentChain?: boolean;
  /** Every document in the chain that must be cited, not only the one in force. */
  chainDocs?: string[];
  group: "base" | "capstone" | "bonus";
}

const CHAINS = new Set(["T07", "T08", "T09", "T17"]);

const base: CapstoneCase[] = TEST_SET.map((c) => ({ ...c, group: "base", amendmentChain: CHAINS.has(c.id) }));

export const CAPSTONE_CASES: CapstoneCase[] = [
  ...base,
  {
    id: "C01", group: "capstone", type: "straightforward",
    question: 'What does "Match Fee" mean in Rohan Sharma\'s contract PC-2026-011?',
    gold: [{ source: "player-contract-sharma.txt", section: "2" }],
    answerMustInclude: ["amount payable", "named in the playing eleven"],
    mustCall: ["resolve_defined_term"],
    note: "Defined term must come from the definitions clause via the resolver tool.",
  },
  {
    id: "C02", group: "capstone", type: "unanswerable",
    question: 'What does "Affiliate" mean under the franchise agreement?',
    gold: [], answerMustInclude: [], expectRefusal: true,
    mustCall: ["resolve_defined_term"],
    note: "Not defined in the store: must say so, not supply the ordinary meaning.",
  },
  {
    id: "C03", group: "capstone", type: "superseded-value",
    question: "Is the 90-day termination notice in Rohan Sharma's contract standard?",
    gold: [{ source: "amendment-pc-2026-011-01.txt", section: "3" }],
    answerMustInclude: ["90"], expectCounsel: true, amendmentChain: true,
    note: "Judgement question over an amended clause: state the fact, refer the judgement.",
  },
  {
    id: "C04", group: "capstone", type: "straightforward",
    question: "Should we accept the 30-day termination notice in Dinesh Mendis's contract?",
    gold: [{ source: "player-contract-mendis.txt", section: "8" }],
    answerMustInclude: ["30"], expectCounsel: true,
    note: "Advice request: lookup only, then refer to counsel.",
  },
  {
    id: "C05", group: "capstone", type: "straightforward",
    question: "Which court has jurisdiction over disputes in Rohan Sharma's contract?",
    gold: [{ source: "player-contract-sharma.txt", section: "11" }],
    answerMustInclude: ["chennai"],
    note: "Governing law / venue must be carried into the answer.",
  },

  // ── Bonus: resolve the chain, cite every link. No SOWs exist in this store, so
  // "SOW conflicts with the MSA" is the amendment-versus-base precedence case (B03).
  {
    id: "B01", group: "bonus", type: "superseded-value", amendmentChain: true,
    question: "What is Rohan Sharma's current termination notice period, and when did the change take effect?",
    gold: [{ source: "amendment-pc-2026-011-01.txt", section: "3" }],
    answerMustInclude: ["90", "1 january 2026"], chainDocs: ["PC-2026-011", "AMD-PC-011-01"],
    note: "Chain: base §8 (60) superseded by AMD-PC-011-01 §3 (90), effective 1 Jan 2026. Cite both and the date.",
  },
  {
    id: "B02", group: "bonus", type: "superseded-value", amendmentChain: true,
    question: "What notice must be given to terminate the AlphaTech service agreement, and from what date does that apply?",
    gold: [{ source: "contract-amendment.txt", section: "2" }],
    answerMustInclude: ["60", "october 1, 2026|1 october 2026"], chainDocs: ["SA-2026-001", "AMD-2026-001"],
    note: "Chain: SA-2026-001 §5 (30) superseded by AMD-2026-001 §2 (60), effective 1 Oct 2026.",
  },
  {
    id: "B03", group: "bonus", type: "superseded-value", amendmentChain: true,
    question: "If Rohan Sharma's contract PC-2026-011 and its amendment conflict, which controls, and does that change his Match Fee?",
    gold: [{ source: "amendment-pc-2026-011-01.txt", section: "6" }],
    answerMustInclude: ["150000|150,000", "amend"], chainDocs: ["PC-2026-011", "AMD-PC-011-01"],
    note: "Precedence clause decides: amendment controls only for sections it amends; Match Fee (§5) unchanged.",
  },
  {
    id: "B04", group: "bonus", type: "superseded-value", amendmentChain: true,
    question: "What was the AlphaTech service agreement's termination notice before the amendment, and what replaced it?",
    gold: [{ source: "service-agreement.txt", section: "5" }],
    answerMustInclude: ["30", "60"], chainDocs: ["SA-2026-001", "AMD-2026-001"],
    note: "Counsel needs what was superseded, not only what survived: both values, both documents.",
  },
  {
    id: "B05", group: "bonus", type: "straightforward",
    question: "Which law governs the AlphaTech service agreement SA-2026-001, and from what date is it effective?",
    gold: [{ source: "service-agreement.txt", section: "8" }],
    answerMustInclude: ["india", "august 1, 2026|1 august 2026"], chainDocs: ["SA-2026-001"],
    note: "Governing law and effective date carried into the answer.",
  },
];
