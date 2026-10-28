# Week 11: Find the answer that cited the wrong termination clause

Track F, legal contracts. The complaint was: *"a lawyer said it cited the wrong clause on termination, maybe Thursday"*, with no trace id, contract or time. This week the app logs every request as a trace and gained a drill tool that finds an answer from a vague complaint. The failure became an eval case that was seen failing before the fix and passing after it, and the fix shipped as a versioned prompt with a canary and a rollback.

**The failure is real, and the app still produces it under the old prompt.** Asked *"How much notice does Rohan Sharma need to give to terminate his contract?"*, `rag-answer@1` answers **"60 days [3]"**, and `[3]` is PC-2026-011 §8 as originally signed. Amendment AMD-PC-011-01 §3 replaced that clause with 90 days, and it never reached the model. The LLM judge rates the answer "supported", because the clause it cites really does say 60 days. Only a rule that knows which clause should be cited catches it.

| Requirement | Result | Evidence |
|---|---|---|
| 1. Find it from logs, mm:ss and slice | Rehearsal: **time + user (role) + input type** cut 161 requests to 2 in the first query. **The graded run needs a squadmate to plant and time it, and is not done yet.** | [week11/drill.md](week11/drill.md), [drill-procedure.md](week11/drill-procedure.md) |
| 2. The trace | Per-span latency, tokens and cost, prompt version, context ids | [week11/trace.json](week11/trace.json) |
| 3. RED → GREEN with suite counts | **14/17 → 17/17**, nothing regressed | [evals/cases/T17-sharma-termination-notice.json](evals/cases/T17-sharma-termination-notice.json), [suite-red.txt](week11/suite-red.txt), [suite-green.txt](week11/suite-green.txt) |
| 4. Fix, version bump, canary and rollback | `rag-answer@1` → `rag-answer@3`, with a two-line plan | [lib/prompts.ts](lib/prompts.ts), [week11/canary.md](week11/canary.md) |
| 5. Cost by stage, and 10× | $0.000131 per query, 97.8% generation. **At 10× the rate limit breaks first: 20 a minute against a measured cap of 15.** | [week11/cost_by_stage.md](week11/cost_by_stage.md), [week11/tenx.md](week11/tenx.md) |

---

## 1. What every request now logs

`askQuestion` (`lib/rag.ts`) runs each request as a trace (`lib/telemetry.ts`) and writes one JSON line to `logs/requests/YYYY-MM-DD.jsonl`. A record holds:

- who asked, and their role;
- the input type and the contracts the question names;
- the prompt version;
- every excerpt the model was shown, as `[n]` → chunk id and clause label;
- the answer;
- one span per step (embedding, Qdrant, BM25, fusion, lookups, model call), each with its time, tokens and cost, split into retrieval, generation and tools;
- the time spent queued behind the rate limiter.

The field-by-field reasons are in [week11/logging.md](week11/logging.md). The tracing is hand-built, with OpenTelemetry field names and no new dependency.

`npm run logs` is the drill tool:

- slices: `--day`, `--since`/`--until`, `--user`, `--role`, `--type`, `--prompt`, `--cost-outlier`, `--slow`;
- searches: `--q` (questions), `--a` (answers) and `--ctx` (context ids);
- commands: `show`, `export`, `cost`, `slices`, and `to-case`, which drafts an eval case from a trace.

## 2. The drill (rehearsal)

The haystack is last week's traffic, replayed through the real pipeline: 160 requests from 8 people over 19–27 October. Every answer, token and millisecond is real; the users and arrival times are simulated and marked `clock: "simulated"`. One request was planted into Thursday afternoon under `rag-answer@1`, as a.iyer (a lawyer).

`npm run logs -- find --day thu --role lawyer --type termination` returned 2 of 161. One had refused. The other cited `[3] PC-2026-011 §8` for Sharma's notice period. Because the context ids are logged, the diagnosis takes one hop: the amendment is not among the three excerpts, so retrieval served the superseded text and the model read correctly what it was given.

**The rehearsal cannot measure time-to-find**, because I planted the answer myself. It does name the field a stranger would have missed. Logs alone could not say that §8 *is* superseded; that took knowing the amendment exists. The field is `output.cited_clauses` with `superseded_by`, which is the bonus.

The haystack also showed **the bug was not a one-off.** Of last week's 22 termination requests, 11 refused answerable questions and 1 more cited another contract's clause.

## 3. The loop: RED → GREEN

The case came straight from the trace (`npm run logs -- to-case bc2b2ed7 --id T17`). It is one JSON file in `evals/cases/`, which the Week 6 suite now loads. It requires three things: the answer states 90 days, it **cites the amendment clause**, and it never cites Mendis's PC-2026-027 §8. The new `cites-gold` assertion resolves `[n]` to the excerpt the model was shown. It does not forbid the words "60 days", because "90 days, replacing the original 60" is a correct answer.

The suite now runs the same `askQuestion` path production serves, pinned with `--prompt`. `--compare` lists every case whose verdict changed, so one fixed case cannot hide another that broke.

