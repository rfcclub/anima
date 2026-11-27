import { createHash } from "node:crypto";
import type { ProviderToolCall } from "../providers/interface";
import type { ProgressClassification, WorkStore } from "./store";

type Intervention = "none" | "warn" | "stop";
export interface ProgressSample {
  classification: ProgressClassification | "polling";
  streak: number;
  wouldAction: Intervention;
  action: Intervention;
  falsePositive: boolean;
}
export interface ProgressGuardInput {
  store: WorkStore;
  workId: string;
  sessionId: string;
  claimId: string;
  generation: number;
  signal: AbortSignal;
  state: () => Promise<string | null>;
  enforce?: boolean;
  pollingReadPaths?: readonly string[];
  pollingCommands?: readonly string[];
}
export interface ToolObservation { call: ProviderToolCall; result: string; iteration: number; completed: boolean }

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const hexHash = (value: string | null): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

function callIdentity(call: ProviderToolCall): { hash: string; args: Record<string, unknown> | null } {
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return { hash: digest(JSON.stringify([call.name, canonical(parsed)])), args: parsed as Record<string, unknown> };
  } catch {
    return { hash: digest(JSON.stringify([call.name, call.arguments])), args: null };
  }
}

function isPolling(call: ProviderToolCall, args: Record<string, unknown> | null, paths: readonly string[], commands: readonly string[]): boolean {
  if (!args) return false;
  if (call.name === "read" && typeof args.path === "string" && paths.includes(args.path)) return true;
  return call.name === "bash" && typeof args.command === "string" && (
    commands.includes(args.command) ||
    /^\s*git\s+status(?:\s+(?:-s|-b|--short|--branch|--porcelain(?:=v1)?))*\s*$/.test(args.command)
  );
}

/** Advisory observations are best-effort; only an emitted, known observation can lead to enforcement. */
export function createProgressGuard(input: ProgressGuardInput) {
  const warnedAt = new Map<string, number>();
  return {
    async observe(observation: ToolObservation): Promise<ProgressSample> {
      const unknown: ProgressSample = { classification: "unknown", streak: 0, wouldAction: "none", action: "none", falsePositive: false };
      try {
        const identity = callIdentity(observation.call);
        let state: string | null = null;
        if (observation.completed && !input.signal.aborted) {
          try { state = await input.state(); } catch { /* incomplete snapshots are unknown */ }
        }
        const compared = input.store.observeProgress({
          workId: input.workId, sessionId: input.sessionId, claimId: input.claimId,
          generation: input.generation, signal: input.signal, callHash: identity.hash,
          resultHash: observation.completed && hexHash(state) ? digest(observation.result) : null,
          stateHash: hexHash(state) ? state : null,
        });
        const eligible = compared.classification === "unchanged";
        const polling = eligible && isPolling(observation.call, identity.args, input.pollingReadPaths ?? [], input.pollingCommands ?? []);
        const wouldAction: Intervention = eligible && compared.streak >= 2 ? (compared.streak === 2 ? "warn" : "stop") : "none";
        let action: Intervention = "none";
        const warned = warnedAt.get(identity.hash);
        if (input.enforce === true && eligible && !polling && wouldAction !== "none") {
          if (warned === undefined) action = "warn";
          else if (observation.iteration > warned) action = "stop";
        }
        const sample: ProgressSample = {
          classification: polling ? "polling" : compared.classification, streak: compared.streak,
          wouldAction, action, falsePositive: polling && wouldAction !== "none",
        };
        input.store.appendEvent(input.workId, "progress-guard", {
          classification: sample.classification, streak: sample.streak, wouldAction, action,
          falsePositive: sample.falsePositive, callHash: identity.hash,
          tool: ["read", "write", "edit", "bash", "publish"].includes(observation.call.name) ? observation.call.name : "unknown",
        });
        if (action === "warn") warnedAt.set(identity.hash, observation.iteration);
        return sample;
      } catch {
        return unknown;
      }
    },
  };
}
