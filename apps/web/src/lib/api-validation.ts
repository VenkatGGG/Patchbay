import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse };

export async function parseJsonBody<T>(
  request: NextRequest,
  schema: z.ZodType<T>,
  error = "Invalid request body"
): Promise<ParseResult<T>> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Malformed JSON request body" },
        { status: 400 }
      )
    };
  }

  const parsed = await schema.safeParseAsync(json);

  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }

  return {
    ok: false,
    response: NextResponse.json(
      {
        error,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      },
      { status: 400 }
    )
  };
}

export function domainErrorResponse(error: unknown) {
  if (!(error instanceof Error)) {
    return undefined;
  }

  if (
    error.message.startsWith("Unknown environment:") ||
    error.message.startsWith("Unknown agent:") ||
    error.message.startsWith("Unknown session:") ||
    error.message.startsWith("Unknown task:")
  ) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }

  if (error.message === "Session is not active") {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }

  return undefined;
}
