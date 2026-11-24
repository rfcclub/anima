#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { AgentLoader, SubstrateNotMountedError } from "./agents/loader";
import { headlessAgent } from "./agents/headless";
import { AutoModeNotEnabledError } from "./agents/session";
import { createAutoGuard } from "./agents/auto-guard";
import { buildSystemPrompt } from "./agents/prompter";
import { buildSessionMessages, buildSessionMessagesFromTurns } from "./agents/messages";
import { runLoopMode } from "./agents/loop";
import { createTalkProvider, runTalkToolLoop, type TalkProviderDeps } from "./agents/talk-runtime";
import { buildToolDefinitions } from "./tools/definitions";
import type { ExecuteToolOptions } from "./tools/executor";
export { buildSessionMessages } from "./agents/messages";
import { resolveTalkMessage } from "./utils/talk-message";
import type { ModeMap, PermissionMode, ProviderDef, ProviderType, TaskMode } from "./config/types";
import type { Store } from "./memory/jsonl-store";
import { SqliteStore } from "./memory/sqlite-store";
import { SessionStore } from "./memory/session-store";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAIv1ChatProvider } from "./providers/openai-v1-chat";
import { OpenAIv1ResponseProvider } from "./providers/openai-v1-response";
import { isAsyncGenerator } from "./utils/async-generator";
import { ProviderError, type Provider, type ProviderMessage, type ProviderResponse } from "./providers/interface";
import { ProviderRegistry } from "./providers/registry";
import { Compactor } from "./session/compactor";
import { SessionManager } from "./session/manager";
import type { SessionContext } from "./session/types";
import type { TurnRecord } from "./memory/session-store";
import { MeetingRoom } from "./meeting/room";
import type { MeetingOptions } from "./meeting/types";
import { MailChecker } from "./meeting/daemon";
import { CartridgeRegistry } from "./cartridge/registry";
import { buildHeadlessPromptParts, headlessCacheKey, headlessReviewTools } from "./cartridge/headless-profile";
import { runCartridgeCli } from "./cartridge/cli";
import { runMeshTool } from "./mesh-a2a/agent-tools";
import { rotateBearerToken } from "./services/abel-mem";
import { appendBeamEntries, type BeamEntry } from "./dream/light-nap";
import { meterProvider } from "./cost/meter";

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export interface ProcessRunner {
  run(cmd: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

const defaultRunner: ProcessRunner = {
  async run(cmd, args) {
    const proc = Bun.spawn([cmd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdoutBuffer, stderrBuffer] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout: stdoutBuffer, stderr: stderrBuffer };
  },
};

const TASK_MODES: TaskMode[] = ["chatting", "programming", "image", "private", "philosophy", "creative"];
const DEFAULT_TASK_MODE: TaskMode = "chatting";
const DEFAULT_GEMINI_ROUTER_MODEL = "gemini-3.1-flash-lite-preview";

export async function main(argv: string[] = process.argv.slice(2), runner: ProcessRunner = defaultRunner): Promise<void> {
  const [command, ...rest] = argv;

  switch (command) {
    case "talk":
      await talk(parseArgs(rest));
      return;
    case "meet":
      await meetCommand(parseArgs(rest));
      return;
    case "beam":
      await beamCommand(parseArgs(rest));
      return;
    case "mode":
      await modeCommand(parseArgs(rest));
      return;
    case "rotate-abel-token":
      await rotate2bTokenCommand();
      return;
    case "send-mail":
      await sendMailCommand(parseArgs(rest));
      return;
    case "check-mail":
      await checkMailCommand(parseArgs(rest));
      return;
    case "status":
      await status();
      return;
    case "work": {
      const { WorkStore } = await import("./work/store");
      const { gitInRecoveryTree } = await import("./work/production");
      if (rest[0] === "retry-revise") {
        const { parseRetryRevisionArgs, requestRevisionRetry } = await import("./work/retry-revise");
        const input = parseRetryRevisionArgs(rest);
        const { defaultMeshJobsConfigPath, loadMeshJobsConfig } = await import("./mesh-jobs/config");
        const config = loadMeshJobsConfig(defaultMeshJobsConfigPath())?.work;
        if (!config) throw new Error("retry refused: the work loop is not configured");
        const { ghReader, spawnGh } = await import("./mesh-jobs/github");
        const { ghWorkGitHub } = await import("./work/gh-adapter");
        const gh = spawnGh();
        const store = WorkStore.open();
        try {
          const result = await requestRevisionRetry({
            store, read: gitInRecoveryTree, github: ghWorkGitHub(gh), issue: ghReader(gh).issue, config,
          }, input);
          process.stdout.write(`Revision retry ${result.inserted ? "requested" : "already requested"}: ${result.key}; the reconciler validates and dispatches it.\n`);
        } finally {
          store.close();
        }
        return;
      }
      const { parseRecoveryArgs, recoverWork } = await import("./work/recover");
      const input = parseRecoveryArgs(rest);
      const store = WorkStore.open();
      try {
        const work = await recoverWork({ store, read: gitInRecoveryTree }, input);
        process.stdout.write(`Work ${work.workId} recovered to ${work.state}; dispatch is a separate action.\n`);
      } finally {
        store.close();
      }
      return;
    }
    case "session":
      await sessionCommand(parseArgs(rest));
      return;
    case "/cartridge":
      await cartridgeCommand(parseArgs(rest));
      return;
    case "cartridge":
      process.exitCode = await runCartridgeCli(rest);
      break;
    case "seed":
      await seed(rest);
      return;
    case "restart":
      {
        const code = await restartCommand(parseArgs(rest), runner);
        if (code !== 0) process.exit(code);
      }
      return;
    default:
      usage();
  }
}

async function talk(args: ParsedArgs): Promise<void> {
  const agentName = String(args.flags.agent ?? args.flags.a ?? args.positional[0] ?? "");
  const message = await resolveTalkMessage(String(args.flags.message ?? args.flags.m ?? args.positional[1] ?? ""));
  if (!agentName || !message) {
    usage();
  }

  const loopMode = !!args.flags.loop;
  // rfcclub/anima#71: opt-in checkpoint on a non-done exit; --resume implies --checkpoint.
  const resume = !!args.flags.resume;
  const checkpoints = resume || !!args.flags.checkpoint;
  const MAX_CAP = 50;
  const rawMax = parseInt(String(args.flags.max ?? "10"));
  const maxIterations = Math.min(rawMax, MAX_CAP);
  if (rawMax > MAX_CAP) process.stderr.write(`Warning: --max ${rawMax} capped to ${MAX_CAP}\n`);
  const permissionMode = readPermissionMode(args.flags.permission ?? permissionModeFlag(args.flags.mode));
  const taskModeOverride = readTaskMode(args.flags.mode);
  const loader = new AgentLoader();
  const headlessReview = args.flags["headless-review"] === true;
  const reviewRepo = args.flags["review-repo"];
  if (headlessReview && (loopMode || typeof reviewRepo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(reviewRepo))) {
    throw new Error("headless review requires a repository in owner/name form and cannot use loop mode");
  }
  const agent = headlessReview
    ? await (async () => {
      const config = await loader.loadConfig(agentName);
      const policy = { ...config.policy, allowedTools: headlessReviewTools(config.policy.allowedTools ?? []) };
      const roomDir = join(process.env.ANIMA_ROOMS_DIR ?? join(process.env.HOME ?? "~", ".anima", "rooms"), agentName);
      return headlessAgent({ name: config.identity.name, label: config.identity.label }, { ...config, policy }, roomDir);
    })()
    : await loader.load(agentName);
  const modelOverride = typeof args.flags.model === "string" ? args.flags.model : undefined;
  const providerName = readProvider(args.flags.provider ?? agent.config.provider.type);
  const taskMode = taskModeOverride ?? await readCurrentTaskMode();
  const provider = await createTalkProvider(
    agent.config.provider,
    { providerName, providerFlag: args.flags.provider !== undefined, modelFlag: modelOverride !== undefined, taskMode },
    await talkProviderDeps(),
  );
  const eventStore = await SqliteStore.open();
  const sessionStore = await SessionStore.open(process.env.ANIMA_SESSIONS_DB ?? join(animaHome(), "sessions.db"));
  const sessionManager = new SessionManager({
    store: sessionStore,
    maxTokens: agent.config.session.compactThreshold * 4,
  });

  const session = headlessReview ? sessionStore.createSession(agent.name, "review") : sessionManager.openSession(agent.name, "talk");
  const sessionId = session.id;
  let reviewClosed = false;
  const closeReviewSession = () => {
    if (!headlessReview || reviewClosed) return;
    sessionStore.endSession(sessionId);
    reviewClosed = true;
  };
  const onReviewTerm = () => {
    try {
      closeReviewSession();
    } catch {
      process.stderr.write("Headless review session could not be closed after SIGTERM.\n");
    }
    process.exit(143);
  };
  const finishReview = () => {
    if (!headlessReview) return;
    process.removeListener("SIGTERM", onReviewTerm);
    closeReviewSession();
  };
  if (headlessReview) process.once("SIGTERM", onReviewTerm);
  const { turns, mailContext, effectiveMode, autoGuard } = await (async () => {
    try {
      if (headlessReview) sessionStore.ensureMainBranch(sessionId);
      const turns = headlessReview ? [] : sessionManager.getTurns(sessionId);

      let mailContext: string | undefined;
      if (!headlessReview) {
        const mailChecker = new MailChecker();
        const lastActivity = turns.length > 0 ? turns[turns.length - 1].ts : "1970-01-01T00:00:00Z";
        const unreadMail = await mailChecker.check(agent.name, lastActivity);
        mailContext = unreadMail.length > 0 ? mailChecker.formatMailContext(unreadMail) : undefined;
        eventStore.append(agent.name, {
          timestamp: new Date().toISOString(), type: "mail_check", sessionId, unread: unreadMail.length,
        });
      }

      const effectiveMode = permissionMode ?? agent.config.session.defaultMode;
      if (effectiveMode === "auto" && !agent.config.session.autoModeOptIn) {
        throw new AutoModeNotEnabledError(agent.name);
      }

      const autoGuard = effectiveMode === "auto" ? createAutoGuard(
        (event) => eventStore.append(agent.name, { timestamp: new Date().toISOString(), ...event, sessionId }),
        agent.config.policy.allowedTools,
        (stats) => structuredLog("info", "auto execution complete", {
          type: "auto_execution_complete", agent: agent.name, sessionId, ...stats,
        }),
      ) : undefined;
      return { turns, mailContext, effectiveMode, autoGuard };
    } catch (error) {
      finishReview();
      throw error;
    }
  })();

  if (loopMode) {
    const result = await runLoopMode(agent, message, provider, sessionManager, sessionStore, {
      maxIterations,
      permissionMode: effectiveMode,
      model: modelOverride ?? agent.config.provider.model,
      mailContext,
      checkpoints,
      resume,
      onTurn: (n, output, signal) => {
        process.stdout.write(`\n--- loop ${n}/${maxIterations} [${signal.type}] ---\n`);
        process.stdout.write(output + "\n");
      },
    });
    if (result.checkpoint) {
      process.stderr.write(`checkpoint ${result.checkpoint.id}: ${result.checkpoint.stopReason} at ${result.checkpoint.iteration} (last step ${result.checkpoint.lastOutcome}); rerun with --resume\n`);
    }
    if (result.exitReason === "max_reached") {
      process.stderr.write(`Loop ended: max iterations (${maxIterations}) reached\n`);
      process.exit(1);
    } else if (result.exitReason === "interrupted") {
      process.stderr.write(`\nLoop interrupted after ${result.iterations} turn(s). Progress saved.\n`);
      process.exit(0);
    } else if (result.exitReason === "error") {
      process.exit(2);
    }
    return;
  }

  try {
    const memoryRecall = headlessReview ? [] : await recallTalkMemory(agent, message, sessionStore, sessionId);
    const toolDefinitions = buildToolDefinitions(agent.config.policy.allowedTools ?? []);
    const prompt = () => {
      if (!headlessReview) return buildSystemPrompt(agent, { mode: effectiveMode, memoryRecall });
      return buildHeadlessPromptParts({ name: agent.name, label: agent.label, repo: reviewRepo as string, profile: "review" });
    };
    const { full: system, staticPrefix, staticHash } = prompt();
    if (headlessReview) {
      try {
        structuredLog("info", "headless profile", { sessionId, profile: "work-review", promptStaticHash: staticHash });
      } catch {
        // Observability must not change the review session's result.
      }
    }
    const providerResult = (await provider.query({
      agent: agent.name,
      sessionId,
      mode: effectiveMode,
      cwd: agent.roomDir,
      model: modelOverride ?? agent.config.provider.model,
      system,
      cachePrefix: staticPrefix,
      staticHash,
      ...(headlessReview ? { promptCacheKey: headlessCacheKey(staticPrefix, toolDefinitions) } : {}),
      messages: buildSessionMessagesFromTurns(turns, message, mailContext),
      tools: toolDefinitions,
      canUseTool: autoGuard?.handler,
    })) as ProviderResponse;
    if (isAsyncGenerator(providerResult)) {
      throw new Error("streaming provider responses are not supported by talk yet");
    }

    sessionManager.appendTurn(sessionId, "user", message);

    // Execute tools and send their results back as tool messages (rfcclub/anima#97).
    const { result: currentResult, toolOutputs: allToolOutputs } = await runTalkToolLoop({
      first: providerResult,
      messages: buildSessionMessagesFromTurns(turns, message, mailContext),
      canUseTool: autoGuard?.handler,
      execution: { cwd: agent.roomDir, agentName: agent.name, memoryStore: agent.memoryStore, contextEngine: agent.contextEngine as ExecuteToolOptions["contextEngine"], policy: agent.config.policy },
      onRoundError: (round, err) => {
        process.stderr.write(`[talk] round ${round} failed: ${err instanceof Error ? err.message : String(err)}\n`);
      },
      query: async (messages) => {
        const { full: sys2, staticPrefix: sp2, staticHash: sh2 } = prompt();
        const next = await provider.query({
          agent: agent.name,
          sessionId,
          mode: effectiveMode,
          cwd: agent.roomDir,
          model: modelOverride ?? agent.config.provider.model,
          system: sys2,
          cachePrefix: sp2,
          staticHash: sh2,
          ...(headlessReview ? { promptCacheKey: headlessCacheKey(sp2, toolDefinitions) } : {}),
          messages,
          tools: toolDefinitions,
          canUseTool: autoGuard?.handler,
        });
        if (isAsyncGenerator(next)) {
          throw new Error("streaming not supported by talk");
        }
        return next;
      },
    });

    const finalText = responseContent(currentResult) || allToolOutputs.join("\n") || "(no output)";
    sessionManager.appendTurn(sessionId, "assistant", finalText);
    process.stdout.write(finalText + "\n");

    // Auto-compact check — this used to be unreachable (an early `return`
    // sat right before it), so every plain `anima talk` call (mesh-talk,
    // pulse-anima — anything not using --loop) accumulated context forever.
    // Mirrors the same check→summarize→compact sequence agents/loop.ts
    // already runs reachably for --loop mode.
    if (providerResult.usage) {
      const compaction = sessionManager.checkCompaction(sessionId);
      if (compaction.needed) {
        const currentTurns = sessionManager.getTurns(sessionId);
        const compactor = new Compactor({
          provider,
          store: sessionStore,
          sessionId,
          model: modelOverride ?? agent.config.provider.model,
        });
        await compactor.summarize(currentTurns.map(t => ({ timestamp: t.ts, type: "turn", sessionId: t.sessionId, role: t.role, content: t.content })));
        if (compaction.level === "hard") {
          await sessionManager.compact(sessionId, "hard");
        }
      }
    }
  } finally {
    try {
      autoGuard?.complete();
    } finally {
      finishReview();
    }
  }
}

async function recallTalkMemory(
  agent: Awaited<ReturnType<AgentLoader["load"]>>,
  message: string,
  sessionStore: SessionStore,
  sessionId: string,
): Promise<string[]> {
  try {
    const entries = await agent.memoryAdapter.recall(message, {
      namespace: agent.name,
      topK: agent.config.memory?.topK ?? 5,
      mode: agent.config.memory?.recallMode,
      recentDays: agent.config.memory?.recentDays,
      sessionStore,
      sessionId,
    });
    return entries.map((entry) => entry.content).filter((content) => content.trim().length > 0);
  } catch (error) {
    process.stderr.write(`[talk] memory recall failed, continuing without memory: ${error instanceof Error ? error.message : String(error)}\n`);
    return [];
  }
}

async function status(): Promise<void> {
  const loader = new AgentLoader();
  const names = await loader.list();
  const rows = await Promise.all(names.map((name) => readStatusRow(loader, name)));
  process.stdout.write(JSON.stringify({ agents: rows }, null, 2) + "\n");
}

async function modeCommand(args: ParsedArgs): Promise<void> {
  const [mode] = args.positional;
  await ensureDefaultAnimaConfig();

  if (mode === undefined) {
    process.stdout.write(`Current mode: ${await readCurrentTaskMode()}\n`);
    return;
  }

  if (!isTaskMode(mode)) {
    throw new Error(`invalid mode: ${mode}. Valid modes: ${TASK_MODES.join(", ")}`);
  }

  await writeCurrentTaskMode(mode);
  process.stdout.write(`Current mode: ${mode}\n`);
}

async function sessionCommand(args: ParsedArgs): Promise<void> {
  const positional = args.positional[0] === "status" ? args.positional.slice(1) : args.positional;
  const [agentName] = positional;
  if (!agentName) {
    usage();
  }

  const loader = new AgentLoader();
  const agent = await loader.load(agentName);
  const modelOverride = typeof args.flags.model === "string" ? args.flags.model : undefined;
  const sessionStore = await SessionStore.open(process.env.ANIMA_SESSIONS_DB ?? join(animaHome(), "sessions.db"));
  const sessionManager = new SessionManager({
    store: sessionStore,
    maxTokens: agent.config.session.compactThreshold * 4,
  });

  if (args.flags.reset) {
    const session = sessionManager.openSession(agent.name, "cli");
    sessionManager.resetSession(session.id);
    process.stdout.write(`Reset session ${session.id}\n`);
    return;
  }

  if (args.flags.compact) {
    const session = sessionManager.openSession(agent.name, "cli");
    const turns = sessionManager.getTurns(session.id);
    if (turns.length === 0) {
      process.stdout.write(`No turns to compact for ${session.id}\n`);
      return;
    }

    const providerName = readProvider(args.flags.provider ?? agent.config.provider.type);
    const provider = await createProvider(providerName);
    const compactor = new Compactor({
      provider,
      store: sessionStore,
      sessionId: session.id,
      model: modelOverride ?? agent.config.provider.model,
    });
    await compactor.summarize(turns.map(t => ({ timestamp: t.ts, type: "turn", sessionId: t.sessionId, role: t.role, content: t.content })));
    process.stdout.write(`Compacted ${turns.length} turns for ${session.id}\n`);
    return;
  }

  const session = sessionManager.openSession(agent.name, "cli");
  const turns = sessionManager.getTurns(session.id);
  const mailChecker = new MailChecker();
  const lastActivity = turns.length > 0 ? turns[turns.length - 1].ts : "1970-01-01T00:00:00Z";
  const unreadMail = await mailChecker.check(agent.name, lastActivity);

  process.stdout.write(JSON.stringify({
    agent: agent.name,
    sessionId: session.id,
    turnCount: turns.length,
    unreadMail: unreadMail.length,
    estimatedTokens: estimateTokensFromTurns(turns),
  }, null, 2) + "\n");
}

// ── A2A Mail Commands ─────────────────────────────────────────────────────

export interface SendMailOptions {
  from: string;
  to: string;
  subject: string;
  body: string;
}

/**
 * Send an A2A message and return a human-readable result string.
 * Exported for testing.
 */
export async function sendA2AMail(opts: SendMailOptions): Promise<string> {
  if (!opts.from || !opts.to || !opts.body) {
    return JSON.stringify({
      error: "missing_required_fields",
      detail: "--from, --to and --body are required.",
    });
  }
  // rfcclub/anima#103: by mesh ID, as the sending agent, through its socket (the ANIMA server must be running).
  const content = opts.subject ? `[${opts.subject}] ${opts.body}` : opts.body;
  return runMeshTool("mesh_send", { to: opts.to, content }, opts.from);
}

export interface CheckMailOptions {
  agent: string;
}

/** The mesh mailbox is retired (rfcclub/anima#103). Exported for testing. */
export async function checkA2AMail(opts: CheckMailOptions): Promise<string> {
  return `${opts.agent}: the mesh mailbox is retired; requests now arrive in the agent's session through its A2A inbox`;
}

async function rotate2bTokenCommand(): Promise<void> {
  const newToken = rotateBearerToken();
  process.stdout.write(`New BEARER_2B_TOKEN: ${newToken}\n`);
  process.stdout.write("Add this to your .env file and restart ANIMA for all 2B instances.\n");
}

async function sendMailCommand(args: ParsedArgs): Promise<void> {
  const from = typeof args.flags.from === "string" ? args.flags.from : "";
  const to = typeof args.flags.to === "string" ? args.flags.to : "";
  const subject = typeof args.flags.subject === "string" ? args.flags.subject : "";
  const body = typeof args.flags.body === "string" ? args.flags.body : "";

  if (!from || !to || !body) {
    console.error("Usage: anima send-mail --from <agent> --to <mesh ID> --body <body> [--subject <subject>]");
    process.exit(1);
  }

  const result = await sendA2AMail({ from, to, subject, body });
  process.stdout.write(result + "\n");
}

async function checkMailCommand(args: ParsedArgs): Promise<void> {
  const loader = new AgentLoader();
  const names = typeof args.flags.agent === "string"
    ? [args.flags.agent]
    : await loader.list();
  const checker = new MailChecker();
  const eventStore = await SqliteStore.open();
  const sessionStore = await SessionStore.open(process.env.ANIMA_SESSIONS_DB ?? join(animaHome(), "sessions.db"));
  const markRead = args.flags["mark-read"] === true;

  for (const name of names) {
    const agent = await loader.load(name);
    const sessionManager = new SessionManager({
      store: sessionStore,
      maxTokens: agent.config.session.compactThreshold * 4,
    });
    const session = sessionManager.openSession(agent.name, "mail");
    const turns = sessionManager.getTurns(session.id);
    const lastActivity = turns.length > 0 ? turns[turns.length - 1].ts : "1970-01-01T00:00:00Z";

    // Check meeting-based mail (backward compat)
    const meetingMessages = await checker.check(agent.name, lastActivity);

    // Mesh requests now arrive in the agent's session through its A2A inbox (rfcclub/anima#103).
    const totalUnread = meetingMessages.length;

    eventStore.append(agent.name, {
      timestamp: new Date().toISOString(),
      type: "mail_check",
      sessionId: session.id,
      unread: totalUnread,
      meetingUnread: meetingMessages.length,
    });

    process.stdout.write(`${agent.name}: ${totalUnread} unread meeting mail (mesh requests arrive in the session)\n`);

    // Handle meeting mail mark-read
    if (markRead) {
      const latestByTopic = new Map<string, string>();
      for (const message of meetingMessages) {
        const previous = latestByTopic.get(message.topic);
        if (previous === undefined || message.timestamp > previous) {
          latestByTopic.set(message.topic, message.timestamp);
        }
      }
      for (const [topic, timestamp] of latestByTopic) {
        await checker.markRead(agent.name, topic, timestamp);
      }
    }
  }
}

async function seed(args: string[]): Promise<void> {
  if (args.length < 2) {
    usage();
  }

  const proc = Bun.spawn({
    cmd: ["bun", "scripts/seed-room.ts", ...args],
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  process.exit(code);
}

async function readStatusRow(loader: AgentLoader, name: string): Promise<Record<string, unknown>> {
  try {
    const agent = await loader.load(name);
    return {
      name: agent.name,
      label: agent.label,
      provider: agent.config.provider.type,
      mount: "ok",
      lastSession: await readLastSessionTimestamp(join(agent.roomDir, "sessions")),
    };
  } catch (error) {
    if (error instanceof SubstrateNotMountedError) {
      return { name, mount: "fail", lastSession: await readLastSessionTimestamp(join(process.cwd(), "rooms", name, "sessions")) };
    }
    return { name, mount: "fail", error: error instanceof Error ? error.message : String(error) };
  }
}

async function readLastSessionTimestamp(sessionsDir: string): Promise<string | null> {
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    let latest = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      latest = Math.max(latest, statSync(join(sessionsDir, entry.name)).mtimeMs);
    }
    return latest > 0 ? new Date(latest).toISOString() : null;
  } catch {
    return null;
  }
}

async function createProvider(provider: ProviderType): Promise<Provider> {
  if (provider === "claude") {
    return meterProvider(new AnthropicProvider({ log: structuredLog }), { path: "cli" });
  }
  const home = animaHome();
  const registry = await ProviderRegistry.load(join(home, "providers.d"));
  const def = registry.get(provider);
  if (def) return createProviderFromDef(def);
  throw new Error(`provider not found: ${provider}`);
}

async function talkProviderDeps(): Promise<TalkProviderDeps> {
  const home = animaHome();
  return {
    registry: await ProviderRegistry.load(join(home, "providers.d")),
    loadModeMap: async () => {
      await ensureDefaultAnimaConfig();
      return loadModeMap(join(home, "mode-map.yaml"));
    },
    createDirect: (name) => createProvider(name),
    createProvider: (_providerId: string, provider: ProviderDef) => createProviderFromDef(provider),
  };
}

function createProviderFromDef(provider: ProviderDef): Provider {
  if (provider.api === "openai-completions") {
    return meterProvider(new OpenAIv1ChatProvider(provider), { path: "cli" });
  }
  if (provider.api === "openai-responses") {
    return meterProvider(new OpenAIv1ResponseProvider(provider), { path: "cli" });
  }
  throw new Error(`provider not implemented: ${provider.id}`);
}

function readPermissionMode(value: string | boolean | undefined): PermissionMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "plan" || value === "edit" || value === "auto") {
    return value;
  }
  throw new Error("--permission must be plan, edit, or auto");
}

