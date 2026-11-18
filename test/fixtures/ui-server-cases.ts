import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Provider, ProviderChunk } from "../../src/providers/interface";

// ── Mock provider ──────────────────────────────────────────────────────────

function mockProvider(chunks: string[]): Provider {
  return {
    name: "mock",
    async *query(): AsyncGenerator<ProviderChunk> {
      for (const chunk of chunks) {
        yield { type: "text", content: chunk };
      }
    },
  };
}

// Exercise the canonical router with the Host header a real local HTTP client sends.
// Direct Request construction does not add it; the origin guard correctly refuses it.
function localRequest(url: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("host", new URL(url).host);
  return new Request(url, { ...init, headers });
}

type TestContext = {
  roomsDir: string;
  stateDir: string;
  previousRoomsDir: string | undefined;
  previousStateDir: string | undefined;
  previousPort: string | undefined;
  previousTestProviders: string | undefined;
};

async function createTestContext(): Promise<TestContext> {
  const roomsDir = await mkdtemp(join(tmpdir(), "anima-ui-rooms-"));
  const stateDir = await mkdtemp(join(tmpdir(), "anima-ui-state-"));
  const previousRoomsDir = Bun.env.ANIMA_ROOMS_DIR;
  const previousStateDir = Bun.env.ANIMA_UI_STATE_DIR;
  const previousTestProviders = Bun.env.ANIMA_TEST_PROVIDERS;
  const previousPort = Bun.env.ANIMA_UI_PORT;

  Bun.env.ANIMA_ROOMS_DIR = roomsDir;
  Bun.env.ANIMA_UI_STATE_DIR = stateDir;
  Bun.env.ANIMA_UI_PORT = "3099";
  // talk.ts:515 only honors deps.providers (the mock) when this flag is set —
  // otherwise it ignores the mock and resolves a real provider from config,
  // which hangs the SSE test on a non-existent API path. Set it for the whole
  // test context so any /api/talk test gets the mock provider it passed in.
  Bun.env.ANIMA_TEST_PROVIDERS = "true";

  // Create a mock agent room
  const agentDir = join(roomsDir, "bruno");
  await mkdir(join(agentDir, "sessions"), { recursive: true });

  // Write config.yaml
  await writeFile(
    join(agentDir, "config.yaml"),
    [
      "identity:",
      "  name: bruno",
      "  label: Bruno - Orchestrator",
      "provider:",
      "  type: claude",
      "  model: claude-3-opus",
      "policy:",
      "  allowedRoots:",
      "    - /home",
      "session:",
      "  defaultMode: plan",
      "  autoModeOptIn: false",
      "  compactThreshold: 60000",
      "boot:",
      "  gene: soul.md",
      "  soul: soul.md",
      "  sessionContext:",
      "    - AGENTS.md",
    ].join("\n"),
  );

  // Write boot files
  await writeFile(join(agentDir, "soul.md"), "Bruno identity content");
  await writeFile(join(agentDir, "AGENTS.md"), "Session instructions");

  // Write a session file
  const sessionLine = JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "turn",
    sessionId: "bruno:today",
    role: "user",
    content: "hello",
  });
  await writeFile(
    join(agentDir, "sessions", `${new Date().toISOString().slice(0, 10)}.jsonl`),
    sessionLine + "\n",
  );

  return { roomsDir, stateDir, previousRoomsDir, previousStateDir, previousPort, previousTestProviders };
}

async function cleanupContext(ctx: TestContext): Promise<void> {
  if (ctx.previousRoomsDir === undefined) {
    delete Bun.env.ANIMA_ROOMS_DIR;
  } else {
    Bun.env.ANIMA_ROOMS_DIR = ctx.previousRoomsDir;
  }
  if (ctx.previousStateDir === undefined) {
    delete Bun.env.ANIMA_UI_STATE_DIR;
  } else {
    Bun.env.ANIMA_UI_STATE_DIR = ctx.previousStateDir;
  }
  if (ctx.previousPort === undefined) {
    delete Bun.env.ANIMA_UI_PORT;
  } else {
    Bun.env.ANIMA_UI_PORT = ctx.previousPort;
  }
  if (ctx.previousTestProviders === undefined) {
    delete Bun.env.ANIMA_TEST_PROVIDERS;
  } else {
    Bun.env.ANIMA_TEST_PROVIDERS = ctx.previousTestProviders;
  }
  await rm(ctx.roomsDir, { recursive: true, force: true });
  await rm(ctx.stateDir, { recursive: true, force: true });
}

