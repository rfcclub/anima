import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TrustSystem, type TrustDomain, TRUST_DOMAINS } from "./trust-system";
import { guardAgentId } from "../utils/path-guard";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REVIEW_EXPIRY_MS = 48 * 60 * 60 * 1000; // 48 hours

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewQueueItem {
  /** Composite id: "{agentId}/{timestamp}" */
  id: string;
  agentId: string;
  timestamp: string;
  domain: string;
  output: string;
  summary: string;
  report: {
    confidence: number;
    flags: string[];
    rationale: string;
    testsRun: string[];
  };
}

export interface EscalationSystemOptions {
  roomsDir?: string;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// EscalationSystem
// ---------------------------------------------------------------------------

/**
 * Manages the review queue lifecycle: listing, approving, rejecting, and
 * automatic expiry of held outputs.
 *
 * Review queue entries live at `rooms/{agent}/review_queue/{timestamp}.json`
 * and expire 48 hours after creation.
 */
export class EscalationSystem {
  private readonly roomsDir: string;
  private readonly now: () => Date;
  private readonly trustSystem: TrustSystem;

  constructor(options: EscalationSystemOptions = {}) {
    this.roomsDir = options.roomsDir ?? join(process.cwd(), "rooms");
    this.now = options.now ?? (() => new Date());
    this.trustSystem = new TrustSystem({
      roomsDir: this.roomsDir,
      now: this.now,
    });
  }

  // -----------------------------------------------------------------------
  // Task 9.5: Auto-cleanup — expired entries are discarded on every read
  // -----------------------------------------------------------------------

  /**
   * List all pending review queue items across all agents.
   * Expired entries (>= 48h old) are automatically removed.
   */
  async list(): Promise<ReviewQueueItem[]> {
    if (!existsSync(this.roomsDir)) return [];

    const items: ReviewQueueItem[] = [];
    const agentDirs = await readdir(this.roomsDir, { withFileTypes: true });

    for (const dirent of agentDirs) {
      if (!dirent.isDirectory()) continue;
      const agentId = dirent.name;
      await this.cleanExpiredForAgent(agentId);

      const queueDir = this.queuePath(agentId);
      if (!existsSync(queueDir)) continue;

      const files = await readdir(queueDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const entry = await this.loadEntry(agentId, file);
        if (entry) items.push(entry);
      }
    }

    return items.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  }

