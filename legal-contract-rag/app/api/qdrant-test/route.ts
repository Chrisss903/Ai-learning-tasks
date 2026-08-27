import { NextResponse } from "next/server";
import { qdrant } from "@/lib/qdrant";

export async function GET() {
  try {
    const response = await qdrant.getCollections();
    console.log("QDRANT_URL:", process.env.QDRANT_URL);
    console.log("QDRANT_API_KEY exists:", Boolean(process.env.QDRANT_API_KEY));

    return NextResponse.json({
      connected: true,
      collections: response.collections,
    });
  } catch (error) {
    console.error("Qdrant connection failed:", error);

    return NextResponse.json(
      {
        connected: false,
        error: "Unable to connect to Qdrant",
      },
      { status: 500 },
    );
  }
}
