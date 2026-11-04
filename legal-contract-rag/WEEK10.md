# Week 10 — One agent or a squad? Raced on the same tests

Track F, legal contracts. This week's question: does a team, made of a manager and two specialists, beat the single contract agent from weeks 7–9? Both answered the same 21 questions twice. They used the same model, the same MCP tools and the same scoring, and each was measured on quality, speed, tokens and cost.

**Verdict: keep the single agent, and move one rule over from the squad.**

| | Single agent | Squad |
|---|---|---|
| Correct answers, reading every failure | 41/42 | 41/42 |
| Pass rate as the scorer marks it | 83% | **98%** |
| Tokens per question | 7,644 | **5,379** (−30%) |
| Cost per 1,000 questions | $4.89 | **$4.16** (−15%) |
| Model calls per question | **4.0** | 5.7 (+41%) |
| Critical path, median | **7.7 s** | 8.3 s |
| Wall clock on the free tier, mean | **27.1 s** | 46.0 s |

- **Correctness was level.** Each got 41 of 42 right, and each missed T11 once.
- **The squad's quality lead is citation format.** It always cited in `[ID §N]` brackets; the single agent wrote a bare "VEN-2026-005 §4" five times. A control run shows one prompt rule takes those slips from 5 to 0 (section 5).
- **The squad's savings are real but small:** 30% fewer tokens and 15% lower cost, which is $0.73 per 1,000 questions.
- **What the squad costs:**
  - 41% more model calls. On the free tier this app runs on, that makes it 70% slower by the clock.
  - Two model calls in series on every question, from the manager. They cancel out what running the tasks in parallel gained.
  - Two places where a correct fact was lost at a hand-off (section 6).

Keep the single agent, with all seven tools, and give it the squad's citation rule. That exact combination has not been raced yet, and it is the next run.

The call would change in two cases. One is a paid tier, where calls are not the limit and the critical paths are level. The other is traffic that leans towards multi-step questions, where the squad used 37% fewer tokens in the same time (section 7).

Reproduce:

```bash
GEMINI_MODEL=gemini-3.5-flash-lite CONTRACT_REPO_TOKEN=… npm run race:squad -- --label week10 --repeat 2
GEMINI_MODEL=gemini-3.5-flash-lite CONTRACT_REPO_TOKEN=… npm run race -- --contenders lean --label week10-lean --repeat 2
npm run agent -- --squad "Who has the longer termination notice period, Rohan Sharma or Dinesh Mendis?"
```

`race:squad` is the week 7 race runner, now taking `--contenders agent,squad`. The second command shows the squad on one question: the plan, each hand-off and every specialist step. Runs are saved to `evals/race-week10.json`. The log, side-by-side traces and smoke runs are in `week10/`.

---

## 1. The two contenders

**Single agent.** This is the week 9 agent, unchanged. It is one ReAct loop with up to 8 steps and seven tools found over MCP: four from `clause-search` and three from `contract-repository`. This week `runAgent` gained an optional `role`, and its default is this agent. Its system prompt is byte-identical to week 9's: sha256 `26656fd2…`, 4,246 characters, checked against `HEAD` with the same seven tools.

**Squad** (`lib/squad.ts`): a manager and two specialists. Each specialist is the same ReAct loop with a narrower brief and only the tools its job needs.

```
                         question
                            │
                   ┌────────▼────────┐   call 1: question + contract catalog + agent cards
                   │     manager     │   → a JSON plan: one task per specialist per contract
                   └──┬───────────┬──┘
          tasks t1…tn │  all at   │ once; each sees its task, never the question
       ┌──────────────▼───┐   ┌───▼────────────────────┐
       │ clause-researcher│   │ amendment-checker      │   the week 7 loop,
       │ list_contracts   │   │ find_amendments        │   narrower brief,
       │ search_clauses   │   │ get_amendment_chain    │   up to 6 steps
       │ read_section     │   └───┬────────────────────┘
       └──────────────┬───┘       │
                      │ reports: text with [ID §N] citations
                   ┌──▼───────────▼──┐
                   │     manager     │   call 2: question + its own plan + the reports
                   └─────────────────┘   → the answer
```