// ── Tests ─────────────────────────────────────────────────────────────────

test("GET /api/status returns JSON with agent status", async () => {
  const ctx = await createTestContext();

  try {
    // Import AFTER env setup so defaults pick up temp dirs
    const { handleUIRequest } = await import("../../src/ui/app/router");

    const res = await handleUIRequest(
      localRequest("http://127.0.0.1:3099/api/status"),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toInclude("application/json");

    const body = await res.json();
    expect(body).toHaveProperty("agents");
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.agents.length).toBeGreaterThanOrEqual(1);

    const bruno = body.agents.find((a: { name: string }) => a.name === "bruno");
    expect(bruno).toBeDefined();
    expect(bruno).toHaveProperty("status");
    expect(bruno).toHaveProperty("label");
  } finally {
    await cleanupContext(ctx);
  }
});

test("POST /api/talk/:agent returns SSE stream (text/event-stream)", async () => {
  const ctx = await createTestContext();

  try {
    const { handleUIRequest } = await import("../../src/ui/app/router");

    // Use a mock provider for this agent
    const provider = mockProvider(["Hello ", "from ", "Bruno"]);
    const providers = new Map<string, Provider>([["bruno", provider]]);

    const res = await handleUIRequest(
      localRequest("http://127.0.0.1:3099/api/talk/bruno", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "test" }),
      }),
      { providers },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const text = await res.text();
    expect(text).toInclude('data: "Hello "');
    expect(text).toInclude('data: "from "');
    expect(text).toInclude('data: "Bruno"');
    expect(text).toInclude("data: [DONE]");
  } finally {
    await cleanupContext(ctx);
  }
});

test("POST /api/talk/bruno with slash command /branch list returns branch info", async () => {
  const ctx = await createTestContext();

  try {
    const { handleUIRequest } = await import("../../src/ui/app/router");
    const provider = mockProvider(["ok"]);
    const providers = new Map<string, Provider>([["bruno", provider]]);

    // First talk to create a session with branches
    await handleUIRequest(
      localRequest("http://127.0.0.1:3099/api/talk/bruno", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      }),
      { providers },
    );

    // Now check /branch list
    const res = await handleUIRequest(
      localRequest("http://127.0.0.1:3099/api/talk/bruno", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "/branch list" }),
      }),
      { providers },
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toInclude("main");
    expect(text).toInclude("*");
  } finally {
    await cleanupContext(ctx);
  }
});

test("GET /api/branches/:agent returns branch list with active branch", async () => {
  const ctx = await createTestContext();

  try {
    const { handleUIRequest } = await import("../../src/ui/app/router");

    // First talk to create a session
    const provider = mockProvider(["ok"]);
    const providers = new Map<string, Provider>([["bruno", provider]]);
    await handleUIRequest(
      localRequest("http://127.0.0.1:3099/api/talk/bruno", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "first turn" }),
      }),
      { providers },
    );

    // Fetch branches
    const res = await handleUIRequest(
      localRequest("http://127.0.0.1:3099/api/branches/bruno"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("branches");
    expect(Array.isArray(body.branches)).toBe(true);
    expect(body.branches.length).toBeGreaterThanOrEqual(1);
    expect(body.branches[0].name).toBe("main");
    expect(body.activeBranchId).toBe(body.branches[0].id);
  } finally {
    await cleanupContext(ctx);
  }
});

test("POST /api/talk/bruno /branch new creates a branch from last turn", async () => {
  const ctx = await createTestContext();

  try {
    const { handleUIRequest } = await import("../../src/ui/app/router");
    const provider = mockProvider(["ok"]);
    const providers = new Map<string, Provider>([["bruno", provider]]);

    // Send 3 turns to build history
    await handleUIRequest(
      localRequest("http://127.0.0.1:3099/api/talk/bruno", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "turn 1" }),
      }), { providers },
    );
    await handleUIRequest(
      localRequest("http://127.0.0.1:3099/api/talk/bruno", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "turn 2" }),
      }), { providers },
    );

    // Create a new branch
    const res = await handleUIRequest(
      localRequest("http://127.0.0.1:3099/api/talk/bruno", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "/branch new experiment" }),
      }), { providers },
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toInclude("experiment");
    expect(text).toInclude("Created");
  } finally {
    await cleanupContext(ctx);
  }
});

