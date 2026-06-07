import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      service: "patchbay",
      timestamp: new Date().toISOString()
    },
    {
      headers: {
        "cache-control": "no-store"
      }
    }
  );
}