  /**
   * Load a single review queue entry by composite id ("agentId/timestamp").
   * Returns null if not found or expired.
   */
  async get(id: string): Promise<ReviewQueueItem | null> {
    const slashIdx = id.indexOf("/");
    if (slashIdx === -1) return null;

    const agentId = id.slice(0, slashIdx);
    const timestamp = id.slice(slashIdx + 1);
    guardAgentId(agentId);

    // Clean expired entries for this agent first
    await this.cleanExpiredForAgent(agentId);

    const filePath = join(this.queuePath(agentId), `${timestamp}.json`);
    if (!existsSync(filePath)) return null;

    try {
      const content = await readFile(filePath, "utf-8");
      const data = JSON.parse(content);
      return {
        id,
        agentId,
        timestamp: data.timestamp,
        domain: data.domain,
        output: data.output,
        summary: (data.output || "").slice(0, 120).replace(/\n/g, " "),
        report: data.report,
      };
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Task 9.2: Approve — confirm trust, apply held action, remove from queue
  // -----------------------------------------------------------------------

  /**
   * Approve a held review entry.
   * - Confirms trust for the agent+domain
   * - Removes the entry from the queue
   * Returns the trust domain that was confirmed, or null if the entry
   * does not exist.
   */
  async approve(id: string): Promise<{ agentId: string; domain: TrustDomain } | null> {
    const entry = await this.get(id);
    if (!entry) return null;

    const domain = this.asTrustDomain(entry.domain);
    await this.trustSystem.confirm(entry.agentId, domain);
    await this.removeEntry(id);

    return { agentId: entry.agentId, domain };
  }

  // -----------------------------------------------------------------------
  // Task 9.3: Reject — penalize trust, log feedback, remove from queue
  // -----------------------------------------------------------------------

  /**
   * Reject a held review entry with feedback.
   * - Penalizes trust for the agent+domain
   * - Logs the rejection to the learning store (rooms/{agent}/rejected/)
   * - Removes the entry from the queue
   * Returns the trust domain that was penalized, or null if the entry
   * does not exist.
   */
  async reject(id: string, feedback: string): Promise<{ agentId: string; domain: TrustDomain } | null> {
    const entry = await this.get(id);
    if (!entry) return null;

    const domain = this.asTrustDomain(entry.domain);
    await this.trustSystem.penalize(entry.agentId, domain);
    await this.logRejection(entry, feedback);
    await this.removeEntry(id);

    return { agentId: entry.agentId, domain };
  }

  // -----------------------------------------------------------------------
  // Task 9.4: Escalation notification
  // -----------------------------------------------------------------------

  /**
   * Build a Telegram notification message for when output is escalated
   * (held for human review).
   */
  buildNotification(agentId: string, domain: string, entryId: string): string {
    return `⚠️ ${agentId} held output for review [domain: ${domain}] — /review (use /approve ${entryId} or /reject ${entryId})`;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private queuePath(agentId: string): string {
    guardAgentId(agentId);
    return join(this.roomsDir, agentId, "review_queue");
  }

  private async cleanExpiredForAgent(agentId: string): Promise<number> {
    const queueDir = this.queuePath(agentId);
    if (!existsSync(queueDir)) return 0;

    let cleaned = 0;
    const now = this.now().getTime();
    const files = await readdir(queueDir);

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = join(queueDir, file);

      try {
        const content = await readFile(filePath, "utf-8");
        const data = JSON.parse(content);
        const entryTime = new Date(data.timestamp).getTime();
        if (now - entryTime >= REVIEW_EXPIRY_MS) {
          await unlink(filePath);
          cleaned++;
        }
      } catch {
        // Skip corrupt entries
        continue;
      }
    }

    return cleaned;
  }

  private async loadEntry(agentId: string, filename: string): Promise<ReviewQueueItem | null> {
    const queueDir = this.queuePath(agentId);
    const filePath = join(queueDir, filename);
    const id = `${agentId}/${filename.replace(".json", "")}`;

    try {
      const content = await readFile(filePath, "utf-8");
      const data = JSON.parse(content);
      return {
        id,
        agentId,
        timestamp: data.timestamp,
        domain: data.domain,
        output: data.output,
        summary: (data.output || "").slice(0, 120).replace(/\n/g, " "),
        report: data.report,
      };
    } catch {
      return null;
    }
  }

  private async removeEntry(id: string): Promise<boolean> {
    const slashIdx = id.indexOf("/");
    if (slashIdx === -1) return false;

    const agentId = id.slice(0, slashIdx);
    const timestamp = id.slice(slashIdx + 1);
    guardAgentId(agentId);
    const filePath = join(this.queuePath(agentId), `${timestamp}.json`);

    if (!existsSync(filePath)) return false;
    await unlink(filePath);
    return true;
  }

  private async logRejection(entry: ReviewQueueItem, feedback: string): Promise<void> {
    const rejectedDir = join(this.roomsDir, entry.agentId, "rejected");
    await mkdir(rejectedDir, { recursive: true });

    const logEntry = {
      timestamp: this.now().toISOString(),
      originalTimestamp: entry.timestamp,
      domain: entry.domain,
      feedback,
      output: entry.output,
    };

    const filename = `rejected-${Date.now()}.json`;
    await writeFile(
      join(rejectedDir, filename),
      JSON.stringify(logEntry, null, 2) + "\n",
      "utf-8",
    );
  }

  private asTrustDomain(domain: string): TrustDomain {
    if (TRUST_DOMAINS.includes(domain as TrustDomain)) {
      return domain as TrustDomain;
    }
    // Map review domain names to trust domain names
    const map: Record<string, TrustDomain> = {
      code: "code_review",
      memory: "memory_write",
      communication: "communication",
      architecture: "architecture",
      external_action: "external_action",
      private_mode: "private_mode",
    };
    return map[domain] ?? "communication";
  }
}