| Member | Job | Tools | Told not to |
|---|---|---|---|
| manager | Turns names into contract ids using the catalog. Writes one task per specialist per contract, then answers from the reports. | none. It is handed the catalog from the same `list_contracts` MCP tool. | read contracts itself |
| clause-researcher | Finds the clause that answers its task and reports it as signed, with its `[ID §N]` label | `list_contracts`, `search_clauses`, `read_section` | look for amendments |
| amendment-checker | Reports what amendments to one contract changed: the section, the old value and the new value | `find_amendments`, `get_amendment_chain` | search the contract itself |

Why these two specialists:

- **Split by job, not by contract.** The commonest trap in this corpus is a value an amendment replaced. Finding a clause and checking a contract's amendments are independent jobs, so they can run at the same time. They also need opposite instructions: one reports the clause as signed, the other reports only what changed. The brief names those two conditions as the ones where a team can help.
- **The manager reads the catalog and decides who to ask.** It sends the amendment-checker only for contracts the catalog lists an amendment for, so the stadium agreement does not pay for a check that cannot find anything.
- **The hand-off is the only channel.** A specialist never sees the user's question, and the manager never sees a clause. Each gets only the other's text. That is the honest version of a team: anything not written into a task or a report is lost.
- **Agent cards, the A2A format.** Each specialist describes itself in an A2A agent card (section 8), and the manager's prompt is built from those cards. In week 9 the single agent's prompt was built the same way from `tools/list`.
- **Hand-built, not CrewAI or AutoGen.** A framework adds prompts and calls of its own. This week's point is to count every token, so every call here is ours.

---

## 2. A fair race

| | Single agent | Squad |
|---|---|---|
| Questions | the 21 race cases (the 16-case week 6 test set plus 5 multi-step cases), twice each | same |
| Model | `gemini-3.5-flash-lite` through the same generator, same output limit | same |
| Tools | 7 MCP tools from `tools/list` (`mcp.config.json`) | same servers; each specialist gets a subset |
| Search | hybrid: Qdrant vectors plus BM25, fused | same |
| Defences | off, as in the week 7 and week 8 races | off |
| Scoring | `checkAnswer` assertions plus at least one `[ID §N]` citation | the same function |
| Pricing | $0.50 per million input tokens, $3.00 per million output | same |
| Order | the two take turns on every case, so a slow minute at the provider hits both | |

Two definitions matter for speed:

- **Critical path** is time spent in model and tool calls along the longest chain, without free-tier waits. For the single agent that is every call in turn. For the squad it is the plan, plus the slowest task, plus the answer. This is the speed a paid tier would see.
- **Wall clock** is the time a run actually took on the free tier. The generator spaces Gemini calls 6.5 seconds apart, so here every extra model call costs about 6.5 seconds, wherever it sits.

Errors are kept out of the scoring. A run the provider failed is excluded from every number and re-run with `--resume`. In the end no run errored, so nothing had to be re-run.

One scorer change, made before the full race and applied to both contenders: the week 7 citation check wanted `]` straight after the section number, so `[SA-2026-001 §5, AMD-2026-001 §2]` (two citations in one bracket) failed a correct answer in the first smoke run. It now accepts `,` or `;` there too.

---

## 3. Results

There are 42 runs per contender (21 cases, twice each) and no errored runs. Every run, with its plan, hand-offs and timings, is in `evals/race-week10.json`.

