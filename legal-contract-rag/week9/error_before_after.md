# Same failing call, old docstring and error vs new

**Server:** our own `clause-search` server (`mcp/clause-search/server.mts`).
**Tool:** `search_clauses`.
**Failing call:** `search_clauses {"contract_id": "PC-2026-027", "query": "injury retainer"}` while the semantic index (Qdrant Cloud) is unreachable. This outage is real: the cluster has been refusing connections throughout this week's work.

**Question:** *In PC-2026-027, what happens to the player's retainer if he is injured during the season?*
**Correct answer:** §9: if he is injured during Franchise Activity, the retainer is paid in full for the season.

| | Before | After |
|---|---|---|
| Server version | `4bca4b3`, the week-7 tool ported to MCP unchanged | `9407179` |
| What the model is told when the index is down | `fetch failed`. That is the raw exception: the SDK turns any thrown error into `isError: true` plus `error.message`. | What failed, what it does **not** mean, the keyword half of the search, and a tool that needs no index |

## The change

**Docstring.** Before, it described the search engine:

> Hybrid keyword + semantic search over clauses; returns the top 3, each labelled [CONTRACT-ID §N]. Pass contract_id whenever you know which contract the question is about — the two player contracts share almost identical wording, and an unscoped search often returns the other player's clause. Leave contract_id out only to discover which document covers a topic.

After, it is written as a prompt. It covers when to use the tool, how to word the query, what the result leaves out, and what a failure means:

> Finds the clauses that deal with a topic when you do not know which section holds them. Returns the 3 best matches, each labelled [CONTRACT-ID §N]; cite those labels.
> Use it when you know what the clause is about (termination notice, injury, image rights) but not its number. If you already know the section, read_section is exact and cheaper.
> Word the query the way a contract does, not the way the user asked: "notice period", "retainer", "Franchise Activity".
> Pass contract_id whenever you know the contract. The two player contracts (PC-2026-011, PC-2026-027) are worded almost identically, and an unscoped search often returns the other player's clause. Leave it out only to find which document covers a topic.
> Clauses come back as executed: amendments are NOT applied. Before answering with a fee, date or notice period, check that contract's amendments.
> If the search index is down, the reply says so and falls back to keyword matching. That means an outage, not a missing clause, and repeating the call will not fix it. Follow what the reply suggests instead.

Both arguments also gained descriptions: `query` says "words the clause itself would use", and `contract_id` says "id from the contract's header".

**Error path.** The same call before and after:

```text
BEFORE  isError: true
fetch failed

AFTER   isError: false (it still returns results)
The search index is unreachable (vector store: ECONNRESET). This is an outage on the search side, not a sign
that PC-2026-027 lacks such a clause, and repeating this call — reworded or not — will not help.
Keyword-only matches (they share your words; a clause worded differently can be missed):
[PC-2026-027 §9] 9. INJURY AND MEDICAL …   [PC-2026-027 §4] …   [PC-2026-027 §5] …
If none of these answers the question: read_section needs no index — PC-2026-027's sections are:
§1 PARTIES; §2 DEFINITIONS; … §9 INJURY AND MEDICAL; §10 CODE OF CONDUCT; §11 GOVERNING LAW AND DISPUTES.
```

If keyword matching also finds nothing, the reply is `isError: true` with the same explanation and the section list.

## Result: 3 runs each

All 6 runs had the same conditions: model `gemini-3.5-flash-lite`, the same day (2026-10-14), the same question, and both servers configured. The only difference was the clause-search server's version. For the before runs, the `4bca4b3` server file ran from a temporary path; it is byte-identical to the server at the bolt-on commit.

| Run | Stopped | Correct | `search_clauses` calls | …of them repeats of the failing call | Model calls | Tokens | Path |
|---|---|---|---|---|---|---|---|
| error-before-1 | repeating | **no** | 4 | 3 | 5 | 6131 | search_clauses → search_clauses → search_clauses → list_contracts → search_clauses |
| error-before-2 | finished | yes | 3 | 2 | 6 | 9502 | search_clauses → search_clauses → list_contracts → search_clauses → get_contract → finish |
| error-before-3 | finished | yes | 3 | 2 | 5 | 6387 | search_clauses → search_clauses → search_clauses → get_contract → finish |
| error-after-1 | finished | yes | 1 | 0 | 3 | 4699 | search_clauses → find_amendments → finish |
| error-after-2 | finished | yes | 1 | 0 | 3 | 4677 | search_clauses → find_amendments → finish |
| error-after-3 | finished | yes | 1 | 0 | 3 | 4682 | search_clauses → find_amendments → finish |

| | Before | After |
|---|---|---|
| Answered correctly | **2/3** | **3/3** |
| Repeats of the failing call per run | **2.3** | **0** |
| Model calls per run | 5.3 | **3.0** |
| Tokens per run | 7,340 | **4,686 (−36%)** |
| Checked amendments before answering | 0/3 | 3/3 |

What the numbers say:
- **Before.** The model read `fetch failed` as a problem with its query. It retried the same query and then reworded it ("injury retainer" → "injury"), and the agent's repeat guard blocked whatever it tried twice. Run 1 ended in that loop with no answer. Runs 2 and 3 were rescued only because server two was configured: `get_contract` returned the full text.
- **After.** The model never re-sent the failing call. It used §9 from the keyword fallback and followed the docstring's "check that contract's amendments" (`find_amendments`) before answering.