function permissionModeFlag(value: string | boolean | undefined): string | boolean | undefined {
  return value === "plan" || value === "edit" || value === "auto" ? value : undefined;
}

function readTaskMode(value: string | boolean | undefined): TaskMode | undefined {
  if (value === undefined || value === true || permissionModeFlag(value) !== undefined) {
    return undefined;
  }
  if (typeof value === "string" && isTaskMode(value)) {
    return value;
  }
  throw new Error(`--mode must be one of: ${TASK_MODES.join(", ")}`);
}

function readProvider(value: string | boolean): ProviderType {
  return String(value) as ProviderType;
}

async function ensureDefaultAnimaConfig(home = animaHome()): Promise<void> {
  const providersDir = join(home, "providers.d");
  await mkdir(providersDir, { recursive: true });

  const geminiPath = join(providersDir, "gemini.yaml");
  if (!existsSync(geminiPath)) {
    await writeFile(geminiPath, [
      "id: gemini",
      "label: Gemini",
      "baseUrl: https://generativelanguage.googleapis.com",
      "api: generic",
      `apiKey: ${process.env.GEMINI_API_KEY ?? "GEMINI_API_KEY"}`,
      "models:",
      `  - id: ${DEFAULT_GEMINI_ROUTER_MODEL}`,
      "",
    ].join("\n"));
  }

  const modeMapPath = join(home, "mode-map.yaml");
  if (!existsSync(modeMapPath)) {
    await writeFile(modeMapPath, TASK_MODES.map((mode) => `${mode}: [${DEFAULT_GEMINI_ROUTER_MODEL}@gemini]`).join("\n") + "\n");
  }
}

