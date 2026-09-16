import { searchDocuments, type SearchMode, type SearchResult } from "./search";
import { generateAnswer } from "./rag";
import { resolveGenerator } from "./generator";
import { EVAL_SET, type EvalQuestion, type GoldChunk } from "./eval-set";

export type FailureLabel = "pass" | "retrieval" | "generation";

export interface QuestionResult {
  id: string;
  question: string;
  note: string;
  gold: GoldChunk[];
  retrieved: SearchResult[];
  /** 1-based position of the gold chunk, or null if it never showed up. */
  goldRank: number | null;
  retrievalHit: boolean;
  answer: string | null;
  answerOk: boolean | null;
  missing: string[];
  label: FailureLabel;
}

export interface EvalMetrics {
  total: number;
  hits: number;
  hitRate: number;
  mrr: number;
  passed: number;
  retrievalFailures: number;
  generationFailures: number;
}

export interface EvalRun {
  mode: SearchMode;
  k: number;
  withAnswers: boolean;
  /** Which model produced the answers, so a run can be reproduced. */
  generator: string | null;
  metrics: EvalMetrics;
  results: QuestionResult[];
}

/** Chunks start with "4. ACCEPTANCE PROCESS"; the number is the stable part. */
function sectionNumber(section: string): string {
  return section.match(/^(\d+)\./)?.[1] ?? section.trim();
}

function isGold(result: SearchResult, gold: GoldChunk[]): boolean {
  return gold.some(
    (entry) =>
      entry.source === result.source &&
      entry.section === sectionNumber(result.section),
  );
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/,/g, "").replace(/\s+/g, " ");
}

function checkAnswer(answer: string, question: EvalQuestion): string[] {
  const haystack = normalise(answer);

  return question.answerMustInclude.filter(
    (requirement) =>
      !requirement
        .split("|")
        .some((alternative) => haystack.includes(normalise(alternative))),
  );
}

export async function runEvaluation(
  mode: SearchMode,
  options: { k?: number; withAnswers?: boolean } = {},
): Promise<EvalRun> {
  const k = options.k ?? 3;
  const withAnswers = options.withAnswers ?? true;

  const results: QuestionResult[] = [];

  for (const question of EVAL_SET) {
    const retrieved = await searchDocuments(question.question, k, mode);

    const goldIndex = retrieved.findIndex((result) =>
      isGold(result, question.gold),
    );
    const goldRank = goldIndex === -1 ? null : goldIndex + 1;
    const retrievalHit = goldRank !== null;

    let answer: string | null = null;
    let answerOk: boolean | null = null;
    let missing: string[] = [];

    if (withAnswers) {
      answer = await generateAnswer(question.question, retrieved);
      missing = checkAnswer(answer, question);
      answerOk = missing.length === 0;
    }

    // A wrong answer on top of a failed retrieval is still a retrieval
    // problem — fixing the model would not help it.
    const label: FailureLabel = !retrievalHit
      ? "retrieval"
      : answerOk === false
        ? "generation"
        : "pass";

    results.push({
      id: question.id,
      question: question.question,
      note: question.note,
      gold: question.gold,
      retrieved,
      goldRank,
      retrievalHit,
      answer,
      answerOk,
      missing,
      label,
    });
  }

  const total = results.length;
  const hits = results.filter((result) => result.retrievalHit).length;
  const reciprocalRanks = results.reduce(
    (sum, result) => sum + (result.goldRank ? 1 / result.goldRank : 0),
    0,
  );

  return {
    mode,
    k,
    withAnswers,
    generator: withAnswers ? resolveGenerator().label : null,
    metrics: {
      total,
      hits,
      hitRate: total ? hits / total : 0,
      mrr: total ? reciprocalRanks / total : 0,
      passed: results.filter((result) => result.label === "pass").length,
      retrievalFailures: results.filter((result) => result.label === "retrieval")
        .length,
      generationFailures: results.filter(
        (result) => result.label === "generation",
      ).length,
    },
    results,
  };
}
