import { describe, test, expect } from "bun:test";
import { createApiClient, type HealthResponse, type ColonyResponse } from "./api";

const HEALTH: HealthResponse = {
  status: "ok",
  version: "0.1.0",
  uptime: 57036.1,
  agents: ["bruno", "eli"],
};

const COLONY: ColonyResponse = {
  agents: [
    {
      name: "eli",
      substrateName: "Codex-One",
      platform: "cli",
      trust: { domains: [{ domain: "code_review", score: 0.47, samples: 0 }] },
    },
  ],
  agora: {},
};

function mockTransport(routes: Record<string, unknown>) {
  const calls: string[] = [];
  return {
    calls,
    fetchJson: async (url: string) => {
      calls.push(url);
      const hit = Object.entries(routes).find(([path]) => url.endsWith(path));
      if (!hit) return { ok: false, status: 404, json: { error: "not_found" } };
      return { ok: true, status: 200, json: hit[1] };
    },
  };
}

describe("createApiClient", () => {
  test("getHealth hits {base}/health and parses the payload", async () => {
    const t = mockTransport({ "/health": HEALTH });
    const api = createApiClient(() => "http://localhost:3700", t.fetchJson);
    const health = await api.getHealth();
    expect(t.calls).toEqual(["http://localhost:3700/health"]);
    expect(health.uptime).toBe(57036.1);
    expect(health.agents.length).toBe(2);
  });

  test("getColony hits {base}/api/colony", async () => {
    const t = mockTransport({ "/api/colony": COLONY });
    const api = createApiClient(() => "http://localhost:3700", t.fetchJson);
    const colony = await api.getColony();
    expect(t.calls).toEqual(["http://localhost:3700/api/colony"]);
    expect(colony.agents[0]!.name).toBe("eli");
  });

  test("getAgent hits {base}/api/agent/:id with encoding", async () => {
    const t = mockTransport({ "/api/agent/a%20b": { name: "a b" } });
    const api = createApiClient(() => "http://x.dev", t.fetchJson);
    const agent = await api.getAgent("a b");
    expect(t.calls).toEqual(["http://x.dev/api/agent/a%20b"]);
    expect(agent.name).toBe("a b");
  });

  test("uses the CURRENT base url at call time (settings change applies immediately)", async () => {
    const t = mockTransport({ "/health": HEALTH });
    let base = "http://old.dev";
    const api = createApiClient(() => base, t.fetchJson);
    await api.getHealth().catch(() => {});
    base = "http://new.dev";
    await api.getHealth().catch(() => {});
    expect(t.calls).toEqual(["http://old.dev/health", "http://new.dev/health"]);
  });

  test("non-ok responses throw", async () => {
    const t = mockTransport({});
    const api = createApiClient(() => "http://x.dev", t.fetchJson);
    await expect(api.getHealth()).rejects.toThrow();
  });
});
