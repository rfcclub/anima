import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type StagingKind = "beam" | "wound" | "dream";
export type StagingStatus = "pending" | "merged" | "rejected";

export interface StagingEntry {
  kind: StagingKind;
  filename: string;
  content: string;
  status: StagingStatus;
}

export interface StagingSummary {
  beams: number;
  wounds: number;
  dreams: number;
  pendingMerges: number;
}

export class StagingManager {
  async write(roomDir: string, kind: StagingKind, content: string, date?: string): Promise<string> {
    const stagingDir = join(roomDir, "staging", kind === "beam" ? "beams" : kind === "wound" ? "wounds" : "dreams");
    await mkdir(stagingDir, { recursive: true });

    const dateStr = date ?? new Date().toISOString().slice(0, 10);
    const filename = `${dateStr}.md`;
    const filePath = join(stagingDir, filename);

    const existing = existsSync(filePath) ? await readFile(filePath, "utf-8") : "";
    const timestamp = new Date().toISOString();
    const entry = `\n---\n## ${timestamp}\n${content}\n`;
    await writeFile(filePath, existing + entry, "utf-8");

    return filePath;
  }

  async writeBeam(roomDir: string, content: string): Promise<string> {
    return this.write(roomDir, "beam", content);
  }

  async writeWound(roomDir: string, type: string, description: string): Promise<string> {
    return this.write(roomDir, "wound", `**Type:** ${type}\n${description}`);
  }

  async list(roomDir: string, kind: StagingKind): Promise<StagingEntry[]> {
    const stagingDir = join(roomDir, "staging", kind === "beam" ? "beams" : kind === "wound" ? "wounds" : "dreams");
    if (!existsSync(stagingDir)) return [];

    const entries: StagingEntry[] = [];
    const { readdir } = await import("node:fs/promises");
    try {
      const files = await readdir(stagingDir);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const content = await readFile(join(stagingDir, file), "utf-8");
        entries.push({
          kind,
          filename: file,
          content,
          status: "pending",
        });
      }
    } catch {
      // directory may not exist yet
    }

    return entries.sort((a, b) => b.filename.localeCompare(a.filename));
  }

  async summary(roomDir: string): Promise<StagingSummary> {
    const beams = await this.list(roomDir, "beam");
    const wounds = await this.list(roomDir, "wound");
    const dreams = await this.list(roomDir, "dream");

    return {
      beams: beams.length,
      wounds: wounds.length,
      dreams: dreams.length,
      pendingMerges: beams.filter((b) => b.status === "pending").length + wounds.filter((w) => w.status === "pending").length,
    };
  }

  async hasPending(roomDir: string): Promise<boolean> {
    const s = await this.summary(roomDir);
    return s.pendingMerges > 0;
  }
}