| | Single agent | Squad | Squad vs single |
|---|---|---|---|
| **Quality**, as the scorer marks it | 35/42 (83%) | **41/42 (98%)** | +6 runs |
| Quality, reading every failed answer | 41/42 (98%) | 41/42 (98%) | tie |
| Same verdict on both attempts | 16/21 cases | 20/21 cases | |
| **Speed**, critical path, median | **7.7 s** | 8.3 s | +8% |
| Speed, critical path, mean | **9.5 s** | 19.8 s (10.3 s without 2 stalled calls) | |
| Speed, wall clock on the free tier, mean | **27.1 s** | 46.0 s (36.1 s without them) | +70% (+33%) |
| **Tokens** per question | 7,644 (7,217 in, 426 out) | **5,379** (4,791 in, 588 out) | −30% |
| Model calls per question | **4.0** | 5.7 | +41% |
| **Cost** per question | $0.00489 | **$0.00416** | −15% |
| Cost per 1,000 questions | $4.89 | **$4.16** | |

By kind of question:

| | Single-clause (32 runs): single | Single-clause: squad | Multi-step (10 runs): single | Multi-step: squad |
|---|---|---|---|---|
| Passed, by the scorer | 26/32 | 31/32 | 9/10 | 10/10 |
| Tokens | 6,854 | 5,045 | 10,173 | 6,447 |
| Cost per question | $0.00434 | $0.00381 | $0.00664 | $0.00528 |
| Model calls | 3.8 | 5.3 | 4.8 | 6.8 |
| Critical path, median | 7.2 s | 8.3 s | 10.6 s | 10.6 s |
| Wall clock, mean, without the 2 stalls | 25.1 s | 33.5 s | 33.5 s | 45.3 s |

**Quality: the gap is citation format, not correctness.** I read all eight failed answers:

| Run | Contender | The scorer said | What the answer actually did |
|---|---|---|---|
| T03 #2, T04 #1, T04 #2, T16 #1, M04 #1 | single | no `[ID §N]` citation | The right clause and the right value, cited without brackets: "as specified in VEN-2026-005 §4", "(PC-2026-027 §11)" |
| T12 #2 | single | answered anyway | "There is no buyout clause in Rohan Sharma's contract." That is a correct refusal, but the scorer's refusal-phrase list does not include it. |
| T11 #2 | single | answered anyway | It said "No" to Australia, although the answer sits in Annex I, which is not in the corpus |
| T11 #1 | squad | answered anyway | The same mistake, made at a hand-off. The researcher reported "…not included … unless specifically listed in Annex I", and the manager dropped the "unless" (`week10/trace-T11.txt`). |

On content, the two are level: each got 41 of 42 right, and each failed T11 once. The squad's real advantage is that its answers always use bracket citations. The manager's answer prompt is short and puts the citation rule right before it writes. The single agent's citation rule sits inside the `finish` description, the last of eight tool descriptions.

**Speed: parallel tasks bought less than the manager cost.** On the critical path, a squad run is the plan, then the longest task, then the answer: on average **4.33 model calls one after another**. The single agent makes 4.02 calls in total. The tasks overlap, but the manager adds two calls in series to every question. So the medians come out close. On single-clause questions the squad is a second slower (8.3 s against 7.2 s), because the manager's two calls are pure overhead. On multi-step questions they are level at 10.6 s each: running the tasks in parallel only pays for the manager's calls.

The means tell a different story because of two stalled calls. A single Gemini call took 148 seconds (the amendment-checker on M04, attempt 1) and another took 256 seconds (the plan on T12, attempt 2). The single agent's slowest call in 169 was 7.1 seconds. Two stalls are too few to call a trend. But the squad makes more calls per question, so it has more chances to hit one, and a fan-out always waits for its slowest member.

**On the free tier the squad is plainly slower.** Calls are spaced 6.5 seconds apart, so the wall clock follows the number of calls, and the squad makes 41% more.

---

## 4. Where the tokens go

The brief's warning is that every hand-off re-sends everything, so a team costs more. Here the squad cost less, and the input tokens per call show why:

