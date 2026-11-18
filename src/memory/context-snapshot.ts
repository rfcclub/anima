import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function snapshotDir(): string {
  return process.env.ANIMA_SNAPSHOT_DIR ?? join(homedir(), "snapshots");
}

function snapshotPath(agentName: string): string {
  const safeName = agentName.replace(/[^A-Za-z0-9_-]/g, "_");
  return join(snapshotDir(), `${safeName}.snapshot`);
}

export function writeSnapshot(agentName: string, content: string): void {
  const dir = snapshotDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(snapshotPath(agentName), content, "utf8");
}

export function readSnapshot(agentName: string): string | null {
  const path = snapshotPath(agentName);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}