test("POST /api/talk/bruno /branch turn creates fork when turn exists", async () => {
  const ctx = await createTestContext();

  try {
    const { handleUIRequest } = await import("../../src/ui/app/router");
    const provider = mockProvider(["response"]);
    const providers = new Map<string, Provider>([["bruno", provider]]);

    // Talk creates a session with 1 user + 1 assistant turn
    await handleUIRequest(
      localRequest("http://127.0.0.1:3099/api/talk/bruno", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "first" }),
      }), { providers },
    );

    // Create a new branch from the latest (using /branch new instead)
    const res = await handleUIRequest(
      localRequest("http://127.0.0.1:3099/api/talk/bruno", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "/branch new test-fork" }),
      }), { providers },
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toInclude("test-fork");
  } finally {
    await cleanupContext(ctx);
  }
});

test("POST /api/talk/bruno /help includes branch commands in branching mode", async () => {
  const ctx = await createTestContext();

  // Add contextManagement to the config
  const agentDir = join(ctx.roomsDir, "bruno");
  await writeFile(
    join(agentDir, "config.yaml"),
    [
      "identity:",
      "  name: bruno",
      "  label: Bruno - Orchestrator",
      "provider:",
      "  type: claude",
      "  model: claude-3-opus",
      "policy:",
      "  allowedRoots:",
      "    - /home",
      "session:",
      "  defaultMode: plan",
      "  autoModeOptIn: false",
      "  compactThreshold: 60000",
      "contextManagement:",
      "  mode: branching",
      "boot:",
      "  gene: soul.md",
      "  soul: soul.md",
      "  sessionContext:",
      "    - AGENTS.md",
    ].join("\n"),
  );

  try {
    const { handleUIRequest } = await import("../../src/ui/app/router");
    const provider = mockProvider(["ok"]);
    const providers = new Map<string, Provider>([["bruno", provider]]);

    const res = await handleUIRequest(
      localRequest("http://127.0.0.1:3099/api/talk/bruno", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "/help" }),
      }),
      { providers },
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toInclude("branch");
    expect(text).toInclude("list");
    expect(text).toInclude("switch");
    expect(text).toInclude("delete");
  } finally {
    await cleanupContext(ctx);
  }
});

test("GET /api/session/:agent returns session JSON", async () => {
  const ctx = await createTestContext();

  try {
    const { handleUIRequest } = await import("../../src/ui/app/router");

    const res = await handleUIRequest(
      localRequest("http://127.0.0.1:3099/api/session/bruno"),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toInclude("application/json");

    const body = await res.json();
    expect(body).toHaveProperty("sessionId");
    expect(body).toHaveProperty("turnCount");
    expect(body).toHaveProperty("estimatedTokens");
    expect(body).toHaveProperty("hasBaseline");
    expect(body).toHaveProperty("unreadMailCount");
    expect(typeof body.sessionId).toBe("string");
    expect(body.sessionId.length).toBeGreaterThan(0);
  } finally {
    await cleanupContext(ctx);
  }
});

test("POST /api/meet returns SSE stream", async () => {
  const ctx = await createTestContext();

  try {
    const { handleUIRequest } = await import("../../src/ui/app/router");

    // Mock providers for meeting agents
    const agentProvider = mockProvider(["Meeting ", "response"]);
    const providers = new Map<string, Provider>([["bruno", agentProvider]]);

    const res = await handleUIRequest(
      localRequest("http://127.0.0.1:3099/api/meet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agents: ["bruno"], topic: "test-meeting" }),
      }),
      { providers },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const text = await res.text();
    expect(text).toInclude("data: [DONE]");
  } finally {
    await cleanupContext(ctx);
  }
});

test("POST /api/mode switches mode and persists", async () => {
  const ctx = await createTestContext();

  try {
    const { handleUIRequest } = await import("../../src/ui/app/router");

    // Start in plan mode
    const res1 = await handleUIRequest(
      localRequest("http://127.0.0.1:3099/api/mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "edit" }),
      }),
    );

    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.mode).toBe("edit");

    // Check the state file was created
    const stateFilePath = join(ctx.stateDir, "state.yaml");
    const stateFile = await Bun.file(stateFilePath).text();
    expect(stateFile).toInclude("edit");

    // Read current mode
    const res2 = await handleUIRequest(
      localRequest("http://127.0.0.1:3099/api/mode", { method: "GET" }),
    );
    const body2 = await res2.json();
    expect(body2.mode).toBe("edit");
  } finally {
    await cleanupContext(ctx);
  }
});

