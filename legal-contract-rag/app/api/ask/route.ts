import { NextResponse } from "next/server";
import { askQuestion } from "@/lib/rag";
import type { SearchMode } from "@/lib/search";

export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const { question, mode } = await request.json();

    if (!question || typeof question !== "string") {
      return NextResponse.json(
        { success: false, error: "A 'question' string is required" },
        { status: 400 },
      );
    }

    const searchMode: SearchMode = mode === "hybrid" ? "hybrid" : "vector";
    const result = await askQuestion(question, searchMode);

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error("RAG query failed:", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "RAG query failed",
      },
      { status: 500 },
    );
  }
}
