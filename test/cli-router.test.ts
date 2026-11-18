import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let animaHome: string;
let server: ReturnType<typeof Bun.serve>;

beforeEach(async () => {
  tempDir = join(tmpdir(), `anima-cli-router-${crypto.randomUUID()}`);
  animaHome = join(tempDir, ".anima");
  await mkdir(join(tempDir, "rooms", "eli", "staging"), { recursive: true });
  await Bun.write(join(tempDir, "rooms", "eli", "PREFACE.md"), "You are Eli.\n");
  await Bun.write(join(tempDir, "rooms", "eli", "AGENTS.md"), "Session instructions.\n");
  await Bun.write(join(tempDir, "rooms", "eli", "config.yaml"), roomConfig());
});

afterEach(async () => {
  server?.stop(true);
  await rm(tempDir, { recursive: true, force: true });
});

test("mode command shows and switches task mode in ANIMA_HOME/state.yaml", async () => {
  const initial = await runCli(["mode"]);
  expect(initial.exitCode).toBe(0);
  expect(initial.stdout).toContain("Current mode: chatting");

  const switched = await runCli(["mode", "programming"]);
  expect(switched.exitCode).toBe(0);
  expect(switched.stdout).toContain("Current mode: programming");

  const shown = await runCli(["mode"]);
  expect(shown.stdout).toContain("Current mode: programming");
});

test("mode command rejects invalid task modes", async () => {
  const result = await runCli(["mode", "invalid-mode"]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("chatting, programming, image, private, philosophy, creative");
});

test("talk routes provider.type router through mode map and --mode override without changing global mode", async () => {
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json() as { model: string; messages: Array<{ role: string; content: string }> };
      return Response.json({
        choices: [{ message: { role: "assistant", content: `${body.model}:${body.messages.at(-1)?.content}` } }],
      });
    },
  });
  await writeRouterConfig(`http://127.0.0.1:${server.port}/v1`);
  await runCli(["mode", "programming"]);

  const result = await runCli(["talk", "eli", "hello", "--mode", "private"]);
  const shown = await runCli(["mode"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("private-model:hello");
  expect(shown.stdout).toContain("Current mode: programming");
});

async function writeRouterConfig(baseUrl: string): Promise<void> {
  await mkdir(join(animaHome, "providers.d"), { recursive: true });
  await Bun.write(join(animaHome, "providers.d", "gemini.yaml"), [
    "id: gemini",
    "label: Gemini Test",
    `baseUrl: ${baseUrl}`,
    "api: openai-completions",
    "apiKey: test-key",
    "models:",
    "  - id: programming-model",
    "  - id: private-model",
    "",
  ].join("\n"));
  await Bun.write(join(animaHome, "mode-map.yaml"), [
    "chatting: [programming-model@gemini]",
    "programming: [programming-model@gemini]",
    "image: [programming-model@gemini]",
    "private: [private-model@gemini]",
    "philosophy: [programming-model@gemini]",
    "creative: [programming-model@gemini]",
    "",
  ].join("\n"));
}

function roomConfig(): string {
  return [
    "identity:",
    "  name: eli",
    "  label: Eli",
    "provider:",
    "  type: router",
    "policy:",
    `  allowedRoots: ["${join(tempDir, "rooms", "eli", "staging")}"]`,
    `  readOnlyRoots: ["${join(tempDir, "rooms", "eli")}"]`,
    "session:",
    "  defaultMode: plan",
    "  autoModeOptIn: false",
    "  compactThreshold: 60000",
    "boot:",
    "  gene: PREFACE.md",
    "  soul: PREFACE.md",
    "  sessionContext:",
    "    - path: AGENTS.md",
    "",
  ].join("\n");
}

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["bun", join(process.cwd(), "src/cli.ts"), ...args],
    cwd: tempDir,
    env: {
      ...process.env,
      ANIMA_HOME: animaHome,
      ANIMA_ROOMS_DIR: join(tempDir, "rooms"),
      GEMINI_API_KEY: "test-gemini-key",
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
