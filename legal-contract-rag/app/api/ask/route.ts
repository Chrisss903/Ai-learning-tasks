import { NextResponse } from "next/server";
import { askQuestion } from "@/lib/rag";
import type { SearchMode } from "@/lib/search";

export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const { question, mode, user, role } = await request.json();

    if (!question || typeof question !== "string") {
      return NextResponse.json(
        { success: false, error: "A 'question' string is required" },
        { status: 400 },
      );
    }

    const searchMode: SearchMode = mode === "hybrid" ? "hybrid" : "vector";

    // Week 11: who asked is logged with every request — the user slice of a
    // complaint. A real deployment takes it from the session; this app has
    // none, so it is accepted from the body or a header.
    const result = await askQuestion(question, searchMode, {
      channel: "web",
      user: {
        id: String(user ?? request.headers.get("x-user-id") ?? "anonymous"),
        role: String(role ?? request.headers.get("x-user-role") ?? "unknown"),
      },
    });

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