| Call | Input tokens per call, mean |
|---|---|
| single agent, steps 1 → 5 | 1,093 → 1,660 → 1,952 → 2,356 → 2,670 |
| manager, plan (catalog plus two agent cards) | 1,086 |
| clause-researcher, steps 1 → 2 | 787 → 1,058 |
| amendment-checker, steps 1 → 2 | 466 → 852 |
| manager, answer (its plan plus the reports) | 405 |
| **mean per call** | **single 1,794 · squad 845** |

- **Context re-sending is real, but here it costs the single agent most.** Every step re-sends its whole prompt, about 1,090 tokens of mostly descriptions for seven tools, plus every result so far. Per question that is 4,400 tokens of repeated prompt and 2,817 of repeated transcript: 7,217 tokens of input.
- **The squad's hand-offs are short.** A task is one sentence and a report is a paragraph; no member ever sees another's transcript. Each specialist re-sends a prompt that lists 2–3 tools, not 7. So the squad makes 41% more calls at under half the size: 5.67 × 845 ≈ 4,791 tokens in, against 4.02 × 1,794 ≈ 7,217.
- **Output costs more, and the squad writes more.** The plan, the reports and the final answer add up to 588 output tokens against 426, at six times the input price. That is why tokens fall 30% but cost falls only 15%.
- **Where the squad's tokens go:** the manager 1,715 a question (32%), the clause-researcher 2,865 (53%), the amendment-checker 800 (15%). Plans had 1 task 20 times, 2 tasks 16 times and 3 tasks 6 times. The amendment-checker was sent 22 times in 42 runs, only where the catalog lists an amendment. All 70 tasks completed.

So the team looks cheaper because each member's prompt is smaller, not because the members work together. That is a claim about prompts, and section 5 tests it.

---

## 5. Is it the team, or the prompts?

Both of the squad's wins look like prompt effects. Its manager is told the bracket format just before it answers. Each specialist re-sends a prompt that lists two or three tools, where the single agent re-sends seven.

So one more contender raced: `lean`, the single agent with exactly those two changes and nothing else (`LEAN_AGENT` in `lib/agent.ts`):

- week 8's four tools instead of seven;
- one rule: *put every citation in square brackets — [PC-2026-011 §6] — never a bare "PC-2026-011 §6" or "(PC-2026-011 §6)"*.

It ran the same 21 cases twice, after the main race (`evals/race-week10-lean.json`).

| | Single agent | Squad | Lean single agent |
|---|---|---|---|
| Passed, as the scorer marks it | 35/42 | 41/42 | 36/42 |
| Citation-format slips | 5 | 0 | **0** |
| Runs stopped at the step limit | 0 | 0 | 5 |
| Tokens per question | 7,644 | 5,379 | 7,552 |
| Input tokens per call | 1,794 | 845 | 1,578 |
| Model calls per question | 4.0 | 5.7 | 4.5 |
| Cost per question | $0.00489 | $0.00416 | $0.00491 |
| Critical path, median | 7.7 s | 8.3 s | 9.9 s |
| Wall clock, mean | 27.1 s | 46.0 s | 30.0 s |

There are two effects, and they come out differently:

- **Citations: a prompt effect.** One rule took format slips from 5 to 0. The squad's quality lead needs no team.
- **Tokens: not just prompt length.** Trimming the tool list made each call smaller (1,578 tokens against 1,794), but the agent made more calls, and the total barely moved (−1%).
  - **The cut tools were not dead weight.** `get_contract` is how the full agent stops searching when a clause does not exist. On T10 and T11, the unanswerable questions, the full agent read the whole contract three times out of four, and those three runs refused correctly. The lean agent could not, and it searched until it ran out of steps four times out of four (`week10/trace-T10.txt`). It also missed the sell-on clause in M05 once, reading sections one at a time.
  - **The squad's researcher lacks `get_contract` too, but it did not loop.** Its brief tells it to say plainly when a contract has no such clause, and its run is capped at 6 steps. It said so after two or three searches, and the manager turned that into "I don't know".

So the squad's token saving is at least partly structural. Splitting the work keeps each context short, and a narrow job ends sooner. A single agent cannot copy that by deleting tools; what it can copy is the citation rule.

