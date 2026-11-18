import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchIdentityProjection } from "./fetch-projection.ts";

describe("fetchIdentityProjection", () => {
  test("sends Eli's fixed path-scoped join request without a body identity", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    const projection = await fetchIdentityProjection({
      origin: "http://127.0.0.1:13541/",
      tenant: "eli",
      clientId: "codex",
      surfaceId: "codex-eli",
      message: "Fetch Eli identity.",
      fetcher: async (url, init) => {
        calls.push({ url, init });
        return Response.json({ projection: "Eli projection" });
      },
    });

    expect(projection).toBe("Eli projection");
    expect(calls).toEqual([{
      url: "http://127.0.0.1:13541/identity-runtime/eli/join",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "codex",
          surfaceId: "codex-eli",
          message: "Fetch Eli identity.",
        }),
      },
    }]);
  });

  test("sends Bruno's fixed path-scoped join request", async () => {
    const calls: string[] = [];

    await fetchIdentityProjection({
      origin: "http://identity-runtime.test",
      tenant: "bruno",
      clientId: "claude",
      surfaceId: "claudia-bruno",
      message: "Fetch Bruno identity.",
      fetcher: async (url) => {
        calls.push(url);
        return Response.json({ projection: "Bruno projection" });
      },
    });

    expect(calls).toEqual(["http://identity-runtime.test/identity-runtime/bruno/join"]);
  });

  test("rejects a successful response without a non-empty projection", async () => {
    await expect(fetchIdentityProjection({
      origin: "http://identity-runtime.test",
      tenant: "eli",
      clientId: "codex",
      surfaceId: "codex-eli",
      message: "Fetch Eli identity.",
      fetcher: async () => Response.json({ projection: "" }),
    })).rejects.toThrow("join failed");
  });
});

test("Windows tenant launchers use only fixed unified join routes", () => {
  const eli = readFileSync(join(import.meta.dir, "..", "codex", "codex-eli.ps1"), "utf8");
  const bruno = readFileSync(join(import.meta.dir, "..", "claude", "claude-bruno.ps1"), "utf8");

  expect(eli).toContain("IDENTITY_RUNTIME_URL");
  expect(eli).toContain("/identity-runtime/eli/join");
  expect(eli).not.toContain("ELI_RUNTIME_URL");
  expect(eli).not.toContain("/v1/join");
  expect(eli).not.toContain("agentId");

  expect(bruno).toContain("IDENTITY_RUNTIME_URL");
  expect(bruno).toContain("/identity-runtime/bruno/join");
  expect(bruno).not.toContain("BRUNO_RUNTIME_URL");
  expect(bruno).not.toContain("/v1/join");
  expect(bruno).not.toContain("agentId");
  expect(bruno).not.toContain("sk-");
});
