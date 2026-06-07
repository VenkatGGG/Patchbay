import { NextResponse } from "next/server";
import { buildSessionReport } from "@/lib/report";
import { store } from "@/lib/store";

export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await context.params;
  const session = await store.getSession(sessionId);

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const report = buildSessionReport(session, await store.snapshot());

  return new NextResponse(report, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${sessionId}.md"`,
      "content-type": "text/markdown; charset=utf-8"
    }
  });
}
