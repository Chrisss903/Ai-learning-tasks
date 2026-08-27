import { NextResponse } from "next/server";
import { ingestDocuments } from "@/lib/ingest";

export async function POST() {
  try {
    const message = await ingestDocuments();

    return NextResponse.json({
      success: true,
      message,
    });
  } catch (error) {
    console.error("Ingestion failed:", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Ingestion failed",
      },
      { status: 500 },
    );
  }
}
