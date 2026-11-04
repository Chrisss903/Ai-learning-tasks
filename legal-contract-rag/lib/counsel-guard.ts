/**
 * Week 12: this is a lookup tool, not an opinion generator. A prompt that asks
 * the model not to call a clause "standard" is a request; this is the
 * enforcement. Every answer passes through `enforceCounselLine` before it
 * leaves the app, and the same patterns are the eval suite's assertion.
 */
export const ADVICE_PATTERNS: { name: string; pattern: RegExp }[] = [
  // "is standard", "is not standard", "isn't unusual", "standard clause" — a verdict either way.
  { name: "standard", pattern: /\b(?:is|are|was|were|looks?|seems?|appears?|isn't|aren't)\s+(?:not\s+|quite\s+|fairly\s+|very\s+|rather\s+|particularly\s+)*(?:standard|typical|customary|usual|normal|common|unusual|atypical|uncommon|non-standard)\b|\b(?:non-)?standard (?:clause|term|provision|practice|notice|period)\b|\bnot standard\b/i },
  { name: "acceptable", pattern: /\b(?:acceptable|reasonable|fair|favou?rable|unfavou?rable|market[- ](?:rate|standard|practice))\b/i },
  { name: "looks-fine", pattern: /\b(?:looks?|seems?)\s+(?:fine|ok|okay|good|safe)\b|\bnothing to worry\b|\bno (?:risk|concern)s?\b/i },
  { name: "recommend", pattern: /\byou should (?:sign|accept|agree|reject|negotiate)\b|\bi (?:recommend|advise)\b/i },
];

export const COUNSEL_REFERRAL =
  "I can only report what the documents say; any judgement on the clause belongs to counsel. Please refer this question to the legal team.";

export function adviceHits(answer: string): string[] {
  // A sentence that hands the judgement to counsel ("I cannot judge whether it
  // is standard — that is for counsel") names the word without giving a verdict.
  const asserted = answer
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !/\b(?:counsel|legal team|lawyers?)\b/i.test(sentence))
    .join(" ");
  return ADVICE_PATTERNS.filter(({ pattern }) => pattern.test(asserted)).map(({ name }) => name);
}

/** Questions that ask for a judgement rather than a lookup. */
const JUDGEMENT_QUESTION =
  /\b(?:is (?:this|that|it|the \w+(?: \w+)?) (?:standard|fair|acceptable|reasonable|ok|okay|normal|typical|safe|enforceable|legal|valid)|should (?:we|i) (?:sign|accept|agree|negotiate)|is it (?:a )?(?:good|bad)|market standard|enforceable|legal advice|worth (?:signing|accepting))\b/i;

export const isJudgementQuestion = (question: string) => JUDGEMENT_QUESTION.test(question);

export const mentionsCounsel = (answer: string) => /\b(?:counsel|legal team|lawyer|attorney)\b/i.test(answer);

/**
 * Judgement questions are answered with the facts the documents give plus the
 * referral; any other answer that slips into advice language is replaced.
 */
export function enforceCounselLine(
  question: string,
  answer: string,
): { answer: string; intervened: boolean; reason: string | null } {
  const hits = adviceHits(answer);
  const judgement = isJudgementQuestion(question);

  if (hits.length) {
    // Keep the sentences that only state what the documents say; drop the ones that judge.
    const kept = answer
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => !adviceHits(sentence).length)
      .join(" ")
      .trim();
    const facts = /\[[A-Z]{2,4}[^\]]*§\d+\]/.test(kept) ? `${kept}\n\n` : "";
    return { answer: `${facts}${COUNSEL_REFERRAL}`, intervened: true, reason: `advice language: ${hits.join(", ")}` };
  }
  if (judgement && !mentionsCounsel(answer)) {
    return { answer: `${answer}\n\n${COUNSEL_REFERRAL}`, intervened: true, reason: "judgement question without a referral" };
  }
  return { answer, intervened: false, reason: null };
}
