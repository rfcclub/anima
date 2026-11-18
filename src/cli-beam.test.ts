import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beamCommand } from "./cli";
import { parseBeamEntries } from "./dream/light-nap";

let dir: string;
let originalAnimaHome: string | undefined;
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-beam-"));
  originalAnimaHome = process.env.ANIMA_HOME;
  // Bun ignores assignment of undefined after status1; default success is 0.
  originalExitCode = process.exitCode ?? 0;
  process.env.ANIMA_HOME = dir;
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } finally {
    if (originalAnimaHome === undefined) delete process.env.ANIMA_HOME;
    else process.env.ANIMA_HOME = originalAnimaHome;
    process.exitCode = originalExitCode;
  }
});

test("beamCommand writes a beam file under the agent's room dir", async () => {
  await beamCommand({
    positional: ["lena"],
    flags: { content: "Trust compounds faster than it decays.", source: "mesh-talk" },
  });

  const today = new Date().toISOString().slice(0, 10);
  const filePath = join(dir, "rooms", "lena", "staging", "beams", `${today}.md`);
  const parsed = parseBeamEntries(readFileSync(filePath, "utf-8"));

  expect(parsed).toHaveLength(1);
  expect(parsed[0].agent).toBe("lena");
  expect(parsed[0].source).toBe("mesh-talk");
  expect(parsed[0].content).toContain("Trust compounds faster than it decays.");
});

test("beamCommand defaults keywords to the source when --keywords is omitted", async () => {
  await beamCommand({
    positional: ["lena"],
    flags: { content: "Something worth keeping.", source: "mesh-talk" },
  });

  const today = new Date().toISOString().slice(0, 10);
  const filePath = join(dir, "rooms", "lena", "staging", "beams", `${today}.md`);
  const parsed = parseBeamEntries(readFileSync(filePath, "utf-8"));
  expect(parsed[0].keywords).toEqual(["mesh-talk"]);
});

test("beamCommand splits comma-separated --keywords", async () => {
  await beamCommand({
    positional: ["lena"],
    flags: { content: "Something worth keeping.", source: "mesh-talk", keywords: "trust, decay" },
  });

  const today = new Date().toISOString().slice(0, 10);
  const filePath = join(dir, "rooms", "lena", "staging", "beams", `${today}.md`);
  const parsed = parseBeamEntries(readFileSync(filePath, "utf-8"));
  expect(parsed[0].keywords).toEqual(["trust", "decay"]);
});

test("beamCommand skips writing when --content is empty or whitespace-only", async () => {
  await beamCommand({
    positional: ["lena"],
    flags: { content: "   ", source: "mesh-talk" },
  });
  expect(process.exitCode).toBe(1);

  const today = new Date().toISOString().slice(0, 10);
  const filePath = join(dir, "rooms", "lena", "staging", "beams", `${today}.md`);
  expect(() => readFileSync(filePath, "utf-8")).toThrow();
});

test("beamCommand skips writing when the agent name is missing", async () => {
  await beamCommand({
    positional: [],
    flags: { content: "Something.", source: "mesh-talk" },
  });
  expect(process.exitCode).toBe(1);
  // No agent dir should have been created at all under rooms/.
  const roomsPath = join(dir, "rooms");
  const { existsSync } = await import("node:fs");
  expect(existsSync(roomsPath)).toBe(false);
});
