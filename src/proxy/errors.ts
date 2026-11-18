import { ProviderError } from "../providers/interface";

function statusForCode(code: string): number {
  if (code === "RATE_LIMITED" || code === "QUOTA_EXHAUSTED") return 429;
  if (code === "AUTH_ERROR") return 401;
  if (code === "TIMEOUT") return 504;
  return 500;
}

export function mapProviderError(err: ProviderError, protocol: "anthropic" | "openai"): Response {
  const status = statusForCode(err.code);
  if (protocol === "anthropic") {
    return Response.json(
      { type: "error", error: { type: "api_error", message: err.message } },
      { status },
    );
  }
  return Response.json(
    { error: { message: err.message, type: "api_error", code: err.code.toLowerCase() } },
    { status },
  );
}
