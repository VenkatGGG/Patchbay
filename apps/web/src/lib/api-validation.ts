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
  const json = await request.json().catch(() => ({}));
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
