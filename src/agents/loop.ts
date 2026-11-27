import type { LoadedAgent } from "./loader";
import { headlessCacheKey } from "../cartridge/headless-profile";
import type { Provider, ProviderToolCall, ProviderToolDefinition, WorkCallLink } from "../providers/interface";
import type { SessionManager } from "../session/manager";
import { buildSystemPrompt } from "./prompter";
import { buildSessionMessagesFromTurns } from "./messages";
import type { ProviderChunk, ProviderResponse } from "../providers/interface";
import type { TurnRecord } from "../memory/session-store";
import type { SessionTurn } from "../session/types";
import { Compactor } from "../session/compactor";
import type { SessionStore } from "../memory/session-store";
import { STALE_AFTER_MS, buildResumeMessage, classifyStopError, goalHash, type RunCheckpoint, type StepOutcome, type StopReason } from "./run-checkpoint";

function responseContent(r: ProviderResponse): string {
  const c = r.message.content;
  if (typeof c === "string") return c;
  return (c as Array<{type:string;text?:string}>).filter(b => b.type === "text").map(b => b.text ?? "").join("");
}

function isAsyncGen(v: unknown): v is AsyncGenerator<ProviderChunk> {
  return typeof (v as AsyncGenerator<ProviderChunk>)?.[Symbol.asyncIterator] === "function";
}

export interface LoopSignal {
  type: "loop" | "done" | "none";
  reason: string;
}

export function parseLoopSignal(output: string): LoopSignal {
  const match = output.match(/<(LOOP|DONE)[^>]*\/?>/i);
  if (match) {
    const reasonMatch = match[0].match(/reason="([^"]*)"/i);
    return { type: match[1].toLowerCase() as "loop" | "done", reason: reasonMatch?.[1] ?? "" };
  }
  return { type: "none", reason: "" };
}

export const LOOP_DIRECTIVE = `## Loop Mode Active

You are running in autonomous loop mode. Work until the task is fully complete.
At the end of EVERY response, output exactly one signal on its own line:
  <LOOP reason="what you did and what remains" />
  <DONE reason="why the task is complete" />

Rules:
- Never ask the user for confirmation or choices mid-task
- Never stop and keep working
- If you hit a blocker you cannot resolve: <DONE reason="blocked: <description>" />
- Max iterations are enforced externally — focus on completing the task`;

/** One marker around a provider or compaction call: opened before it, closed after it. */
export interface LoopHostStep { id: string; seq: number; kind: string }

/**
 * Tools the host runs for the model (anima #135). `execute` is supervised and sandboxed by the caller and reports
 * a failing command as text rather than throwing; if it does throw, the loop turns that into an error result.
 */
export interface LoopHostTools {
  definitions: ProviderToolDefinition[];
  execute(call: ProviderToolCall, signal?: AbortSignal): Promise<string>;
}

const TOOL_RESULT_CAP = 8_000;

function capToolResult(text: string): string {
  return text.length > TOOL_RESULT_CAP ? `${text.slice(0, TOOL_RESULT_CAP)}\n…[truncated ${text.length - TOOL_RESULT_CAP} characters]` : text;
}

/**
 * What the castle work loop (anima #135) plugs into `runLoopMode`. The host persists a marker before each
 * provider call so that a session that dies mid-call leaves a durable "outcome unknown" record, and it
 * reconciles such markers against the workspace and GitHub before the next session repeats anything.
 */
export interface LoopHost {
  workId: string;
  /** Stamped on every provider and compaction call of this session so the work's cost can be summed. */
  link?: WorkCallLink;
  /** Persist an in-progress marker. If this throws the provider is not called. */
  beginStep(info: { seq: number; kind: "provider" | "compaction" | "tool"; sessionId: string; toolName?: string }): string;
  /** `completed` when the call returned; `unknown` when it threw (it may have partly run). */
  endStep(id: string, outcome: "completed" | "unknown"): void;
  /** Tools the host runs for the model. Without them no tools are offered. */
  tools?: LoopHostTools;
  /** Markers still open from earlier sessions of this work, oldest first. */
  openSteps(): LoopHostStep[];
  /** Check what the open steps left behind and mark them verified; returns text for the model's first message. */
  reconcile(steps: LoopHostStep[], context: { stale: boolean; checkpoint: RunCheckpoint | null }): Promise<string>;
}

