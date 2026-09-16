"use client";

import { useState } from "react";
import Link from "next/link";

interface Source {
  text: string;
  source: string;
  section: string;
  score: number;
}

type Mode = "vector" | "hybrid";

export default function Home() {
  const [mode, setMode] = useState<Mode>("hybrid");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [ingesting, setIngesting] = useState(false);

  async function handleIngest() {
    setIngesting(true);
    setStatus("Ingesting documents...");
    try {
      const res = await fetch("/api/ingest", { method: "POST" });
      const data = await res.json();
      setStatus(data.success ? data.message : `Error: ${data.error}`);
    } catch {
      setStatus("Error: ingestion request failed");
    } finally {
      setIngesting(false);
    }
  }

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim() || loading) return;

    setLoading(true);
    setAnswer("");
    setSources([]);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, mode }),
      });
      const data = await res.json();
      if (data.success) {
        setAnswer(data.answer);
        setSources(data.sources);
      } else {
        setAnswer(`Error: ${data.error}`);
      }
    } catch {
      setAnswer("Error: request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-16">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Legal Contract RAG
          </h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            Ask questions about the sample contracts. Ingest the documents
            first, then ask away.
          </p>
          <Link
            href="/inspect"
            className="text-sm text-zinc-500 underline-offset-4 hover:underline"
          >
            Open the retrieval inspector →
          </Link>
        </header>

        <section className="flex flex-wrap items-center gap-4">
          <button
            onClick={handleIngest}
            disabled={ingesting}
            className="rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-300"
          >
            {ingesting ? "Ingesting..." : "Ingest documents"}
          </button>

          <div className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <label htmlFor="mode">Retrieval</label>
            <select
              id="mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as Mode)}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            >
              <option value="vector">Vector only</option>
              <option value="hybrid">Hybrid (BM25 + RRF)</option>
            </select>
          </div>

          {status && (
            <span className="text-sm text-zinc-600 dark:text-zinc-400">
              {status}
            </span>
          )}
        </section>

        <form onSubmit={handleAsk} className="flex gap-3">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. How many days notice is needed to terminate?"
            className="flex-1 rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />
          <button
            type="submit"
            disabled={loading || !question.trim()}
            className="rounded-lg bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-300"
          >
            {loading ? "Thinking..." : "Ask"}
          </button>
        </form>

        {answer && (
          <section className="flex flex-col gap-4">
            <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
                Answer
              </h2>
              <p className="whitespace-pre-wrap leading-7 text-black dark:text-zinc-50">
                {answer}
              </p>
            </div>

            {sources.length > 0 && (
              <div className="flex flex-col gap-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
                  Sources
                </h2>
                {sources.map((source, index) => (
                  <div
                    key={index}
                    className="rounded-lg border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2 text-zinc-500">
                      <span className="font-medium">
                        [{index + 1}] {source.source} — {source.section}
                      </span>
                      <span>score {source.score.toFixed(3)}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">
                      {source.text}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
