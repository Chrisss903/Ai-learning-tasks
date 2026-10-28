# Prompt version bump: `rag-answer@1` → `rag-answer@3`

| | |
|---|---|
| Was | `rag-answer@1`: top-3 hybrid search, excerpts headed by file name, the weeks 3–10 system prompt |
| Now | `rag-answer@3`, the default in `lib/prompts.ts`. Search is scoped to the contract the question names, the amending clause is attached to any clause it changes, every excerpt is labelled with its contract, and the prompt says the amendment is in force where the two differ. |
| Rejected | `rag-answer@2`: the same change, except it labelled an amended clause as "replaced". It regressed T06 (16/17). It never shipped, and it is kept because eval traces record it. |
| Logged | Every request records `prompt_version`, so `npm run logs -- slices --prompt rag-answer@3` compares the two versions side by side. |
| Evidence | Suite: RED 14/17 → GREEN 17/17, nothing regressed. Shadow replay of last week's termination traffic: refusals 13/23 → 2/23, both remaining refusals correct. |

**Canary:** run `PROMPT_VERSION=rag-answer@1 PROMPT_CANARY=rag-answer@3:10` (10% of users, stable by user-id hash) for two working days, comparing `slices --prompt` for each version: termination refusals, cost per query (expect about +40%) and p95 service latency. Go to 100% only if the suite stays 17/17 and no termination complaint comes in.
**Rollback:** set `PROMPT_VERSION=rag-answer@1` and unset `PROMPT_CANARY`. It is one environment change, no code deploy. The answer cache is keyed by version, so no `@3` answer can leak into `@1`.