export interface LoopRunOptions {
  maxIterations?: number;
  permissionMode?: string;
  model?: string;
  onTurn?: (n: number, output: string, signal: LoopSignal) => void;
  signal?: AbortSignal;
  mailContext?: string;
  /** Text appended to the next continuation message, for example a notice that the session is nearly out of time. */
  windDown?: (iteration: number, lastIteration: number) => string | undefined;
  /** Write a checkpoint when the run ends for any reason other than `done` (rfcclub/anima#71). */
  checkpoints?: boolean;
  /** Continue from the latest open checkpoint for this agent and goal, if any. */
  resume?: boolean;
  /** Work-scoped recovery, step markers and signal-aware calls for the castle work loop. */
  host?: LoopHost;
  /** A work host's technical prompt; starts a new conversation while continuing its checkpoint. */
  cleanWorkPrompt?: { full: string; staticPrefix: string; staticHash: string };
  /** Allows the host to close the fresh work conversation without running agent memory hooks. */
  onWorkConversationStarted?: (sessionId: string) => void;
  now?: () => number;
  /**
   * The handoff as its own task (owner, 2026-11-27). When `due()` turns true between turns, or the iteration limit
   * is reached, the run is not cut off: the turn in flight finishes, then the model gets up to `turns` more turns
   * in the same conversation, offered only `tools`, whose only job is the handoff note. After each of those turns
   * `check()` returns null once the note is usable, which ends the run, or the problem, which is sent back. A DONE
   * in these turns ends the handoff, never the work. The run then ends as `deadline` (time) or `max_reached`.
   */
  handoff?: {
    due: () => boolean;
    turns: number;
    prompt: string;
    tools: LoopHostTools;
    check: () => string | null;
  };
}

export interface LoopRunResult {
  iterations: number;
  exitReason: "done" | "max_reached" | "error" | "interrupted" | "blocked" | "deadline";
  interruptionSource?: "abort" | "sigint";
  checkpoint?: RunCheckpoint;
}

function turnsToSessionTurns(turns: TurnRecord[]): SessionTurn[] {
  return turns.map(t => ({ timestamp: t.ts, role: t.role, content: t.content, type: "turn" as const, sessionId: t.sessionId }));
}

