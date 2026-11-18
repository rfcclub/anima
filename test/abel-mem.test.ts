import { afterEach, beforeEach, expect, test, mock } from "bun:test";
import {
  AbelMemService,
  authorizeRequest,
  getBearerToken,
  rotateBearerToken,
} from "../src/services/abel-mem";
import { AbelMemAdapter } from "../src/memory/abel-mem-adapter";

// ── Fetch mocking ─────────────────────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch;
const mockResponses = new Map<string, { status: number; body: unknown }>();

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mockResponses.clear();
  delete process.env["BEARER_2B_TOKEN"];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env["BEARER_2B_TOKEN"];
});

function setupMockFetch() {
  globalThis.fetch = mock(async (url: string | URL | Request, opts?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    // Find matching mock response
    for (const [pattern, response] of mockResponses) {
      if (urlStr.includes(pattern)) {
        return new Response(JSON.stringify(response.body), {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  }) as typeof globalThis.fetch;
}

function mockEndpoint(pattern: string, response: { status: number; body: unknown }) {
  mockResponses.set(pattern, response);
}

// ── Token Management (imported from src/services/abel-mem) ──────────────────

test("getBearerToken generates a valid UUID when env is not set", () => {
  const token = getBearerToken();
  expect(token).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("getBearerToken returns existing env var value", () => {
  process.env["BEARER_2B_TOKEN"] = "existing-token-value";
  expect(getBearerToken()).toBe("existing-token-value");
});

test("rotateBearerToken generates a new valid token", () => {
  const oldToken = getBearerToken();
  const newToken = rotateBearerToken();

  expect(newToken).not.toBe(oldToken);
  expect(newToken).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("rotateBearerToken updates process.env", () => {
  const newToken = rotateBearerToken();
  expect(process.env["BEARER_2B_TOKEN"]).toBe(newToken);
});

// ── Authorization (imported from src/services/abel-mem) ────────────────────

test("authorizeRequest returns true for matching Bearer token", () => {
  const token = getBearerToken();
  expect(authorizeRequest(`Bearer ${token}`)).toBe(true);
});

test("authorizeRequest returns false for null auth header", () => {
  expect(authorizeRequest(null)).toBe(false);
});

test("authorizeRequest returns false for wrong token", () => {
  getBearerToken(); // set expected
  expect(authorizeRequest("Bearer wrong-token")).toBe(false);
});

test("authorizeRequest returns false for empty auth header", () => {
  expect(authorizeRequest("")).toBe(false);
});

test("authorizeRequest is case-insensitive for Bearer prefix", () => {
  const token = getBearerToken();
  expect(authorizeRequest(`bearer ${token}`)).toBe(true);
  expect(authorizeRequest(`BEARER ${token}`)).toBe(true);
});

test("authorizeRequest rejects non-Bearer auth schemes", () => {
  const token = getBearerToken();
  expect(authorizeRequest(`Basic ${token}`)).toBe(false);
  expect(authorizeRequest(`Digest ${token}`)).toBe(false);
});

// ── AbelMemService — with mocked HTTP ─────────────────────────────────────────

test("AbelMemService health returns ok when HTTP responds", async () => {
  setupMockFetch();
  mockEndpoint("/health", { status: 200, body: { status: "ok", version: "0.2.0" } });

  const service = new AbelMemService("http://test.local:9999");
  const health = await service.health();

  expect(health.status).toBe("ok");
  expect(health.engine).toBe("available");
  expect(health.version).toBe("0.2.0");
});

test("AbelMemService store returns stored id from HTTP response", async () => {
  setupMockFetch();
  mockEndpoint("/api/memory", { status: 200, body: { id: "mem-123" } });

  const service = new AbelMemService("http://test.local:9999");
  const result = await service.store({
    content: "test memory",
    agent: "test-agent",
    timestamp: new Date().toISOString(),
  });

  expect(result.status).toBe("stored");
  expect(result.id).toBe("mem-123");
});

test("AbelMemService recall returns results from HTTP response", async () => {
  setupMockFetch();
  mockEndpoint("/api/memory?q=", {
    status: 200,
    body: {
      results: [
        {
          id: "r1",
          content: "recalled memory",
          agent: "test-agent",
          timestamp: new Date().toISOString(),
          relevance: 0.95,
        },
      ],
    },
  });

  const service = new AbelMemService("http://test.local:9999");
  const result = await service.recall({ query: "test", topK: 5 });

  expect(result.results).toHaveLength(1);
  expect(result.results[0].content).toBe("recalled memory");
  expect(result.results[0].relevance).toBe(0.95);
});

test("AbelMemService bootstrap returns bootstrapped status from HTTP response", async () => {
  setupMockFetch();
  mockEndpoint("/api/bootstrap", { status: 200, body: { status: "bootstrapped" } });

  const service = new AbelMemService("http://test.local:9999");
  const result = await service.bootstrap({ agent: "test-agent" });

  expect(result.status).toBe("bootstrapped");
  expect(result.agent).toBe("test-agent");
});

test("AbelMemService dream returns dream status from HTTP response", async () => {
  setupMockFetch();
  mockEndpoint("/api/dream", {
    status: 200,
    body: { status: "dreaming", reflection: "Deep thoughts..." },
  });

  const service = new AbelMemService("http://test.local:9999");
  const result = await service.dream({ agent: "test-agent" });

  expect(result.status).toBe("dreaming");
  expect(result.reflection).toBe("Deep thoughts...");
});

// ── AbelMemService — HTTP failure handling ────────────────────────────────────

test("AbelMemService returns error health when HTTP fails", async () => {
  setupMockFetch();
  // No mock endpoint registered — fetch will return 404

  const service = new AbelMemService("http://test.local:9999");
  const health = await service.health();

  expect(health.status).toBe("error");
  expect(health.engine).toBe("unavailable");
});

test("AbelMemService falls back to engine_unavailable on HTTP error", async () => {
  setupMockFetch();
  mockEndpoint("/health", { status: 200, body: { status: "ok" } });

  const service = new AbelMemService("http://test.local:9999");

  // First call health to verify engine is available
  const health = await service.health();
  expect(health.engine).toBe("available");

  // Now unset the mock to cause the next call to fail
  mockResponses.clear();

  const result = await service.store({
    content: "test", agent: "test", timestamp: new Date().toISOString(),
  });
  expect(result.status).toBe("engine_unavailable");
});

// ── AbelMemService — constructor defaults ─────────────────────────────────────

test("AbelMemService defaults to env var base URL when available", () => {
  process.env["ANIMA_2B_MEM_BASE_URL"] = "http://custom:8888";
  const service = new AbelMemService();
  expect(service.getBaseUrl()).toBe("http://custom:8888");
  delete process.env["ANIMA_2B_MEM_BASE_URL"];
});

test("AbelMemService defaults to localhost:3579", () => {
  const service = new AbelMemService();
  expect(service.getBaseUrl()).toBe("http://127.0.0.1:3579");
});

// ── AbelMemAdapter.bootstrap() ─────────────────────────────────────────

test("AbelMemAdapter.bootstrap returns entries when service succeeds", async () => {
  setupMockFetch();
  mockEndpoint("/api/bootstrap", { status: 200, body: { status: "bootstrapped" } });

  const service = new AbelMemService("http://test.local:9999");
  const adapter = new AbelMemAdapter(service);

  const entries = await adapter.bootstrap();

  expect(entries.length).toBeGreaterThan(0);
  expect(entries[0].content).toContain("Bootstrap");
  expect(entries[0].source).toBe("abel-mem-adapter");
  expect(entries[0].tags).toContain("bootstrap");
});

test("AbelMemAdapter.bootstrap returns entry with correct scope and confidence", async () => {
  setupMockFetch();
  mockEndpoint("/api/bootstrap", { status: 200, body: { status: "bootstrapped" } });

  const service = new AbelMemService("http://test.local:9999");
  const adapter = new AbelMemAdapter(service);

  const entries = await adapter.bootstrap();

  const entry = entries[0];
  expect(entry.scope).toBe("observation");
  expect(entry.confidence).toBeGreaterThanOrEqual(0.8);
  expect(typeof entry.id).toBe("string");
  expect(typeof entry.createdAt).toBe("string");
});
