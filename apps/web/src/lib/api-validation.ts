import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_CONFIGURABLE_JSON_BODY_BYTES = 10 * 1024 * 1024;

type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse };

export async function parseJsonBody<T>(
  request: NextRequest,
  schema: z.ZodType<T>,
  error = "Invalid request body"
): Promise<ParseResult<T>> {
  const maxBodyBytes = maxJsonBodyBytes();
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    return oversizedJsonBodyResponse(maxBodyBytes);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return malformedJsonBodyResponse();
  }

  if (new TextEncoder().encode(rawBody).byteLength > maxBodyBytes) {
    return oversizedJsonBodyResponse(maxBodyBytes);
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return malformedJsonBodyResponse();
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

function malformedJsonBodyResponse(): ParseResult<never> {
  return {
    ok: false,
    response: NextResponse.json(
      { error: "Malformed JSON request body" },
      { status: 400 }
    )
  };
}

function oversizedJsonBodyResponse(maxBodyBytes: number): ParseResult<never> {
  return {
    ok: false,
    response: NextResponse.json(
      { error: `JSON request body exceeds ${maxBodyBytes} bytes` },
      { status: 413 }
    )
  };
}

function maxJsonBodyBytes() {
  const configured = Number(process.env.PATCHBAY_MAX_JSON_BODY_BYTES);
  if (!Number.isInteger(configured) || configured <= 0) {
    return DEFAULT_MAX_JSON_BODY_BYTES;
  }
  return Math.min(configured, MAX_CONFIGURABLE_JSON_BODY_BYTES);
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