---

## 6. Hand-offs lose facts

### The first squad's M01

The first smoke run (`week10/smoke-1-before-fix.json`) lost M01: *"Who has the longer termination notice period today, Rohan Sharma or Dinesh Mendis?"* All three specialist reports were correct:

| Task | Report |
|---|---|
| t1 clause-researcher · PC-2026-011 | 60 days written notice [PC-2026-011 §8] |
| t2 amendment-checker · PC-2026-011 | §8 amended: 60 days replaced with 90 days [AMD-PC-011-01 §3] |
| t3 clause-researcher · PC-2026-027 | 30 days written notice [PC-2026-027 §8] |

The manager's answer was *"I don't know the name of the employee associated with contract PC-2026-027, nor do I have any reports for Dinesh Mendis or Rohan Sharma."*

The answer call is a fresh context. The reports name contract ids and the question names people. The only thing linking the two was the manager's own plan ("Rohan Sharma (Contract PC-2026-011) and Dinesh Mendis (Contract PC-2026-027)"), and the manager never saw its plan again. The fix hands the manager its plan back in the answer call. It costs about a hundred tokens, and M01 passed in the second smoke run (`week10/smoke-2-after-fix.json`).

That bug is the brief's warning in miniature. A single agent keeps its reasoning in one transcript. A team keeps it only where somebody writes it down, and every boundary is a place to lose a fact. The full race ran on the fixed squad.

### T11 in the full race

It happened once more, in a way no fix to the plan prevents. On T11, attempt 1, the clause-researcher reported:

> "…Rights for all other territories are retained by the League and are listed in Annex I [BRD-2026-002 §2], meaning Australia is not included in Meridian Sports Network's broadcast territory **unless specifically listed in Annex I**."

The manager answered:

> "No, Meridian Sports Network cannot show matches in Australia."

The "unless" was the whole answer, because Annex I is not in the corpus, and it was lost when the manager retold the report (`week10/trace-T11.txt`). The single agent got T11 wrong once as well, so this costs nothing on the scoreboard. But the way it went wrong belongs to the team: a summary of a summary keeps the conclusion and drops the condition.

---

## 7. When a team is worth it here, and when it isn't

**For this app's contract questions, it is not worth it.** Most questions ask for one clause in one contract: 32 of the 42 runs, as in the week 6 test set. On those the manager adds two model calls in series and has nothing to split. Its critical path is a second slower (8.3 s against 7.2 s, median) and it makes 1.5 more calls.

Where the numbers lean towards a team:

- **Multi-step questions.** These need two contracts, an amendment and some arithmetic. The squad used 37% fewer tokens (6,447 against 10,173) in the same median time (10.6 s each). Its researchers and amendment-checker worked at the same time, which paid for the manager's two extra calls. Five cases are too few to decide on, but this is the direction the brief predicts: independent pieces, run in parallel.
- **Long investigations.** The single agent's input grows with every step, from 1,093 tokens to 2,670 by step 5, because it re-sends its whole transcript. A twenty-step task, such as checking every player contract for one clause, would pay that growth on every step. Split across specialists, each context stays short.
- **Different permissions, not just different instructions.** Week 9's gateway already gives callers different tool scopes. A specialist allowed to read NDA contracts, behind a manager that is not, is a reason for a team that no prompt can stand in for.
- **A specialist someone else owns.** That is where A2A comes in (section 8).

Signs it is not:

- **Model calls are what you are limited on.** A free tier caps requests per minute. The squad made 41% more calls, so it was 70% slower by the clock.
- **Facts have to survive the hand-off.** Two correct facts were lost between team members: the names in the first M01, and the "unless" in T11.
- **The gain is really a prompt.** The squad's citation lead came from one instruction, and the control moved it into a single agent.

---

## 8. A2A: where it fits

