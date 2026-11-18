import { expect, test } from "bun:test";
import { createLog } from "./log.ts";
import type { Fs } from "./types.ts";

class MemoryFs implements Fs {
  value = "";
  read(path: string): string | undefined { return path === "watchdog.log" && this.value ? this.value : undefined; }
  write(_path: string, data: string): void { this.value = data; }
  rename(): void { throw new Error("unexpected rename"); }
  chmod(): void {}
  stat(): { size: number } | undefined { return this.value ? { size: this.value.length } : undefined; }
  mkdir(): void {}
  readdir(): string[] { return []; }
  size(): number { return this.value.length; }
}

test("SC-032: log rotation discards old entries and keeps the newest half", () => {
  const fs = new MemoryFs(); const log = createLog(fs, "watchdog.log", 300);
  for (let i = 0; i < 8; i++) log.write({ level: "info", msg: `entry-${i}` });
  const lines = fs.value.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(lines.at(-1)?.msg).toBe("entry-7");
  expect(lines.some((line) => line.msg === "entry-0")).toBe(false);
  expect(fs.value.length).toBeLessThanOrEqual(300);
});

test("SC-032: fields outside the fixed whitelist are dropped", () => {
  const fs = new MemoryFs(); createLog(fs, "watchdog.log", 1000).write({ level: "warn", msg: "safe", secret: "do-not-write" });
  const line = JSON.parse(fs.value) as Record<string, unknown>;
  expect(line).toHaveProperty("ts");
  expect(line).toHaveProperty("msg", "safe");
  expect(line).not.toHaveProperty("secret");
});

const sizeOf = (value: string) => new TextEncoder().encode(value).byteLength;

test("SC-032: unequal entries still end within the byte bound", () => {
  const fs = new MemoryFs(); const log = createLog(fs, "watchdog.log", 1000);
  for (let i = 0; i < 8; i++) log.write({ ts: "t", msg: "short" });
  log.write({ ts: "t", msg: "x".repeat(2000) });
  log.write({ ts: "t", msg: "short" });
  expect(sizeOf(fs.value)).toBeLessThanOrEqual(1000);
  expect(fs.value.trim().split("\n").at(-1)).toContain('"short"');
});

test("SC-032: multibyte entries are measured in bytes", () => {
  const fs = new MemoryFs(); const log = createLog(fs, "watchdog.log", 400);
  for (let i = 0; i < 10; i++) log.write({ ts: "t", msg: "\u1ec7".repeat(30) });
  expect(sizeOf(fs.value)).toBeLessThanOrEqual(400);
  expect(fs.value.trim().split("\n").every((l) => { JSON.parse(l); return true; })).toBe(true);
});

test("SC-032: a single oversized newest entry is cut to fit, not dropped", () => {
  const fs = new MemoryFs(); const log = createLog(fs, "watchdog.log", 256);
  log.write({ ts: "t", level: "error", msg: "y".repeat(5000), reason: "why" });
  const line = JSON.parse(fs.value) as Record<string, unknown>;
  expect(sizeOf(fs.value)).toBeLessThanOrEqual(256);
  expect(line.level).toBe("error");
  expect(line.reason).toBe("why");
  expect(String(line.msg).length).toBeGreaterThan(0);
});

test("SC-032: cutting never leaves half of a surrogate pair", () => {
  const fs = new MemoryFs(); const log = createLog(fs, "watchdog.log", 256);
  log.write({ ts: "t", msg: "😀".repeat(100) });
  expect(() => JSON.parse(fs.value)).not.toThrow();
  expect(fs.value).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  expect(sizeOf(fs.value)).toBeLessThanOrEqual(256);
});

test("SC-032: an object-valued field cannot defeat the byte bound", () => {
  const fs = new MemoryFs(); const log = createLog(fs, "watchdog.log", 300);
  log.write({ msg: { big: "z".repeat(5000) }, reason: "r" });
  expect(sizeOf(fs.value)).toBeLessThanOrEqual(300);
  expect(typeof (JSON.parse(fs.value) as Record<string, unknown>).msg).toBe("string");
});

test("SC-032: an oversized or non-string timestamp is replaced", () => {
  const fs = new MemoryFs(); const log = createLog(fs, "watchdog.log", 256);
  log.write({ ts: "t".repeat(5000), msg: "m" });
  log.write({ ts: { x: 1 }, msg: "n" });
  expect(sizeOf(fs.value)).toBeLessThanOrEqual(256);
  for (const line of fs.value.trim().split("\n")) expect(String((JSON.parse(line) as { ts: unknown }).ts).length).toBeLessThanOrEqual(40);
});

test("SC-032: a limit too small for a minimal entry is refused", () => {
  expect(() => createLog(new MemoryFs(), "watchdog.log", 1)).toThrow(/at least/);
  expect(() => createLog(new MemoryFs(), "watchdog.log", 255)).toThrow(/at least/);
});

test("SC-032: a 40-emoji timestamp (160 bytes) is replaced, not trusted", () => {
  const fs = new MemoryFs(); const log = createLog(fs, "watchdog.log", 256);
  log.write({ ts: "😀".repeat(40), msg: "m" });
  expect(sizeOf(fs.value)).toBeLessThanOrEqual(256);
  expect(String((JSON.parse(fs.value) as { ts: string }).ts)).toMatch(/^\d{4}-/);
});

test("SC-032: every field filled with the largest values still fits the smallest limit", () => {
  const fs = new MemoryFs(); const log = createLog(fs, "watchdog.log", 256);
  const big = { a: "\u00e9".repeat(500) };
  log.write({ level: big, msg: big, check: 1.7976931348623157e308, subject: big, status: true, reason: big, incident: null, action: -1e-300 });
  expect(sizeOf(fs.value)).toBeLessThanOrEqual(256);
});

test("SC-032: a small overflow still rewrites the log with the newest half of its lines", () => {
  const fs = new MemoryFs();
  const probe = createLog(fs, "watchdog.log", 100000);
  for (let i = 0; i < 10; i++) probe.write({ ts: "2026-11-11T00:00:00.000Z", msg: `entry-${i}` });
  const lineBytes = sizeOf(fs.value.split("\n")[0] + "\n");
  fs.value = fs.value; // keep the ten lines
  const log = createLog(fs, "watchdog.log", lineBytes * 10 + 1); // the eleventh line overflows by a little
  log.write({ ts: "2026-11-11T00:00:00.000Z", msg: "entry-10" });
  const msgs = fs.value.trim().split("\n").map((l) => (JSON.parse(l) as { msg: string }).msg);
  expect(msgs.at(-1)).toBe("entry-10");
  expect(msgs.length).toBe(5); // floor(11 / 2)
  expect(msgs[0]).toBe("entry-6");
});