async function loadModeMap(path: string): Promise<ModeMap> {
  const parsed = yaml.load(await readFile(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`invalid mode map: ${path}`);
  }

  const record = parsed as Record<string, unknown>;
  const result = {} as ModeMap;
  for (const mode of TASK_MODES) {
    const refs = record[mode];
    if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string")) {
      throw new Error(`invalid mode map: missing ${mode}`);
    }
    result[mode] = refs as ModeMap[TaskMode];
  }
  return result;
}

async function readCurrentTaskMode(): Promise<TaskMode> {
  await ensureDefaultAnimaConfig();
  const path = join(animaHome(), "state.yaml");
  if (!existsSync(path)) {
    return DEFAULT_TASK_MODE;
  }
  const parsed = yaml.load(await readFile(path, "utf8"));
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const mode = (parsed as Record<string, unknown>).mode;
    if (typeof mode === "string" && isTaskMode(mode)) {
      return mode;
    }
  }
  return DEFAULT_TASK_MODE;
}

async function writeCurrentTaskMode(mode: TaskMode): Promise<void> {
  await ensureDefaultAnimaConfig();
  await writeFile(join(animaHome(), "state.yaml"), yaml.dump({ mode }));
}

function isTaskMode(value: string): value is TaskMode {
  return TASK_MODES.includes(value as TaskMode);
}

