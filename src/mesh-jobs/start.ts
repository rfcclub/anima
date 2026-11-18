import { join } from "node:path";
import { MeshJobsClient } from "./client";
import { loadMeshJobsConfig } from "./config";
import { MeshJobConsumer, type ConsumerLog, type TurnRunner, type WorkJobHandler } from "./consumer";
import { ghReader, spawnGh } from "./github";
import { formatIntentTarget, INTENT_REVIEW_ENV, type IntentTarget } from "../tools/review-budget";

/** The part of the server's mesh presence the workers need (rfcclub/anima#103). */
export interface MeshJobsPresence {
  meshId(agent: string): string | null;
  inbox(agent: string): { address: string; capability: string } | null;
}

export interface StartMeshJobConsumerOptions {
  configPath: string;
  /** Null when ANIMA_MESH_PRESENCE is off: the workers then have no mesh ID to work as. */
  presence: MeshJobsPresence | null;
  log: ConsumerLog;
}

/** The child's environment: ours, with the intent-review target set for an intent review and never inherited otherwise. */
export function intentReviewEnv(intent?: IntentTarget): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (intent) env[INTENT_REVIEW_ENV] = formatIntentTarget(intent);
  else delete env[INTENT_REVIEW_ENV];
  return env;
}

/**
 * The reviewer path used by request-review.sh: `anima talk --permission auto`
 * in a child process, killed when the consumer aborts the turn.
 */
export function cliTurnRunner(cliPath = join(process.env.HOME ?? "~", ".anima", "dist", "cli.js"), log?: ConsumerLog): TurnRunner {
  return async ({ agent, message, signal, provider, model, profile, repo, intent }) => {
    // The message goes through stdin: a long diff would exceed Linux's per-argument limit.
    const reviewModel = provider && model ? ["--provider", provider, "--model", model] : [];
    if (profile === "review" && !repo) throw new Error("headless review requires a repository");
    const headless = profile === "review" ? ["--headless-review", "--review-repo", repo!] : [];
    const proc = Bun.spawn([process.execPath, cliPath, "talk", "-a", agent, "-m", "-", "--permission", "auto", ...reviewModel, ...headless], {
      stdin: new Blob([message]),
      // The child is where the GitHub tool runs, so it is told which issue it reviews (#300). Never inherited.
      env: intentReviewEnv(intent),
      stdout: "ignore",
      stderr: "pipe",
      signal,
    });
    const stderrOutput = profile === "review" && log
      ? captureReviewStderr(proc.stderr, agent, log)
      : new Response(proc.stderr).text();
    const [stderr, code] = await Promise.all([stderrOutput, proc.exited]);
    if (code !== 0) throw new Error(`anima talk exited ${code}: ${stderr.trim().slice(-200)}`);
  };
}

/** Forward only the child's bounded profile metadata; keep arbitrary stderr out of the server log. */
async function captureReviewStderr(stream: ReadableStream<Uint8Array>, agent: string, log: ConsumerLog): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let stderr = "";
  let pending = "";
  let forwarded = false;
  while (true) {
    const { value, done } = await reader.read();
    const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
    stderr += chunk;
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (forwarded) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!record || record.level !== "info" || record.msg !== "headless profile" || record.profile !== "work-review"
        || typeof record.promptStaticHash !== "string" || !/^[0-9a-f]{64}$/.test(record.promptStaticHash)
        || typeof record.sessionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.sessionId)) continue;
      try {
        log("info", "headless profile", {
          agent, sessionId: record.sessionId, profile: "work-review", promptStaticHash: record.promptStaticHash,
        });
      } catch {
        // A logger failure must not alter the review session.
      }
      forwarded = true;
    }
    if (done) break;
  }
  return stderr;
}

/**
 * Starts the job consumer when its config file exists. Never throws: a bad
 * config must not crash-loop the ANIMA process. Returns a stop function, or
 * null when the consumer is off.
 */
