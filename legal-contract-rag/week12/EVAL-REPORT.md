# Week 12 — Eval report (integrated system)

Model `gemini-3.5-flash-lite`, free tier. System under test = `npm run capstone` path: agent loop → MCP tools (discovered at runtime) → hybrid RAG → counsel guard. Raw output: `week12/eval-full.txt`, `evals/capstone-full.json`.

**Corpus caveat, up front.** The store is the 13 cricket contracts in `documents/` (text, not PDF). It is not 60 executed MSAs, there are no scanned PDFs, no indemnity or limitation-of-liability clauses, and one amended account family (PC-2026-011, SA-2026-001) rather than twelve. Every number below is about *this* corpus.

## Headline numbers

| Metric | Result | n |
|---|---|---|
| Suite pass, as run | **20/22 = 91%** | 22 |
| Same run, C02 re-scored after the refusal-detector fix | 21/22 = 95% (re-scored on the saved answer, not re-run) | 22 |
| Live amendment chain (answer must cite the amending doc) | **5/5** | 5 |
| Judgement question → counsel referral, no advice language | **2/2** after the guard fix (RED run: C03 failed, C04 errored) | 2 |
| Unanswerable (must refuse) | **2/4 as run** (T11 real failure; C02 was a detector bug) | 4 |
| Indemnity / limitation of liability | **0 cases — not covered** | 0 |
| Trajectory (12 cases): outcome / path | **12/12 / 11/12** | 12 |
| Trajectory: tool-choice accuracy | **100%** | 12 |
| Outcome-vs-trajectory gap | **1/12 (T10, wasted step)** | 12 |
| Cost per question (suite run, mean) | **$0.0031** (3.6 model calls); trajectory batch $0.0050 | 22 / 12 |
| Latency per question | **p50 26.3 s, p95 41.7 s** (wall clock on the free tier, includes throttle waits) | 22 |
| **Judge agreement with hand labels on integrated outputs** | **NOT MEASURED — see below** | – |

### The judge number (does not clear the bar)
I have not hand-labelled the 22 integrated outputs — that has to be *your* grade, made before seeing the judge's. `week12/label-sheet.md` + `evals/capstone-labels.json` are ready; fill them and run `npm run capstone -- agreement --label full`.
What the data already shows: **the judge returned "supported" for all 22 answers, "refused" for none** — including answers that are plainly refusals (C02, T10, T12) and T11, which I read as an unsupported inference. A judge that never discriminates is not safe to quote. The only labelled agreement I have is week 11's replay, **5/6 = 83%, below the 85% bar**. The judge also only checks tool-returned excerpts, so it cannot see a clause that should have been fetched.

## Re-scored error taxonomy (integrated system)

Frequencies are over the 22-case run unless stated. One trace id each (full ids in `logs/eval/` or `logs/agent/`).

| # | Mode | Freq | Severity | Trace |
|---|---|---|---|---|
| 1 | **Unsupported inference on an unanswerable question** — T11 answers "cannot broadcast in Australia" from a clause that never mentions Australia; judge says "supported" | 1/22 = 4.5% | **High** (confident wrong answer, passes judge) | `5dca4ce8446c…` |
| 2 | **Advice language in a judgement question** (inherited from the model, *worsened* by the agent's cross-contract comparison): "…is not standard" | 1/1 gradable probe before the guard fix; 0/2 after | **High** (legal advice with the firm's name on it) | `7d2716193a94…` |
| 3 | **Superseded clause quoted** (inherited, week 11) — RAG path only, fixed by `rag-answer@3` | agent path 0/5 amended cases; RAG path was 1/17 before | High | week 11 `bc2b2ed7` |
| 4 | **NEW — created by integration: tool-vocabulary drift across MCP servers.** Vendored server adds `get_amendment_chain`; the week 8 trajectory scorer only knew `find_amendments`, so correct paths were scored BAD (2/11 on the first run) | 2/11 = 18% of trajectory runs (scorer, not agent) | Medium (false alarms hide real regressions) | T07 `de1218b61618…` |
| 5 | **NEW — created by integration: transport/model malformed reply kills a whole case.** Gemini `MALFORMED_RESPONSE` mid-loop; the agent has no retry for it, one case yields no answer | 2 of ~38 agent runs ≈ 5% | Medium | `83d568b1fb7a…` |
| 6 | **Measurement error: refusal detector misses "is not defined"** — C02 (correct behaviour) scored FAIL | 1/22 | Low (eval, not user-facing) | C02 `897918e67330…` |
| 7 | **OCR / scan extraction error** | **n/a — 0 scanned PDFs in this corpus; rate not measurable here.** Named so it is not someone else's backlog: the real corpus needs a measured character/clause-level error rate before any citation from a scan is trusted | unknown, **High** by default | – |

