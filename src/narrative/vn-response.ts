/**
 * Framework-free VN response parser + decline detection, shared by the
 * server (talk.ts) and the UI (parse-vn-response.ts re-exports it).
 * Lives under src/narrative/ so neither side imports across the other's
 * boundary.
 */
export interface VNChoice {
  label: string;
  value: string;
}

export interface ParsedVNResponse {
  narrative: string;
  text: string;
  choices: VNChoice[];
  mood?: string;
  emotion?: string;
  action?: string;
}

const FENCE_RE = /```json\s*([\s\S]*?)```/;
// A bare JSON object somewhere in the content — anchored on `{`, permissive
// about whitespace/newlines inside. Used only when no ```json fence matches.
const RAW_JSON_RE = /\{[\s\S]*\}/;

interface ExtractedJSON {
  parsed: Record<string, unknown>;
  /** Index in `content` where the JSON object started (for narrative slice). */
  index: number;
}

/** Try to locate + parse a JSON object in `content`. Prefers a ```json fence;
 *  falls back to the first bare `{...}` blob. Returns null if neither parses. */
function extractJSON(content: string): ExtractedJSON | null {
  const fence = content.match(FENCE_RE);
  if (fence && fence.index !== undefined) {
    try {
      return { parsed: JSON.parse(fence[1]), index: fence.index };
    } catch {
      // fall through to raw-JSON attempt
    }
  }
  const raw = content.match(RAW_JSON_RE);
  if (raw && raw.index !== undefined) {
    try {
      const parsed = JSON.parse(raw[0]);
      // Only accept objects with at least one recognized VN field — otherwise a
      // stray `{` mid-prose (e.g. "x = {1, 2}") would hijack the whole reply.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
          ("text" in parsed || "choices" in parsed || "mood" in parsed ||
           "emotion" in parsed || "action" in parsed)) {
        return { parsed, index: raw.index };
      }
    } catch {
      // not valid JSON — degrade
    }
  }
  return null;
}

export function parseVNResponse(content: string): ParsedVNResponse {
  const extracted = extractJSON(content);
  if (!extracted) {
    return { narrative: content.trim(), text: "", choices: [] };
  }

  const { parsed, index } = extracted;
  const narrative = content.slice(0, index).trim();
  const rawChoices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const choices: VNChoice[] = rawChoices
    .filter((c): c is { label: string; value: string } =>
      typeof c === "object" && c !== null && typeof (c as { label?: unknown }).label === "string" && typeof (c as { value?: unknown }).value === "string")
    .map((c) => ({ label: c.label, value: c.value }));

  return {
    narrative,
    text: typeof parsed.text === "string" ? parsed.text : "",
    choices,
    mood: typeof parsed.mood === "string" ? parsed.mood : undefined,
    emotion: typeof parsed.emotion === "string" ? parsed.emotion : undefined,
    action: typeof parsed.action === "string" ? parsed.action : undefined,
  };
}

/** The effective spoken text of a reply: the parsed `text` field when VN JSON
 *  is present, else the trimmed raw reply. This is the single source of truth
 *  for both decline detection and follow-up prompt context — never feed the
 *  raw reply string to either (SC-208/209).
 *
 *  When VN JSON is present, the spoken text is exactly the parsed `text`
 *  field — even when empty (an empty `text` is a decline per SC-202, NOT a
 *  fall-through to the raw JSON). Narrative before the JSON (if any) is used
 *  only when `text` is absent but prose preceded the object. */
export function extractSpokenText(rawReply: string): string {
  const extracted = extractJSON(rawReply);
  if (!extracted) {
    return rawReply.trim();
  }
  const { parsed, index } = extracted;
  const narrative = rawReply.slice(0, index).trim();
  if (typeof parsed.text === "string" && parsed.text.length > 0) return parsed.text;
  if (narrative) return narrative;
  // JSON parsed, text is empty/absent, no narrative → empty spoken text.
  return "";
}

/** Render text for display: narrative + text joined, either may be empty. */
export function renderVNText(parsed: ParsedVNResponse): string {
  return [parsed.narrative, parsed.text].filter(Boolean).join("\n\n");
}

const DECLINE_SENTINELS = new Set(["...", ""]);

/** Decline iff the effective spoken text is exactly "..." or empty.
 *  Closed set, exact match — no substring/prefix/case-fold. A unicode
 *  ellipsis "…" or a quoted `"..."` copied from the prompt is NOT a
 *  decline (SC-206/207): the model deviated, and the closed set refuses
 *  to guess — the reply is surfaced as a real (terse) answer instead. */
export function detectDecline(rawReply: string): boolean {
  return DECLINE_SENTINELS.has(extractSpokenText(rawReply).trim());
}
