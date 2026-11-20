#!/usr/bin/env bun
/**
 * Deploy roster check. The deploy used to copy the checkout's data/colony.json over the runtime roster. The public
 * default branch carries a neutral sample roster, so deploying from it would replace the real roster. This chooses
 * which file to install: a private overlay kept outside every repository, the repository roster when it names the
 * same agents as the runtime roster (or there is no runtime roster yet), and otherwise it refuses, before anything is
 * copied.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type RosterChoice = { action: "overlay" } | { action: "repo" } | { action: "refuse"; reason: string };

/** Sorted agent names, or null when the text is not a roster. */
export function rosterNames(text: string): string[] | null {
  try {
    const parsed = JSON.parse(text) as { agents?: unknown };
    const agents = parsed.agents;
    let names: string[];
    if (Array.isArray(agents)) {
      names = agents.map((a) => (typeof a === "string" ? a : String((a as { name?: unknown; id?: unknown })?.name ?? (a as { id?: unknown })?.id ?? "")));
    } else if (agents && typeof agents === "object") {
      names = Object.keys(agents as object);
    } else {
      return null;
    }
    if (names.length === 0 || names.some((n) => n === "")) return null;
    return [...names].sort();
  } catch {
    return null;
  }
}

export function chooseRoster(input: { repo: string; runtime: string | null; overlay?: string | null }): RosterChoice {
  if (input.overlay !== undefined && input.overlay !== null) {
    return rosterNames(input.overlay) ? { action: "overlay" } : { action: "refuse", reason: "the overlay roster is not a readable roster" };
  }
  const repoNames = rosterNames(input.repo);
  if (!repoNames) return { action: "refuse", reason: "the repository roster is not a readable roster" };
  if (input.runtime === null) return { action: "repo" };
  const runtimeNames = rosterNames(input.runtime);
  if (runtimeNames && runtimeNames.join("\n") === repoNames.join("\n")) return { action: "repo" };
  return {
    action: "refuse",
    reason: "the build's roster differs from the runtime roster and no overlay is configured; set ANIMA_OVERLAY_DIR to a private directory holding colony.json",
  };
}

if (import.meta.main) {
  const [repoFile, runtimeFile, overlayDir] = process.argv.slice(2);
  if (!repoFile || !runtimeFile) {
    console.error("usage: deploy-roster.ts <repo roster> <runtime roster> [overlay dir]");
    process.exit(2);
  }
  const overlayFile = overlayDir ? join(overlayDir, "colony.json") : "";
  if (overlayDir && !existsSync(overlayFile)) {
    console.error(`refusing to deploy: the overlay directory has no colony.json`);
    process.exit(1);
  }
  const choice = chooseRoster({
    repo: readFileSync(repoFile, "utf-8"),
    runtime: existsSync(runtimeFile) ? readFileSync(runtimeFile, "utf-8") : null,
    overlay: overlayDir ? readFileSync(overlayFile, "utf-8") : undefined,
  });
  if (choice.action === "refuse") {
    console.error(`refusing to deploy: ${choice.reason}`);
    process.exit(1);
  }
  console.log(choice.action === "overlay" ? overlayFile : repoFile);
}
