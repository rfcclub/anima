import engineer from "../../cartridges/headless/work-engineer.md" with { type: "text" };
import bun from "../../cartridges/headless/typescript-bun.md" with { type: "text" };
import revise from "../../cartridges/headless/work-revise.md" with { type: "text" };
import review from "../../cartridges/headless/work-review.md" with { type: "text" };
import { createHash } from "node:crypto";
import type { ProviderToolDefinition } from "../providers/interface";

export type HeadlessProfile = "work" | "revise" | "review";

const profiles: Record<HeadlessProfile, readonly [string, string][]> = {
  work: [["work-engineer", engineer], ["typescript-bun", bun]],
  revise: [["work-engineer", engineer], ["typescript-bun", bun], ["work-revise", revise]],
  review: [["work-review", review]],
};

export function headlessCartridgeNames(profile: HeadlessProfile): string[] {
  return profiles[profile].map(([name]) => name);
}

type PromptInput = { name: string; label: string; repo: string; profile: HeadlessProfile };

/** Common work instructions precede revision-specific instructions and all changing identity fields. */
export function buildHeadlessPromptParts(input: PromptInput): { full: string; staticPrefix: string; staticHash: string } {
  const singleLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
  const lead = `You are ${singleLine(input.name)} (${singleLine(input.label)}), a software engineer on ${singleLine(input.repo)}.`;
  const text = (content: string) => content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
  const common = input.profile === "review" ? profiles.review : profiles.work;
  const staticPrefix = common.map(([, content]) => text(content)).join("\n\n") + "\n\n";
  const dynamic = input.profile === "revise" ? `${text(revise)}\n\n${lead}` : lead;
  return {
    full: staticPrefix + dynamic,
    staticPrefix,
    staticHash: createHash("sha256").update(staticPrefix).digest("hex"),
  };
}

export function buildHeadlessPrompt(input: PromptInput): string {
  return buildHeadlessPromptParts(input).full;
}

/** Only identical instructions and granted tool schemas share a provider routing key. */
export function headlessCacheKey(staticPrefix: string, tools: readonly ProviderToolDefinition[]): string {
  return createHash("sha256").update(staticPrefix).update("\0").update(JSON.stringify(tools)).digest("hex");
}

/** Canonical ordering improves reuse without adding any authority to the configured reviewer. */
export function headlessReviewTools(configured: readonly string[]): string[] {
  const allowed = new Set(configured);
  return ["anima_github", "bash", "read", "grep", "glob"].filter((tool) => allowed.has(tool));
}
