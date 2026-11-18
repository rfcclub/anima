const PATTERNS: Array<{ re: RegExp; id: string }> = [
  { re: /claude-code/i, id: "claude-code" },
  { re: /codex|openai-codex/i, id: "codex" },
  { re: /anthropic-sdk/i, id: "anthropic-sdk" },
  { re: /openai/i, id: "openai-sdk" },
];

export function detectCaller(req: Request): string {
  const explicit = req.headers.get("x-anima-caller")?.trim();
  if (explicit) return explicit.toLowerCase();

  const ua = req.headers.get("user-agent") ?? "";
  for (const { re, id } of PATTERNS) {
    if (re.test(ua)) return id;
  }
  return "proxy-gateway";
}
