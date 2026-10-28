# Cost per query, by stage

All costs are at the paid list rate. The app runs on free tiers, so nothing here was actually billed. Rates were read on 2026-10-28:

- `gemini-3.5-flash-lite`: $0.30 per million input tokens and $2.50 per million output tokens, with thinking billed as output.
- `gemini-embedding-001`: $0.15 per million tokens. The API does not return a token count, so the count is estimated at 4 characters per token.
- Qdrant Cloud free tier: $0 per query.

The rates are in `lib/pricing.ts`.

**Stages.** *Retrieval* is the embedding call, the Qdrant query, BM25 and fusion. *Generation* is the answer model call. *Tools* are catalog lookups: resolving the contract and finding amendments. These are the same functions the agent's MCP tools call, and they exist from `rag-answer@3` on.

## The found request: `bc2b2ed7`, `rag-answer@1`

`npm run logs -- cost bc2b2ed7`

| Stage | Spans | Latency | Tokens in / out | Cost | Share |
|---|---|---|---|---|---|
| retrieval | retrieval.search, retrieval.embed, retrieval.keyword, retrieval.vector, retrieval.fuse | 2038 ms | 19 / 0 | $0.000003 | 2.2% |
| generation | generation.answer | 2457 ms | 270 / 19 | $0.000129 | 97.8% |
| tools | none called | 0 ms | 0 / 0 | $0.000000 | 0.0% |
| **total** | 6 | 4497 ms wall | 289 / 19 | **$0.000131** | 100% |

- **Generation is the cost.** Retrieval's only priced call is one embedding of 19 estimated tokens.
- **Retrieval is half the latency here.** The Qdrant query took 1,453 ms. That is a cold connection: `npm run ask` opens a new one for each request. In a long-running process (the replay) retrieval averaged 575 ms.

## The same question after the fix: `rag-answer@3`

`npm run logs -- cost 5c9abde0 --eval` (T17 in the GREEN suite run)

| Stage | Spans | Latency | Tokens in / out | Cost | Share |
|---|---|---|---|---|---|
| retrieval | retrieval.search, retrieval.embed, retrieval.keyword, retrieval.vector, retrieval.fuse | 1945 ms | 19 / 0 | $0.000003 | 1.0% |
| generation | generation.answer | 4821 ms (3,663 ms of it queued behind the throttle) | 593 / 43 | $0.000285 | 99.0% |
| tools | tools.resolve_contracts, tools.find_amendments | 0 ms | 0 / 0 | $0.000000 | 0.0% |
| **total** | 8 | 6767 ms wall | 612 / 43 | **$0.000288** | 100% |

**The fix more than doubles the cost of this question: +120%.** All of the increase is input tokens to generation: 270 → 593. They come from the contract legend, the labels, and one more excerpt (the amendment). The tools cost nothing and take under 1 ms, because they are in-process lookups over 13 documents.

## Across traffic

| | Requests | Cost / query | Retrieval | Generation | Tools |
|---|---|---|---|---|---|
| Last week's production, `@1` (`npm run logs -- cost`) | 161 | $0.000152 | $0.000001 (0.6%) | $0.000151 (99.4%) | $0 |
| Suite, `@1` (RED run) | 17 | $0.000146 | $0.000002 | $0.000144 | $0 |
| Suite, `@3` (GREEN run) | 17 | $0.000257 (+76%) | $0.000003 | $0.000254 | $0 |
| Termination traffic, `@1` as served | 23 | $0.000129 | | | |
| Termination traffic replayed, `@3`, no cache | 23 | $0.000375 | | | |
| Termination traffic replayed, `@3`, **answer cache** | 23 | **$0.000179** | $0.000002 | $0.000177 | $0 |

The cost was attributed by stage before anything was optimised. Since 99% of it is generation, the only lever that matters is the number and size of generation calls.

## The one improvement: an exact-match answer cache, −52%

58% of last week's requests repeated a question already asked; that is 93 of 161 (the embedding cache shows the same 93 hits). `lib/rag.ts` now caches the answer. The key is the prompt version, the model, the normalised question, and the id and full text of every clause shown. A prompt bump or an edited document can therefore only miss; it can never serve a stale answer.

Measured on last week's termination traffic replayed under `@3`: **11 of 23 requests hit the cache, and cost per request fell from $0.000375 to $0.000179 (−52%).** The counterfactual prices each hit at the cost of its own miss. Hits also skip the rate limiter, which matters more than the dollars: see [tenx.md](./tenx.md).

Net of both changes, termination traffic costs $0.000179 against `@1`'s $0.000129. That is +39%, the price of answering instead of refusing 11 of 23 times.

## Why not a semantic cache

| Question pair | Cosine similarity (`gemini-embedding-001`) |
|---|---|
| "…termination notice period in **PC-2026-011**?" vs "…in **PC-2026-027**?" | **0.912** |
| Sharma's termination notice vs Sharma's retainer | 0.811 |
| Sharma's termination notice vs Mendis's termination notice | 0.763 |

Two questions about *different contracts* are closer than two questions about the *same player*. A semantic cache at a typical 0.90 threshold would serve PC-2026-011's 90-day answer to a question about PC-2026-027, which has 30 days. That is this week's failure, served from cache.
