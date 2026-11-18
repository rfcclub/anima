import type { LoadedAgent } from "./loader";
import type { PermissionMode } from "../config/types";
import type { CartridgeBlock, ExecutionPlan, IdentitySummary, RetrievedMemory } from "../cartridge/types";
import { LOOP_DIRECTIVE } from "./loop";
import { formatBootstrapContent } from "../session/cross-session-memory";

const MAX_FILE_CHARS = 4_000;

const CARTRIDGE_SCOPE_RANK: Record<string, number> = { shared: 0, agent: 1 };

export interface SystemPromptOptions {
  mode?: PermissionMode;
  loop?: boolean;
  memoryRecall?: string[];
  recentEvents?: unknown[];
  /** Always-on cartridges (shared+agent scope) — composed into the static, cacheable prefix. */
  baseCartridges?: CartridgeBlock[];
  /** The pluggable cartridge for this turn — composed into the dynamic suffix (after cache boundary). */
  activeCartridge?: CartridgeBlock;
  /** Pre-synthesized Current Identity Summary (SOUL + substrate + relationship). Overrides raw soulContent. */
  currentIdentitySummary?: string;
}

export interface StructuredPrompt {
  /** Full prompt as single string (backwards-compatible) */
  full: string;
  /** Static prefix — doesn't change mid-session. Providers with prefix caching (DeepSeek, GLM, Anthropic) cache this automatically. */
  staticPrefix: string;
  /** Dynamic suffix — changes per-turn (memory recall, bootstrap). Goes after static prefix. */
  dynamicSuffix: string;
  /** Simple hash of staticPrefix for cache tracking */
  staticHash: string;
}

export function buildSystemPrompt(
  loadedAgent: LoadedAgent,
  options: SystemPromptOptions = {},
): StructuredPrompt {
  const mode = options.mode ?? loadedAgent.config.session.defaultMode;
  const staticSections = [
    `# ${loadedAgent.name} - ${loadedAgent.label}`,
  ];

  // ── Static layers (prefix-cacheable) ─────────────────────────────────

  // Soul first — identity before instruction. Prefer synthesized Current Identity Summary if available.
  if (options.currentIdentitySummary?.trim()) {
    staticSections.push("## Soul", truncateContent(options.currentIdentitySummary.trim(), MAX_FILE_CHARS));
  } else if (loadedAgent.soulContent?.trim()) {
    staticSections.push("## Soul", loadedAgent.soulContent.trim());
  }

  // Instructions capped at 4K chars
  staticSections.push("## Instructions", truncateContent(loadedAgent.geneContent.trim(), MAX_FILE_CHARS));

  staticSections.push("## Context", formatSessionContext(loadedAgent.sessionContextFiles));

  const preloadedFiles = collectPreloadedPaths(loadedAgent);
  if (preloadedFiles.length > 0) {
    staticSections.push("## Pre-loaded Context", preloadedDirective(preloadedFiles));
  }

  if (loadedAgent.additionalSessionContext && loadedAgent.additionalSessionContext.length > 0) {
    staticSections.push("## Additional Context", formatSessionContext(loadedAgent.additionalSessionContext));
  }

  for (const file of loadedAgent.additionalContent) {
    staticSections.push(`## Additional Boot File: ${file.name}`, file.content.trim());
  }

  // Base cartridges (shared + agent) — stable within session, so part of the cacheable prefix
  if (options.baseCartridges && options.baseCartridges.length > 0) {
    const sorted = [...options.baseCartridges].sort((a, b) => {
      const rank = (CARTRIDGE_SCOPE_RANK[a.scope] ?? 9) - (CARTRIDGE_SCOPE_RANK[b.scope] ?? 9);
      return rank !== 0 ? rank : a.name.localeCompare(b.name);
    });
    for (const c of sorted) {
      staticSections.push(`## Cartridge: ${c.scope}/${c.category}/${c.name}`, c.content.trim());
    }
  }

  // Runtime section — model, provider, agent (stable within session)
  staticSections.push("## Runtime", runtimeSection(loadedAgent));

  // Soft mode hint
  staticSections.push("## Mode", modeDirective(mode));
  if (options.loop) staticSections.push(LOOP_DIRECTIVE);
  staticSections.push("## Tools", toolPolicySummary(loadedAgent));

  const staticPrefix = staticSections.map((s) => s.trim()).join("\n\n") + "\n";

  // ── Dynamic layers (change per-turn — after cache boundary) ─────────

  const dynamicSections: string[] = [];
  // Date is volatile — goes in dynamic section to keep staticPrefix byte-stable across days.
  dynamicSections.push(`Date: ${new Date().toISOString().slice(0, 10)}`);

  // Active pluggable cartridge — changes per turn, so lives after the cache boundary
  if (options.activeCartridge) {
    const c = options.activeCartridge;
    dynamicSections.push(`## Active Cartridge: ${c.scope}/${c.category}/${c.name}`, c.content.trim());
  }

  const memoryRecall = formatMemoryRecall(loadedAgent, options.memoryRecall);
  if (memoryRecall) {
    dynamicSections.push("## Memory Recall", memoryRecall);
  }

  const bootstrap = formatBootstrapContent(loadedAgent.bootstrapContent ?? "");
  if (bootstrap) {
    dynamicSections.push(bootstrap);
  }

  const dynamicSuffix = dynamicSections.length > 0
    ? dynamicSections.map((s) => s.trim()).join("\n\n") + "\n"
    : "";

  const full = staticPrefix + (dynamicSuffix ? "\n" + dynamicSuffix : "");

  // Fast hash for cache tracking
  let h = 0;
  for (let i = 0; i < staticPrefix.length; i++) {
    h = ((h << 5) - h) + staticPrefix.charCodeAt(i);
    h |= 0;
  }
  const staticHash = (h >>> 0).toString(36);

  return { full, staticPrefix, dynamicSuffix, staticHash };
}

