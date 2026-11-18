import { describe, test } from "bun:test";
import { existsSync } from "node:fs";

// Supported-host integration only. No application bypass or substitute sandbox.
export function hasSeatbeltBinary(platform: string, present: boolean): boolean {
  return platform === "darwin" && present;
}
const available = hasSeatbeltBinary(process.platform, existsSync("/usr/bin/sandbox-exec"));
if (!available) console.warn("Seatbelt integration tests skipped: supported Darwin /usr/bin/sandbox-exec is unavailable; unsupported activation refusal is tested separately.");
export const seatbeltTest = test.skipIf(!available);
export const seatbeltDescribe = describe.skipIf(!available);
