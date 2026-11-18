import { expect, test } from "bun:test";
import { handleRequest as handleCoreRequest } from "../src/server";

// Match Bun's real HTTP request headers for these direct-router fixtures.
const handleRequest = (req: Request) => {
  req.headers.set("host", new URL(req.url).host);
  return handleCoreRequest(req);
};

test("GET /colony returns 200", async () => {
  const response = await handleRequest(new Request("http://127.0.0.1:3700/colony"));
  expect(response.status).toBe(200);
});

test("GET /colony has agents array", async () => {
  const response = await handleRequest(new Request("http://127.0.0.1:3700/colony"));
  const body = await response.json() as { agents: unknown[] };
  expect(Array.isArray(body.agents)).toBe(true);
  expect(body.agents.length).toBeGreaterThan(0);
});

test("GET /colony each agent has required fields", async () => {
  const response = await handleRequest(new Request("http://127.0.0.1:3700/colony"));
  const body = await response.json() as { agents: any[] };
  for (const agent of body.agents) {
    expect(agent.name).toBeString();
    expect(agent.substrateName).toBeString();
    expect(agent.substratePath).toBeString();
    expect(Array.isArray(agent.bootSequence)).toBe(true);
    expect(agent.continuityMode).toBeString();
    expect(agent.platform).toBeString();
    expect(typeof agent.needsEntityMemory).toBe("boolean");
  }
});

test("GET /api/colony returns JSON colony state with trust data", async () => {
  const response = await handleRequest(new Request("http://127.0.0.1:3700/api/colony"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toInclude("application/json");

  const body = await response.json() as { agents: any[] };
  expect(body).toHaveProperty("agents");
  expect(Array.isArray(body.agents)).toBe(true);
  // Colony roster has grown over time (11 → 16). Pin a floor, not an exact
  // count, so this test doesn't break every time an agent is added — the
  // shape assertions below are what actually matter.
  expect(body.agents.length).toBeGreaterThanOrEqual(11);

  // Each agent should have trust, wounds, pendingReviews, lastCrossing
  for (const agent of body.agents) {
    expect(agent).toHaveProperty("name");
    expect(agent).toHaveProperty("trust");
    expect(agent.trust).toHaveProperty("topDomains");
    expect(Array.isArray(agent.trust.topDomains)).toBe(true);
    expect(agent).toHaveProperty("wounds");
    expect(agent).toHaveProperty("pendingReviews");
    expect(agent).toHaveProperty("lastCrossing");
  }
});

test("GET /api/colony trust topDomains has up to 3 entries with domain and score", async () => {
  const response = await handleRequest(new Request("http://127.0.0.1:3700/api/colony"));
  const body = await response.json() as { agents: any[] };

  for (const agent of body.agents) {
    const top = agent.trust.topDomains;
    expect(top.length).toBeLessThanOrEqual(3);
    for (const entry of top) {
      expect(entry).toHaveProperty("domain");
      expect(entry).toHaveProperty("score");
      expect(typeof entry.score).toBe("number");
    }
  }
});

test("GET /api/agent/:id returns single agent detail with full domain breakdown", async () => {
  const response = await handleRequest(new Request("http://127.0.0.1:3700/api/agent/bruno"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toInclude("application/json");

  const body = await response.json() as any;
  expect(body.name).toBe("bruno");
  expect(body).toHaveProperty("trust");
  expect(body.trust).toHaveProperty("domains");
  expect(Array.isArray(body.trust.domains)).toBe(true);

  for (const entry of body.trust.domains) {
    expect(entry).toHaveProperty("domain");
    expect(entry).toHaveProperty("score");
    expect(entry).toHaveProperty("samples");
  }
});

test("GET /api/agent/:id returns 404 for unknown agent", async () => {
  const response = await handleRequest(new Request("http://127.0.0.1:3700/api/agent/nonexistent"));
  expect(response.status).toBe(404);
});

test("GET /api/agent/:id domains are sorted by score descending", async () => {
  const response = await handleRequest(new Request("http://127.0.0.1:3700/api/agent/bruno"));
  const body = await response.json() as any;
  const domains = body.trust.domains;

  for (let i = 1; i < domains.length; i++) {
    expect(domains[i - 1].score).toBeGreaterThanOrEqual(domains[i].score);
  }
});
