import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export function requireOperator(request: NextRequest) {
  const expected = operatorToken();

  if (!expected) {
    return null;
  }

  const actual =
    bearerToken(request.headers.get("authorization")) ??
    request.headers.get("x-patchbay-operator-token")?.trim();

  if (actual && safeEqual(actual, expected)) {
    return null;
  }

  return NextResponse.json(
    {
      error: "Operator token required"
    },
    {
      status: 401,
      headers: {
        "www-authenticate": "Bearer"
      }
    }
  );
}

export function operatorAuthStatus() {
  return {
    required: Boolean(operatorToken())
  };
}

function operatorToken() {
  const value = process.env.PATCHBAY_OPERATOR_TOKEN?.trim();
  return value && value.length > 0 ? value : undefined;
}

function bearerToken(header: string | null) {
  if (!header) {
    return undefined;
  }

  const [scheme, token] = header.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" ? token?.trim() : undefined;
}

function safeEqual(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
