import { createCollection } from "@/lib/qdarnt-collections";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const message = await createCollection();

    return NextResponse.json({
      success: true,
      message,
    });
  } catch (error) {
    console.error("Collection creation failed:", error);

    return NextResponse.json(
      {
        success: false,
        error: "Failed to create collection",
      },
      { status: 500 },
    );
  }
}
