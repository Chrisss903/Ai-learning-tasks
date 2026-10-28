# What every request logs, and why

Each request writes one line to `logs/requests/YYYY-MM-DD.jsonl` (UTC day): one trace with its spans, written when the request ends, including when it fails. Suite runs go to `logs/eval/`, so a drill never has to step over them. The code is in `lib/telemetry.ts`, called from `askQuestion` in `lib/rag.ts`.

| Field | Example | The question it answers in a drill |
|---|---|---|
| `trace_id` | `4b34b6a5…` (32 hex, the OTel format) | Which request is this? Returned by `/api/ask`, so the next complaint can quote it. |
| `ts`, `clock` | `2026-10-22T09:41:07Z` | When? The **time** slice. `clock: "simulated"` marks replayed traffic. |
| `user.id`, `user.role` | `s.khan`, `lawyer` | Who? The **user** slice. A complaint says "a lawyer", never a user id. |
| `input.question` | full text | What did they ask? Searched with `--q`. |
| `input.type` | `termination` | What was it about? The **input type** slice, from `lib/input-type.ts`. |
| `input.contracts` | `["PC-2026-011"]` | Which contract did the question name? Resolved in code. |
| `prompt_version` | `rag-answer@1` | Which prompt answered it? The **prompt version** slice, and the rollback lever. |
| `model`, `embedding_model` | `gemini:gemini-3.5-flash-lite` | Which models? |
| `retrieval.context[]` | `{n: 3, chunk_id: 79, label: "PC-2026-011 §8", via: "search", vector_rank: 4, keyword_rank: 3}` | What was the model shown, and as which `[n]`? This separates "retrieval served the superseded text" from "the model misread the right text" in one hop. |
| `output.answer` | full text | What did it say? Searched with `--a`. The complaint describes the output, so the output has to be searchable. |
| `output.cited_excerpts`, `refused` | `[3]`, `false` | Which excerpts did it cite? |
| `spans[]` | name, stage, start, duration, tokens, cost, attributes | Where did the time and money go? One span per step. |
| `totals` | latency, queue, tokens, cost, `cost_by_stage` | The **cost outlier** slice, and cost split into retrieval, generation and tools. |
| `status`, `error` | `ok` | Did it fail? |

## Spans

```
retrieval.search                 retrieval    the version's retrieval step
  retrieval.embed                retrieval    tokens (estimated, 4 chars per token), cost, cache hit or miss
  retrieval.vector               retrieval    Qdrant query; $0 per query on the free tier
  retrieval.keyword              retrieval    BM25, in process
  retrieval.fuse                 retrieval    RRF
tools.*                          tools        catalog lookups (rag-answer@2): resolve contracts, find amendments
generation.answer                generation   tokens in, out and thinking; cost; provider_ms;
                                              queue_ms; attempts; throttled
```

`queue_ms` is the time a request waited on the rate limiter. On a quiet day it is zero. At 10× load it becomes latency (see tenx.md).

Field names follow OpenTelemetry: `trace_id`, `span_id`, `parent_id`, and `gen_ai.request.model` among the attributes. The records could be sent to Phoenix or any OTel collector without renaming anything. They are hand-built, like the Week 7 agent, so every number in them comes from this code.
