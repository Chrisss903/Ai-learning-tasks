"use client";

import { useState } from "react";
import Link from "next/link";

type Mode = "vector" | "hybrid";

interface Retrieved {
  id: number;
  text: string;
  source: string;
  section: string;
  score: number;
  vectorRank: number | null;
  keywordRank: number | null;
}

interface AskResult {
  answer: string;
  sources: Retrieved[];
  mode: Mode;
}

type Label = "pass" | "retrieval" | "generation";

interface QuestionResult {
  id: string;
  question: string;
  note: string;
  gold: { source: string; section: string }[];
  retrieved: Retrieved[];
  goldRank: number | null;
  retrievalHit: boolean;
  answer: string | null;
  answerOk: boolean | null;
  missing: string[];
  label: Label;
}

interface EvalRun {
  mode: Mode;
  k: number;
  generator: string | null;
  metrics: {
    total: number;
    hits: number;
    hitRate: number;
    mrr: number;
    passed: number;
    retrievalFailures: number;
    generationFailures: number;
  };
  results: QuestionResult[];
}

const MODE_LABELS: Record<Mode, string> = {
  vector: "Vector only (before)",
  hybrid: "Hybrid BM25 + RRF (after)",
};

const LABEL_STYLES: Record<Label, string> = {
  pass: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  retrieval: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  generation:
    "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
};

const LABEL_TEXT: Record<Label, string> = {
  pass: "pass",
  retrieval: "wrong document fetched",
  generation: "right document, wrong answer",
};

function percent(value: number) {
  return `${(value * 100).toFixed(0)}%`;
}

