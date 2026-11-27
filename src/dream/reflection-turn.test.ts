import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runReflectionTurn } from "./reflection-turn";
import { extractProposals, writeInbox } from "./inbox";
import type { AgentMemoryStore, AgentMemoryEntry } from "../memory/contract";
import type { Provider, ProviderRequest, ProviderResponse, ProviderToolCall } from "../providers/interface";

let roomDir: string;

beforeEach(() => {
  roomDir = mkdtempSync(join(tmpdir(), "reflection-turn-"));
  mkdirSync(roomDir, { recursive: true });
  writeFileSync(join(roomDir, "SOUL.md"), "- I keep my notes close.\n", "utf-8");
});

afterEach(() => {
  rmSync(roomDir, { recursive: true, force: true });
});

const seededProposals = extractProposals([
  { id: "a", content: "I judge sources before trusting them", tags: ["craft"], confidence: 0.9 },
  { id: "b", content: "I judge sources before trusting them", tags: ["craft"], confidence: 0.85 },
  { id: "c", content: "I judge sources before trusting them", tags: ["craft"], confidence: 0.8 },
]);

function makeMemoryStoreSpy(): { store: AgentMemoryStore; calls: Omit<AgentMemoryEntry, "id" | "createdAt">[] } {
  const calls: Omit<AgentMemoryEntry, "id" | "createdAt">[] = [];
  const store: AgentMemoryStore = {
    async remember(entry) {
      calls.push(entry);
      return { ...entry, id: "fake-id", createdAt: new Date().toISOString() };
    },
    async recall() { return []; },
    async bootstrap() { return []; },
    async forget() {},
  };
  return { store, calls };
}

/** A provider that emits the given tool calls on its first answer, then a final text. */
function scriptedProvider(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  finalText = "kept one, rejected the rest",
  captured: { requests: ProviderRequest[] } = { requests: [] },
): Provider {
  let turn = 0;
  return {
    name: "fake" as Provider["name"],
    async query(req: ProviderRequest): Promise<ProviderResponse> {
      captured.requests.push(req);
      const index = turn++;
      if (index === 0 && calls.length > 0) {
        const tool_calls: ProviderToolCall[] = calls.map((call, i) => ({
          id: `call-${i}`,
          name: call.name,
          arguments: JSON.stringify(call.args),
        }));
        return { message: { role: "assistant", content: null }, tool_calls };
      }
      return { message: { role: "assistant", content: finalText } };
    },
  };
}

test("no inbox means there is nothing to judge: no provider call, no write", async () => {
  const captured = { requests: [] as ProviderRequest[] };
  const result = await runReflectionTurn({
    roomDir,
    agentName: "lena",
    provider: scriptedProvider([], "free reflection", captured),
  });

  expect(result.judged).toBe(false);
  expect(result.touched).toEqual([]);
  expect(captured.requests).toHaveLength(0);
  expect(readdirSync(roomDir).sort()).toEqual(["SOUL.md"]);
});

test("an accepted proposal is written by the agent into its own substrate", async () => {
  await writeInbox(roomDir, "lena", seededProposals);
  const { store, calls } = makeMemoryStoreSpy();

  const result = await runReflectionTurn({
    roomDir,
    agentName: "lena",
    memoryStore: store,
    provider: scriptedProvider([
      { name: "write", args: { path: "VALUES.md", content: "- I judge sources before trusting them\n" } },
    ]),
  });

  expect(result.judged).toBe(true);
  expect(readFileSync(join(roomDir, "VALUES.md"), "utf-8")).toContain("judge sources");
  expect(result.touched).toEqual(["VALUES.md"]);
  // the memory store keeps the audit note, never the model's whole response
  expect(calls).toHaveLength(1);
  expect(calls[0]!.content).toContain("VALUES.md");
  expect(calls[0]!.content).not.toBe("kept one, rejected the rest");
});

test("a rejected proposal never reaches the substrate", async () => {
  await writeInbox(roomDir, "lena", seededProposals);
  const result = await runReflectionTurn({
    roomDir,
    agentName: "lena",
    provider: scriptedProvider([], "rejected: one mention is not a pattern"),
  });

  expect(result.judged).toBe(true);
  expect(result.touched).toEqual([]);
  expect(readdirSync(roomDir).sort()).toEqual(["SOUL.md", "staging"]);
});

