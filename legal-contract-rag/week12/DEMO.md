# 10-minute demo script

Setup: `export GEMINI_MODEL=gemini-3.5-flash-lite CONTRACT_REPO_TOKEN=local` (any value).

**Part 1 — real run (3 min)**
1. `npm run capstone -- ask "What is Rohan Sharma's current termination notice?"` — point at `find_amendments`/`get_amendment_chain` in the steps (chain resolved before quoting), answer cites `[PC-2026-011 §8]` AND `[AMD-PC-011-01 §3]`.
2. `npm run capstone -- ask 'What does "Match Fee" mean in Rohan Sharma contract PC-2026-011?'` — `resolve_defined_term` call, schedule definition returned.
3. `npm run capstone -- ask "Is the 90-day termination notice in Rohan Sharma's contract standard?"` — fact + referral to counsel, no verdict.
4. `npm run capstone -- trace <id>` — spans, cost, and "trace id survived every hop".

**Part 2 — failures (3 min)** `week12/EVAL-REPORT.md` taxonomy: T11 (trace `5dca4ce8…`, 1/22), the "is not standard" leak (`7d271619…`), the integration-created modes (#4, #5), OCR = not measurable (0 PDFs), the three weaknesses.

**Part 3 — number that moved (2 min)** Counsel guard C03: FAIL → PASS (`counsel-red.txt` → `counsel-green.txt`, n=2). Amended chains 5/5. Judge agreement: say plainly it is NOT measured and the judge said "supported" to 22/22. Not covered: indemnity/liability (0 cases), OCR, 12 amended accounts.

**Part 4 — next (2 min)** Cost $0.0031/question; 10× breaks the 15 calls/min provider cap first (72 needed); fixes ranked in the report.

Live-demo risk: free tier ≈ 25–40 s per question; pre-run the traces and have ids ready.
