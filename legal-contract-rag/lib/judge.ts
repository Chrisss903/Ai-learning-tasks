import { resolveGenerator } from "./generator";
import type { SearchResult } from "./search";

/**
 * The clause-answer judge (track F).
 *
 * It grades only what a rule cannot: whether the answer is actually supported
 * by the excerpts it was given (faithfulness), and whether it answers the
 * question that was asked (relevancy).
 *
 * Scoring is binary, not 1-10. A judge asked for a number invents precision it
 * does not have, and two runs disagree on whether an answer is a 6 or a 7 while
 * agreeing perfectly on whether it is supported. Binary verdicts are what can
 * actually be validated against a human.
 */
export type Verdict = "supported" | "unsupported" | "refused";

export interface Judgement {
  verdict: Verdict;
  answersQuestion: boolean;
  reason: string;
}

const SYSTEM_PROMPT = `You grade answers produced by a legal contract assistant.

You are given a QUESTION, the CONTRACT EXCERPTS the assistant was shown, and its ANSWER.

Decide two things.

1. verdict:
   - "supported"   — every factual claim in the answer is stated in the excerpts.
   - "unsupported" — the answer asserts something the excerpts do not support,
                     including a value that an amendment in the excerpts replaced.
   - "refused"     — the answer declines to answer or says it does not know.

2. answersQuestion: true if the answer addresses what was asked, false if it is
   about a different contract, a different clause, or evades the question.

Judge ONLY against the excerpts shown. Do not use outside knowledge about
cricket or contracts. An answer that is factually true in the real world but not
present in the excerpts is "unsupported".

Reply with strict JSON and nothing else:
{"verdict":"supported|unsupported|refused","answersQuestion":true|false,"reason":"one sentence"}`;

function extractJson(text: string): Judgement {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Judge returned no JSON: ${text.slice(0, 200)}`);

  const parsed = JSON.parse(match[0]);
  const verdict: Verdict = ["supported", "unsupported", "refused"].includes(
    parsed.verdict,
  )
    ? parsed.verdict
    : "unsupported";

  return {
    verdict,
    answersQuestion: Boolean(parsed.answersQuestion),
    reason: String(parsed.reason ?? ""),
  };
}

export async function judgeAnswer(
  question: string,
  retrieved: SearchResult[],
  answer: string,
): Promise<Judgement> {
  const excerpts = retrieved
    .map(
      (source, index) =>
        `[${index + 1}] (${source.source} — ${source.section})\n${source.text}`,
    )
    .join("\n\n");

  const response = await resolveGenerator().complete([
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `QUESTION:\n${question}\n\nCONTRACT EXCERPTS:\n${excerpts}\n\nANSWER:\n${answer}`,
    },
  ]);

  return extractJson(response);
}

/**
 * A judge nobody checked is just a confident number. These are my own grades,
 * written by reading the trace before seeing any judge output; the runner
 * reports how often the judge agrees. Below roughly 80 percent agreement the
 * judge's scores should not be quoted.
 */
export interface HumanLabel {
  traceId: string;
  question: string;
  answerSummary: string;
  verdict: Verdict;
  answersQuestion: boolean;
  why: string;
}

export const HUMAN_LABELS: HumanLabel[] = [
  {
    traceId: "W4-Q08",
    question: "What is the termination notice period in PC-2026-027?",
    answerSummary:
      "I don't know. The excerpts do not contain information regarding PC-2026-027; excerpt [1] mentions PC-2026-011.",
    verdict: "refused",
    answersQuestion: false,
    why: "Correctly declined — it was handed the wrong contract's clause and said so rather than guessing.",
  },
  {
    traceId: "W4-Q11",
    question: "What is Rohan Sharma's current annual retainer?",
    answerSummary:
      "13,500,000 rupees [1]; the original 9,000,000 [3] was amended upward on his appointment as vice captain.",
    verdict: "supported",
    answersQuestion: true,
    why: "Took the amended figure and explained the supersession, both present in the excerpts.",
  },
  {
    traceId: "W4-Q13",
    question:
      "How much written notice is needed to terminate the AlphaTech service agreement?",
    answerSummary:
      "60 days [1]; the original agreement specified 30 days [2] and was amended.",
    verdict: "supported",
    answersQuestion: true,
    why: "Correct amended value with the original cited as context.",
  },
  {
    traceId: "W4-Q16",
    question: "A player reached 8 demerit points — how many matches suspended?",
    answerSummary: "Two matches [1].",
    verdict: "supported",
    answersQuestion: true,
    why: "Read 8 points against the banded threshold table correctly.",
  },
  {
    traceId: "W4-OLD-Q13",
    question:
      "How much written notice is needed to terminate the AlphaTech service agreement?",
    answerSummary:
      "I don't know based on the provided excerpts. None of the excerpts mention 'AlphaTech'.",
    verdict: "refused",
    answersQuestion: false,
    why: "Refused although excerpt [1] was the amendment that answers it — the clause just never names the party.",
  },
  {
    traceId: "W4-OLD-Q11",
    question: "How long does Northwind have to pay an invoice under current terms?",
    answerSummary: "Within 30 days of the invoice date [1].",
    verdict: "unsupported",
    answersQuestion: true,
    why: "Stated a superseded figure with no hedging; the amendment replacing it was not in the excerpts.",
  },
];