test("a write outside the agent's own identity directory is refused", async () => {
  await writeInbox(roomDir, "lena", seededProposals);
  const outside = join(roomDir, "..", "someone-else.md");

  const result = await runReflectionTurn({
    roomDir,
    agentName: "lena",
    provider: scriptedProvider([
      { name: "write", args: { path: outside, content: "not mine to write\n" } },
    ]),
  });

  expect(existsSync(outside)).toBe(false);
  expect(result.refused).toHaveLength(1);
  expect(result.touched).toEqual([]);
});

test("a changed file has a copy from before the change", async () => {
  await writeInbox(roomDir, "lena", seededProposals);
  const before = readFileSync(join(roomDir, "SOUL.md"), "utf-8");

  const result = await runReflectionTurn({
    roomDir,
    agentName: "lena",
    provider: scriptedProvider([
      { name: "edit", args: { path: "SOUL.md", old_string: "keep my notes close", new_string: "keep my notes exact" } },
    ]),
  });

  expect(readFileSync(join(roomDir, "SOUL.md"), "utf-8")).toContain("exact");
  expect(result.backups).toHaveLength(1);
  expect(readFileSync(result.backups[0]!, "utf-8")).toBe(before);
});

test("a failed run leaves no half-applied change", async () => {
  await writeInbox(roomDir, "lena", seededProposals);
  const before = readFileSync(join(roomDir, "SOUL.md"), "utf-8");

  // Second answer throws after the first tool call already changed SOUL.md.
  let turn = 0;
  const failing: Provider = {
    name: "fake" as Provider["name"],
    async query(): Promise<ProviderResponse> {
      if (turn++ === 0) {
        return {
          message: { role: "assistant", content: null },
          tool_calls: [{
            id: "call-0",
            name: "write",
            arguments: JSON.stringify({ path: "SOUL.md", content: "- half applied\n" }),
          }],
        };
      }
      throw new Error("provider went away");
    },
  };

  const result = await runReflectionTurn({ roomDir, agentName: "lena", provider: failing });

  expect(result.error).toBeDefined();
  expect(readFileSync(join(roomDir, "SOUL.md"), "utf-8")).toBe(before);
  expect(result.touched).toEqual([]);
});

test("a symlink inside the room cannot be used to write outside it", async () => {
  await writeInbox(roomDir, "lena", seededProposals);
  const outside = mkdtempSync(join(tmpdir(), "reflection-outside-"));
  try {
    symlinkSync(outside, join(roomDir, "escape"));

    const result = await runReflectionTurn({
      roomDir,
      agentName: "lena",
      provider: scriptedProvider([
        { name: "write", args: { path: "escape/someone-else.md", content: "not mine to write\n" } },
      ]),
    });

    expect(existsSync(join(outside, "someone-else.md"))).toBe(false);
    expect(result.refused).toHaveLength(1);
    expect(result.touched).toEqual([]);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a rollback restores a file whose name contains the backup separator", async () => {
  await writeInbox(roomDir, "lena", seededProposals);
  const name = "notes__draft.md";
  writeFileSync(join(roomDir, name), "- original\n", "utf-8");

  let turn = 0;
  const failing: Provider = {
    name: "fake" as Provider["name"],
    async query(): Promise<ProviderResponse> {
      if (turn++ === 0) {
        return {
          message: { role: "assistant", content: null },
          tool_calls: [{
            id: "call-0",
            name: "write",
            arguments: JSON.stringify({ path: name, content: "- half applied\n" }),
          }],
        };
      }
      throw new Error("provider went away");
    },
  };

  const result = await runReflectionTurn({ roomDir, agentName: "lena", provider: failing });

  expect(result.error).toBeDefined();
  expect(readFileSync(join(roomDir, name), "utf-8")).toBe("- original\n");
  // the rollback must not have written the wrong file into a "notes/draft.md"
  expect(existsSync(join(roomDir, "notes", "draft.md"))).toBe(false);
});
