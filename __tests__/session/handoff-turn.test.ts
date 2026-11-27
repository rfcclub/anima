import { test, expect, describe, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadedAgent } from "../../src/agents/loader";
import { HANDOFF_PROMPT, handoffArchiveDir, readHandoff } from "../../src/session/handoff";
import { createHandoffTurn } from "../../src/session/handoff-turn";

const rooms: string[] = [];
afterEach(() => {
  for (const room of rooms.splice(0)) rmSync(room, { recursive: true, force: true });
});

function makeRoom() {
  const room = mkdtempSync(join(tmpdir(), "handoff-turn-"));
  rooms.push(room);
  return room;
}

function fakeAgent(roomDir: string): LoadedAgent {
  return { name: "bruno", label: "Bruno", roomDir } as LoadedAgent;
}

const session = { id: "session-1" } as Parameters<ReturnType<typeof createHandoffTurn>>[1];

describe("the handoff turn before a reset", () => {
  test("runs one turn with the handoff prompt and archives the version it replaces", async () => {
    const room = makeRoom();
    writeFileSync(join(room, "HANDOFF.md"), "yesterday's note");
    const prompts: string[] = [];

    const turn = createHandoffTurn({
      loadAgent: async () => fakeAgent(room),
      runTurn: async (_agent, sessionId, message) => {
        prompts.push(message);
        expect(sessionId).toBe("session-1");
        writeFileSync(join(room, "HANDOFF.md"), "tonight's note");
      },
      now: () => new Date("2026-01-02T00:00:00Z"),
    });

    expect(await turn("bruno", session)).toBe(true);
    expect(prompts).toEqual([HANDOFF_PROMPT]);
    expect(await readHandoff(room)).toBe("tonight's note");
    const copies = readdirSync(handoffArchiveDir(room));
    expect(copies.length).toBe(1);
    expect(copies[0]).toContain("2026-01-02");
  });

  test("reports nothing written when the agent leaves no handoff", async () => {
    const room = makeRoom();
    const turn = createHandoffTurn({
      loadAgent: async () => fakeAgent(room),
      runTurn: async () => {},
    });
    expect(await turn("bruno", session)).toBe(false);
    expect(await readHandoff(room)).toBeUndefined();
  });

  test("an unchanged handoff is not archived again", async () => {
    const room = makeRoom();
    writeFileSync(join(room, "HANDOFF.md"), "the same note");
    const turn = createHandoffTurn({
      loadAgent: async () => fakeAgent(room),
      runTurn: async () => {},
      now: () => new Date("2026-01-02T00:00:00Z"),
    });
    expect(await turn("bruno", session)).toBe(true);
    const archive = handoffArchiveDir(room);
    expect(existsSync(archive) ? readdirSync(archive).length : 0).toBe(0);
  });
});