function animaHome(): string {
  return process.env.ANIMA_HOME ?? join(homedir(), ".anima");
}

export function lastActivityFromSession(context: SessionContext): string {
  return context.turns.reduce(
    (latest, turn) => turn.timestamp > latest ? turn.timestamp : latest,
    "1970-01-01T00:00:00Z",
  );
}

export function lastActivityFromTurns(turns: TurnRecord[]): string {
  return turns.reduce(
    (latest, turn) => turn.ts > latest ? turn.ts : latest,
    "1970-01-01T00:00:00Z",
  );
}

function estimateTokens(context: SessionContext): number {
  const baselineChars = context.baseline?.summary.length ?? 0;
  const turnChars = context.turns.reduce((sum, turn) => sum + turn.content.length, 0);
  return Math.ceil((baselineChars + turnChars) / 4);
}

function estimateTokensFromTurns(turns: TurnRecord[]): number {
  const turnChars = turns.reduce((sum, turn) => sum + turn.content.length, 0);
  return Math.ceil(turnChars / 4);
}

export function truncateTurnsIfNeeded(context: SessionContext, threshold: number): SessionContext {
  const CHARS_PER_TOKEN = 4;
  const maxChars = threshold * CHARS_PER_TOKEN;
  const baselineChars = context.baseline?.summary.length ?? 0;

  let turns = context.turns;
  let turnChars = turns.reduce((sum, t) => sum + t.content.length, 0);

  // Drop oldest turns in pairs to preserve user/assistant alternation
  while (turns.length >= 2 && baselineChars + turnChars > maxChars) {
    turnChars -= turns[0].content.length;
    turns = turns.slice(1);
  }

  return turns === context.turns ? context : { ...context, turns };
}

