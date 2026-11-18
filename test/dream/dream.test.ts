import { beforeEach, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LightNap } from "../../src/dream/light-nap";
import { DeepDream } from "../../src/dream/deep-dream";
import { LucidDream } from "../../src/dream/lucid-dream";
import type { Provider, ProviderRequest, ProviderResponse } from "../../src/providers/interface";

let tempDir: string;
const originalHome = process.env.HOME;
const originalAnimaHome = process.env.ANIMA_HOME;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-dream-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  // Isolate from the real ~/.anima so deep dream fallback doesn't read production neurons
  process.env.HOME = tempDir;
  process.env.ANIMA_HOME = tempDir;
});

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.ANIMA_HOME = originalAnimaHome;
});

/* ------------------------------------------------------------------ */
/*  Light Nap Tests                                                    */
/* ------------------------------------------------------------------ */

test("light nap stores beam on insight keyword", async () => {
  const roomsDir = join(tempDir, "rooms");
  const roomDir = join(roomsDir, "cleo");
  mkdirSync(roomDir, { recursive: true });

  const lightNap = new LightNap();
  await lightNap.run({
    roomDir,
    agentName: "cleo",
    sessionId: "s1",
    sessionEvents: [
      {
        timestamp: new Date().toISOString(),
        type: "user_message",
        sessionId: "s1",
        body: "I discovered a pattern in the data",
      },
    ],
  });

  const date = new Date().toISOString().slice(0, 10);
  const beamPath = join(roomDir, "staging", "beams", `${date}.md`);
  expect(existsSync(beamPath)).toBe(true);

  const content = readFileSync(beamPath, "utf-8");
  expect(content).toContain("discovered");
  expect(content).toContain("cleo");
  expect(content).toContain("s1");
});

test("light nap stores beam on learned keyword", async () => {
  const roomsDir = join(tempDir, "rooms");
  const roomDir = join(roomsDir, "cleo");
  mkdirSync(roomDir, { recursive: true });

  const lightNap = new LightNap();
  await lightNap.run({
    roomDir,
    agentName: "cleo",
    sessionId: "s1",
    sessionEvents: [
      {
        timestamp: new Date().toISOString(),
        type: "user_message",
        sessionId: "s1",
        body: "I learned something important today",
      },
    ],
  });

  const date = new Date().toISOString().slice(0, 10);
  const beamPath = join(roomDir, "staging", "beams", `${date}.md`);
  expect(existsSync(beamPath)).toBe(true);

  const content = readFileSync(beamPath, "utf-8");
  expect(content).toContain("learned");
});

test("light nap never throws on missing staging dir", async () => {
  const lightNap = new LightNap();

  await expect(
    lightNap.run({
      roomDir: join(tempDir, "nonexistent"),
      agentName: "ghost",
      sessionId: "s1",
      sessionEvents: [],
    }),
  ).resolves.toBeUndefined();
});

test("light nap never throws with undefined body", async () => {
  const lightNap = new LightNap();

  await expect(
    lightNap.run({
      roomDir: join(tempDir, "missing"),
      agentName: "test",
      sessionId: "s1",
      sessionEvents: [
        {
          timestamp: new Date().toISOString(),
          type: "user_message",
          sessionId: "s1",
          // no body field
        } as any,
      ],
    }),
  ).resolves.toBeUndefined();
});

test("light nap skips events without matching keywords", async () => {
  const roomDir = join(tempDir, "rooms", "cleo");
  mkdirSync(roomDir, { recursive: true });

  const lightNap = new LightNap();
  await lightNap.run({
    roomDir,
    agentName: "cleo",
    sessionId: "s1",
    sessionEvents: [
      {
        timestamp: new Date().toISOString(),
        type: "user_message",
        sessionId: "s1",
        body: "Just a normal message with no keywords",
      },
    ],
  });

  const date = new Date().toISOString().slice(0, 10);
  const beamPath = join(roomDir, "staging", "beams", `${date}.md`);
  // No beam file should be created
  expect(existsSync(beamPath)).toBe(false);
});

/* ------------------------------------------------------------------ */
/*  Deep Dream Tests                                                   */
/* ------------------------------------------------------------------ */

