import { NextResponse } from "next/server";
import { searchDocuments, type SearchMode } from "@/lib/search";
import { generateAnswer } from "@/lib/rag";
import { resolveGenerator } from "@/lib/generator";
import { EMBEDDING_LABEL } from "@/lib/embeddings";
import { sampleQuestions } from "@/lib/trace-questions";

// 20 answers from a rate-limited free tier is a slow loop.
export const maxDuration = 800;

export async function POST(request: Request) {
  try {
    const { count, seed, mode } = await request.json();

    const searchMode: SearchMode = mode === "vector" ? "vector" : "hybrid";
    const sampleSize = Number(count ?? 20);
    const sampleSeed = Number(seed ?? 1);

    const questions = sampleQuestions(sampleSize, sampleSeed);

    const traces = [];
    for (const [index, question] of questions.entries()) {
      const retrieved = await searchDocuments(question, 3, searchMode);
      const answer = await generateAnswer(question, retrieved);

      traces.push({
        id: `T${String(index + 1).padStart(2, "0")}`,
        question,
        mode: searchMode,
        retrieved,
        answer,
      });
    }

    return NextResponse.json({
      success: true,
      run: {
        capturedAt: new Date().toISOString(),
        seed: sampleSeed,
        mode: searchMode,
        embeddingModel: EMBEDDING_LABEL,
        generator: resolveGenerator().label,
        traces,
      },
    });
  } catch (error) {
    console.error("Trace capture failed:", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Trace capture failed",
      },
      { status: 500 },
    );
  }
}