export async function runLoopMode(
  agent: LoadedAgent,
  goal: string,
  provider: Provider,
  sessionManager: SessionManager,
  store: SessionStore,
  options: LoopRunOptions = {},
): Promise<LoopRunResult> {
  if (options.cleanWorkPrompt !== undefined && !options.host) throw new Error("clean work prompt requires a work host");
  const max = options.maxIterations ?? 10;
  const now = options.now ?? Date.now;
  const hash = goalHash(goal);
  let currentMessage = goal;
  let interrupted = false;
  let interruptionSource: LoopRunResult["interruptionSource"];
  let first = 1;
  let resumedSessionId: string | undefined;
  let resumedRemaining = "";

  let resumedCheckpointId: string | undefined;
  let startFresh = false;
  if (options.host) {
    // Work-scoped recovery: found by work id, never hidden by a resumed flag, and a stale checkpoint is
    // reconciled and continued in a fresh session instead of being refused.
    const host = options.host;
    const checkpoint = options.resume ? store.getLatestRunCheckpointForWork(host.workId) : null;
    const steps = host.openSteps();
    if (checkpoint || steps.length > 0) {
      const session = checkpoint ? store.getSession(checkpoint.sessionId) : null;
      const stale = checkpoint !== null && (
        !session || (options.cleanWorkPrompt === undefined && Boolean(session.ended)) ||
        now() - Date.parse(checkpoint.createdAt) > STALE_AFTER_MS
      );
      const note = steps.length > 0 || stale || (checkpoint !== null && options.cleanWorkPrompt !== undefined)
        ? await host.reconcile(steps, { stale, checkpoint }) : "";
      const lines: string[] = [];
      if (checkpoint) {
        resumedCheckpointId = checkpoint.id;
        lines.push(buildResumeMessage(checkpoint, { includeGoal: options.cleanWorkPrompt === undefined }));
        if (options.cleanWorkPrompt !== undefined) {
          lines.push(checkpoint.goalHash !== hash
            ? `[goal changed] The current goal below supersedes all earlier goals, including any earlier <review>.\nCurrent work goal:\n${goal}`
            : `Current work goal:\n${goal}`);
        } else if (checkpoint.goalHash !== hash) {
          lines.push(`[goal changed] The current goal below supersedes the goal above, including any earlier <review>.\nCurrent work goal:\n${goal}`);
        }
        if (!stale) {
          if (options.cleanWorkPrompt === undefined) resumedSessionId = checkpoint.sessionId;
          first = checkpoint.iteration + 1;
          resumedRemaining = checkpoint.remaining;
        } else {
          startFresh = true;
        }
      } else {
        lines.push(goal);
      }
      if (steps.length > 0) {
        lines.push(
          `[recovery] An earlier session of this work stopped while ${steps.length === 1 ? "a step was" : `${steps.length} steps were`} in progress ` +
          `(${steps.map((step) => `${step.kind} ${step.seq}`).join(", ")}). Their outcome is unknown: they may have partly run. ` +
          "Do not repeat their side effects; verify what they changed first.",
        );
      }
      if (note) lines.push(`Reconciliation${stale ? " (the checkpoint is older than 24 hours)" : ""}: ${note}`);
      currentMessage = lines.join("\n");
    }
  } else if (options.resume) {
    const checkpoint = store.getLatestOpenRunCheckpoint(agent.name, hash);
    if (checkpoint) {
      const session = store.getSession(checkpoint.sessionId);
      if (!session || session.ended || now() - Date.parse(checkpoint.createdAt) > STALE_AFTER_MS) {
        // Close it so the next resume of this goal starts fresh instead of refusing forever.
        store.setRunCheckpointStatus(checkpoint.id, "expired");
        throw new Error(`stale checkpoint ${checkpoint.id}: created ${checkpoint.createdAt}, session ${session ? (session.ended ? "ended" : "open") : "missing"}`);
      }
      store.setRunCheckpointStatus(checkpoint.id, "resumed");
      resumedSessionId = checkpoint.sessionId;
      first = checkpoint.iteration + 1;
      resumedRemaining = checkpoint.remaining;
      currentMessage = buildResumeMessage(checkpoint);
    }
  }
  const last = first + max - 1;
  const initialHint = options.windDown?.(first - 1, last);
  if (initialHint) currentMessage += `\n\n${initialHint}`;
  let remaining = resumedRemaining;

  const sigintHandler = () => { interrupted = true; interruptionSource ??= "sigint"; };
  const abortHandler = () => { interrupted = true; interruptionSource ??= "abort"; };
  process.on("SIGINT", sigintHandler);
  const cleanup = () => {
    process.off("SIGINT", sigintHandler);
    options.signal?.removeEventListener("abort", abortHandler);
  };

  if (options.signal?.aborted) abortHandler();
  else options.signal?.addEventListener("abort", abortHandler, { once: true });

  // Open session for this agent (a resumed run continues in the checkpoint's session)
  // A work keeps its own conversation (channel `work:<id>`), never the agent's shared loop session.
  const channel = options.host ? `work:${options.host.workId}` : "loop";
  const sessionId = options.cleanWorkPrompt !== undefined
    ? store.createSession(agent.name, channel).id
    : resumedSessionId ?? (startFresh ? sessionManager.newSession(agent.name, channel).id : sessionManager.openSession(agent.name, channel).id);
  if (options.cleanWorkPrompt !== undefined) {
    options.onWorkConversationStarted?.(sessionId);
    store.ensureMainBranch(sessionId);
  }

  const finish = (exitReason: LoopRunResult["exitReason"], iterations: number, stop?: { reason: StopReason; outcome: StepOutcome }): LoopRunResult => {
    cleanup();
    if (!stop && resumedCheckpointId && exitReason === "done") store.setRunCheckpointStatus(resumedCheckpointId, "done");
    if (!options.checkpoints || !stop) return { iterations, exitReason, ...(interruptionSource ? { interruptionSource } : {}) };
    const checkpoint = store.saveRunCheckpoint({
      agent: agent.name, sessionId, goal, goalHash: hash, stopReason: stop.reason, iteration: iterations,
      maxIterations: last, lastOutcome: stop.outcome, remaining, createdAt: new Date(now()).toISOString(),
      ...(options.host ? { workId: options.host.workId } : {}),
    });
    // The resumed checkpoint is consumed only now that its successor is durable.
    if (resumedCheckpointId) store.setRunCheckpointStatus(resumedCheckpointId, "resumed");
    return { iterations, exitReason, checkpoint, ...(interruptionSource ? { interruptionSource } : {}) };
  };

  // The handoff task's first and last iteration, and what ended the working part of the run.
  let handoffFrom: number | undefined;
  let handoffLast = 0;
  let handoffCause: "deadline" | "max_reached" = "deadline";
  for (let i = first; ; i++) {
    if (handoffFrom === undefined) {
      const overLimit = i > last;
      if (options.handoff && (overLimit || options.handoff.due())) {
        handoffFrom = i;
        handoffLast = i + Math.max(1, options.handoff.turns) - 1;
        handoffCause = overLimit ? "max_reached" : "deadline";
        currentMessage = `${currentMessage}\n\n${options.handoff.prompt}`;
      } else if (overLimit) {
        break;
      }
    } else if (i > handoffLast) {
      return finish(handoffCause, i - 1, { reason: handoffCause, outcome: "completed" });
    }
    const inHandoff = handoffFrom !== undefined;
    const turnTools = inHandoff ? options.handoff!.tools : options.host?.tools;
    const turns = sessionManager.getTurns(sessionId);

    let output: string;
    let stepId: string | undefined;
    const toolCalls: ProviderToolCall[] = [];
    try {
      const { full: sys, staticPrefix, staticHash } = options.cleanWorkPrompt !== undefined
        ? options.cleanWorkPrompt
        : buildSystemPrompt(agent, {
          mode: (options.permissionMode as never) ?? agent.config.session.defaultMode,
          loop: true,
        });
      if (options.host) stepId = options.host.beginStep({ seq: i, kind: "provider", sessionId });
      const result = await provider.query({
        agent: agent.name,
        sessionId,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.host?.link ? { work: options.host.link } : {}),
        mode: (options.permissionMode as never) ?? agent.config.session.defaultMode,
        cwd: agent.roomDir,
        ...(turnTools ? { tools: turnTools.definitions } : {}),
        model: options.model ?? agent.config.provider.model,
        system: sys,
        cachePrefix: staticPrefix,
        staticHash,
        ...(options.cleanWorkPrompt !== undefined
          ? { promptCacheKey: headlessCacheKey(staticPrefix, options.host?.tools?.definitions ?? []) } : {}),
        messages: buildSessionMessagesFromTurns(turns, currentMessage, options.mailContext),
      });

      if (isAsyncGen(result)) {
        const parts: string[] = [];
        for await (const chunk of result) {
          if (chunk.type === "text") parts.push(chunk.content ?? "");
          else if ((chunk.type === "tool_call" || chunk.type === "tool_use") && (chunk.tool_call ?? chunk.tool_use)) toolCalls.push((chunk.tool_call ?? chunk.tool_use)!);
        }
        output = parts.join("");
      } else {
        const r = result as ProviderResponse;
        output = responseContent(r);
        if (r.tool_calls) toolCalls.push(...r.tool_calls);
      }
      if (stepId) options.host!.endStep(stepId, "completed");
    } catch (err) {
      if (stepId) {
        try { options.host!.endStep(stepId, "unknown"); } catch { /* the marker stays open, which is the safe state */ }
      }
      options.onTurn?.(i, String(err), { type: "none", reason: String(err) });
      // The provider may have acted before failing, so this step's outcome is unknown.
      return finish("error", i, { reason: interrupted ? "interrupted" : classifyStopError(err), outcome: "unknown" });
    }

    // Host-run tools: each call has its own marker, runs one after another, and its result goes into the next message.
    let toolResults = "";
    const hostTools = turnTools;
    if (hostTools && toolCalls.length > 0) {
      const sections: string[] = [];
      for (const toolCall of toolCalls) {
        if (interrupted) break;
        let toolStep: string | undefined;
        let text: string;
        try {
          toolStep = options.host!.beginStep({ seq: i, kind: "tool", sessionId, toolName: toolCall.name });
          text = capToolResult(await hostTools.execute(toolCall, options.signal));
          options.host!.endStep(toolStep, "completed");
        } catch (error) {
          text = `Error: ${error instanceof Error ? error.message : String(error)}`;
          if (toolStep) {
            try { options.host!.endStep(toolStep, "unknown"); } catch { /* left open */ }
          }
        }
        sections.push(`#${toolCall.id} ${toolCall.name} ${toolCall.arguments.slice(0, 300)}\n${text}`);
      }
      toolResults = sections.join("\n\n");
    }

    sessionManager.appendTurn(sessionId, "user", currentMessage);
    sessionManager.appendTurn(sessionId, "assistant", toolCalls.length > 0 && hostTools
      ? `${output}\n[tool calls: ${toolCalls.map((c) => c.name).join(", ")}]`
      : output);

    const signal = parseLoopSignal(output);
    if (signal.type === "loop") remaining = signal.reason;
    options.onTurn?.(i, output, signal);

    if (interrupted) {
      return finish("interrupted", i, { reason: "interrupted", outcome: "completed" });
    }

    if (inHandoff) {
      // Only the note counts here: DONE, LOOP or silence end the handoff once the note is usable, and a problem is sent back.
      const problem = options.handoff!.check();
      if (problem === null || signal.type === "done" || i >= handoffLast) {
        return finish(handoffCause, i, { reason: handoffCause, outcome: "completed" });
      }
      currentMessage = `${toolResults ? `Tool results:\n${toolResults}\n\n` : ""}The handoff note is not usable yet: ${problem}. ` +
        `Fix it with the tools you have (${options.handoff!.tools.definitions.map((d) => d.name).join(", ")}).`;
      continue;
    }

    // A done signal that came with tool calls is not final: the results have not been seen yet.
    if (signal.type === "done" && !toolResults) {
      const blocker = options.cleanWorkPrompt !== undefined && /^blocked\s*:/i.test(signal.reason)
        ? signal.reason.replace(/^blocked\s*:\s*/i, "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 500) || "unspecified blocker"
        : "";
      if (blocker) {
        remaining = blocker;
        return finish("blocked", i, { reason: "blocked", outcome: "completed" });
      }
      return finish("done", i);
    }

    // Compact if needed
    const compaction = sessionManager.checkCompaction(sessionId);
    if (compaction.needed) {
      const currentTurns = sessionManager.getTurns(sessionId);
      const compactor = new Compactor({
        provider,
        store,
        sessionId,
        model: options.model ?? agent.config.provider.model,
        ...(options.host?.link ? { work: options.host.link } : {}),
      });
      const compactionStep = options.host?.beginStep({ seq: i, kind: "compaction", sessionId });
      try {
        await compactor.summarize(turnsToSessionTurns(currentTurns));
      } catch (error) {
        if (compactionStep) {
          try { options.host!.endStep(compactionStep, "unknown"); } catch { /* left open */ }
        }
        throw error;
      }
      if (compactionStep) options.host!.endStep(compactionStep, "completed");
      if (compaction.level === "hard") {
        await sessionManager.compact(sessionId, "hard");
      }
    }

    // Build continuation prompt for next iteration
    const reason = signal.reason || "continuing";
    currentMessage = toolResults
      ? `[loop:${i}/${last}] Tool results:\n${toolResults}\n\nContinue. Previous step: ${reason}`
      : `[loop:${i}/${last}] Continue. Previous step: ${reason}`;
    const hint = options.windDown?.(i, last);
    if (hint) currentMessage += `\n\n${hint}`;
  }

  return finish("max_reached", last, { reason: "max_reached", outcome: "completed" });
}
