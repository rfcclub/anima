import { createHash } from "node:crypto";

export type StopReason = "max_reached" | "interrupted" | "quota" | "provider_error" | "blocked";
export type StepOutcome = "completed" | "unknown";
export type RunCheckpointStatus = "open" | "resumed" | "expired" | "done";

/** What a loop run leaves behind when it stops before `done` (rfcclub/anima#71). */
export interface RunCheckpoint {
  id: string;
  agent: string;
  sessionId: string;
  goal: string;
  goalHash: string;
  stopReason: StopReason;
  iteration: number;
  maxIterations: number;
  lastOutcome: StepOutcome;
  remaining: string;
  status: RunCheckpointStatus;
  createdAt: string;
  /** The castle work this run belongs to (anima #135). Recovery for a work is looked up by this id. */
  workId?: string;
}

export type NewRunCheckpoint = Omit<RunCheckpoint, "id" | "status">;

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// Providers shape quota/token errors differently; the message text is the common ground.
const QUOTA_PATTERN = /quota|\b429\b|rate.?limit|insufficient|exceeded|credit|context.?length|too many tokens/i;

export function classifyStopError(error: unknown): "quota" | "provider_error" {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return QUOTA_PATTERN.test(message) ? "quota" : "provider_error";
}

export function goalHash(goal: string): string {
  return createHash("sha256").update(goal).digest("hex");
}

/** First message of a resumed run. Never the bare goal: it says where the last run stopped. */
export function buildResumeMessage(checkpoint: RunCheckpoint, options: { includeGoal?: boolean } = {}): string {
  const lines = [
    `[resume] The previous run of this goal stopped: ${checkpoint.stopReason} at step ${checkpoint.iteration}/${checkpoint.maxIterations}.`,
    ...(options.includeGoal === false ? [] : [`Goal: ${checkpoint.goal}`]),
    `Remaining work, as last reported: ${checkpoint.remaining || "(not reported)"}`,
  ];
  if (checkpoint.lastOutcome === "unknown") {
    lines.push(
      `The outcome of step ${checkpoint.iteration} is unknown: it may have partly run. ` +
      "Do not repeat its side effects; verify what it changed first, then continue.",
    );
  }
  lines.push("Continue from there, not from the beginning.");
  return lines.join("\n");
}
