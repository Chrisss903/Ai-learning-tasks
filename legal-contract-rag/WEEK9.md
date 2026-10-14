# Week 9: MCP, and bolting on the contract-repository server without touching the agent

Track F, legal contracts.

**Week 9 base.** The agent no longer has a hand-written tool list. It reads `mcp.config.json`, starts each MCP server listed there, and builds its prompt from whatever `tools/list` returns. Our own server, `mcp/clause-search/server.mts`, exposes the app's real capability (clause search) to any MCP host.

**Task Set F.** Add the knowledge team's contract-repository server with nothing but config.

Every artifact is in [`week9/`](./week9).

| # | Requirement | Result | Evidence |
|---|---|---|---|
| 1 | Server two added by config; one query provably calls it | Step 3 of the run is `get_amendment_chain {"contract_id":"SA-2026-001","as_of":"2026-10-15"}   [mcp: contract-repository]`. Answer: 60 days, in force since 2026-10-01 under AMD-2026-001. | `trace-bolt-on.txt` / `.json` |
| 2 | Zero lines changed in the agent module | **0 changed lines** from `6598cce` (server one) to `f86939b` (server one + two). Agent files have identical blob ids in both. The bolt-on commit adds 8 lines to `mcp.config.json` and nothing else. | `agent_diff.txt`, `config.diff` |
| 3 | Tool count from `tools/list` | **4 → 7.** Added `get_contract`, `get_effective_date`, `get_amendment_chain`. | `tool-counts.txt`, `tools-before.json`, `tools-after.json` |
| 4 | Raw initialize → tools/list → tools/call, annotated | 7 messages, captured from the requirement-1 run; every top-level field annotated by hand. | `wire.json` (raw: `wire.raw.jsonl`) |
| 5 | Docstring as a prompt, recoverable error, before/after | `search_clauses` with the vector index down. Before, 2/3 runs answered and each repeated the failing call 2.3 times on average. After, 3/3 answered with 0 repeats, 5.3 → 3.0 model calls, and −36% tokens. | `error_before_after.md` |
| 6 | 5-line risk note | Recommendation: ship only behind the gateway, never with the all-contracts token. | `risk_note.md` |
| Bonus | One gateway, audit line per call, scoped token | The renewal-review token is denied `get_amendment_chain`; the model said it could not verify amendments rather than assume. The full-access token gets the right answer. | `gateway-*.txt`, `gateway-audit.jsonl` |

## Where the model runs

The model runs **only in the host**: `lib/agent.ts`, via `generator.run`.

- The MCP client (`lib/mcp-client.ts`) only forwards: `initialize`, `tools/list`, and one `tools/call` for each action the model picks.
- Neither server calls a chat model.
- Our client advertises no `sampling` capability, so a server could not ask our host to run the model even if it tried.
- In `wire.json`, the 107 s gap between the `tools/list` result and the `tools/call` is the host's three model turns. Nothing crossed the wire during that time.

Strictly, `clause-search` calls an *embedding* encoder to vectorise the query for retrieval. That is search, not generation. `contract-repository` has no model dependency at all.

## Layout

| Path | Role |
|---|---|
| `mcp.config.json` | The servers the agent connects to. The only file the bolt-on changed. |
| `lib/mcp-client.ts` | Host-side MCP client: starts servers, runs `initialize` + `tools/list`, forwards `tools/call`, and records the raw wire when `MCP_WIRE_LOG` is set. A server that fails to start loses its tools, not the run. |
| `lib/agent.ts` | The week-7 ReAct loop. It now renders discovered tools into its prompt and names no tool. |
| `mcp/clause-search/server.mts` | **Our server.** The four week-7 tools, moved out of the agent. |
| `vendor/contract-repository-mcp/` | **Their server.** A stand-in for the knowledge team's, self-contained, needs `CONTRACT_REPO_TOKEN`. |
| `mcp/gateway/server.mts`, `mcp.gateway.json`, `mcp.frontdoor.json` | Bonus: the front door. Per-caller scopes keyed by token sha256, plus an audit log. |
| `scripts/mcp-tools.mts` | `npm run mcp:tools`: prints what `tools/list` returned. |

## Reproduce

```bash
export CONTRACT_REPO_TOKEN=demo-repo-service-token     # the contract-repository server refuses to start without it
export GEMINI_MODEL=gemini-3.5-flash-lite              # the model every run here used

npm run mcp:tools                                       # 7 tools, from tools/list
MCP_WIRE_LOG=wire.jsonl npm run agent -- "For Thursday's renewal review on 2026-10-15: what termination notice period applies under SA-2026-001 on that date, and since when has it applied?"
git diff --stat 6598cce f86939b -- lib/agent.ts lib/mcp-client.ts scripts/agent.mts   # prints nothing

# bonus: through the gateway, with a scoped and a full token (demo tokens; the config only stores their hashes)
MCP_CONFIG=mcp.frontdoor.json GATEWAY_TOKEN=demo-renewal-review-token npm run agent -- "…same question…"
MCP_CONFIG=mcp.frontdoor.json GATEWAY_TOKEN=demo-full-access-token    npm run agent -- "…same question…"
```

## Caveats

- **Qdrant Cloud is unreachable.** The cluster resets every connection, most likely because the free tier was suspended. Semantic search is down, so `search_clauses` now degrades to keyword-only matching and says so; that outage is the failing call in requirement 5. To reproduce requirement 5 once the cluster is back, point `QDRANT_URL` in `.env.local` at a closed port.
- **The contract-repository server is a stand-in.** It is written to the interface the brief describes, because the real one isn't available here. The risk note judges it as third-party code.
- **Tool scopes are not data scopes.** The renewal-review token is denied `get_amendment_chain` but can still call our `find_amendments`, which returns the same amendment text. The model didn't try it in this run, but the gap is real; `risk_note.md` line 5 says what would close it.
- **Two changes outside the agent module:**
  - `lib/generator.ts` now retries Gemini's 503 "high demand", which lost a run on 2026-10-13. It is its own commit, after the bolt-on.
  - `lib/trajectory.ts` (the week-8 scorer) takes its tool names from the run instead of the old hard-coded list. This is in the base commit.
