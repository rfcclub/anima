import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteAgentStream } from "../../src/remote-talk/stream";
import { SessionStore } from "../../src/memory/session-store";
import type { Provider, ProviderRequest, ProviderResponse } from "../../src/providers/interface";

let home: string;
let roomsDir: string;
let originalHome: string | undefined;

function setupRoom(name: string): void {
  const dir = join(roomsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.yaml"), [
    "identity:",
    `  name: ${name}`,
    "  label: Jade",
    "boot:",
    "  gene: AGENTS.md",
    "  soul: SOUL.md",
    "  sessionContext:",
    "  - MEMORY.md",
    "memory:",
    "  store: jsonl",
    "session:",
    "  defaultMode: edit",
    "  compactThreshold: 50",
    "provider:",
    "  type: mock",
    "  model: mock-model",
    "policy:",
    "  allowedRoots:",
    `  - ${dir}`,
    "  allowedTools:",
    "  - bash",
    "  - write",
    "reflection:",
    "  enabled: false",
  ].join("\n"));
  writeFileSync(join(dir, "AGENTS.md"), `# ${name}`);
  writeFileSync(join(dir, "SOUL.md"), `# ${name} soul`);
  writeFileSync(join(dir, "MEMORY.md"), "");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "anima-remote-stream-"));
  roomsDir = join(home, "rooms");
  originalHome = process.env.HOME;
  process.env.HOME = home;
  process.env.ANIMA_UI_STATE_DIR = home;
  setupRoom("jade");
});

afterEach(() => {
  process.env.HOME = originalHome;
  delete process.env.ANIMA_UI_STATE_DIR;
  rmSync(home, { recursive: true, force: true });
});

test("remote turn: separate remote:<caller> session with 2 turns, attributed context, no tools", async () => {
  const requests: ProviderRequest[] = [];
  const provider = {
    name: "mock",
    async query(req: ProviderRequest): Promise<ProviderResponse> {
      requests.push(req);
      return { message: { role: "assistant", content: "hello sister" }, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  } as unknown as Provider;

  const response = await remoteAgentStream({ agentName: "jade", caller: "jade@grok", message: "hi", roomsDir, provider });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const text = await response.text();
  expect(text).toContain("hello sister");

  expect(requests).toHaveLength(1);
  expect(requests[0].tools).toBeUndefined();
  expect(requests[0].system).toContain("jade@grok");
  expect(requests[0].system).toContain("not Owner");

  const store = new SessionStore(join(home, "sessions.db"));
  const remote = store.getLatestSession("jade", "remote:jade@grok");
  expect(remote).not.toBeNull();
  expect(store.getTurns(remote!.id).map((turn) => [turn.role, turn.content])).toEqual([
    ["user", "hi"],
    ["assistant", "hello sister"],
  ]);
  expect(store.getLatestSession("jade", "ui")).toBeNull();
});

test("unknown agent → 404, provider not called", async () => {
  const requests: ProviderRequest[] = [];
  const provider = { name: "mock", async query(req: ProviderRequest) { requests.push(req); return { message: { role: "assistant", content: "x" } }; } } as unknown as Provider;
  const response = await remoteAgentStream({ agentName: "ghost", caller: "jade@grok", message: "hi", roomsDir, provider });
  expect(response.status).toBe(404);
  expect(requests).toHaveLength(0);
});
