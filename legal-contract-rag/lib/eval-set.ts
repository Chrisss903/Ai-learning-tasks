/**
 * The evaluation set. Each question has exactly one clause that should answer
 * it (`gold`) and one fact the answer has to state (`answerMustInclude`).
 *
 * Those two fields are what separate the failure kinds: gold missing from the
 * top-k is a retrieval failure, gold present but the fact missing is a
 * generation failure.
 *
 * `answerMustInclude` entries must all appear in the answer; a `|` inside an
 * entry lists acceptable wordings of the same fact. Commas are stripped before
 * matching, so "13,500,000" and "13500000" are the same.
 */
export interface GoldChunk {
  source: string;
  /** Section number as it appears at the start of the chunk, e.g. "4". */
  section: string;
}

export interface EvalQuestion {
  id: string;
  question: string;
  gold: GoldChunk[];
  answerMustInclude: string[];
  /** Why this question is in the set — the trap it is meant to expose. */
  note: string;
}

export const EVAL_SET: EvalQuestion[] = [
  {
    id: "Q01",
    question: "What is the match fee in PC-2026-027?",
    gold: [{ source: "player-contract-mendis.txt", section: "5" }],
    answerMustInclude: ["110000|1.1 lakh"],
    note: "Exact contract id. Two player contracts have near-identical match fee clauses with different amounts.",
  },
  {
    id: "Q02",
    question:
      "How many days before the first league match must the player report to camp under PC-2026-011?",
    gold: [{ source: "player-contract-sharma.txt", section: "6" }],
    answerMustInclude: ["14 days"],
    note: "Exact contract id. The other player contract says 7 days.",
  },
  {
    id: "Q03",
    question: "Which annex lists the prohibited substances in ADP-2026?",
    gold: [{ source: "anti-doping-policy.txt", section: "2" }],
    answerMustInclude: ["annex ii"],
    note: "Answer is an identifier, not a paraphrase. The policy references two different annexes.",
  },
  {
    id: "Q04",
    question:
      "Under SPN-2026-014, what bonus does the sponsor pay if the team wins the final?",
    gold: [{ source: "sponsorship-agreement.txt", section: "6" }],
    answerMustInclude: ["20000000|2 crore|20 million"],
    note: "Exact agreement id. Several documents contain large rupee figures.",
  },
  {
    id: "Q05",
    question:
      "Which exhibit sets out the stadium hire charges under VEN-2026-005?",
    gold: [{ source: "stadium-agreement.txt", section: "3" }],
    answerMustInclude: ["exhibit b"],
    note: "The answer is the exhibit letter, which only keyword matching preserves exactly.",
  },
  {
    id: "Q06",
    question: "What is the transfer fee under TRF-2026-008?",
    gold: [{ source: "player-transfer.txt", section: "2" }],
    answerMustInclude: ["35000000|3.5 crore|35 million"],
    note: "Exact agreement id. The same figure reappears in the sell-on clause.",
  },
  {
    id: "Q07",
    question: "Which annex covers digital streaming rights in BRD-2026-002?",
    gold: [{ source: "broadcast-rights.txt", section: "3" }],
    answerMustInclude: ["annex iii"],
    note: "Annex I and Annex III both appear in this agreement, so the numeral matters.",
  },
  {
    id: "Q08",
    question: "What is the termination notice period in PC-2026-027?",
    gold: [{ source: "player-contract-mendis.txt", section: "8" }],
    answerMustInclude: ["30 days"],
    note: "Two player contracts, two notice periods (60 and 30 days). Only the id separates them.",
  },
  {
    id: "Q09",
    question: "What is the season salary cap under FA-2025-003?",
    gold: [{ source: "franchise-agreement.txt", section: "4" }],
    answerMustInclude: ["900000000|90 crore|900 million"],
    note: "Exact agreement id, competing with the franchise fee in the neighbouring clause.",
  },
  {
    id: "Q10",
    question:
      "Where are disputes under Dinesh Mendis's player contract resolved?",
    gold: [{ source: "player-contract-mendis.txt", section: "11" }],
    answerMustInclude: ["singapore"],
    note: "Orphan trap. The governing law clause never contains the player's name — it is only in Section 1.",
  },
  {
    id: "Q11",
    question: "What is Rohan Sharma's current annual retainer?",
    gold: [{ source: "amendment-pc-2026-011-01.txt", section: "2" }],
    answerMustInclude: ["13500000|1.35 crore|13.5 million"],
    note: "Override plus orphan trap. The original says 9,000,000; the amendment raised it but never names the player.",
  },
  {
    id: "Q12",
    question: "What is the current termination notice period for PC-2026-011?",
    gold: [{ source: "amendment-pc-2026-011-01.txt", section: "3" }],
    answerMustInclude: ["90 days"],
    note: "Override trap. The original contract says 60 days; the amendment replaced it with 90.",
  },
  {
    id: "Q13",
    question:
      "How much written notice is needed to terminate the AlphaTech service agreement?",
    gold: [{ source: "contract-amendment.txt", section: "2" }],
    answerMustInclude: ["60 days"],
    note: "Override trap from the week 3 corpus. The original says 30 days; AMD-2026-001 replaced it with 60.",
  },
  {
    id: "Q14",
    question: "How long do demerit points stay on a player's record?",
    gold: [{ source: "code-of-conduct.txt", section: "6" }],
    answerMustInclude: ["24 months|two years|2 years"],
    note: "Control question. Distinctive vocabulary that appears in only one clause.",
  },
  {
    id: "Q15",
    question:
      "How quickly must a player report to doping control after being selected for testing?",
    gold: [{ source: "anti-doping-policy.txt", section: "5" }],
    answerMustInclude: ["60 minutes"],
    note: "Control question. Plain semantic match, no identifier needed.",
  },
  {
    id: "Q16",
    question:
      "A player has just reached 8 demerit points. How many matches is he suspended for?",
    gold: [{ source: "code-of-conduct.txt", section: "6" }],
    answerMustInclude: ["two matches|2 matches"],
    note: "Reasoning over a retrieved threshold table. A miss here is generation, not retrieval.",
  },
  {
    id: "Q17",
    question: "What late payment charge applies to overdue AlphaTech invoices?",
    gold: [{ source: "payment-terms.txt", section: "3" }],
    answerMustInclude: ["1.5"],
    note: "Control question from the week 3 corpus.",
  },
  {
    id: "Q18",
    question: "How is net ticket revenue split for a home match?",
    gold: [{ source: "stadium-agreement.txt", section: "4" }],
    answerMustInclude: ["80"],
    note: "Control question. Only one document covers match day revenue.",
  },
  {
    id: "Q19",
    question: "What is the sanction for a Level 3 offence?",
    gold: [{ source: "code-of-conduct.txt", section: "4" }],
    answerMustInclude: ["one match|1 match"],
    note: "Short code (Level 3) sitting among four near-identical offence clauses.",
  },
  {
    id: "Q20",
    question:
      "How many overseas players may appear in the playing eleven?",
    gold: [{ source: "franchise-agreement.txt", section: "7" }],
    answerMustInclude: ["4|four"],
    note: "Control question. The same clause also caps squad size, so the model must pick the right number.",
  },
];
