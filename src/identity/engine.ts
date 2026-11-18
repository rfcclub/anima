import type { IdentitySummary } from "../cartridge/types";
import { estimateTokens } from "../utils/tokens";

/**
 * Sanitize content that will be composed into a prompt to prevent heading / comment spoofing.
 * Headings are demoted to plain text (structure neutralized, content preserved) — legitimate
 * soul content and injected headings are indistinguishable at the grammar level, so dropping
 * content would amputate real identity (F1).
 */
function sanitizeIdentityContent(content: string): string {
  const cleaned = content.replace(/<!--[\s\S]*?-->/g, "");
  const lines = cleaned.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    // ATX heading (up to 3 leading spaces, then 1-6 # followed by whitespace): keep the text, drop the markers.
    const atx = line.match(/^ {0,3}#{1,6}\s+(.*)$/);
    if (atx) {
      out.push(atx[1]);
      continue;
    }
    // Setext underline (promotes the preceding line to a heading): drop the underline only,
    // leaving the preceding line as plain text. A run of =/- after a blank line is a thematic
    // break, not a heading — keep it.
    if (/^ {0,3}[=-]+\s*$/.test(line) && out.length > 0 && out[out.length - 1].trim() !== "") {
      continue;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

export interface TieredSoul {
  core: string;
  preferences?: string;
  state?: string;
}

export interface IdentityContext {
  /** Parsed SOUL.md tiers. */
  soul: TieredSoul;
  /** Scars & lessons — hard-learned corrections. */
  scars?: string;
  /** External current state from substrate (e.g., state/, CURRENT.md). */
  state?: string;
  /** Relationship memory with the user / other agents. */
  relationship?: string;
}

const SECTION_MARKERS = {
  core: /^##\s+Identity\s+Core\s*$/im,
  preferences: /^##\s+Stable\s+Preferences\s*$/im,
  state: /^##\s+Current\s+State\s*$/im,
};

/** Parse SOUL.md content into tiered sections. */
export function tierSoul(content: string): TieredSoul {
  const lines = content.split("\n");

  const hasMarkers = SECTION_MARKERS.core.test(content);

  if (!hasMarkers) {
    return { core: content.trim() };
  }

  let currentSection: "core" | "preferences" | "state" | null = null;
  const sections: Record<string, string[]> = {
    core: [],
    preferences: [],
    state: [],
  };

  for (const line of lines) {
    if (SECTION_MARKERS.core.test(line)) {
      currentSection = "core";
      continue;
    }
    if (SECTION_MARKERS.preferences.test(line)) {
      currentSection = "preferences";
      continue;
    }
    if (SECTION_MARKERS.state.test(line)) {
      currentSection = "state";
      continue;
    }

    if (currentSection) {
      sections[currentSection].push(line);
    }
  }

  const result: TieredSoul = {
    core: sections.core.join("\n").trim(),
  };

  const preferences = sections.preferences.join("\n").trim();
  if (preferences) {
    result.preferences = preferences;
  }

  const state = sections.state.join("\n").trim();
  if (state) {
    result.state = state;
  }

  return result;
}


/** Produce a bounded Identity Summary from tiered content. */
export function produceIdentitySummary(
  tiered: TieredSoul,
  maxTokens: number,
): IdentitySummary {
  const core = tiered.core;
  const preferences = tiered.preferences;
  const state = tiered.state;

  let resultCore = core;
  let resultPreferences = preferences;
  let resultState = state;

  const coreTokens = estimateTokens(core);
  const prefTokens = preferences ? estimateTokens(preferences) : 0;
  const stateTokens = state ? estimateTokens(state) : 0;
  let totalTokens = coreTokens + prefTokens + stateTokens;

  if (totalTokens > maxTokens) {
    if (state) {
      resultState = undefined;
      totalTokens -= stateTokens;
    }

    if (totalTokens > maxTokens && preferences) {
      resultPreferences = undefined;
      totalTokens -= prefTokens;
    }

    if (totalTokens > maxTokens && core) {
      const maxChars = maxTokens * 4;
      resultCore = core.slice(0, maxChars);
      totalTokens = estimateTokens(resultCore);
    }
  }

  const summary: IdentitySummary = {
    core: resultCore,
    totalTokens,
  };

  if (resultPreferences) {
    summary.preferences = resultPreferences;
  }

  if (resultState) {
    summary.state = resultState;
  }

  return summary;
}

/**
 * Produce a single Current Identity Summary combining SOUL tiers with external substrate scopes.
 *
 * Truncation priority (most disposable first):
 *   1. External state
 *   2. Scars & lessons
 *   3. Relationship context
 *   4. Stable preferences
 *   5. Current state from SOUL
 *   6. Identity core (never dropped, truncated only as last resort)
 *
 * Returns a markdown block suitable for direct injection into the system prompt.
 */
function buildSummaryText(sections: { label: string; content: string; priority: number }[]): string {
  return sections
    .slice()
    .sort((a, b) => b.priority - a.priority)
    .map((s) => `## ${s.label}\n\n${s.content}`)
    .join("\n\n");
}

export function produceCurrentIdentitySummary(
  context: IdentityContext,
  maxTokens: number,
): string {
  const sections: { label: string; content: string; priority: number }[] = [];

  if (context.soul.core?.trim()) {
    sections.push({ label: "Identity Core", content: sanitizeIdentityContent(context.soul.core.trim()), priority: 6 });
  }
  if (context.soul.preferences?.trim()) {
    sections.push({ label: "Stable Preferences", content: sanitizeIdentityContent(context.soul.preferences.trim()), priority: 4 });
  }
  if (context.soul.state?.trim()) {
    sections.push({ label: "Current State", content: sanitizeIdentityContent(context.soul.state.trim()), priority: 5 });
  }
  if (context.relationship?.trim()) {
    sections.push({ label: "Relationship Context", content: sanitizeIdentityContent(context.relationship.trim()), priority: 3 });
  }
  if (context.scars?.trim()) {
    sections.push({ label: "Scars & Lessons", content: sanitizeIdentityContent(context.scars.trim()), priority: 2 });
  }
  if (context.state?.trim()) {
    sections.push({ label: "External State", content: sanitizeIdentityContent(context.state.trim()), priority: 1 });
  }

  if (sections.length === 0) {
    return "";
  }

  // Sort ascending so we can prune the lowest-priority (most disposable) section first.
  sections.sort((a, b) => a.priority - b.priority);

  let kept = sections.slice();
  while (true) {
    const text = buildSummaryText(kept);
    if (estimateTokens(text) <= maxTokens) {
      return text;
    }
    if (kept.length > 1) {
      // Remove the lowest-priority (first) section.
      kept.shift();
      continue;
    }
    // Last remaining section: trim its content to fit the budget.
    // Use a conservative 1:1 chars-to-tokens ratio, then re-measure the final text.
    const header = `## ${kept[0].label}\n\n`;
    const headerTokens = estimateTokens(header);
    let budget = Math.max(0, maxTokens - headerTokens);
    kept[0].content = kept[0].content.slice(0, budget);
    let finalText = buildSummaryText(kept);
    while (estimateTokens(finalText) > maxTokens && budget > 0) {
      budget = Math.max(0, budget - 4);
      kept[0].content = kept[0].content.slice(0, budget);
      finalText = buildSummaryText(kept);
    }
    return finalText;
  }
}