export function startMeshJobConsumer(options: StartMeshJobConsumerOptions): (() => void) | null {
  const { configPath, presence, log } = options;
  try {
    const config = loadMeshJobsConfig(configPath);
    if (!config) return null;
    if (!presence) {
      log("error", "mesh job consumer needs mesh presence (ANIMA_MESH_PRESENCE=on) — off");
      return null;
    }
    const makeConsumer = (work?: WorkJobHandler) => new MeshJobConsumer({
      workers: config.workers.map((worker) => ({
        agent: worker.agent,
        // Read on every call: the credential changes when the agent rejoins.
        jobs: new MeshJobsClient(config.gatewayUrl, () => presence.inbox(worker.agent)?.capability ?? null),
        ...(worker.provider && worker.model ? { provider: worker.provider, model: worker.model } : {}),
      })),
      github: ghReader(spawnGh()),
      runTurn: cliTurnRunner(undefined, log),
      heartbeatMs: config.heartbeatMs,
      turnTimeoutMs: config.turnTimeoutMs,
      ...(work ? { work } : {}),
      ...(config.work ? {
        releaseBackoffMs: config.work.releaseBackoffMs,
        intentReviewers: config.work.reviewers.map(({ agent, login }) => ({ agent, login })),
        approvalLabel,
      } : {}),
      log,
    });
    const describeWorkers = () => config.workers.map((w) => {
      const id = presence.meshId(w.agent) ?? `${w.agent} (not yet online)`;
      return w.model ? `${id} (${w.provider}/${w.model})` : id;
    });

    if (!config.work) {
      const consumer = makeConsumer();
      // tick() skips busy workers, so an overlapping interval never starts a second job.
      const timer = setInterval(() => { void consumer.tick(); }, config.intervalMs);
      log("info", "mesh job consumer started", { workers: describeWorkers(), intervalMs: config.intervalMs });
      return () => clearInterval(timer);
    }

    // The work loop is on: build its parts (they load heavy modules, so lazily), then start both ticks. If the
    // parts cannot be built the consumer still starts for reviews and hands work jobs back untouched.
    const work = config.work;
    const timers: Array<ReturnType<typeof setInterval>> = [];
    let stopped = false;
    let stopPipeline: (() => void) | null = null;
    let approvalLabel = "orca:approved";
    void (async () => {
      let handler: WorkJobHandler | undefined;
      let reconcile: (() => Promise<void>) | undefined;
      try {
        const { createProductionWorkRuntime } = await import("../work/production");
        const runtime = await createProductionWorkRuntime({ config: work, gatewayUrl: config.gatewayUrl, heartbeatMs: config.heartbeatMs, presence, log });
        handler = runtime.handler;
        reconcile = () => runtime.reconciler.tick();
      } catch (error) {
        log("error", "work loop could not start — reviews only, work jobs handed back", { error: error instanceof Error ? error.message : String(error) });
      }
      if (stopped) return;
      try {
        const { defaultPipelineConfigPath, loadPipelineConfig } = await import("./pipeline");
        approvalLabel = loadPipelineConfig(defaultPipelineConfigPath())?.issueLabel ?? approvalLabel;
      } catch {
        // The pipeline start below reports a bad config; the consumer keeps the default label.
      }
      const consumer = makeConsumer(handler);
      timers.push(setInterval(() => { void consumer.tick(); }, config.intervalMs));
      if (reconcile) {
        let running = false;
        timers.push(setInterval(() => {
          if (running) return;
          running = true;
          void reconcile!().catch((error) => log("error", "work reconcile failed", { error: error instanceof Error ? error.message : String(error) })).finally(() => { running = false; });
        }, work.reconcileIntervalMs));
      }
      if (handler) {
        try {
          const { defaultPipelineConfigPath, startPipeline } = await import("./pipeline");
          stopPipeline = startPipeline({
            configPath: defaultPipelineConfigPath(), gatewayUrl: config.gatewayUrl, work, presence, log,
          });
        } catch (error) {
          log("error", "issue dispatch failed to start — non-fatal", { error: error instanceof Error ? error.message : String(error) });
        }
      }
      log("info", "mesh job consumer started", { workers: describeWorkers(), intervalMs: config.intervalMs, work: handler ? "on" : "unavailable" });
    })();
    return () => { stopped = true; for (const timer of timers) clearInterval(timer); stopPipeline?.(); };
  } catch (error) {
    log("error", "mesh job consumer failed to start — non-fatal", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
