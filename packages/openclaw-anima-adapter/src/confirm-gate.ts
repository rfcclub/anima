/**
 * Confirm-Before-Action Gate — pure helpers for the before_prompt_build hook.
 *
 * The gate turns recalled heuristic/decision/axiom rules into a hard
 * instruction block appended at the END of the system prompt (recency bias),
 * so the model must weigh "ask first" rules before acting on imperative
 * requests. Pure functions only — no DB, no side effects (unit-testable).
 */

export interface GateEntry {
  id: string;
  content: string;
  scope: string;
  tags: string[];
  confidence: number;
  source: string;
  createdAt: string;
}

/** Imperative action commands that should trigger the gate. */
const ACTION_INTENT_RE =
  // Matches Vietnamese action verbs (do, fix, change, write, delete, run, create, install) plus English ones; written as \u escapes.
  /\b(l\u00e0m|s\u1eeda|s\u1eeda l\u1ea1i|thay \u0111\u1ed5i|\u0111\u1ed5i|vi\u1ebft|x\u00f3a|xo\u00e1|ch\u1ea1y|ch\u1ea1y l\u1ec7nh|t\u1ea1o|t\u1ea1o m\u1edbi|c\u00e0i|c\u00e0i \u0111\u1eb7t|update|upgrade|deploy|install|uninstall|restart|reboot|kill|rm|drop|delete|remove|migrate|config|set|apply|patch|publish|push|merge)\b/i;

/** Rule content signals that the rule requires confirmation before acting. */
const CONFIRM_RULE_RE =
  // Matches Vietnamese and English confirmation phrases (must ask first, ask the owner, confirm, permission, before, wait for me); written as \u escapes.
  /\b(ph\u1ea3i h\u1ecfi|h\u1ecfi tr\u01b0\u1edbc|h\u1ecfi anh|h\u1ecfi owner|h\u1ecfi x\u00e1c nh\u1eadn|confirm|x\u00e1c nh\u1eadn|permission|cho ph\u00e9p|tr\u01b0\u1edbc khi|tr\u01b0\u1edbc m\u1ed7i action|not reversible|kh\u00f4ng reversible|destructive|ask first|ask before|wait for confirm|ch\u1edd anh)\b/i;

/** True when the user message reads like an imperative action command. */
export function detectActionIntent(userMessage: string): boolean {
  return ACTION_INTENT_RE.test(userMessage);
}

/** Keep only recalled entries that mandate confirmation before action. */
export function filterConfirmRules(entries: GateEntry[]): GateEntry[] {
  return entries.filter((e) => CONFIRM_RULE_RE.test(e.content));
}

/**
 * Render the gate block. Returns null when there is nothing to enforce —
 * callers should then inject nothing extra.
 */
export function formatConfirmGate(hits: GateEntry[]): string | null {
  if (hits.length === 0) return null;
  const lines: string[] = [
    "## ⛔ Confirm-Before-Action Gate",
    "",
    "The following recalled rules apply to this request:",
    "",
  ];
  for (const entry of hits) {
    lines.push(`- **${entry.scope}:${entry.id.slice(0, 8)}** — ${entry.content.split("\n")[0]}`);
  }
  lines.push(
    "",
    "If the current request asks you to act, change, execute, or write something",
    "(code, config, destructive ops, production state, shared files):",
    "you MUST pause and ask Owner to confirm before performing the action.",
    "Do not skip this step. A short imperative request is NOT authorization.",
  );
  return lines.join("\n");
}
