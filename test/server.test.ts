import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRequest as handleCoreRequest } from "../src/server";

// Match Bun's real HTTP request headers for these direct-router fixtures.
const handleRequest = (req: Request) => {
  req.headers.set("host", new URL(req.url).host);
  return handleCoreRequest(req);
};
import { SessionStore } from "../src/memory/session-store";

type HealthBody = {
  status: string;
  version: string;
  uptime: number;
  agents: string[];
};

type StatusBody = {
  agents: unknown[];
};

let tempDir: string;
let previousRoomsDir: string | undefined;
let previousStateDir: string | undefined;

beforeEach(async () => {
  previousRoomsDir = Bun.env.ANIMA_ROOMS_DIR;
  previousStateDir = Bun.env.ANIMA_UI_STATE_DIR;
  tempDir = await mkdtemp(join(tmpdir(), "anima-server-"));
  Bun.env.ANIMA_ROOMS_DIR = join(tempDir, "rooms");
  Bun.env.ANIMA_UI_STATE_DIR = join(tempDir, "state");
});

afterEach(async () => {
  if (previousRoomsDir === undefined) {
    delete Bun.env.ANIMA_ROOMS_DIR;
  } else {
    Bun.env.ANIMA_ROOMS_DIR = previousRoomsDir;
  }
  if (previousStateDir === undefined) {
    delete Bun.env.ANIMA_UI_STATE_DIR;
  } else {
    Bun.env.ANIMA_UI_STATE_DIR = previousStateDir;
  }
  await rm(tempDir, { recursive: true, force: true });
});

test("GET /health returns ok when no rooms are seeded", async () => {
  const response = await handleRequest(new Request("http://127.0.0.1:3700/health"));
  const body = (await response.json()) as HealthBody;

  expect(response.status).toBe(200);
  expect(body.status).toBe("ok");
  expect(body.version).toBeString();
  expect(body.uptime).toBeNumber();
  expect(body.agents).toEqual([]);
});

test("GET /status returns agent list", async () => {
  const response = await handleRequest(new Request("http://127.0.0.1:3700/status"));
  const body = (await response.json()) as StatusBody;

  expect(response.status).toBe(200);
  expect(body.agents).toEqual([]);
});

test("POST /api/mesh/notify appends incoming mesh message to agent mesh session", async () => {
  const response = await handleRequest(new Request("http://127.0.0.1:3700/api/mesh/notify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      recipient_id: "anima-abel",
      from_id: "eli",
      from_platform: "codex",
      subject: "mesh hello",
      content: "hello abel from mesh",
    }),
  }));
  const body = await response.json() as { ok?: boolean; session_id?: string; error?: string };

  expect(response.status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.session_id).toBeString();

  const store = new SessionStore(join(Bun.env.ANIMA_UI_STATE_DIR!, "sessions.db"));
  try {
    const session = store.getSession(body.session_id!);
    const turns = store.getTurns(body.session_id!);
    expect(session?.agent).toBe("abel");
    expect(session?.channel).toBe("mesh");
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe("user");
    expect(turns[0].content).toContain("mesh hello");
    expect(turns[0].content).toContain("hello abel from mesh");
  } finally {
    store.close();
  }
});

test("mesh server wiring uses the neutral agent session channel, not TelegramChannel", async () => {
  const serverSource = await readFile(join(import.meta.dir, "..", "src", "server.ts"), "utf8");

  expect(serverSource).toContain("AgentSessionChannel");
  expect(serverSource).not.toContain('from "./channels/telegram"');
  expect(serverSource).not.toContain("new TelegramChannel");
});