test("deep dream links cross-agent beams", async () => {
  const roomsDir = join(tempDir, "rooms");
  const date = new Date().toISOString().slice(0, 10);

  // Set up two agents with beam files sharing keywords
  for (const agent of ["cleo", "milo"]) {
    const agentDir = join(roomsDir, agent);
    mkdirSync(join(agentDir, "staging", "beams"), { recursive: true });
    // Also create config.yaml so they're recognized as agents
    writeFileSync(
      join(agentDir, "config.yaml"),
      `identity:\n  name: ${agent}\n  label: ${agent}\n`,
    );

    const beamContent =
      agent === "cleo"
        ? `# Beams — ${date}\n\n## Beam — ${date}T10:00:00.000Z\n- Agent: cleo\n- Session: s1\n- Keywords: insight, pattern\n- Source: user_message\n- Content: I discovered a pattern\n\n`
        : `# Beams — ${date}\n\n## Beam — ${date}T10:00:00.000Z\n- Agent: milo\n- Session: s2\n- Keywords: insight, pattern\n- Source: user_message\n- Content: I realized the pattern too\n\n`;

    writeFileSync(join(agentDir, "staging", "beams", `${date}.md`), beamContent);
  }

  const deepDream = new DeepDream();
  await deepDream.run(roomsDir);

  const dreamPath = join(roomsDir, "staging", "dreams", `${date}.md`);
  expect(existsSync(dreamPath)).toBe(true);

  const content = readFileSync(dreamPath, "utf-8");
  expect(content).toContain("cleo");
  expect(content).toContain("milo");
  expect(content).toContain("Cross-Agent");
  expect(content).toContain("insight");
  expect(content).toContain("pattern");
});

test("deep dream skips agents with no beams", async () => {
  const roomsDir = join(tempDir, "rooms");
  const date = new Date().toISOString().slice(0, 10);

  // One agent with beams, one without
  mkdirSync(join(roomsDir, "cleo", "staging", "beams"), { recursive: true });
  writeFileSync(
    join(roomsDir, "cleo", "config.yaml"),
    "identity:\n  name: cleo\n  label: Cleo\n",
  );
  writeFileSync(
    join(roomsDir, "cleo", "staging", "beams", `${date}.md`),
    `# Beams — ${date}\n\n## Beam — ${date}T10:00:00.000Z\n- Agent: cleo\n- Session: s1\n- Keywords: insight\n- Source: user_message\n- Content: insight found\n\n`,
  );

  mkdirSync(join(roomsDir, "milo"), { recursive: true });
  writeFileSync(
    join(roomsDir, "milo", "config.yaml"),
    "identity:\n  name: milo\n  label: Milo\n",
  );
  // no beams for milo

  const deepDream = new DeepDream();
  await deepDream.run(roomsDir);

  const dreamPath = join(roomsDir, "staging", "dreams", `${date}.md`);
  expect(existsSync(dreamPath)).toBe(true);

  const content = readFileSync(dreamPath, "utf-8");
  expect(content).toContain("cleo");
  // milo has no beams, so should not appear in beam summary
  expect(content).not.toContain("milo");
});

test("deep dream transactional per-agent with crash recovery", async () => {
  const roomsDir = join(tempDir, "rooms");
  const date = new Date().toISOString().slice(0, 10);

  // Set up two agents with beam files
  for (const agent of ["cleo", "milo"]) {
    mkdirSync(join(roomsDir, agent, "staging", "beams"), { recursive: true });
    writeFileSync(
      join(roomsDir, agent, "config.yaml"),
      `identity:\n  name: ${agent}\n  label: Test\n`,
    );
    writeFileSync(
      join(roomsDir, agent, "staging", "beams", `${date}.md`),
      `# Beams — ${date}\n\n## Beam — ${date}T10:00:00.000Z\n- Agent: ${agent}\n- Session: s1\n- Keywords: test\n- Source: user_message\n- Content: a test beam\n\n`,
    );
  }

  // Simulate a crash mid-way: cleo already completed
  const stagingDir = join(roomsDir, "staging");
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(
    join(stagingDir, ".dream-state.json"),
    JSON.stringify({
      startedAt: new Date().toISOString(),
      completedAgents: ["cleo"],
      currentAgent: "",
      crossLinksWritten: false,
    }),
  );

  // Run deep dream — should resume, process milo, then cross-link
  const deepDream = new DeepDream();
  await deepDream.run(roomsDir);

  // Verify dream report contains both agents
  const dreamPath = join(roomsDir, "staging", "dreams", `${date}.md`);
  expect(existsSync(dreamPath)).toBe(true);

  const content = readFileSync(dreamPath, "utf-8");
  expect(content).toContain("cleo");
  expect(content).toContain("milo");
});

