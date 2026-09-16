# Week 4 — Debugging Retrieval

Topic F, legal contracts — cricket edition. The corpus is cricket contracts
(player contracts, franchise, sponsorship, broadcast, transfer, stadium, code of
conduct, anti-doping), which are ordinary legal agreements in a setting that is
easy to reason about.

13 documents → 118 chunks in Qdrant. Embeddings `gemini-embedding-001` (768d),
answers `gemini-3.6-flash`, top-3 retrieval.

Reproduce with `/inspect` → **Run both modes**.

---

## The one change

**Vector-only search → hybrid search.** BM25 keyword scoring over the same
chunks, fused with the vector results by Reciprocal Rank Fusion (`k=60`, 20
candidates per retriever).

Nothing else moved: same chunker, same embedding model, same prompt, same chat
model, same top-3.

**Why this change.** Contract questions lean on exact identifiers —
`PC-2026-027`, `TRF-2026-008`, `Annex III`, `Exhibit B`, `Level 3`. An embedding
flattens those into "a player contract", "an annex", so two near-identical
clauses in sibling contracts look equally relevant and the wrong one is fetched.
BM25 keeps the identifier literal.

## The number

| | hit-rate@3 | MRR@3 |
|---|---|---|
| Vector only (before) | 16/20 = **80%** | 0.700 |
| Hybrid BM25 + RRF (after) | 18/20 = **90%** | 0.750 |

**+10 percentage points, two questions fixed, nothing regressed.** MRR rose too,
so the gain is not just a chunk scraping into third place.

| | Before | After | |
|---|---|---|---|
| Q06 — transfer fee under TRF-2026-008 | not in top 3 | rank 2 | **fixed** |
| Q10 — where Dinesh Mendis's disputes are resolved | not in top 3 | rank 2 | **fixed** |
| Q01 — match fee in PC-2026-027 | not in top 3 | not in top 3 | still failing |
| Q08 — termination notice in PC-2026-027 | not in top 3 | not in top 3 | still failing |

Two questions out of twenty is a small sample. The direction is clear and the
mechanism is understood, but the exact percentage should not be over-read.

---

## The two kinds of failure

- **Wrong document fetched** — the correct clause is not in the top 3. A better
  model cannot help.
- **Right document, wrong answer** — the correct clause *is* in the top 3 and
  the answer is still wrong. Retrieval work cannot help.

### Q08 — wrong document fetched

> *"What is the termination notice period in PC-2026-027?"*

Retrieved: `amendment-pc-2026-011-01.txt §3`, `sponsorship-agreement.txt §8`, `contract-amendment.txt §2`
Correct clause: `player-contract-mendis.txt §8` (30 days) — **not retrieved**

> **Answer:** "I don't know. The excerpts do not contain any information
> regarding contract PC-2026-027 (excerpt [1] mentions PC-2026-011, while [2]
> and [3] do not specify this contract number)."

The model diagnosed its own input: it was handed the amendment to a **different
player's contract**. Rank 1 is the notice period from PC-2026-011, which is the
right kind of clause attached to the wrong contract — the most dangerous near
miss there is. **Retrieval failure.** A stronger model changes nothing here.

### Q11, Q13, Q16 — right document, right answer

Three questions where the correct clause *was* retrieved, checked to confirm the
generation side is sound:

| | Result |
|---|---|
| Q11 — Rohan Sharma's current retainer | "13,500,000 … the original 9,000,000 was amended" ✓ |
| Q13 — notice to terminate the AlphaTech agreement | "60 days … the original specified 30 days" ✓ |
| Q16 — suspension at 8 demerit points | "two matches" ✓ |

Q11 and Q13 are both **override traps**: the original clause and the amendment
that supersedes it were retrieved together, and the model took the amendment
both times. Q16 required reading 8 points against a banded threshold table.

**In this run, every failure was a retrieval failure.** That is itself the
finding — it says spending effort on a better generator would have bought
nothing.

---

## What the change did NOT fix

**Q01 and Q08 both still fail, and both ask about PC-2026-027.** The cause is
the same one that makes Q10 hard:

> **Every clause chunk is orphaned from its own contract.**

`player-contract-mendis.txt §5` reads *"the Player receives a Match Fee of
110,000 Indian rupees."* It does not contain `PC-2026-027`, and it does not
contain "Mendis" — both appear only in the document header, which is a separate
chunk. So a question naming the contract cannot match the clause that answers it.

Hybrid search makes this *worse* in one specific way. The tokeniser splits
`PC-2026-027` into `pc`, `2026`, `027`; the amendment chunks contain
`PC-2026-011` → `pc`, `2026`, `011`. Two of three tokens match, so the wrong
contract's clauses score well on keywords *and* on meaning. The one token that
would settle it is drowned out.

This is also why hybrid helped where it did: Q06 and Q10 were fixed because the
answering clause happened to contain distinctive words from the question
("transfer fee", "disputes"), not because of the identifier.

**The next change — deliberately not made this week,** so this week's number
measures one thing: prepend document context to every chunk at ingest, e.g.
`player-contract-mendis.txt · PC-2026-027 · Chennai Chargers ↔ Dinesh Mendis`.
That gives every clause its contract id and party names, and would be measured
the same way.

---

## Honest limits

- **n = 20.** Two questions is a small margin. The mechanism is understood; the
  precise percentage is not firmly established.
- **Generation was spot-checked on 4 questions**, not all 20. The retrieval
  numbers cover the full set. `/inspect` runs the full sweep when there is LLM
  budget for it.
- **One generation failure was seen during development**, on an earlier version
  of the corpus, for the Q13 AlphaTech question: the amendment clause was
  retrieved at rank 1 and the model still refused it, saying *"none of the
  excerpts mention 'AlphaTech'"* — because that clause never names the party
  either. Once a chunk naming AlphaTech was also retrieved, the same question
  answered correctly. The same root cause produces both failure kinds.
- **The corpus is synthetic**, written to contain these collisions — sibling
  contracts, amendment chains, cross-referenced annexes.
- **Both providers changed from week 3** (HF Llama-3.1-8B and MiniLM embeddings
  → Gemini) because the Hugging Face free allowance was exhausted mid-project.
  This does not affect the before/after comparison: both retrieval modes were
  scored with the same embedding model and the same generator, and hit-rate@3
  and MRR@3 do not involve the LLM at all.
