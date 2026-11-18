/**
 * SentinelGate — synchronous pre-output drift gate.
 *
 * Wraps existing DriftDetector (Step 1, heuristic, < 50ms) and
 * EvaluationPipeline (Step 2, LLM review, only triggered on high-severity flags).
 *
 * Runs at the response boundary — after LLM generates, before bytes are sent.
 * Covers ANIMA (server.ts handleTalk/agentStream) and OpenClaw (OC gateway).
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DriftDetector, type DriftContext, type DriftReport } from './drift-detector';
import type { EvaluationPipeline, EvalOutput } from './pipeline';

const HOME = process.env.HOME ?? require('node:os').homedir();
const LOGS_DIR = join(HOME, 'substrate', 'logs');
const SENTINEL_ERRORS_LOG = join(LOGS_DIR, 'sentinel-errors.jsonl');

function ensureLogsDir(): void {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
}

function appendJSONL(path: string, record: Record<string, unknown>): void {
  ensureLogsDir();
  appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
}

export interface SentinelResult {
  pass: boolean;
  /** Re-grounding instruction to inject. Only set when pass is false. */
  injection?: string;
  /** Reason for the hold (logged but not shown to user). */
  reason?: string;
  /** Which step caught the drift. */
  step?: 1 | 2;
}

export interface SentinelGateOptions {
  /** Session ID for tracking attempt counts per session. */
  sessionId?: string;
  /** EvaluationPipeline for Step 2 LLM review. */
  evaluationPipeline?: EvaluationPipeline;
  /** Per-session hold counter (shared mutable state). */
  holdCounter?: Map<string, number>;
}

export class SentinelGate {
  private readonly driftDetector: DriftDetector;
  private readonly pipeline?: EvaluationPipeline;
  private readonly holdCounter: Map<string, number>;

  constructor(private options: SentinelGateOptions = {}) {
    this.driftDetector = new DriftDetector();
    // Add pronoun_drift_viet pattern (D8, risk #5)
    this.driftDetector.loadCartridge(
      // Pattern matches the Vietnamese first-person pronoun "t\u00f4i" (written as \u escapes).
      'pronoun_drift_viet|identity|high|\\bt\u00f4i\\b(?!.*\\bem\\b)',
    );
    this.pipeline = options.evaluationPipeline;
    this.holdCounter = options.holdCounter ?? new Map();
  }

  /**
   * Check a response for drift before sending to client.
   *
   * Step 1: DriftDetector (heuristic, target < 50ms).
   * Step 2: EvaluationPipeline (LLM review) — only triggered if Step 1
   *         returns high-severity drift.
   */
  async check(response: string, context: DriftContext & { agentName?: string }): Promise<SentinelResult> {
    try {
      // Step 1: Heuristic detection
      const step1Result: DriftReport = await this.driftDetector.detect(response, context);

      if (step1Result.status === 'clear') {
        return { pass: true };
      }

      // Low-severity only: pass with warning (no Step 2)
      const hasHighSeverity = step1Result.patterns.some((name) => {
        const pattern = this.driftDetector['patterns']?.find((p: any) => p.name === name);
        return pattern?.severity === 'high';
      });

      if (!hasHighSeverity && step1Result.recommendation !== 'escalate') {
        // Low-severity flags: log but don't block
        appendJSONL(SENTINEL_ERRORS_LOG, {
          ts: new Date().toISOString(),
          type: 'sentinel_step1_low',
          patterns: step1Result.patterns,
          confidence: step1Result.confidence,
          session: this.options.sessionId,
        });
        return { pass: true };
      }

      // High severity or escalate recommendation → Step 2 if available
      if (this.pipeline) {
        const step2Result = await this.evaluatePipeline(response, context);

        if (step2Result?.decision === 'hold') {
          return this.holdResponse(step1Result.patterns, context.agentName);
        }

        // Step 2 disagrees (false positive) — log and pass
        appendJSONL(SENTINEL_ERRORS_LOG, {
          ts: new Date().toISOString(),
          type: 'sentinel_false_positive',
          step1_patterns: step1Result.patterns,
          step2_decision: step2Result?.decision,
          session: this.options.sessionId,
        });
        return { pass: true };
      }

      // No Step 2 available — hold on high-severity Step 1
      return this.holdResponse(step1Result.patterns, context.agentName);
    } catch (error) {
      // Gate failure — pass response with error header, log error
      appendJSONL(SENTINEL_ERRORS_LOG, {
        ts: new Date().toISOString(),
        type: 'sentinel_internal_error',
        error: (error as Error).message,
        session: this.options.sessionId,
      });
      return { pass: true };
    }
  }

  /** Run Step 2 LLM review via EvaluationPipeline. */
  private async evaluatePipeline(
    response: string,
    context: DriftContext,
  ): Promise<EvalOutput | null> {
    if (!this.pipeline) return null;
    try {
      return await this.pipeline.evaluate({
        agentId: context.agentName ?? 'bruno',
        output: response,
        domain: 'identity' as any,
        recentStatements: context.recentStatements,
        allowedTasks: context.allowedTasks,
      });
    } catch {
      return null; // Pipeline failure → don't block
    }
  }

  /** Hold the response, inject re-grounding instruction. */
  private holdResponse(patterns: string[], agentName?: string): SentinelResult {
    const sessionId = this.options.sessionId ?? 'unknown';
    const count = (this.holdCounter.get(sessionId) ?? 0) + 1;
    this.holdCounter.set(sessionId, count);

    const patternList = patterns.join(', ');
    const injection = `[SENTINEL] Drift detected: ${patternList}. Re-read axiom 0 and respond as ${agentName ?? 'Bruno'}.`;

    // Escalate if 3+ consecutive holds
    if (count >= 3) {
      const queuePath = join(HOME, 'substrate', 'heartbeat-queue.jsonl');
      ensureLogsDir();
      appendJSONL(queuePath, {
        ts: new Date().toISOString(),
        type: 'sentinel_escalation',
        severity: 'critical',
        session_id: sessionId,
        patterns,
        hold_count: count,
      });
    }

    return {
      pass: false,
      injection,
      reason: `drift confirmed: ${patternList}`,
      step: this.pipeline ? 2 : 1,
    };
  }
}