export interface PlanPromptOptions extends SystemPromptOptions {
  identitySummary?: IdentitySummary;
  /** A pre-synthesized Current Identity Summary (SOUL + substrate + relationship). Takes precedence over identitySummary. */
  currentIdentitySummary?: string;
  trustedMemories?: RetrievedMemory[];
  unverifiedMemories?: RetrievedMemory[];
}

/** Build system prompt from an ExecutionPlan (multi-layer composition). */
export function buildSystemPromptFromPlan(
  loadedAgent: LoadedAgent,
  plan: ExecutionPlan,
  options: PlanPromptOptions = {},
): StructuredPrompt {
  const mode = options.mode ?? loadedAgent.config.session.defaultMode;
  const staticSections = [
    `# ${loadedAgent.name} - ${loadedAgent.label}`,
  ];

  // Soul — use pre-synthesized Current Identity Summary if available, then Identity Summary, then raw fallback.
  if (options.currentIdentitySummary?.trim()) {
    staticSections.push("## Soul", truncateContent(options.currentIdentitySummary.trim(), MAX_FILE_CHARS));
  } else if (options.identitySummary) {
    const parts: string[] = [options.identitySummary.core];
    if (options.identitySummary.preferences) parts.push(options.identitySummary.preferences);
    if (options.identitySummary.state) parts.push(options.identitySummary.state);
    staticSections.push("## Soul", parts.join("\n\n"));
  } else if (loadedAgent.soulContent?.trim()) {
    staticSections.push("## Soul", truncateContent(loadedAgent.soulContent.trim(), MAX_FILE_CHARS));
  }

  staticSections.push("## Instructions", truncateContent(loadedAgent.geneContent.trim(), MAX_FILE_CHARS));
  staticSections.push("## Context", formatSessionContext(loadedAgent.sessionContextFiles));

  const preloadedFiles = collectPreloadedPaths(loadedAgent);
  if (preloadedFiles.length > 0) {
    staticSections.push("## Pre-loaded Context", preloadedDirective(preloadedFiles));
  }

  if (loadedAgent.additionalSessionContext && loadedAgent.additionalSessionContext.length > 0) {
    staticSections.push("## Additional Context", formatSessionContext(loadedAgent.additionalSessionContext));
  }

  for (const file of loadedAgent.additionalContent) {
    staticSections.push(`## Additional Boot File: ${file.name}`, file.content.trim());
  }

  // Universal cartridges (always-on, identity-baseline)
  for (const c of plan.universal) {
    staticSections.push(`## Universal: ${c.name}`, c.content.trim());
  }

  // Dependencies (kernel, review-common, etc.)
  for (const c of plan.dependencies) {
    staticSections.push(`## Dependency: ${c.name}`, c.content.trim());
  }

  // Persona (interaction style)
  if (plan.interactionPersona) {
    staticSections.push(`## Persona: ${plan.interactionPersona.name}`, plan.interactionPersona.content.trim());
  }

  // Working role
  if (plan.workingRole) {
    staticSections.push(`## Role: ${plan.workingRole.name}`, plan.workingRole.content.trim());
  }

  staticSections.push("## Runtime", runtimeSection(loadedAgent));
  staticSections.push("## Mode", modeDirective(mode));
  if (options.loop) staticSections.push(LOOP_DIRECTIVE);
  staticSections.push("## Tools", toolPolicySummary(loadedAgent));

  // Language, framework, project, task — stable within a session, cacheable
  if (plan.language) {
    staticSections.push(`## Language: ${plan.language.name}`, plan.language.content.trim());
  }
  if (plan.framework) {
    staticSections.push(`## Framework: ${plan.framework.name}`, plan.framework.content.trim());
  }
  if (plan.project) {
    staticSections.push(`## Project: ${plan.project.name}`, plan.project.content.trim());
  }
  if (plan.task) {
    staticSections.push(`## Task: ${plan.task.name}`, plan.task.content.trim());
  }

  let staticPrefix = staticSections.map((s) => s.trim()).join("\n\n") + "\n";
  // Normalize before hashing so the cache key matches the normalized prefix after
  // identity-anchor injection (which applies the same transform to the full system).
  staticPrefix = staticPrefix.replace(/\n{3,}/g, "\n\n").trim() + "\n";

  // Dynamic layers
  const dynamicSections: string[] = [];
  dynamicSections.push(`Date: ${new Date().toISOString().slice(0, 10)}`);

  // Trusted Memory and Unverified Candidates from substrate retrieval
  if (options.trustedMemories && options.trustedMemories.length > 0) {
    const lines = options.trustedMemories.map(m => `- [${m.scope}] ${m.content}`).join("\n");
    dynamicSections.push("## Trusted Memory", lines);
  }
  if (options.unverifiedMemories && options.unverifiedMemories.length > 0) {
    const lines = options.unverifiedMemories.map(m => `- [${m.scope}] ${m.content}`).join("\n");
    dynamicSections.push("## Unverified Candidates", lines);
  }

  const memoryRecall = formatMemoryRecall(loadedAgent, options.memoryRecall);
  if (memoryRecall) {
    dynamicSections.push("## Memory Recall", memoryRecall);
  }

  const bootstrap = formatBootstrapContent(loadedAgent.bootstrapContent ?? "");
  if (bootstrap) {
    dynamicSections.push(bootstrap);
  }

  const dynamicSuffix = dynamicSections.length > 0
    ? dynamicSections.map((s) => s.trim()).join("\n\n") + "\n"
    : "";

  const full = staticPrefix + (dynamicSuffix ? "\n" + dynamicSuffix : "");

  let h = 0;
  for (let i = 0; i < staticPrefix.length; i++) {
    h = ((h << 5) - h) + staticPrefix.charCodeAt(i);
    h |= 0;
  }
  const staticHash = (h >>> 0).toString(36);

  return { full, staticPrefix, dynamicSuffix, staticHash };
}

