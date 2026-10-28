# Running the graded drill: for the planter and the finder

The rehearsal in [drill.md](./drill.md) was planted and found by the same person, so it proves the tooling works but proves nothing about time-to-find. The graded run needs two people.

## Planter (the squadmate), while the finder is out of the room

1. Choose a lawyer from `lib/team.ts` (`a.iyer`, `r.menon` or `s.khan`), a time last week, and a termination question the app gets wrong. Plant it under the prompt as it shipped:

   ```bash
   GEMINI_MODEL=gemini-3.5-flash-lite npm run ask -- \
     --as r.menon --at 2026-10-23T11:05:00+05:30 --prompt rag-answer@1 --quiet \
     "<your question>"
   ```

   `--quiet` prints only the trace id. Write it on paper. The record is filed in time order and carries `clock: "simulated"`, the same as the replayed week around it. Neither its position in the file nor any field shows that it was planted.

2. Check it in private with `npm run logs -- show <id>`. If the answer happens to be right, plant another one.
3. Give the finder one vague sentence. For example: *"a lawyer said it cited the wrong clause on termination, maybe Thursday."* Do not give the id, the contract or the time.

## Finder (you)

Start the clock when the sentence is read. Stop it when you say a trace id out loud and the planter confirms it. Use only `npm run logs` (or `grep` on `logs/requests/`). Recognising the contract from memory does not count.

Then, with the found id:

```bash
npm run logs -- export <id> week11/trace.json   # requirement 2
npm run logs -- cost <id>                       # requirement 5, paste into cost_by_stage.md
npm run logs -- to-case <id> --id T18           # requirement 3, if it is a new failure
```

Record the result in drill.md: mm:ss, the slice that found it, and the planter's name.
