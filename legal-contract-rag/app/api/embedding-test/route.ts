import { NextResponse } from "next/server";
import { createEmbedding } from "@/lib/embeddings";

export async function GET() {
  try {
    const text = "Either party must provide 60 days written notice.";

    const embedding = await createEmbedding(text);

    return NextResponse.json({
      success: true,
      dimensions: embedding.length,
      firstFiveValues: embedding.slice(0, 5),
    });
  } catch (error) {
    console.error("Embedding failed:", error);

    return NextResponse.json(
      {
        success: false,
        error: "Failed to create embedding",
      },
      { status: 500 },
    );
  }
}