function formatSessionContext(files: LoadedAgent["sessionContextFiles"]): string {
  return files.map((file) => {
    const label = file.label ?? file.path;
    const limit = file.maxChars ?? MAX_FILE_CHARS;
    const content = truncateContent(file.content.trim(), limit);
    return `### ${label}\n${content}`;
  }).join("\n\n");
}

function formatMemoryRecall(loadedAgent: LoadedAgent, dynamicRecall: string[] = []): string | undefined {
  const results = (loadedAgent.extraActionResults ?? [])
    .filter((result) => result.exitCode === 0 && result.stdout.trim().length > 0);

  const sections = [
    ...dynamicRecall
      .map((content) => content.trim())
      .filter(Boolean)
      .map((content, index) => `### Recall ${index + 1}\n${content}`),
    ...results.map((result) => `### ${result.label}\n${result.stdout.trim()}`),
  ];

  if (sections.length === 0) {
    return undefined;
  }

  return sections.join("\n\n");
}

function modeDirective(mode: PermissionMode): string {
  switch (mode) {
    case "plan":
      return "Plan mode — prefer inspection and reasoning.";
    case "edit":
      return "Edit mode — focused changes inside allowed roots, report what changed.";
    case "auto":
      return "Auto mode — act autonomously within allowed roots and tool policy.";
  }
}

