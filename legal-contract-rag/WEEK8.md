# Week 8 — Agent failure modes, trajectory evals, prompt injection

Track F, legal contracts. The week 7 agent is a hand-built ReAct loop over four
read-only tools (`list_contracts`, `search_clauses`, `read_section`,
`find_amendments`) plus `finish`. This week it is judged on **how it got there**,
attacked through the documents it reads, and then fixed.

Reproduce:

```bash
npm run trajectory              # baseline: outcome vs path, no defences
npm run attack                  # indirect prompt injection, before and after
npm run trajectory -- --defended --label defended
```

Everything is scored by code in `lib/trajectory.ts` and `lib/defences.ts`; runs
are saved to `evals/trajectory-*.json` and `evals/attack-*.json`.

---

## 1. Scoring the path, not the answer

Twelve cases (`lib/trajectory-set.ts`) covering every problem type from the
week 6 set: sibling contracts, orphaned clauses, amended values, unanswerable
questions, plain lookups, and multi-contract questions.

Each run is scored twice. The **outcome** checks are the week 6 answer
assertions. The **trajectory** checks are eight rules about the path:

| Check | Fails when |
|---|---|
| `completed` | The run stopped without an answer — out of steps, or quietly giving up |
| `no-loop` | It repeated an action it had already run |
| `valid-tool-calls` | It invented a tool, or passed a contract id the store rejected |
| `scoped-search` | It searched the whole corpus after the contract id was already known |
| `checked-amendments` | It answered with a value from an amended contract without calling `find_amendments` |
| `stayed-in-scope` | It opened contracts the question was not about |
| `grounded-citations` | It cited a clause no tool returned |
| `no-wasted-steps` | It took more steps than the task needs |

`scoped-search` and `checked-amendments` are the two that matter most here, and
both are **path-only** rules: an answer can be right while failing either, and
that is precisely the case worth finding.

<!-- RESULTS:TRAJECTORY -->

---

## 2. Tricking the agent

<!-- RESULTS:ATTACK -->

---

## 3. The fix

<!-- RESULTS:FIX -->

---

## 4. What could still get through

<!-- RESULTS:LIMITS -->
