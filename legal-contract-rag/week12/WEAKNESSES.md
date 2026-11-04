# Top 3 known weaknesses — Wednesday 2026-11-04

Honest note: written after I had run the suite, so these are derived from the data, not predicted in advance. If the panel needs "before anyone asked", you must write your own version before the eval.

1. **It can answer an unanswerable question confidently, and the judge cannot see it** (T11, 1/22; the judge said "supported" to all 22). Guard against it with a deterministic "claim names a territory/term the cited clause does not contain" assertion, not a better judge prompt.
2. **The no-advice rule is regex-enforced.** Paraphrases ("this is quite unusual", "you'd be fine") will pass. The guard catches the phrasings I thought of and the one I found; it is not a classifier. Cases: 2.
3. **Everything is measured on 13 clean text contracts.** No OCR, no indemnity/liability, 2 amended families, n=22 single runs. The capstone's two hardest traps (cap in an amendment on 12 accounts, scanned PDFs) are *not* exercised here.
