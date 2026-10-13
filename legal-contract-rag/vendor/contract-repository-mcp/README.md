# contract-repository MCP server (vendored)

**Owner:** knowledge team. **We do not maintain this code.**

> **Stand-in.** The knowledge team's real server is not available to this exercise.
> `server.mts` is a stand-in written to their published interface so the agent
> has something to bolt on. It deliberately imports nothing from this app's
> `lib/`, because the real one wouldn't.

## Interface

| Tool | Input | Returns |
|---|---|---|
| `get_contract` | `contract_id` | Record (kind, effective date, amendments recorded) and full text as executed. Amendments are listed, not applied. |
| `get_effective_date` | `contract_id` | Effective date, quoting the clause that states it. If no calendar date is stated, it says so and quotes the term clause. |
| `get_amendment_chain` | `contract_id`, `as_of?` (YYYY-MM-DD) | Amendments oldest first: effective date, sections replaced, text, and whether each was in force on `as_of`. |

Transport: stdio. All three tools are read-only (`readOnlyHint: true`). There are no write tools.

## Runtime

| Variable | Meaning |
|---|---|
| `CONTRACT_REPO_DIR` | Repository directory. The server reads **every** `.txt` in it. |
| `CONTRACT_REPO_TOKEN` | Repository service token. There is one token, and it reads every document. |
| `CONTRACT_REPO_LOG` | Access log, default `logs/contract-repository.log`. |

The server appends one plaintext line per `tools/call` to the access log: timestamp, tool, **full arguments** and outcome. The log is never rotated. It can't record *who* asked, because every call arrives under the one service token.

See [`week9/risk_note.md`](../../week9/risk_note.md) for whether to trust it.
