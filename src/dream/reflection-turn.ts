import { copyFile, mkdir, unlink } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { TurnRunner } from "../agents/turn-runner";
import { executeTool } from "../tools/executor";
import { buildToolDefinitions } from "../tools/definitions";
import { canonicalize, isPathInside } from "../tools/policy-enforcer";
import type { Provider, ProviderToolCall, ProviderToolDefinition } from "../providers/interface";
import type { AgentMemoryStore } from "../memory/contract";
import { readInbox, type InboxProposal } from "./inbox";

/**
 * Reflection turn (rfcclub/anima#666).
 *
 * The scheduled sweep starts this as an agent turn with tools, not a single
 * text completion: the agent reads its own staging/INBOX.md, judges each
 * proposal and, for what it keeps, edits its own substrate itself — choosing
 * the file and the place. The platform prescribes neither a destination nor a
 * record format; it only keeps guard rails on the write side:
 *
 * - writes are limited to the agent's own identity directory (`roomDir`);
 * - before a file is first changed in a run, a copy is kept under
 *   `staging/reflection-backups/<run>/`, so a rare review can undo it;
 * - a failed run restores every file it touched;
 * - `touched` is the run's audit note, which is all the memory store keeps.
 *
 * A run that touches nothing is a valid result: nothing kept is a valid
 * judgement.
 */

/** Tools the reflection turn may use. Writes are re-implemented below so they
 *  can be backed up, scoped and rolled back. */
const REFLECTION_TOOLS = ["read", "grep", "glob", "write", "edit"];
/** Substrate files listed in the prompt; enough to see what exists. */
const MAX_LISTED_FILES = 200;
/** The agent's own words, kept in the audit note. */
const MAX_AGENT_NOTE_CHARS = 4_000;
const MAX_ITERATIONS = 24;

export interface ReflectionTurnOptions {
  roomDir: string;
  agentName: string;
  provider: Provider;
  memoryStore?: AgentMemoryStore;
  model?: string;
  now?: () => Date;
}

export interface ReflectionTurnResult {
  /** False when there was no inbox to judge: nothing was asked of the model. */
  judged: boolean;
  /** Files the agent changed, relative to its identity directory. */
  touched: string[];
  /** Backups written before the first change to each touched file. */
  backups: string[];
  /** Writes refused because they pointed outside the identity directory. */
  refused: string[];
  /** The agent's closing note, when it gave one. */
  note: string;
  error?: string;
}

function listSubstrateFiles(roomDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    if (files.length >= MAX_LISTED_FILES) return;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_LISTED_FILES) return;
      const name = String(entry.name);
      if (name.startsWith(".") || name === "node_modules") continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      if (entry.isDirectory()) {
        // The inbox itself and its backups are inputs, not substrate.
        if (relative === "staging") continue;
        walk(join(dir, name), relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  };
  walk(roomDir, "");
  return files;
}

