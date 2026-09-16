import { NextResponse } from "next/server";
import { runEvaluation } from "@/lib/evaluate";
import type { SearchMode } from "@/lib/search";

// One mode per request: 20 questions with answers is a long-running loop.
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const { mode, withAnswers } = await request.json();

    const searchMode: SearchMode = mode === "hybrid" ? "hybrid" : "vector";

    const run = await runEvaluation(searchMode, {
      withAnswers: withAnswers !== false,
    });

    return NextResponse.json({ success: true, run });
  } catch (error) {
    console.error("Evaluation failed:", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Evaluation failed",
      },
      { status: 500 },
    );
  }
}
