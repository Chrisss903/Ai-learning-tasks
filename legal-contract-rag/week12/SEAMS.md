# Seam list — integration problems actually hit (2026-11-04)

Honest provenance: this list was written as the seams appeared during the integration work in this session, not on a Tuesday before it. Status: fixed / accepted / ran-out-of-time.

| # | Seam | Status |
|---|---|---|
| 1 | Agent loop had no trace; MCP hop carried no id; server logged nothing | **fixed** — `_meta.trace_id` + server audit line |
| 2 | Agent had 3 of the 3 brief tools only by luck: no defined-term resolver existed | **fixed** — `resolve_defined_term` over MCP |
| 3 | Guard regex missed "is **not** standard" | **fixed** (C03 RED→GREEN) |
| 4 | Guard's own referral text contained "standard, acceptable" and failed the assertion | **fixed** |
| 5 | Guard over-triggered on the model's own refusal sentence naming "standard" | **fixed** — sentences that hand to counsel are exempt |
| 6 | Citation checker demanded `[ID §N]` brackets; agent sometimes writes `ID §N` | **fixed in the checker; accepted in the agent** (brackets rule is in the prompt, not enforced) |
| 7 | Refusal detector missed "is not defined" / "do not define" | **fixed** |
| 8 | Trajectory scorer knew one amendment tool; two MCP servers offer one | **fixed** (original 9/11 kept in `week12/trajectory-original-scorer.txt`) |
| 9 | Gemini `MALFORMED_RESPONSE` aborts a case; no retry in the agent loop | **accepted** |
| 10 | Judge says "supported" to everything, incl. refusals; agreement unmeasured | **ran-out-of-time** (needs the human labels) |
| 11 | Week 5 `ERROR-ANALYSIS.md` is not in the repo; taxonomy rebuilt from today's runs | **accepted** |
| 12 | Corpus is 13 cricket contracts, not 60 PDFs: no OCR, no indemnity, 2 amended families | **accepted** — stated everywhere |
| 13 | Bonus: 5 chain cases built, p50 chain cost measured; no SOWs exist so precedence case is amendment-vs-base; only 1/5 was red before | **fixed (with that caveat)** |
| 14 | Fresh-eyes reviewer / external MCP client | **ran-out-of-time** (needs a person) — `FRESH-EYES.md` |