export async function restartCommand(args: ParsedArgs, runner: ProcessRunner): Promise<number> {
  const devOnly = args.flags["dev-only"] === true;

  const devResult = await runner.run("pkill", ["-f", "bun src/server.ts"]);
  if (devResult.exitCode === 0) {
    process.stdout.write("[anima] dev server stopped\n");
  } else {
    process.stdout.write("[anima] no dev server found\n");
  }

  if (devOnly) {
    return 0;
  }

  const prodResult = await runner.run("launchctl", ["kickstart", "-k", "gui/501/com.owner.anima"]);
  if (prodResult.exitCode === 0) {
    process.stdout.write("[anima] production restarted\n");
    return 0;
  }

  process.stderr.write(`[anima] production restart failed:\n${prodResult.stderr}\n`);
  return 1;
}

function responseContent(response: ProviderResponse): string {
  return typeof response.message.content === "string" ? response.message.content : JSON.stringify(response.message.content);
}


export function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Double-dash: --flag or --flag=value
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && (next === "-" || !next.startsWith("-"))) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
    // Single-dash: -f or -f value
    else if (arg.startsWith("-") && arg.length === 2) {
      const key = arg.slice(1);
      const next = args[i + 1];
      if (next && (next === "-" || !next.startsWith("-"))) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

async function meetCommand(args: ParsedArgs): Promise<void> {
  // --list: list topic directories
  if (args.flags.list === true) {
    const room = new MeetingRoom();
    const topics = await room.listTopics();
    for (const topic of topics) {
      process.stdout.write(topic + "\n");
    }
    return;
  }

  // --show <topic>: print today's transcript
  if (typeof args.flags.show === "string") {
    const room = new MeetingRoom();
    const transcript = room.readTranscript(args.flags.show);
    if (transcript === null) {
      console.error(`no meeting transcript found for topic: ${args.flags.show}`);
      process.exit(1);
    }
    process.stdout.write(transcript);
    return;
  }

  // Default: run meeting
  const agents = args.positional;
  if (agents.length < 1) {
    usage();
  }

  const topic = args.flags.topic;
  if (typeof topic !== "string" || topic.length === 0) {
    console.error("--topic is required");
    process.exit(1);
  }

  const turns = typeof args.flags.turns === "string" ? parseInt(args.flags.turns, 10) : 3;
  const opts: MeetingOptions = {
    turns: Number.isFinite(turns) && turns > 0 ? turns : 3,
    resume: args.flags.resume === true,
    inject: typeof args.flags.inject === "string" ? args.flags.inject : undefined,
    provider: typeof args.flags.provider === "string" ? args.flags.provider : undefined,
  };

  const room = new MeetingRoom();
  const transcript = await room.run(agents, topic, opts);
  process.stdout.write(transcript);
}

async function cartridgeCommand(args: ParsedArgs): Promise<void> {
  const [name] = args.positional;
  if (!name) {
    usage();
  }
  const agentName = typeof args.flags.agent === "string" ? args.flags.agent : "";

  if (name === "off" || name === "none") {
    process.stdout.write("Cartridge disabled for next session.\nUse `/cartridge <name>` to enable a specific cartridge.\n");
    return;
  }

  const registry = new CartridgeRegistry(process.cwd());
  const entries = await registry.list(agentName);

  if (name === "list") {
    if (entries.length === 0) {
      process.stdout.write("No cartridges found.\n");
      return;
    }
    for (const c of entries) {
      process.stdout.write(`[${c.scope}] ${c.category}/${c.name}\n`);
    }
    return;
  }

  const cartridge = entries.find(e => e.name === name);

  if (!cartridge) {
    console.error(`Cartridge not found: ${name}`);
    process.exit(1);
  }

  process.stdout.write(`Category: ${cartridge.category}\nName: ${cartridge.name}\nScope: ${cartridge.scope}\nPath: ${cartridge.path}\n\n${cartridge.content}\n`);
}

/**
 * Write a single beam entry for an agent's dream pipeline (staging/beams/),
 * without going through the full AgentLoader boot (no gene/soul reads, no
 * extra-action hooks) — this is a lightweight write path, not a session.
 * Exists so external callers (mesh-talk's bash scripts, most immediately)
 * can record a beam the same way pulse-anima-dispatcher.ts does in-process,
 * via `anima beam <agent> --content "..." --source mesh-talk`.
 * Requirement: mesh-talk conversations also produce a beam.
 */
export async function beamCommand(args: ParsedArgs): Promise<void> {
  const agentName = args.positional[0];
  if (!agentName) {
    process.stderr.write('Usage: anima beam <agent> --content "..." [--source <source>] [--keywords a,b] [--session <id>]\n');
    process.exitCode = 1;
    return;
  }
  const content = typeof args.flags.content === "string" ? args.flags.content : "";
  if (content.trim().length === 0) {
    process.stderr.write("Error: --content is required and must be non-empty\n");
    process.exitCode = 1;
    return;
  }
  const source = typeof args.flags.source === "string" ? args.flags.source : "cli";
  const keywords = typeof args.flags.keywords === "string"
    ? args.flags.keywords.split(",").map((k) => k.trim()).filter((k) => k.length > 0)
    : [source];
  const session = typeof args.flags.session === "string" ? args.flags.session : `cli:${source}`;

  const roomDir = join(animaHome(), "rooms", agentName);
  const beam: BeamEntry = {
    timestamp: new Date().toISOString(),
    agent: agentName,
    session,
    keywords,
    source,
    content,
  };
  await appendBeamEntries(roomDir, [beam]);
  process.stdout.write(`Beam written for ${agentName} (source=${source})\n`);
}

function usage(): never {
  process.stderr.write([
    'Usage:',
    '  anima talk <agent> "<msg>"',
    '  anima talk -a <agent> -m "<msg>" [--mode task-mode] [--permission plan|edit|auto]',
    '  anima session [status] <agent> [--reset] [--compact]',
    '  anima send-mail --from <agent> --to <mesh ID> --body <msg> [--subject <subj>]',
    '  anima rotate-abel-token',
    '  anima check-mail [--agent <agent>] [--mark-read]',
    '  anima meet <agent> [agent...] --topic <topic> [--turns N] [--resume]',
    '  anima meet --list',
    '  anima meet --show <topic>',
    '  anima beam <agent> --content "<text>" [--source <source>] [--keywords a,b] [--session <id>]',
    '  anima mode [chatting|programming|image|private|philosophy|creative]',
    '  anima status',
    '  anima work recover <workId> --base <full SHA> [--caps key=value ...]',
    '  anima work retry-revise <workId> --job <failed-job-id> --head <full-sha> [--reviewer <login> ...]',
    '  anima seed <agent> <path>',
    '  anima restart [--dev-only]',
  ].join("\n") + "\n");
  process.exit(1);
}

function structuredLog(level: "info" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level, ts: new Date().toISOString(), msg, ...fields }));
}

if (import.meta.main) {
  main().catch((error) => {
    if (error instanceof AutoModeNotEnabledError || error instanceof ProviderError) {
      console.error(error.message);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  });
}
