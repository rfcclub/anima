/** A section whose body contains this marker line is kept in full: the source document declares it, not the code. */
export const KEEP_FULL_MARKER = /^[ \t]*<!--\s*distill:\s*keep-full\s*-->[ \t]*$/m;

export interface DistillOptions {
  /** Sections whose "## Heading" line matches this pattern are kept in full, not distilled. */
  keepFullHeading?: RegExp;
}

export interface DistillAdapter {
  distill(content: string, opts?: DistillOptions): Promise<string>;
}

interface MarkdownSection {
  /** Full "## Heading" line, or "" for the preamble before the first heading. */
  heading: string;
  body: string;
}

function splitSections(content: string): MarkdownSection[] {
  const lines = content.split("\n");
  const headings: string[] = [""];
  const bodies: string[][] = [[]];
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      headings.push(line);
      bodies.push([]);
    } else {
      bodies[bodies.length - 1].push(line);
    }
  }
  return headings.map((heading, i) => ({ heading, body: bodies[i].join("\n") }));
}

function firstParagraph(body: string): string {
  const trimmed = body.replace(/^\n+/, "");
  const blankIdx = trimmed.search(/\n[ \t]*\n/);
  return (blankIdx === -1 ? trimmed : trimmed.slice(0, blankIdx)).trim();
}

/**
 * Deterministic, no-LLM distillation: every "## Heading" survives, but only
 * the section's lead paragraph does (unless the heading matches
 * `keepFullHeading` or contains the keep-full marker). Auto-adapts as source files grow — no hand-maintained
 * summary to fall out of sync, unlike the old CORE_IDENTITY.md's frozen
 * v13 self.md.
 */
export class HeadingLeadParagraphDistiller implements DistillAdapter {
  async distill(content: string, opts: DistillOptions = {}): Promise<string> {
    const sections = splitSections(content);
    const out: string[] = [];
    for (const section of sections) {
      if (!section.heading) {
        const preamble = section.body.trim();
        if (preamble) out.push(preamble);
        continue;
      }
      out.push(section.heading);
      const keepFull = (opts.keepFullHeading?.test(section.heading) ?? false) || KEEP_FULL_MARKER.test(section.body);
      const body = keepFull ? section.body.trim() : firstParagraph(section.body);
      if (body) out.push(body);
    }
    return `${out.join("\n\n").trim()}\n`;
  }
}

export interface LLMProviderLike {
  query(request: unknown): Promise<{ text?: string }>;
}

/**
 * Real semantic distillation via an already-configured provider, injected
 * by the caller — this module does not choose or pay for a model itself.
 * Not wired to a provider yet.
 */
export class LLMDistiller implements DistillAdapter {
  constructor(private readonly provider: LLMProviderLike) {}

  async distill(_content: string, _opts: DistillOptions = {}): Promise<string> {
    throw new Error("LLMDistiller has no configured provider wiring yet");
  }
}