| Run | Prompt | Pass | What it showed |
|---|---|---|---|
| RED, first attempt | `@1` | 12/17 | T11 and T12 refused correctly, but the judge labelled their "I don't know" as "supported". It labelled the identical answer on T10 "refused". The measuring tool was fixed first: the judge prompt now says a refusal is always "refused", and the judge can only veto a refusal case for an unsupported claim. → [suite-red-first-run-judge-mislabels.txt](week11/suite-red-first-run-judge-mislabels.txt) |
| **RED** | `@1` | **14/17** | **T17 fails** on `retrieved-gold`, `states:90 days` and `cites-gold`, with the judge saying "supported". T01 and T02, both about PC-2026-027 and failing since Week 4, fail too. The run happened before `@2` or `@3` existed. → [suite-red.txt](week11/suite-red.txt) |
| Rejected | `@2` | 16/17 | Fixed T01, T02 and T17, and **regressed T06**. `@2` labelled Sharma's §4 "replaced by" the amendment, but the amendment changes only the retainer amount; the instalment schedule still stands. The judge believed the label and failed a correct answer. A model reading that label could drop a term still in force just as easily. → [suite-v2-rejected.txt](week11/suite-v2-rejected.txt) |
| **GREEN** | `@3` | **17/17** | The same change, with the amendment described as changing a section rather than replacing it. FIXED T01, T02 and T17; *"Nothing that passed before fails now."* Judge agreement with the human labels was 5/6 (83%). → [suite-green.txt](week11/suite-green.txt) |

Judge agreement was 4/6 on the RED run. The disagreement that remains on every run (W4-OLD-Q13) is a harness artifact: validation replays *today's* retrieval against a Week 4 answer, so the judge sees AlphaTech in excerpts the human never saw.

## 4. The fix: `rag-answer@3`

Each cause found in the trace gets one change, all in `lib/prompts.ts`:

1. **Search is scoped to the contract the question names.** It uses Week 7's `resolveContracts`, so Mendis's §8 stops appearing for a Sharma question.
2. **The amending clause is attached right after any clause it changes.** It uses `findAmendments`, the same function as the agent's MCP tool, logged as a `tools` span.
3. **Every excerpt is labelled with its contract.** A legend lists who each contract is between.
4. **One prompt rule:** where an amendment and the original differ, the amendment is in force, and another contract's clause is never the answer.

A prompt version pins the system prompt, the excerpt format and the context recipe, because all three decide what the model reads. Versions are immutable once they have produced logs, which is why the rejected `@2` is kept. **Canary:** `PROMPT_CANARY=rag-answer@3:10`, 10% of users by user-id hash. **Rollback:** `PROMPT_VERSION=rag-answer@1`. See [canary.md](week11/canary.md).

**A shadow replay of last week's termination traffic under `@3`** ([replay-termination.txt](week11/replay-termination.txt), `npm run replay`):

- refusals fell from 13/23 to 2/23, and both remaining refusals are the correct "no buyout clause";
- the Sharma-vs-Mendis comparison, sponsorship notice and PC-2026-027 are now answered with the right clause.

## 5. Cost

- **99% of cost is generation.** The found request cost $0.000131: retrieval $0.000003, generation $0.000129, tools $0.
- **The fix costs tokens.** Input rose from 300 to 544 tokens on average, and suite cost per query rose 76%.
- **One improvement, measured: an exact-match answer cache.** Its key is the version, the model, the question and the text of every clause shown. 58% of last week's requests repeated a question. On the replayed termination traffic it hit 11 of 23 times and cut cost per request **from $0.000375 to $0.000179 (−52%)**.
- **A semantic cache was rejected with a number.** The PC-2026-011 and PC-2026-027 termination questions have a cosine similarity of 0.912, higher than two questions about the same player. A semantic cache would serve this week's bug.

See [cost_by_stage.md](week11/cost_by_stage.md).

## 6. At 10×

**The free-tier rate limit breaks first.**

- Today's busiest minute had 2 requests, so 10× is 20 a minute.
- The cap was measured from Google's own 429, `GenerateRequestsPerMinutePerProjectPerModel-FreeTier=15`: 20 concurrent calls gave 3 × 429, each with a 40 s retry.
- Cost at 10× is $0.06 a day.
- The plan: the answer cache (shipped), a throttle matched to the measured cap, and billing, which costs under $2 a month at that volume.

See [tenx.md](week11/tenx.md).

## What's left

- **The graded drill.** A squadmate plants an answer and times the find; [drill-procedure.md](week11/drill-procedure.md) has the steps. Record the result in drill.md. If they plant a new kind of failure, `export`, `cost` and `to-case` regenerate the evidence from its trace id.
- **Bonus.** Add `output.cited_clauses` with `superseded_by`, plant a second answer, and beat the first time.
- **T18, found by the shadow replay and not fixed.** *"What notice does the sponsor need to give to walk away from the deal?"* is answered from the AlphaTech service agreement under both `@1` and `@3`. The question names no contract, because "sponsor" is a generic word to `resolveContracts`, so search is unscoped. It is drafted in [week11/T18-draft-sponsor-walk-away.json](week11/T18-draft-sponsor-walk-away.json), outside `evals/cases/`, so the GREEN counts above stand as run. It is the next loop.

## Reproduce

```bash
export GEMINI_MODEL=gemini-3.5-flash-lite
npm run traffic -- --from 2026-10-19 --to 2026-10-27 --seed 11          # the haystack (~25 min)
npm run ask -- --as a.iyer --at 2026-10-22T15:07:31+05:30 --prompt rag-answer@1 --quiet \
  "How much notice does Rohan Sharma need to give to terminate his contract?"
npm run logs -- find --day thu --role lawyer --type termination        # the drill
npm run logs -- export <id> week11/trace.json && npm run logs -- cost <id>
npm run eval -- --prompt rag-answer@1 --label week11-red --validate     # RED
npm run eval -- --prompt rag-answer@3 --label week11-green --compare week11-red --validate   # GREEN
npm run replay -- --prompt rag-answer@3 --type termination              # shadow canary + cache
```

`logs/` is gitignored, as it was in Week 9, so the haystack lives only on the machine that generated it.
