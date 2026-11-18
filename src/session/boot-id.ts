import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const STORED_PATH = join(process.env.ANIMA_STATE_DIR ?? join(process.cwd(), "state"), "boot-id.txt");

function readBootId(): string {
  return readFileSync(BOOT_ID_PATH, "utf-8").trim();
}

function readStoredBootId(): string | null {
  try {
    if (existsSync(STORED_PATH)) return readFileSync(STORED_PATH, "utf-8").trim();
  } catch {}
  return null;
}

function writeStoredBootId(id: string): void {
  const dir = dirname(STORED_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STORED_PATH, id, "utf-8");
}

export interface BootIdResult {
  isReboot: boolean;
  currentBootId: string;
  previousBootId: string | null;
}

export function detectReboot(): BootIdResult {
  if (process.platform !== "linux") {
    return { isReboot: false, currentBootId: "unknown", previousBootId: null };
  }
  const currentBootId = readBootId();
  const previousBootId = readStoredBootId();
  const isReboot = previousBootId !== null && currentBootId !== previousBootId;
  writeStoredBootId(currentBootId);
  return { isReboot, currentBootId, previousBootId };
}