**MCP connects an agent to tools; A2A connects an agent to other agents.** An MCP server is a capability with no model inside: `tools/list` says what it can do, and `tools/call` does one thing and returns. An A2A agent is a peer with its own model, prompt, tools and memory. You hand it a task and get back a result, without seeing how it worked.

The squad uses A2A's two ideas in-process:

- **Agent cards for discovery.** Each specialist publishes a card: name, description, skills with examples, input and output modes. The manager's planning prompt is built from the cards, as the single agent's prompt is built from `tools/list`. The clause-researcher's card:

  ```json
  {
    "protocolVersion": "0.3.0",
    "name": "clause-researcher",
    "description": "Finds the clause in one contract that answers a question and reports it as executed, with its [CONTRACT-ID §N] label. Does not check amendments.",
    "url": "http://localhost:41241/clause-researcher",
    "version": "1.0.0",
    "capabilities": { "streaming": false, "pushNotifications": false },
    "defaultInputModes": ["text/plain"],
    "defaultOutputModes": ["text/plain"],
    "skills": [{
      "id": "find-clause",
      "name": "Find a clause",
      "description": "Given a contract id and a topic, returns the clause that covers it and the exact value it states, or says the contract has no such clause. Given no id, first finds the document that covers the topic.",
      "tags": ["contracts", "clauses", "search"],
      "examples": ["Contract PC-2026-027: what is the termination notice period?", "Which document caps overseas players in the playing eleven, and at how many?"]
    }]
  }
  ```

  Both cards are saved with the race, in the `cards` field of `evals/race-week10.json`.

- **The task lifecycle for hand-offs.** Every task moves through `submitted → working → completed | failed`, with timestamps, and its one artifact is the specialist's report. A specialist that stops without finishing ends `failed`. The manager then gets the failure and the specialist's last note in place of a report.

**What is not A2A here:** the transport. Nothing listens at a card's `url`; a hand-off is a function call inside one process. That is deliberate. Serving our own two specialists over HTTP would add a network hop, an auth surface and JSON-RPC framing, and it would not save a token, because the context re-sent at a hand-off is the prompt, not the wire.

**Where A2A would be the right tool for Track F.** It fits when a specialist is not ours. Take week 9's contract-repository, owned by the knowledge team. If it grew a model of its own, say a "renewal reviewer" that reads a contract and decides what to flag, we would discover it from its agent card and hand it tasks over A2A. We would not wrap it as an MCP tool and pretend it is a lookup. It also fits when a task runs long or has to stop and ask (A2A's `input-required` state), for example a clause review that waits for a lawyer's sign-off. Neither applies to a contract Q&A answered in seconds by our own process.

---

## Evidence

| File | What it is |
|---|---|
| `evals/race-week10.json` | Every run: answer, verdict, failures, tokens by member, timings, the squad's plan and full task records, and the agent cards |
| `evals/race-week10-lean.json` | The control: the single agent with four tools and the citation rule |
| `week10/race-week10.log`, `week10/race-week10-lean.log` | Console output of both runs |
| `week10/trace-M01.txt` | The two-contract amendment question, single agent and squad: 13,479 tokens against 7,520 |
| `week10/trace-T04.txt` | The single agent's citation-format slip, next to the squad's answer |
| `week10/trace-T11.txt` | The squad's manager dropping the researcher's "unless" |
| `week10/trace-T10.txt` | An unanswerable question, all three contenders: the full agent reads the contract, the squad stops early, the lean agent runs out of steps |
| `week10/smoke-1-before-fix.json` | The smoke run that found the manager's hand-off bug (M01) and the citation-pattern false negative (T09) |
| `week10/smoke-2-after-fix.json` | The same two cases after both fixes |
| `lib/squad.ts` | The squad: cards, roles, plan → delegate → answer |
| `lib/agent.ts` | `AgentRole`. `SINGLE_AGENT` is the unchanged week 9 agent; `LEAN_AGENT` is the control. |
| `scripts/race.mts` | `--contenders`, `--resume`, critical path vs wall clock, tokens by member |
