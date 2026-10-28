# Support drill: "a lawyer said it cited the wrong clause on termination, maybe Thursday"

## Graded run

> **To fill in after the real drill.** A squadmate plants the answer and keeps the trace id to themselves; the steps are in [drill-procedure.md](./drill-procedure.md). The rehearsal below does not count, because I planted that answer myself.

| | |
|---|---|
| Planted and timed by (squadmate) | _name_ |
| Found by | _name_ |
| Complaint as given | _"…"_ |
| **Time to find** | **_mm:ss_** |
| **Slice that found it** | _time / user / prompt version / input type / cost outlier_ |
| Trace id | _…_ |
| If over 5:00, the log field whose absence cost the time | _…_ |

## Rehearsal (not graded)

This run checks that the tooling can find a planted answer from logs alone. It cannot measure time-to-find, because the person searching also planted it.

**The haystack.** Last week's traffic was replayed through the real pipeline: 160 requests from 8 users across 19–27 October. 80 questions were drawn from the Week 5 pool, the test set and everyday legal questions. Every record comes from a real model call, with real retrieval, tokens, latency and cost. Only the users and arrival times are simulated, and each record says so with `clock: "simulated"`. 22 of the requests were about termination.

**The plant.**

```bash
npm run ask -- --as a.iyer --at 2026-10-22T15:07:31+05:30 --prompt rag-answer@1 --quiet \
  "How much notice does Rohan Sharma need to give to terminate his contract?"
```

This is a real request under the prompt as it shipped. It was filed in time order, at line 15 of Thursday's 24, so neither its position in the file nor any field marks it out.

**The finding, in three commands.**

| # | Command | Slice | Result |
|---|---|---|---|
| 1 | `npm run logs -- find --day thu --role lawyer --type termination` | **time + user (role) + input type** | 161 → **2 candidates.** One refused, so it cited nothing. The other: *"60 days written notice … [3]"*, with ctx `[3] PC-2026-011 §8`. |
| 2 | `npm run logs -- find --ctx "AMD-PC-011-01 §3" --q "PC-2026-011"` | context ids | Both times the model *was* shown the amendment, it answered 90 days. So §8's 60 days is superseded. |
| 3 | `npm run logs -- show bc2b2ed7` | – | The full trace: the amendment is not among the three excerpts. → [trace.json](./trace.json) |

**The diagnosis takes one hop because the context ids are logged.** The model cited `[3]`, which is PC-2026-011 §8 as signed. AMD-PC-011-01 §3, the clause that replaced it, was never retrieved: it sat at neither vector rank 1–3 nor keyword rank 1–3. So retrieval served the superseded text, and the model read correctly what it was given. `[2]` was Mendis's PC-2026-027 §8, a sibling contract's termination clause. That second trap was in the context too.

**What the logs alone could not say.** Command 1 finds the candidate. Deciding that its citation is *wrong* took command 2, and command 2 only works if the finder already knows PC-2026-011 has an amendment. A colleague at 3am would not know that. The missing piece is a log field: **`output.cited_clauses`**, the answer's `[n]` resolved to clause labels, with each label flagged **`superseded_by`** when an amendment replaces it. With that field, `find --cited-superseded` would return this request alone. Adding it is the bonus.

## Other wrong termination answers already in the haystack

The bug was not a one-off. Under `rag-answer@1`, last week's 22 termination requests included:

- **11 refusals of answerable questions:** sponsorship ×3, Sharma vs Mendis ×4, PC-2026-027 ×2, BetaWorks ×2. Each time, the right contract's clause never reached the model.
- **One more wrong-clause citation:** a.iyer, Mon 26 Oct, 15:51. *"What notice does the sponsor need to give to walk away from the deal?"* was answered from the AlphaTech **service agreement**, SA-2026-001 §5. `rag-answer@3` does not fix this one; see [WEEK11.md](../WEEK11.md#whats-left).

This is why the slice matters more than the input type alone. "Termination" by itself gives 22 candidates, and 12 of them are wrong in some way.

## Bonus plan

1. Do the graded drill above, then record its time and the field it missed.
2. Add `output.cited_clauses` with `superseded_by` at write time in `lib/rag.ts`. Index it in `npm run logs` as `--cited <label>` and `--cited-superseded`. Backfill old records with `npm run logs -- index`; this is possible because the context ids were logged from the start.
3. The squadmate plants a second answer. Find it again and record both times and the field.
