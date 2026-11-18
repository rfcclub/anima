import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSystemPrompt } from "../src/agents/prompter";
import type { LoadedAgent } from "../src/agents/loader";
import { NullMemoryAdapter } from "../src/memory/null-adapter";

let tempDir: string;
let animaHome: string;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(async () => {
  tempDir = join(tmpdir(), `anima-cli-memory-${crypto.randomUUID()}`);
  animaHome = join(tempDir, ".anima");
  await mkdir(join(tempDir, "rooms", "eli", "mount"), { recursive: true });
  await mkdir(join(tempDir, "rooms", "eli", "staging"), { recursive: true });
  await Bun.write(join(tempDir, "rooms", "eli", "mount", "PREFACE.md"), "You are Eli.\n");
  await Bun.write(join(tempDir, "rooms", "eli", "mount", "AGENTS.md"), "Session instructions.\n");
  await Bun.write(join(tempDir, "rooms", "eli", "config.yaml"), roomConfig());
});

afterEach(async () => {
  server?.stop(true);
  server = undefined;
  await rm(tempDir, { recursive: true, force: true });
});

test("memory recall is dynamic and does not alter static prompt prefix", () => {
  const agent = testAgent();
  const withoutRecall = buildSystemPrompt(agent);
  const withRecall = buildSystemPrompt(agent, {
    memoryRecall: ["The user wants evidence before claims."],
  });

  expect(withRecall.dynamicSuffix).toContain("## Memory Recall");
  expect(withRecall.dynamicSuffix).toContain("The user wants evidence before claims.");
  expect(withRecall.staticPrefix).toBe(withoutRecall.staticPrefix);
  expect(withRecall.staticHash).toBe(withoutRecall.staticHash);
  expect(withRecall.staticPrefix).not.toContain("The user wants evidence before claims.");
});

test("anima talk includes memory recall before provider request", async () => {
  await writeProviderConfig();
  await Bun.write(join(tempDir, "rooms", "eli", "memory-adapter.js"), `
export default {
  async store() {},
  async recall(query, opts) {
    return [{
      namespace: opts?.namespace ?? "eli",
      content: "remembered garden boundary: Garden Hub is control plane",
      type: "fact",
      timestamp: "2026-06-29T00:00:00.000Z",
    }];
  },
};
`);

  let capturedSystem = "";
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json() as { messages: Array<{ role: string; content: string }> };
      capturedSystem = body.messages.find((message) => message.role === "system")?.content ?? "";
      return Response.json({
        choices: [{ message: { role: "assistant", content: "ok" } }],
      });
    },
  });
  await writeProviderConfig(`http://127.0.0.1:${server.port}/v1`);

  const result = await runCli(["talk", "eli", "what is garden?", "--provider", "test-openai"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("ok");
  expect(capturedSystem).toContain("## Memory Recall");
  expect(capturedSystem).toContain("remembered garden boundary");
});

test("anima talk completes when memory source is absent", async () => {
  let capturedSystem = "";
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json() as { messages: Array<{ role: string; content: string }> };
      capturedSystem = body.messages.find((message) => message.role === "system")?.content ?? "";
      return Response.json({
        choices: [{ message: { role: "assistant", content: "no memory ok" } }],
      });
    },
  });
  await writeProviderConfig(`http://127.0.0.1:${server.port}/v1`);

  const result = await runCli(["talk", "eli", "hello", "--provider", "test-openai"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("no memory ok");
  expect(capturedSystem).not.toContain("remembered garden boundary");
});

async function writeProviderConfig(baseUrl = "http://127.0.0.1:1/v1"): Promise<void> {
  await mkdir(join(animaHome, "providers.d"), { recursive: true });
  await Bun.write(join(animaHome, "providers.d", "test-openai.yaml"), [
    "id: test-openai",
    "label: Test OpenAI",
    `baseUrl: ${baseUrl}`,
    "api: openai-completions",
    "apiKey: test-key",
    "models:",
    "  - id: test-model",
    "",
  ].join("\n"));
}

function roomConfig(): string {
  return [
    "identity:",
    "  name: eli",
    "  label: Eli",
    "provider:",
    "  type: test-openai",
    "  model: test-model",
    "policy:",
    `  allowedRoots: ["${join(tempDir, "rooms", "eli", "staging")}"]`,
    `  readOnlyRoots: ["${join(tempDir, "rooms", "eli", "mount")}"]`,
    "session:",
    "  defaultMode: plan",
    "  autoModeOptIn: false",
    "  compactThreshold: 60000",
    "memory:",
    "  topK: 3",
    "boot:",
    "  gene: mount/PREFACE.md",
    "  soul: mount/PREFACE.md",
    "  sessionContext:",
    "    - path: mount/AGENTS.md",
    "",
  ].join("\n");
}

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["bun", join(process.cwd(), "src", "cli.ts"), ...args],
    cwd: tempDir,
    env: {
      ...process.env,
      ANIMA_HOME: animaHome,
      ANIMA_ROOMS_DIR: join(tempDir, "rooms"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function testAgent(): LoadedAgent {
  return {
    name: "eli",
    label: "Eli",
    roomDir: join(tempDir, "rooms", "eli"),
    soulPath: "PREFACE.md",
    geneContent: "Core instructions.",
    soulContent: "You are Eli.",
    sessionContextFiles: [{ path: "AGENTS.md", content: "Session context." }],
    additionalContent: [],
    memoryAdapter: new NullMemoryAdapter(),
    config: {
      identity: { name: "eli", label: "Eli" },
      provider: { type: "test-openai", model: "test-model" },
      policy: {
        allowedRoots: [join(tempDir, "rooms", "eli", "staging")],
        readOnlyRoots: [join(tempDir, "rooms", "eli", "mount")],
        allowedTools: [],
      },
      session: { defaultMode: "plan", autoModeOptIn: false, compactThreshold: 60000 },
      boot: { gene: "PREFACE.md", soul: "PREFACE.md", sessionContext: [{ path: "AGENTS.md" }] },
    },
  };
}