function RetrievedChunk({
  chunk,
  position,
  isGold,
}: {
  chunk: Retrieved;
  position: number;
  isGold: boolean;
}) {
  return (
    <div
      className={`rounded-md border p-3 text-xs ${
        isGold
          ? "border-emerald-400 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950/40"
          : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
      }`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-zinc-600 dark:text-zinc-400">
        <span>
          [{position}] {chunk.source} — {chunk.section}
        </span>
        {isGold && (
          <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-white">
            gold
          </span>
        )}
        <span className="ml-auto flex gap-2 text-[11px] text-zinc-500">
          <span>score {chunk.score.toFixed(4)}</span>
          <span>
            vec {chunk.vectorRank ?? "—"} / kw {chunk.keywordRank ?? "—"}
          </span>
        </span>
      </div>
      <p className="whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">
        {chunk.text}
      </p>
    </div>
  );
}

export default function Inspect() {
  const [question, setQuestion] = useState("");
  const [comparison, setComparison] = useState<Record<Mode, AskResult | null>>({
    vector: null,
    hybrid: null,
  });
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState("");

  const [runs, setRuns] = useState<Record<Mode, EvalRun | null>>({
    vector: null,
    hybrid: null,
  });
  const [evaluating, setEvaluating] = useState("");
  const [evalError, setEvalError] = useState("");

  async function handleCompare(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim() || asking) return;

    setAsking(true);
    setAskError("");
    setComparison({ vector: null, hybrid: null });

    try {
      const responses = await Promise.all(
        (["vector", "hybrid"] as Mode[]).map(async (mode) => {
          const res = await fetch("/api/ask", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question, mode }),
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error);
          return [mode, data as AskResult] as const;
        }),
      );

      setComparison({
        vector: responses.find(([mode]) => mode === "vector")![1],
        hybrid: responses.find(([mode]) => mode === "hybrid")![1],
      });
    } catch (error) {
      setAskError(error instanceof Error ? error.message : "Request failed");
    } finally {
      setAsking(false);
    }
  }

  async function handleEvaluate() {
    if (evaluating) return;

    setEvalError("");
    setRuns({ vector: null, hybrid: null });

    try {
      for (const mode of ["vector", "hybrid"] as Mode[]) {
        setEvaluating(mode);

        const res = await fetch("/api/eval", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, withAnswers: true }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        setRuns((current) => ({ ...current, [mode]: data.run as EvalRun }));
      }
    } catch (error) {
      setEvalError(error instanceof Error ? error.message : "Evaluation failed");
    } finally {
      setEvaluating("");
    }
  }

  const before = runs.vector;
  const after = runs.hybrid;

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 py-12">
        <header className="flex flex-col gap-2">
          <Link
            href="/"
            className="text-sm text-zinc-500 underline-offset-4 hover:underline"
          >
            ← Back to the app
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Retrieval inspector
          </h1>
          <p className="max-w-3xl text-zinc-600 dark:text-zinc-400">
            Question, what was fetched, and the final answer side by side — the
            same question run through vector-only search and through hybrid
            BM25 + RRF, so a wrong answer can be traced to the right cause.
          </p>
        </header>

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Inspect one question
          </h2>

          <form onSubmit={handleCompare} className="flex gap-3">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. What is the acceptance period in SOW-2024-017?"
              className="flex-1 rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
            <button
              type="submit"
              disabled={asking || !question.trim()}
              className="rounded-lg bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-300"
            >
              {asking ? "Running both..." : "Compare modes"}
            </button>
          </form>

          {askError && (
            <p className="text-sm text-red-600 dark:text-red-400">{askError}</p>
          )}

          {(comparison.vector || comparison.hybrid) && (
            <div className="grid gap-5 md:grid-cols-2">
              {(["vector", "hybrid"] as Mode[]).map((mode) => {
                const result = comparison[mode];
                if (!result) return null;

                return (
                  <div
                    key={mode}
                    className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
                  >
                    <h3 className="text-sm font-semibold text-black dark:text-zinc-50">
                      {MODE_LABELS[mode]}
                    </h3>

                    <div>
                      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                        Retrieved
                      </p>
                      <div className="flex flex-col gap-2">
                        {result.sources.map((chunk, index) => (
                          <RetrievedChunk
                            key={chunk.id}
                            chunk={chunk}
                            position={index + 1}
                            isGold={false}
                          />
                        ))}
                      </div>
                    </div>

                    <div>
                      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                        Answer
                      </p>
                      <p className="whitespace-pre-wrap text-sm leading-6 text-black dark:text-zinc-50">
                        {result.answer}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
              Scored evaluation
            </h2>
            <button
              onClick={handleEvaluate}
              disabled={Boolean(evaluating)}
              className="rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-300"
            >
              {evaluating
                ? `Running ${MODE_LABELS[evaluating as Mode]}...`
                : "Run both modes"}
            </button>
            <span className="text-sm text-zinc-500">
              20 questions × 2 modes, each with a generated answer — allow a few
              minutes.
            </span>
          </div>

          {evalError && (
            <p className="text-sm text-red-600 dark:text-red-400">{evalError}</p>
          )}

          {(before || after) && (
            <div className="grid gap-4 sm:grid-cols-2">
              {(["vector", "hybrid"] as Mode[]).map((mode) => {
                const run = runs[mode];
                if (!run) return null;

                return (
                  <div
                    key={mode}
                    className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
                  >
                    <h3 className="mb-3 text-sm font-semibold text-black dark:text-zinc-50">
                      {MODE_LABELS[mode]}
                    </h3>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                      <dt className="text-zinc-500">hit-rate@{run.k}</dt>
                      <dd className="font-semibold text-black dark:text-zinc-50">
                        {percent(run.metrics.hitRate)} ({run.metrics.hits}/
                        {run.metrics.total})
                      </dd>
                      <dt className="text-zinc-500">MRR@{run.k}</dt>
                      <dd className="font-semibold text-black dark:text-zinc-50">
                        {run.metrics.mrr.toFixed(3)}
                      </dd>
                      <dt className="text-zinc-500">wrong document</dt>
                      <dd className="text-black dark:text-zinc-50">
                        {run.metrics.retrievalFailures}
                      </dd>
                      <dt className="text-zinc-500">wrong answer</dt>
                      <dd className="text-black dark:text-zinc-50">
                        {run.metrics.generationFailures}
                      </dd>
                    </dl>
                    {run.generator && (
                      <p className="mt-3 text-xs text-zinc-500">
                        answers generated by {run.generator}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {before && after && (
            <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="bg-zinc-100 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
                  <tr>
                    <th className="px-3 py-2">#</th>
                    <th className="px-3 py-2">Question</th>
                    <th className="px-3 py-2">Gold clause</th>
                    <th className="px-3 py-2">Before</th>
                    <th className="px-3 py-2">After</th>
                    <th className="px-3 py-2">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {before.results.map((row) => {
                    const other = after.results.find(
                      (result) => result.id === row.id,
                    );
                    const fixed =
                      row.label !== "pass" && other?.label === "pass";
                    const broke =
                      row.label === "pass" && other && other.label !== "pass";

                    return (
                      <tr
                        key={row.id}
                        className="border-t border-zinc-200 align-top dark:border-zinc-800"
                      >
                        <td className="px-3 py-3 text-zinc-500">{row.id}</td>
                        <td className="px-3 py-3">
                          <p className="text-black dark:text-zinc-50">
                            {row.question}
                          </p>
                          <p className="mt-1 text-xs text-zinc-500">
                            {row.note}
                          </p>
                        </td>
                        <td className="px-3 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                          {row.gold
                            .map((gold) => `${gold.source} §${gold.section}`)
                            .join(", ")}
                        </td>
                        <td className="px-3 py-3">
                          <span
                            className={`inline-block rounded px-2 py-0.5 text-xs ${LABEL_STYLES[row.label]}`}
                          >
                            {LABEL_TEXT[row.label]}
                          </span>
                          <p className="mt-1 text-xs text-zinc-500">
                            gold rank {row.goldRank ?? "not in top 3"}
                          </p>
                        </td>
                        <td className="px-3 py-3">
                          {other && (
                            <>
                              <span
                                className={`inline-block rounded px-2 py-0.5 text-xs ${LABEL_STYLES[other.label]}`}
                              >
                                {LABEL_TEXT[other.label]}
                              </span>
                              <p className="mt-1 text-xs text-zinc-500">
                                gold rank {other.goldRank ?? "not in top 3"}
                              </p>
                            </>
                          )}
                        </td>
                        <td className="px-3 py-3 text-xs font-medium">
                          {fixed && (
                            <span className="text-emerald-700 dark:text-emerald-400">
                              fixed
                            </span>
                          )}
                          {broke && (
                            <span className="text-red-700 dark:text-red-400">
                              regressed
                            </span>
                          )}
                          {!fixed && !broke && (
                            <span className="text-zinc-400">unchanged</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {(before || after) &&
            (["vector", "hybrid"] as Mode[]).map((mode) => {
              const run = runs[mode];
              if (!run) return null;

              return (
                <details
                  key={mode}
                  className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <summary className="cursor-pointer text-sm font-semibold text-black dark:text-zinc-50">
                    Evidence — every question under {MODE_LABELS[mode]}
                  </summary>

                  <div className="mt-4 flex flex-col gap-6">
                    {run.results.map((row) => (
                      <div key={row.id} className="flex flex-col gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-black dark:text-zinc-50">
                            {row.id}. {row.question}
                          </span>
                          <span
                            className={`rounded px-2 py-0.5 text-xs ${LABEL_STYLES[row.label]}`}
                          >
                            {LABEL_TEXT[row.label]}
                          </span>
                        </div>

                        <div className="grid gap-3 md:grid-cols-2">
                          <div className="flex flex-col gap-2">
                            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                              Retrieved
                            </p>
                            {row.retrieved.map((chunk, index) => (
                              <RetrievedChunk
                                key={chunk.id}
                                chunk={chunk}
                                position={index + 1}
                                isGold={row.goldRank === index + 1}
                              />
                            ))}
                          </div>

                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                              Answer
                            </p>
                            <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-black dark:text-zinc-50">
                              {row.answer}
                            </p>
                            {row.missing.length > 0 && (
                              <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                                Missing expected fact:{" "}
                                {row.missing.join("; ")}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              );
            })}
        </section>
      </main>
    </div>
  );
}
