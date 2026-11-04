# Architecture — one page

```
 npm run capstone -- ask "…"                      (scripts/capstone.mts — the only entry point)
        │  new trace_id (32 hex)
        ▼
 ┌────────────────────────────────────────────────────────────────────────────┐
 │ HOST process                                                               │
 │  lib/capstone.ts  askCapstone ── recordRequest(trace) ── logs/agent/*.jsonl │
 │        │                                                                    │
 │        ▼                                                                    │
 │  lib/agent.ts  ReAct loop (CAPSTONE_AGENT role)                             │
 │     ① llm.step-N  ── Gemini call ($ here: ~100% of cost) ◄── MODEL CALL    │
 │     ② tool.<name> ── MCP tools/call, _meta{trace_id, parent_span_id}        │
 │        │                                                                    │
 │        ▼ answer                                                             │
 │  lib/counsel-guard.ts  advice language → stripped, counsel referral added   │
 └───────────────┬────────────────────────────────────────────────────────────┘
                 │ stdio JSON-RPC (tools discovered at runtime via tools/list)
     ┌───────────┴─────────────┐
     ▼                         ▼
 clause-search MCP (OURS)      contract-repository MCP (vendored, exposes
  list_contracts                get_contract / get_effective_date /
  search_clauses ─► week 3–4    get_amendment_chain)
     hybrid RAG: BM25 + Qdrant
     vector, RRF fused
  read_section, find_amendments
  resolve_defined_term
  redact() on every reply · audit line per call → logs/mcp/*.jsonl (same trace_id)
```

**Where the model is called:** once per agent step (4–5 per question). The MCP servers and the guard contain no model call. The only other model call is the LLM judge, in the eval suite.

**Where the money goes:** generation is ~100% of per-question cost; retrieval (Qdrant free tier, embedding) is effectively $0 at this scale. See `week11/cost_by_stage.md` for the RAG-path split and `EVAL-REPORT.md` for the agent-path number.

**What leaves the process:** the question and the clause text the tools returned go to the model provider (Gemini). Nothing is sent anywhere else. The MCP server returns clause text only — never file paths, other tenants' contracts, or logs — with emails and phone/account-length numbers masked (`redact()`); its audit log stores tool name, contract id, timing and size, never query text or returned text. Trace logs in `logs/` DO contain the question and answer, so `logs/` is gitignored and must be treated as privileged.

**One trace id, every hop:** host spans → `_meta.trace_id` on each tools/call → server audit line. `npm run capstone -- trace <id>` prints the host spans and counts the server lines, and says MISMATCH if they disagree.
