import { test, expect, beforeEach } from "bun:test";
import { createMemHandlers } from "../src/api/mem/handlers";
import { AbelMemService, getBearerToken } from "../src/services/abel-mem";

let service: AbelMemService;
let handlers: ReturnType<typeof createMemHandlers>;
let validToken: string;
let engineAvailable = false;

beforeEach(async () => {
  service = new AbelMemService();
  handlers = createMemHandlers(service);
  validToken = getBearerToken();
  try {
    const health = await service.health();
    engineAvailable = health.engine === "available";
  } catch {
    engineAvailable = false;
  }
});

function authedRequest(path: string, options: RequestInit = {}): Request {
  const headers = new Headers(options.headers as Record<string, string> ?? {});
  headers.set("authorization", `Bearer ${validToken}`);
  return new Request(`http://127.0.0.1${path}`, { ...options, headers });
}

test("GET /mem/health returns ok without auth", async () => {
  if (!engineAvailable) return; // requires running abel-mem engine
  const req = new Request("http://127.0.0.1/mem/health");
  const res = await handlers.handleHealth(req);
  expect(res.status).toBe(200);

  const body = await res.json();
  expect(body.status).toBe("ok");
});

test("POST /mem/store requires auth and returns 403 without token", async () => {
  const req = new Request("http://127.0.0.1/mem/store", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "test", agent: "abel" }),
  });
  const res = await handlers.handleStore(req);
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error).toBe("forbidden");
});

test("POST /mem/store with valid token returns stored", async () => {
  if (!engineAvailable) return; // requires running abel-mem engine
  const req = authedRequest("/mem/store", {
    method: "POST",
    body: JSON.stringify({ content: "Important memory", agent: "abel" }),
  });
  const res = await handlers.handleStore(req);
  expect(res.status).toBe(200);

  const body = await res.json();
  expect(body.status).toBe("stored");
  expect(body.id).toBeDefined();
});

test("POST /mem/store with wrong token returns 403", async () => {
  const req = new Request("http://127.0.0.1/mem/store", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer wrong-token",
    },
    body: JSON.stringify({ content: "test", agent: "abel" }),
  });
  const res = await handlers.handleStore(req);
  expect(res.status).toBe(403);
});

test("POST /mem/store requires content and agent fields", async () => {
  const req = authedRequest("/mem/store", {
    method: "POST",
    body: JSON.stringify({ content: "test" }), // missing agent
  });
  const res = await handlers.handleStore(req);
  expect(res.status).toBe(400);
});

test("POST /mem/recall with valid token returns results", async () => {
  const req = authedRequest("/mem/recall", {
    method: "POST",
    body: JSON.stringify({ query: "test query", topK: 5 }),
  });
  const res = await handlers.handleRecall(req);
  expect(res.status).toBe(200);

  const body = await res.json();
  expect(body.results).toBeDefined();
  expect(Array.isArray(body.results)).toBe(true);
});

test("POST /mem/recall requires query field", async () => {
  const req = authedRequest("/mem/recall", {
    method: "POST",
    body: JSON.stringify({}),
  });
  const res = await handlers.handleRecall(req);
  expect(res.status).toBe(400);
});

test("POST /mem/bootstrap with valid token returns bootstrapped", async () => {
  const req = authedRequest("/mem/bootstrap", {
    method: "POST",
    body: JSON.stringify({ agent: "abel-claw" }),
  });
  const res = await handlers.handleBootstrap(req);
  expect(res.status).toBe(200);

  const body = await res.json();
  expect(body.agent).toBe("abel-claw");
});

test("POST /mem/dream with valid token returns dreaming status", async () => {
  const req = authedRequest("/mem/dream", {
    method: "POST",
    body: JSON.stringify({ agent: "abel", prompt: "Reflect" }),
  });
  const res = await handlers.handleDream(req);
  expect(res.status).toBe(200);

  const body = await res.json();
  expect(body.status).toBeDefined();
});

test("POST /mem/dream requires agent field", async () => {
  const req = authedRequest("/mem/dream", {
    method: "POST",
    body: JSON.stringify({}),
  });
  const res = await handlers.handleDream(req);
  expect(res.status).toBe(400);
});

test("all protected endpoints return 403 without auth", async () => {
  const endpoints = [
    () => handlers.handleStore(new Request("http://localhost/mem/store", { method: "POST", body: "{}" })),
    () => handlers.handleRecall(new Request("http://localhost/mem/recall", { method: "POST", body: "{}" })),
    () => handlers.handleBootstrap(new Request("http://localhost/mem/bootstrap", { method: "POST", body: "{}" })),
    () => handlers.handleDream(new Request("http://localhost/mem/dream", { method: "POST", body: "{}" })),
  ];

  for (const endpoint of endpoints) {
    const res = await endpoint();
    expect(res.status).toBe(403);
  }
});
