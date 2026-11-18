/**
 * SOUL.md parser — splits a SOUL markdown file into named parts.
 *
 * Each `## <Part>` section becomes a substrate scope file.
 * Parts are mapped to canonical scope names used by the SubstrateViewLayer.
 */

export interface SoulPart {
  /** Original header from SOUL.md, e.g. "Core Truths". */
  title: string;
  /** Canonical substrate scope, e.g. "values". */
  scope: string;
  /** Body text under the header (trimmed). */
  content: string;
}

const SCOPE_MAP: Record<string, string> = {
  identity: "identity_core",
  "core truths": "values",
  boundaries: "boundaries",
  vibe: "vibe",
  continuity: "continuity",
};

export function parseSoul(content: string): SoulPart[] {
  const parts: SoulPart[] = [];
  const lines = content.split(/\r?\n/);
  let currentTitle = "";
  let currentBody: string[] = [];

  function flush() {
    if (!currentTitle) return;
    const body = currentBody.join("\n").trim();
    if (body.length === 0) return;
    const normalized = currentTitle.trim().toLowerCase();
    parts.push({
      title: currentTitle.trim(),
      scope: SCOPE_MAP[normalized] ?? normalized.replace(/\s+/g, "_"),
      content: body,
    });
  }

  for (const line of lines) {
    const match = line.match(/^##\s+(.+)$/);
    if (match) {
      flush();
      currentTitle = match[1];
      currentBody = [];
    } else if (currentTitle) {
      currentBody.push(line);
    }
  }
  flush();
  return parts;
}

export function mapSoulScope(title: string): string {
  return SCOPE_MAP[title.trim().toLowerCase()] ?? title.trim().toLowerCase().replace(/\s+/g, "_");
}