function toolPolicySummary(loadedAgent: LoadedAgent): string {
  const { policy } = loadedAgent.config;
  const lines = [
    `Allowed roots: ${policy.allowedRoots.join(", ") || "(none)"}`,
    `Read-only roots: ${(policy.readOnlyRoots ?? []).join(", ") || "(none)"}`,
    `Allowed tools: ${(policy.allowedTools ?? []).join(", ") || "(default provider limits)"}`,
  ];

  if (policy.deniedPatterns && policy.deniedPatterns.length > 0) {
    lines.push(`Denied patterns: ${policy.deniedPatterns.join(", ")}`);
  }

  return lines.join("\n");
}

function collectPreloadedPaths(loadedAgent: LoadedAgent): string[] {
  const paths: string[] = [];
  for (const file of loadedAgent.sessionContextFiles) {
    paths.push(file.path);
  }
  if (loadedAgent.additionalSessionContext) {
    for (const file of loadedAgent.additionalSessionContext) {
      paths.push(file.path);
    }
  }
  return paths;
}

function preloadedDirective(paths: string[]): string {
  const list = paths.map((p) => `  - ${p}`).join("\n");
  return `The following files have ALREADY been loaded into this session above. Do NOT re-read them — their content is already in your context.

${list}`;
}

const ANCHOR_MARKER = "<!-- IDENTITY_ANCHOR -->";

/** Build the identity anchor block wrapped in markers for find-and-move. */
export function buildIdentityAnchor(loadedAgent: LoadedAgent): string | undefined {
  const anchor = loadedAgent.config.identity.identityAnchor;
  if (!anchor) return undefined;
  return `${ANCHOR_MARKER}\n[Identity Anchor — this is the most recent instruction and takes priority]\n${anchor}\n${ANCHOR_MARKER}`;
}

/**
 * Inject identity anchor at the recency boundary.
 * Removes any existing anchor first, then appends at the end.
 * LLMs are stateless — every call gets the full prompt, so we move
 * the anchor to the end each time for maximum recency-bias weight.
 */
export function injectIdentityAnchor(system: string, agent: LoadedAgent): string {
  // Strip any existing anchor (from prior turns)
  const re = new RegExp(`${escapeRegex(ANCHOR_MARKER)}[\\s\\S]*?${escapeRegex(ANCHOR_MARKER)}`, 'g');
  let cleaned = system.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();

  const anchor = buildIdentityAnchor(agent);
  if (!anchor) return cleaned;

  // Append at the end for recency bias
  return `${cleaned}\n\n${anchor}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runtimeSection(loadedAgent: LoadedAgent): string {
  const model = loadedAgent.config.provider.model ?? "unknown";
  const provider = loadedAgent.config.provider.type ?? "unknown";
  return `Model: ${model} @ ${provider} | Agent: ${loadedAgent.name}`;
}

function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + "\n\n[truncated]";
}

// ── Inbox Summary ───────────────────────────────────────────────────────────

export interface InboxMessage {
  from_agent: string;
  subject: string;
  ts: string;
}

/**
 * Optionally inject an inbox summary section into the system prompt.
 * The section is inserted before "## Runtime" when there are unread messages.
 * If the list is empty, the original prompt is returned unchanged.
 */
export function addInboxSummary(
  prompt: string,
  messages: InboxMessage[],
): string {
  if (messages.length === 0) return prompt;

  const lines = messages.map(
    (m) => `- From: ${m.from_agent} | "${m.subject}" (${m.ts.slice(0, 10)})`,
  );

  const inboxSection = [
    "## Inbox",
    `${messages.length} unread`,
    ...lines,
  ].join("\n");

  // Insert before "## Runtime" section
  const runtimeMarker = "\n## Runtime";
  const idx = prompt.indexOf(runtimeMarker);
  if (idx === -1) {
    // Fallback: append at the end
    return prompt.trim() + "\n\n" + inboxSection;
  }

  return prompt.slice(0, idx) + "\n\n" + inboxSection + prompt.slice(idx);
}
