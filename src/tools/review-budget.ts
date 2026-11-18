/**
 * Per-turn budget for an intent-review turn.
 *
 * An intent-review turn runs in its own `anima talk` child process (`cliTurnRunner`), and that child is where
 * `handleGithubTool` runs, so the consumer in the server process cannot hold the budget. Instead the consumer tells
 * the child which issue it is reviewing through `ANIMA_INTENT_REVIEW=<repo>#<issue>`; the child adopts a fresh budget
 * on its first GitHub call. One child is one turn, so the budget ends with the process and each claim starts fresh.
 * Any process without that variable has no budget and nothing here applies.
 */

import { createHash } from "node:crypto";

/** Set by the consumer on the child it starts for a review-intent turn. */
export const INTENT_REVIEW_ENV = "ANIMA_INTENT_REVIEW";

export interface IntentTarget {
  repo: string;
  issue: number;
  /** Short hash of the issue title and body the reviewer was shown (see `intentRevision`). */
  revision?: string;
}

/** Identifies the text of the intent under review, so a verdict is only a duplicate within the same text. */
export function intentRevision(title: string, body: string): string {
  return createHash("sha256").update(`${title}\n${body}`).digest("hex").slice(0, 12);
}

export function formatIntentTarget(target: IntentTarget): string {
  return `${target.repo}#${target.issue}${target.revision ? `@${target.revision}` : ""}`;
}

export function parseIntentTarget(value: string | undefined): IntentTarget | null {
  const m = /^(rfcclub\/[A-Za-z0-9._-]+)#([1-9]\d*)(?:@([0-9a-f]{12}))?$/.exec(value ?? "");
  return m ? { repo: m[1], issue: Number(m[2]), ...(m[3] ? { revision: m[3] } : {}) } : null;
}

/** A verdict is a successful `approve_intent` or `issue_comment`. */
export const REVIEW_VERDICTS = 1;
/** An attempt is any call of those two actions that reaches the check, successful or not. */
export const REVIEW_ATTEMPTS = 3;

const ALLOWED_ACTIONS = new Set(["approve_intent", "issue_comment"]);

export interface Budget {
  repo: string;
  issue: number;
  revision?: string;
  /** A verdict is reserved the moment a call is admitted, so two calls in flight cannot both write one. */
  verdictsLeft: number;
  attemptsLeft: number;
}

/** A refused duplicate gives its attempt back once; further repeats of it keep counting. */
export const REVIEW_REFUNDS = 1;

export type RefusalReason = "verdict-recorded" | "attempt-limit" | "not-allowed";
export type Admit = { ok: true } | { ok: false; reason: RefusalReason };

interface Entry extends Budget {
  token: symbol;
  refundsLeft: number;
}

export class ReviewBudgets {
  private budgets = new Map<string, Entry>();
  private adopted = false;

  constructor(private readEnv: () => Record<string, string | undefined> = () => process.env) {}

  /**
   * In a child started for an intent review, registers the budget the environment names, once per process.
   * A process whose environment does not name one is left alone.
   */
  adoptFromEnv(agent: string): void {
    if (this.adopted || this.budgets.has(agent)) return;
    const target = parseIntentTarget(this.readEnv()[INTENT_REVIEW_ENV]);
    if (!target) return;
    this.adopted = true;
    this.begin(agent, target);
  }

  /**
   * Registers a fresh budget for the agent and returns its release. A later `begin` for the same agent replaces
   * this budget, and then this release does nothing, so a stuck earlier turn cannot remove a newer turn's budget.
   */
  begin(agent: string, target: IntentTarget): () => void {
    const token = Symbol(agent);
    this.budgets.set(agent, {
      repo: target.repo, issue: target.issue, ...(target.revision ? { revision: target.revision } : {}),
      verdictsLeft: REVIEW_VERDICTS, attemptsLeft: REVIEW_ATTEMPTS, token, refundsLeft: REVIEW_REFUNDS,
    });
    return () => {
      if (this.budgets.get(agent)?.token === token) this.budgets.delete(agent);
    };
  }

  /** A copy of the agent's current budget, or undefined when none is active. */
  active(agent: string): Budget | undefined {
    const entry = this.budgets.get(agent);
    if (!entry) return undefined;
    const { repo, issue, revision, verdictsLeft, attemptsLeft } = entry;
    return { repo, issue, ...(revision ? { revision } : {}), verdictsLeft, attemptsLeft };
  }

  /**
   * Decides one call. An admitted call counts an attempt and reserves the verdict until it is settled by `commit`
   * (the write succeeded), `release` (it failed) or `refund` (it was a refused duplicate). With no budget
   * everything is admitted.
   */
  admit(agent: string, call: { action: string; repo: string | null; issue: number }): Admit {
    const entry = this.budgets.get(agent);
    if (!entry) return { ok: true };
    if (!ALLOWED_ACTIONS.has(call.action) || call.repo !== entry.repo || call.issue !== entry.issue) {
      return { ok: false, reason: "not-allowed" };
    }
    if (entry.verdictsLeft <= 0) return { ok: false, reason: "verdict-recorded" };
    if (entry.attemptsLeft <= 0) return { ok: false, reason: "attempt-limit" };
    entry.attemptsLeft -= 1;
    entry.verdictsLeft -= 1;
    return { ok: true };
  }

  /** The admitted call's write succeeded: the reservation becomes the recorded verdict. */
  commit(_agent: string): void {
    // Nothing to change: `admit` already took the verdict. Kept so every admitted call ends in exactly one settle.
  }

  /** The admitted call failed without writing: the verdict is free again; the attempt stays spent. */
  release(agent: string): void {
    const entry = this.budgets.get(agent);
    if (entry) entry.verdictsLeft = Math.min(REVIEW_VERDICTS, entry.verdictsLeft + 1);
  }

  /** The admitted call was a refused duplicate: the verdict is free again and, once only, the attempt too. */
  refund(agent: string): void {
    const entry = this.budgets.get(agent);
    if (!entry) return;
    this.release(agent);
    if (entry.refundsLeft > 0) {
      entry.refundsLeft -= 1;
      entry.attemptsLeft = Math.min(REVIEW_ATTEMPTS, entry.attemptsLeft + 1);
    }
  }
}

/** The instance shared by the consumer and the GitHub tool. */
export const reviewBudgets = new ReviewBudgets();