test("GET / returns index.html", async () => {
  const ctx = await createTestContext();

  try {
    const { handleUIRequest } = await import("../../src/ui/app/router");

    const res = await handleUIRequest(
      localRequest("http://127.0.0.1:3099/"),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toInclude("text/html");

    const text = await res.text();
    expect(text).toInclude("<!DOCTYPE html>");
    expect(text).toInclude("ANIMA Colony");
  } finally {
    await cleanupContext(ctx);
  }
});

test("GET /api/status includes meeting topics", async () => {
  const ctx = await createTestContext();

  try {
    const { handleUIRequest } = await import("../../src/ui/app/router");

    const res = await handleUIRequest(
      localRequest("http://127.0.0.1:3099/api/status"),
    );
    const body = await res.json();

    expect(body).toHaveProperty("meetingTopics");
    expect(Array.isArray(body.meetingTopics)).toBe(true);
  } finally {
    await cleanupContext(ctx);
  }
});

/* ---------- Mode validation ---------- */

test("POST /api/mode rejects invalid mode with 400", async () => {
  const ctx = await createTestContext();

  try {
    const { handleUIRequest } = await import("../../src/ui/app/router");

    const res = await handleUIRequest(
      localRequest("http://127.0.0.1:3099/api/mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "dangerous" }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toInclude("invalid_mode");
  } finally {
    await cleanupContext(ctx);
  }
});

test("POST /api/talk/:agent rejects invalid mode with 400", async () => {
  const ctx = await createTestContext();

  try {
    const { handleUIRequest } = await import("../../src/ui/app/router");
    const agentProvider = mockProvider(["response"]);
    const providers = new Map<string, Provider>([["bruno", agentProvider]]);

    const res = await handleUIRequest(
      localRequest("http://127.0.0.1:3099/api/talk/bruno", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello", mode: "insecure" }),
      }),
      { providers },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toInclude("invalid_mode");
  } finally {
    await cleanupContext(ctx);
  }
});

test("POST /api/mode rejects empty mode with 400", async () => {
  const ctx = await createTestContext();

  try {
    const { handleUIRequest } = await import("../../src/ui/app/router");

    const res = await handleUIRequest(
      localRequest("http://127.0.0.1:3099/api/mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("mode_required");
  } finally {
    await cleanupContext(ctx);
  }
});

// ── Visual Novel Stage (now Pixi-VN via SPA) ───────────────────────────────
// Legacy stage.html retired (backed up to _archive/). /stage/:agentId now
// serves the SPA shell, which client-routes to Castle2Page (Pixi-VN).

test("GET /stage/:agentId serves the SPA shell (Pixi-VN via client router)", async () => {
  const ctx = await createTestContext();

  try {
    const { handleUIRequest } = await import("../../src/ui/app/router");

    const res = await handleUIRequest(
      localRequest("http://127.0.0.1:3099/stage/bruno"),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toInclude("text/html");

    const text = await res.text();
    expect(text).toInclude("<!DOCTYPE html>");
    expect(text).toInclude('<div id="root">'); // SPA shell
  } finally {
    await cleanupContext(ctx);
  }
});

test("GET /stage/:agentId renders different agent IDs (all SPA shell)", async () => {
  const ctx = await createTestContext();

  try {
    const { handleUIRequest } = await import("../../src/ui/app/router");

    const res1 = await handleUIRequest(
      localRequest("http://127.0.0.1:3099/stage/eli"),
    );
    expect(res1.status).toBe(200);

    const res2 = await handleUIRequest(
      localRequest("http://127.0.0.1:3099/stage/milo"),
    );
    expect(res2.status).toBe(200);
  } finally {
    await cleanupContext(ctx);
  }
});

test("GET /stage/ (missing agentId) serves SPA shell (client router handles it)", async () => {
  const ctx = await createTestContext();

  try {
    const { handleUIRequest } = await import("../../src/ui/app/router");

    const res = await handleUIRequest(
      localRequest("http://127.0.0.1:3099/stage/"),
    );

    // SPA fallback serves the shell for unmatched non-API GETs.
    expect(res.status).toBe(200);
  } finally {
    await cleanupContext(ctx);
  }
});