## Closed loops this week (RED → GREEN, seen failing first)
1. **Counsel guard** — `week12/counsel-red.txt` (C03 FAIL, no referral; guard regex missed "is not standard") → agent rule + guard fix → `week12/counsel-green.txt` (found my own referral text tripped the assertion with "standard, acceptable"; reworded) → `week12/eval-full.txt` C03, C04 PASS. n=2, small.
2. **Trace propagation** — before: agent run wrote no trace, the MCP server no log. After: `npm run capstone -- trace <id>` shows host spans and 4/4 server audit lines under one trace id, `hop check: trace id survived every hop`.
3. **C02 undefined-term** — FAIL (detector) → detector fixed; verified deterministically on the saved answer (true). I did **not** get a clean live re-run green: the live re-run happened before the second wording fix.

## What this suite does NOT cover
- Indemnity, limitation of liability, caps — no such clauses in the store (0 cases).
- Scanned documents / OCR error (0 PDFs).
- 12 amended accounts: only 2 amended contract families exist; the bonus "SOW conflicts with MSA, precedence clause decides" was **not built**.
- Governing-law/venue is carried in 1 case (C05) only.
- Multi-turn use, adversarial users, and concurrency. Judge agreement unmeasured.
- Single model, single run per case (no variance estimate); the trajectory batch uses the base agent role, not `CAPSTONE_AGENT`.
- Chain-resolution p50 cost (bonus): not isolated.

## Cost and the 10× plan
- **Cost per contract question: $0.0031** (suite mean, 3.6 calls, ~7,600 tokens); ~100% of it is generation. Retrieval/embedding/MCP ≈ $0.
- **What breaks first at 10×: the provider rate limit, 4.8× over.** Measured cap is 15 calls/min (`week11/tenx.md`). Today's busiest minute is 2 questions; on the agent path that is 2 × 3.6 = 7.2 calls (fits). At 10× it is 72 calls/min vs 15. The cap supports ≈ 4 agent questions/min — well below a sales org. Cost at 10× stays small: 224 questions/day × $0.0031 ≈ $0.69/day.
- **Plan, ranked:** (1) paid tier — removes the cap for a few dollars a month; (2) route simple lookups to the week 3–4 RAG path (1 call, $0.00026) and keep the agent for amendment/multi-contract questions — ~3.6× fewer calls; (3) answer cache (−52% generation calls on replayed traffic, week 11); (4) separate eval quota from production.

---

# Addendum — bonus and re-run (2026-11-04, later)

**Added:** effective-date and chain-citation assertions; 5 bonus cases B01–B05 on the amended accounts (PC-2026-011 / AMD-PC-011-01, SA-2026-001 / AMD-2026-001); agent rule "cite every document in the chain, give the amendment's effective date, only cite what you read".

| | Result | Evidence |
|---|---|---|
| Bonus RED (before the rule) | **1/5 red** (B01), 4/5 already green | `bonus-red.txt` |
| Bonus GREEN (after) | **5/5** | `bonus-green.txt` |
| Full suite, 27 cases, after the prompt change | **26/27 = 96%** (was 20/22 = 91%) | `eval-full2.txt` |
| Live amendment chain, answer cites every link + date | **9/9** | `eval-full2.txt` |

**Not the "all 5 red" the bonus asks for.** The agent already resolved most chains and dates unprompted; only B01 failed — correct answer and date, but it cited base clause `PC-2026-011 §8` that no tool had returned in the run (ungrounded citation). I will not claim 5 red. And the GREEN B01 passed without a `read_section` call, so that fix works on one run, not as a guaranteed behaviour.
**No SOWs exist in the store**, so B03 (amendment vs base, precedence clause §6 decides; Match Fee §5 untouched) stands in for "SOW conflicts with MSA".

**Instability, not a clean win:** the failing case flipped between runs. Run 1 failed T11 (answered an unanswerable question), run 2 passed T11 and failed T10 (agent emitted an invalid reply, no answer produced, fallback text not recognised as a refusal). Single run per case, so 91% → 96% is inside this suite's noise; do not present it as a measured improvement. Unanswerable cases are the unstable group (3/4 and 2/4 across the two runs, n=4).

**Cost of chain resolution (bonus):** across the first run, the 5 amended-chain cases had p50 **26.4 s / 3.8 model calls** vs **24.6 s / 3.2 calls** for 10 plain lookups, about **+1.8 s and +0.6 calls** (n=5 vs 10, free-tier throttle dominates; tool time itself is milliseconds — the cost is the extra model step, not the lookup).

Still not done: judge agreement (needs your labels), fresh-eyes reviewer, any OCR figure, indemnity/liability coverage.