test("deep dream starts fresh when previous run completed", async () => {
  const roomsDir = join(tempDir, "rooms");
  const date = new Date().toISOString().slice(0, 10);

  // Set up agent
  mkdirSync(join(roomsDir, "cleo", "staging", "beams"), { recursive: true });
  writeFileSync(
    join(roomsDir, "cleo", "config.yaml"),
    "identity:\n  name: cleo\n  label: Cleo\n",
  );
  writeFileSync(
    join(roomsDir, "cleo", "staging", "beams", `${date}.md`),
    `# Beams — ${date}\n\n## Beam — ${date}T10:00:00.000Z\n- Agent: cleo\n- Session: s1\n- Keywords: insight\n- Source: user_message\n- Content: fresh insight\n\n`,
  );

  // State file says previous run completed
  const stagingDir = join(roomsDir, "staging");
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(
    join(stagingDir, ".dream-state.json"),
    JSON.stringify({
      completed: true,
      completedAt: new Date().toISOString(),
    }),
  );

  const deepDream = new DeepDream();
  await deepDream.run(roomsDir);

  const dreamPath = join(roomsDir, "staging", "dreams", `${date}.md`);
  expect(existsSync(dreamPath)).toBe(true);

  const content = readFileSync(dreamPath, "utf-8");
  expect(content).toContain("fresh insight");
});

/* ------------------------------------------------------------------ */
/*  Lucid Dream Tests                                                  */
/* ------------------------------------------------------------------ */

test("lucid dream builds correct reflection prompt with beams", async () => {
  const roomsDir = join(tempDir, "rooms");
  const roomDir = join(roomsDir, "cleo");
  const beamsDir = join(roomDir, "staging", "beams");
  mkdirSync(beamsDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(beamsDir, `${date}.md`),
    `# Beams — ${date}\n\n## Beam — ${date}T10:00:00.000Z\n- Agent: cleo\n- Session: s1\n- Keywords: insight\n- Source: user_message\n- Content: I had an insight\n\n`,
  );

  const lucidDream = new LucidDream();
  let capturedRequest: ProviderRequest | undefined;

  const mockProvider: Provider = {
    name: "test",
    query: async (req: ProviderRequest) => {
      capturedRequest = req;
      return { message: { role: "assistant", content: "reflection text" } };
    },
  };

  const result = await lucidDream.run({
    roomDir,
    roomsDir,
    agentName: "cleo",
    provider: mockProvider,
    userPrompt: "reflect on today",
  });

  expect(capturedRequest).toBeDefined();
  const userMsg = capturedRequest!.messages[0].content as string;
  expect(userMsg).toContain("reflect on today");
  expect(userMsg).toContain("insight");
  expect(capturedRequest!.agent).toBe("cleo");
  expect(result.response).toBe("reflection text");
});

test("lucid dream works without user prompt", async () => {
  const roomsDir = join(tempDir, "rooms");
  const roomDir = join(roomsDir, "cleo");
  mkdirSync(roomDir, { recursive: true });

  const lucidDream = new LucidDream();
  let capturedRequest: ProviderRequest | undefined;

  const mockProvider: Provider = {
    name: "test",
    query: async (req: ProviderRequest) => {
      capturedRequest = req;
      return { message: { role: "assistant", content: "autonomous reflection" } };
    },
  };

  const result = await lucidDream.run({
    roomDir,
    roomsDir,
    agentName: "cleo",
    provider: mockProvider,
  });

  expect(capturedRequest).toBeDefined();
  const userMsg = capturedRequest!.messages[0].content as string;
  expect(userMsg).toContain("lucid dream state");
  expect(userMsg).toContain("cleo");
  expect(result.response).toBe("autonomous reflection");
});

test("lucid dream stores result file", async () => {
  const roomsDir = join(tempDir, "rooms");
  const roomDir = join(roomsDir, "cleo");
  mkdirSync(roomDir, { recursive: true });

  const lucidDream = new LucidDream();

  const mockProvider: Provider = {
    name: "test",
    query: async () => {
      return { message: { role: "assistant", content: "stored reflection" } };
    },
  };

  const result = await lucidDream.run({
    roomDir,
    roomsDir,
    agentName: "cleo",
    provider: mockProvider,
    userPrompt: "test prompt",
  });

  expect(result.storedAt).toBeDefined();
  expect(existsSync(result.storedAt)).toBe(true);

  const content = readFileSync(result.storedAt, "utf-8");
  expect(content).toContain("Lucid Dream");
  expect(content).toContain("cleo");
  expect(content).toContain("stored reflection");
});