function renderProposals(proposals: readonly InboxProposal[]): string {
  return proposals
    .map((proposal, index) =>
      [
        `## Proposal ${index + 1}`,
        `- claim: ${proposal.claim}`,
        `- tags: ${proposal.tags.join(", ")}`,
        `- confidence: ${proposal.confidence}`,
        `- evidence: ${proposal.evidenceCount}`,
        `- sources: ${proposal.sources.join(", ")}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function buildPrompt(agentName: string, proposals: readonly InboxProposal[], files: readonly string[]): string {
  return [
    `You are ${agentName}. This is your scheduled reflection.`,
    "",
    "Your memory was distilled into the proposals below. They are proposals, not rules:",
    "reading them decides nothing. Judge each one yourself — keep, revise or reject — and",
    "say why in one line.",
    "",
    "For anything you keep, edit your own identity files yourself: choose the file and the",
    "place that fit you. You can write a new file or change an existing one. Deleting nothing",
    "is also fine — rejecting everything is a valid judgement.",
    "",
    "[Proposals in staging/INBOX.md]",
    renderProposals(proposals),
    "",
    "[Your current identity files]",
    files.length > 0 ? files.map((file) => `- ${file}`).join("\n") : "(none yet)",
    "",
    "When you are done, answer with a short note: what you kept, what you rejected, and why.",
  ].join("\n");
}

/** Canonical form of the path: symlinks resolved, so `staging -> /etc` cannot
 *  turn an in-room path into a write outside it. */
function resolveRoomPath(roomDir: string, path: string): string {
  return canonicalize(isAbsolute(path) ? path : join(roomDir, path));
}

/** `path` relative to a canonical `root`. */
function relativeToRoot(root: string, path: string): string {
  const absolute = resolve(path);
  return absolute === root ? basename(root) : absolute.slice(root.length + 1);
}

/** A reflection run's write side: scope check, backup-on-first-change, tracking. */
class ReflectionWriter {
  readonly touched: string[] = [];
  readonly backups: string[] = [];
  readonly refused: string[] = [];
  private readonly seen = new Set<string>();
  /** Files the run created: rolling back means removing them, not restoring. */
  private readonly created: string[] = [];
  /** Target path -> the copy taken before the run first changed it. */
  private readonly backupOf = new Map<string, string>();

  constructor(
    private readonly roomDir: string,
    private readonly backupDir: string,
  ) {}

  private refuse(path: string, reason: string): string {
    this.refused.push(path);
    return `Error: ${reason}`;
  }

  /** Refuse a path outside the room; return the canonical target when allowed. */
  private inScope(path: string): string | undefined {
    const target = resolveRoomPath(this.roomDir, path);
    return isPathInside(this.roomDir, target) && target !== resolve(this.roomDir) ? target : undefined;
  }

  /** First change to a file in this run: remember whether it existed, and
   *  keep a copy when it did, so a rollback can undo the change either way. */
  private async prepare(target: string): Promise<void> {
    if (this.seen.has(target)) return;
    this.seen.add(target);
    if (!existsSync(target)) {
      this.created.push(target);
      return;
    }
    await mkdir(this.backupDir, { recursive: true });
    const backupPath = join(this.backupDir, relativeToRoot(this.roomDir, target).replace(/[\\/]/g, "__"));
    await copyFile(target, backupPath);
    this.backups.push(backupPath);
    // Keyed by target: a name containing "__" must not be decoded back into a
    // different path on rollback.
    this.backupOf.set(target, backupPath);
  }

  private note(target: string): void {
    const relative = relativeToRoot(this.roomDir, target);
    if (!this.touched.includes(relative)) this.touched.push(relative);
  }

  async write(path: string, content: string): Promise<string> {
    const target = this.inScope(path);
    if (!target) return this.refuse(path, `refusing to write outside the agent's own identity directory: ${path}`);
    await this.prepare(target);
    await Bun.write(target, content);
    this.note(target);
    return `Written ${content.length} chars to ${relativeToRoot(this.roomDir, target)}`;
  }

  async edit(path: string, oldString: string, newString: string): Promise<string> {
    const target = this.inScope(path);
    if (!target) return this.refuse(path, `refusing to edit outside the agent's own identity directory: ${path}`);
    const original = await Bun.file(target).text().catch(() => "");
    if (!original.includes(oldString)) {
      return `Error: old_string not found in ${relativeToRoot(this.roomDir, target)}`;
    }
    await this.prepare(target);
    await Bun.write(target, original.replace(oldString, newString));
    this.note(target);
    return `Edited ${relativeToRoot(this.roomDir, target)}: replaced ${oldString.length} chars`;
  }

  /** Put every touched file back the way it was: files the run created are
   *  removed, files it changed are restored from their copy. */
  async restore(): Promise<void> {
    for (const target of this.created) {
      try {
        await unlink(target);
      } catch {
        // already gone: nothing to roll back
      }
    }
    for (const [target, backupPath] of this.backupOf) {
      try {
        await copyFile(backupPath, target);
      } catch {
        // best effort: the original backup stays on disk for a manual restore
      }
    }
  }
}

function auditNote(
  agentName: string,
  result: ReflectionTurnResult,
  proposals: readonly InboxProposal[],
  note: string,
): string {
  return [
    `# Reflection audit — ${agentName}`,
    `- Proposals judged: ${proposals.length}`,
    `- Files touched: ${result.touched.length > 0 ? result.touched.join(", ") : "(none)"}`,
    `- Backups: ${result.backups.length > 0 ? result.backups.join(", ") : "(none)"}`,
    `- Refused writes: ${result.refused.length > 0 ? result.refused.join(", ") : "(none)"}`,
    "",
    "## Agent's note",
    note.length > MAX_AGENT_NOTE_CHARS ? note.slice(0, MAX_AGENT_NOTE_CHARS) + " …" : note,
  ].join("\n");
}

/**
 * Run one agent-judged reflection over its inbox. Never throws: a failed run
 * restores what it changed and reports the error.
 */
export async function runReflectionTurn(options: ReflectionTurnOptions): Promise<ReflectionTurnResult> {
  const { roomDir, agentName, provider, memoryStore, model } = options;
  const now = options.now?.() ?? new Date();
  const result: ReflectionTurnResult = { judged: false, touched: [], backups: [], refused: [], note: "" };

  const proposals = await readInbox(roomDir);
  if (!proposals) return result;
  result.judged = true;

  const runStamp = now.toISOString().replace(/[:.]/g, "-");
  const writer = new ReflectionWriter(roomDir, join(roomDir, "staging", "reflection-backups", runStamp));
  const tools: ProviderToolDefinition[] = buildToolDefinitions(REFLECTION_TOOLS);

  let note = "";
  try {
    for await (const event of new TurnRunner().run({
      provider,
      messages: [{ role: "user", content: buildPrompt(agentName, proposals, listSubstrateFiles(roomDir)) }],
      tools,
      policy: null,
      agentName,
      cwd: roomDir,
      mode: "edit",
      model,
      limits: { maxIterations: MAX_ITERATIONS },
      execute: (call: ProviderToolCall) => executeReflectionTool(call, roomDir, writer),
    })) {
      if (event.type === "error") throw event.error;
      if (event.type === "done") {
        const content = event.response.message.content;
        note = typeof content === "string" ? content : "";
      }
    }
  } catch (err) {
    await writer.restore();
    result.refused = writer.refused;
    result.note = note;
    result.error = String(err);
    return result;
  }

  result.touched = writer.touched;
  result.backups = writer.backups;
  result.refused = writer.refused;
  result.note = note;

  // The memory store keeps the audit note — never the model's whole response.
  if (memoryStore) {
    try {
      await memoryStore.remember({
        content: auditNote(agentName, result, proposals, note),
        scope: "observation",
        confidence: 1,
        tags: ["reflection-audit"],
        source: "reflection-turn",
      });
    } catch {
      // the substrate changes stand even when the audit note cannot be stored
    }
  }

  return result;
}

/** Read tools run as usual; writes go through the run's scoped writer. */
function executeReflectionTool(call: ProviderToolCall, roomDir: string, writer: ReflectionWriter): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments) as Record<string, unknown>;
  } catch {
    return Promise.resolve(`Error: could not parse tool arguments: ${call.arguments}`);
  }
  if (call.name === "write") {
    return writer.write(String(args.path ?? ""), String(args.content ?? ""));
  }
  if (call.name === "edit") {
    return writer.edit(String(args.path ?? ""), String(args.old_string ?? ""), String(args.new_string ?? ""));
  }
  if (!REFLECTION_TOOLS.includes(call.name)) {
    return Promise.resolve(`Error: tool ${call.name} is not available in reflection`);
  }
  return executeTool(call, { cwd: roomDir, agentName: undefined, policy: null });
}
