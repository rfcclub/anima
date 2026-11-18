import { mkdir, readFile, writeFile, copyFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StagingKind, StagingEntry, StagingManager } from "./staging";

export interface MergeRequest {
  stagingEntry: StagingEntry;
  targetPath: string;
  confidence: number;
  kind: StagingKind;
}

export interface MergeResult {
  merged: MergeRequest[];
  pending: MergeRequest[];
  failed: MergeRequest[];
  backedUp: string[];
}

export interface MergeOptions {
  autoThreshold: number;
  backupDir: string;
}

const DEFAULT_MERGE_OPTIONS: MergeOptions = {
  autoThreshold: 0.85,
  backupDir: ".continuity-backup",
};

export class MergeManager {
  private readonly stagingManager: StagingManager;
  private readonly options: MergeOptions;

  constructor(stagingManager: StagingManager, options?: Partial<MergeOptions>) {
    this.stagingManager = stagingManager;
    this.options = { ...DEFAULT_MERGE_OPTIONS, ...options };
  }

  needsApproval(confidence: number): boolean {
    return confidence < this.options.autoThreshold;
  }

  async merge(request: MergeRequest, roomDir: string): Promise<{ merged: boolean; reason: string }> {
    const backupDir = join(roomDir, this.options.backupDir);
    await mkdir(backupDir, { recursive: true });

    const targetFullPath = join(roomDir, "mount", request.targetPath);

    // Backup existing file
    if (existsSync(targetFullPath)) {
      const backupPath = join(backupDir, `${request.targetPath.replace(/\//g, "_")}.${Date.now()}.bak`);
      await copyFile(targetFullPath, backupPath);
    }

    // Auto-merge if confidence is high enough
    if (!this.needsApproval(request.confidence)) {
      try {
        await this.applyMerge(request, targetFullPath, roomDir);
        return { merged: true, reason: `auto-merged at confidence ${request.confidence}` };
      } catch (err) {
        return { merged: false, reason: `merge failed: ${String(err)}` };
      }
    }

    return { merged: false, reason: `pending approval: confidence ${request.confidence} < threshold ${this.options.autoThreshold}` };
  }

  private async applyMerge(request: MergeRequest, targetPath: string, roomDir: string): Promise<void> {
    const dir = join(targetPath, "..");
    await mkdir(dir, { recursive: true });

    if (request.kind === "beam") {
      const existing = existsSync(targetPath) ? await readFile(targetPath, "utf-8") : "";
      const merged = `${existing}\n<!-- merged beam: ${request.stagingEntry.filename} -->\n${request.stagingEntry.content}\n`;
      await writeFile(targetPath, merged, "utf-8");
    } else if (request.kind === "wound") {
      // Wounds don't auto-merge into substrate; they go to review
      await writeFile(join(roomDir, "staging", "wounds", `review-${request.stagingEntry.filename}`), request.stagingEntry.content, "utf-8");
    }
  }

  async restoreBackup(roomDir: string, targetPath: string, timestamp: number): Promise<void> {
    const backupDir = join(roomDir, this.options.backupDir);
    const backupFilename = `${targetPath.replace(/\//g, "_")}.${timestamp}.bak`;
    const backupPath = join(backupDir, backupFilename);

    if (!existsSync(backupPath)) {
      throw new Error(`backup not found: ${backupFilename}`);
    }

    const targetFullPath = join(roomDir, "mount", targetPath);
    await copyFile(backupPath, targetFullPath);
  }

  async pendingApprovals(roomDir: string): Promise<MergeRequest[]> {
    const beams = await this.stagingManager.list(roomDir, "beam");
    const wounds = await this.stagingManager.list(roomDir, "wound");

    const requests: MergeRequest[] = [];
    for (const entry of [...beams, ...wounds]) {
      if (entry.status !== "pending") continue;
      const confidence = this.estimateConfidence(entry);
      if (this.needsApproval(confidence)) {
        requests.push({
          stagingEntry: entry,
          targetPath: entry.kind === "beam" ? "BEAMS.md" : "WOUNDS.md",
          confidence,
          kind: entry.kind,
        });
      }
    }
    return requests;
  }

  private estimateConfidence(entry: StagingEntry): number {
    if (entry.kind === "beam") return 0.7;
    return 0.5;
  }
}
