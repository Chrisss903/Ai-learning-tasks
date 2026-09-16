A RAG app over a set of sample legal contracts — cricket contracts, which are
ordinary legal agreements in a setting that is easy to reason about. Built for
the AI Engineering League.

- **Week 3** — ingest contracts into Qdrant, retrieve with vector search, answer with an LLM.
- **Week 4** — tell retrieval failures apart from generation failures, and buy back hit-rate@3 with one change. → [EVALUATION.md](./EVALUATION.md)
- **Week 5** — read a fair sample of real traces, group the failures, rank them, pick what to fix next. → [ERROR-ANALYSIS.md](./ERROR-ANALYSIS.md)

## Week 4 — debugging retrieval

**The one change:** vector-only search became hybrid search — BM25 keyword scoring over the same chunks, fused with the vector results by Reciprocal Rank Fusion. Nothing else moved: same chunker, same embedding model, same prompt, same chat model, same top-3.

**Why that change.** Contract questions lean on exact identifiers — `PC-2026-027`, `TRF-2026-008`, `Annex III`, `Exhibit B`, `Level 3`. An embedding flattens those into "a player contract", "an annex", so two near-identical clauses in sibling contracts look equally relevant and the wrong one gets fetched. Keyword scoring keeps the identifier literal.

**How to run it**

1. `npm run dev`
2. `POST /api/qdrant/create-collection`, then `POST /api/ingest` (or the button on `/`).
3. Open [`/inspect`](http://localhost:3000/inspect) — the inspection view.
   - *Inspect one question* runs any question through both modes side by side: what was fetched, and the answer each mode produced.
   - *Run both modes* scores the 20-question evaluation set under vector-only and hybrid, and prints hit-rate@3, MRR@3, and a per-question before/after table.

Results and the failure analysis live in [EVALUATION.md](./EVALUATION.md).

**Where things live**

| File | Role |
| --- | --- |
| `lib/chunking.ts` | Splits documents into chunks with stable ids — shared by the vector index and the keyword index so results can be fused by id |
| `lib/bm25.ts` | BM25 keyword index, built in memory from the same chunks |
| `lib/search.ts` | `vector` and `hybrid` retrieval; hybrid fuses the two candidate lists with RRF |
| `lib/eval-set.ts` | 20 questions, each with its correct clause and the fact the answer must state |
| `lib/evaluate.ts` | Scores a run and labels each question `pass`, `retrieval`, or `generation` |
| `app/inspect/page.tsx` | The inspection view |

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
