import type { SearchResult } from "./search";
import type { TestCase, GoldChunk } from "./test-set";

/**
 * Rule-based checks. These cost nothing, are perfectly repeatable, and catch
 * most of what matters — so they run before any LLM judge is consulted.
 */

export interface AssertionResult {
  name: string;
  passed: boolean;
  detail: string;
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

function includesAny(haystack: string, requirement: string): boolean {
  return requirement
    .split("|")
    .some((alternative) => haystack.includes(normalise(alternative)));
}

const REFUSAL_PATTERNS = [
  "i don't know",
  "i do not know",
  "do not contain",
  "does not contain",
  "not contain",
  "no information",
  "cannot determine",
  "not specified in",
  "not mentioned in",
  "unable to answer",
  "not provided in",
];

export function looksLikeRefusal(answer: string): boolean {
  const haystack = normalise(answer);
  return REFUSAL_PATTERNS.some((pattern) => haystack.includes(pattern));
}

/** 1-based rank of the gold chunk, or null if it is absent. */
export function goldRank(
  retrieved: SearchResult[],
  gold: GoldChunk[],
): number | null {
  const index = retrieved.findIndex((result) => isGold(result, gold));
  return index === -1 ? null : index + 1;
}

export function runAssertions(
  testCase: TestCase,
  retrieved: SearchResult[],
  answer: string,
): AssertionResult[] {
  const results: AssertionResult[] = [];
  const haystack = normalise(answer);

  // 1. Did retrieval fetch the clause that answers the question?
  if (testCase.gold.length > 0) {
    const rank = goldRank(retrieved, testCase.gold);
    results.push({
      name: "retrieved-gold",
      passed: rank !== null,
      detail:
        rank !== null
          ? `gold clause at rank ${rank}`
          : `gold clause absent; got ${retrieved
              .map((r) => `${r.source} §${sectionNumber(r.section)}`)
              .join(", ")}`,
    });
  }

  // 2. Did it refuse exactly when it should have?
  const refused = looksLikeRefusal(answer);
  if (testCase.expectRefusal) {
    results.push({
      name: "refused-as-expected",
      passed: refused,
      detail: refused
        ? "declined to answer"
        : "answered a question the corpus cannot support",
    });
  } else {
    results.push({
      name: "did-not-refuse",
      passed: !refused,
      detail: refused ? "refused a question it had the clause for" : "answered",
    });
  }

  // 3. Does the answer state the required fact?
  for (const requirement of testCase.answerMustInclude) {
    results.push({
      name: `states:${requirement}`,
      passed: includesAny(haystack, requirement),
      detail: includesAny(haystack, requirement)
        ? "present"
        : `missing "${requirement}"`,
    });
  }

  // 4. Does it avoid a value an amendment superseded?
  for (const forbidden of testCase.answerMustNotInclude ?? []) {
    const present = includesAny(haystack, forbidden);
    results.push({
      name: `avoids:${forbidden}`,
      passed: !present,
      detail: present ? `stated superseded value "${forbidden}"` : "absent",
    });
  }

  // 5. Citations: present when answering, and pointing at real excerpts.
  const cited = [...answer.matchAll(/\[(\d+)\]/g)].map((match) =>
    Number(match[1]),
  );

  if (!testCase.expectRefusal) {
    results.push({
      name: "cites-a-source",
      passed: cited.length > 0,
      detail: cited.length > 0 ? `cited ${cited.length}` : "no citation",
    });
  }

  const invalid = cited.filter(
    (number) => number < 1 || number > retrieved.length,
  );
  results.push({
    name: "citations-valid",
    passed: invalid.length === 0,
    detail:
      invalid.length === 0
        ? "all citations refer to supplied excerpts"
        : `fabricated citation(s): ${invalid.join(", ")}`,
  });

  return results;
}

/**
 * The answer-only checks, for runs that have no fixed top-3 to grade — the
 * week 7 agent reads as many clauses as it chooses.
 */
export function checkAnswer(
  expected: {
    answerMustInclude: string[];
    answerMustNotInclude?: string[];
    expectRefusal?: boolean;
  },
  answer: string,
): AssertionResult[] {
  const haystack = normalise(answer);
  const refused = looksLikeRefusal(answer);

  const results: AssertionResult[] = [
    expected.expectRefusal
      ? { name: "refused-as-expected", passed: refused, detail: refused ? "declined" : "answered anyway" }
      : { name: "did-not-refuse", passed: !refused, detail: refused ? "refused" : "answered" },
  ];

  for (const requirement of expected.answerMustInclude) {
    const present = includesAny(haystack, requirement);
    results.push({ name: `states:${requirement}`, passed: present, detail: present ? "present" : `missing "${requirement}"` });
  }

  for (const forbidden of expected.answerMustNotInclude ?? []) {
    const present = includesAny(haystack, forbidden);
    results.push({ name: `avoids:${forbidden}`, passed: !present, detail: present ? `stated "${forbidden}"` : "absent" });
  }

  return results;
}