Two earlier attempts are kept in `discarded/` rather than deleted:
- 3 before runs from 2026-10-13, taken while Gemini was overloaded. They show the same pattern: 3/3 repeated the failing search, and 3/3 escaped through `get_contract`.
- 3 after runs from the same day that hit the agent's 180-second time budget because of provider latency. They are not comparable. Even so, none of them repeated the failing call.

## Transcripts: before run 1 and after run 1, step by step

Observations longer than 700 characters are clipped here. The full runs are in `error-before-N.{txt,json}` and `error-after-N.{txt,json}`.

### Before (`fetch failed`)

```text
Question: In PC-2026-027, what happens to the player's retainer if he is injured during the season?

Step 1
  thought   I need to find the contract PC-2026-027 and search for clauses related to injury and the player's retainer. First, I will search for clauses about injury or retainer in contract PC-2026-027.
  action    search_clauses {"query":"injury retainer","contract_id":"PC-2026-027"}   [mcp: clause-search]
  observed  Tool error: fetch failed

Step 2
  thought   The previous tool call failed due to a network/fetch error. I will retry searching for clauses about injury and retainer in contract PC-2026-027.
  action    search_clauses {"query":"injury retainer","contract_id":"PC-2026-027"}
  observed  You already ran this exact action; its result is above. Try something different, or finish.

Step 3
  thought   The previous search failed and repeating it is blocked. I will try a broader search or search specifically for 'injury' in contract PC-2026-027.
  action    search_clauses {"query":"injury","contract_id":"PC-2026-027"}   [mcp: clause-search]
  observed  Tool error: fetch failed

Step 4
  thought   The tool calls are failing due to fetch errors. Let me try using list_contracts or a different tool to see if the store is responsive.
  action    list_contracts {}   [mcp: clause-search]
  observed  AMD-PC-011-01 (amendment) — AMENDMENT NUMBER ONE TO PLAYER CONTRACT
              This Amendment Number One modifies the Player Registration and Services Contract PC-2026-011.
            ADP-2026 — ANTI-DOPING POLICY
              This policy applies to every player registered with the Premier Cricket League and is based on the World Anti-Doping Code.
            BRD-2026-002 — MEDIA AND BROADCAST RIGHTS AGREEMENT
              The Premier Cricket League grants Meridian Sports Network the right to broadcast all League matches for the seasons covered by this agreement.
            COC-2026 — PLAYER CODE OF CONDUCT
              This Code of Conduct applies to every registered player, coach, and support staff member of a Premier Cricket League franchise.
            AMD-2026-001 (amendm …[1697 more chars]

Step 5
  thought   Now that I have confirmed contract PC-2026-027 exists, I will search for 'injury' within it.
  action    search_clauses {"query":"injury","contract_id":"PC-2026-027"}
  observed  You already ran this exact action; its result is above. Try something different, or finish.

Stopped: repeating
Answer:  (none)
```

### After (recoverable outage message)

```text
Question: In PC-2026-027, what happens to the player's retainer if he is injured during the season?

Step 1
  thought   I need to find out what happens to the player's retainer in contract PC-2026-027 if he is injured during the season. I will search for clauses related to injury and retainer in contract PC-2026-027, and also check for any amendments.
  action    search_clauses {"contract_id":"PC-2026-027","query":"injury retainer"}   [mcp: clause-search]
  observed  The search index is unreachable (vector store: ECONNRESET). This is an outage on the search side, not a sign that PC-2026-027 lacks such a clause, and repeating this call — reworded or not — will not help.
            Keyword-only matches (they share your words; a clause worded differently can be missed):
            
            [PC-2026-027 §9] 9. INJURY AND MEDICAL
            
            If the Player is injured during Franchise Activity, the
            Franchise pays the retainer in full for the season. A
            replacement player may be signed without further liability to
            the Player.
            
            [PC-2026-027 §4] 4. RETAINER FEE
            
            The Franchise will pay the Player an annual retainer of
            6,500,000 Indian rupees, payable in two equal instalments on
            1 March and 1 June.
            
            [PC-202 …[478 more chars]

Step 2
  thought   I have found the relevant clause [PC-2026-027 §9] which states that if the Player is injured during Franchise Activity, the Franchise pays the retainer in full for the season. Now I need to check for any amendments to PC-2026-027 to ensure this has not been modified.
  action    find_amendments {"contract_id":"PC-2026-027"}   [mcp: clause-search]
  observed  No amendments modify PC-2026-027. Its own clauses are current.

Step 3
  thought   I have verified that Section 9 of PC-2026-027 governs injury and medical matters, stating that if the Player is injured during Franchise Activity, the Franchise pays the retainer in full for the season. I have also confirmed via find_amendments that no amendments modify PC-2026-027. I am ready to answer.
  action    finish {"answer":"If the player is injured during Franchise Activity in contract PC-2026-027, the Franchise pays the retainer in full for the season [PC-2026-027 §9]."}
  observed  (done)

Stopped: finished
Answer:  If the player is injured during Franchise Activity in contract PC-2026-027, the Franchise pays the retainer in full for the season [PC-2026-027 §9].
```
