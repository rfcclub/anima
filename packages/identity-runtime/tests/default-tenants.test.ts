import { expect, test } from "bun:test";
import { createDefaultTenantDefinitions } from "../src/default-tenants.ts";

test("builds Eli, Bruno and abel tenants with their own ANIMA continuity paths", async () => {
  const urls: string[] = [];
  const tenants = createDefaultTenantDefinitions({
    animaOrigin: "http://anima",
    fetcher: async (input) => {
      urls.push(input);
      return Response.json({});
    },
  });

  await tenants.get("eli")?.continuity.compile({
    identity: "eli",
    surfaceId: "codex",
    message: "hello",
  });
  await tenants.get("bruno")?.continuity.compile({
    identity: "bruno",
    surfaceId: "claude",
    message: "hello",
  });

  await tenants.get("abel")?.continuity.compile({
    identity: "abel",
    surfaceId: "claude",
    message: "hello",
  });

  expect([...tenants.keys()]).toEqual(["eli", "bruno", "abel"]);
  expect(urls).toEqual([
    "http://anima/internal/continuity/eli/compile",
    "http://anima/internal/continuity/bruno/compile",
    "http://anima/internal/continuity/abel/compile",
  ]);
  expect(tenants.get("bruno")?.recallPolicy).toBeDefined();
  expect(tenants.get("eli")?.recallPolicy).toBeUndefined();
  expect(tenants.get("abel")?.recallPolicy).toBeUndefined();
});

test("registers every roster agent it is given as its own tenant, after eli and bruno", async () => {
  const urls: string[] = [];
  const tenants = createDefaultTenantDefinitions({
    animaOrigin: "http://anima",
    agentIds: ["finn", "lena"],
    agentPlatform: "macos",
    fetcher: async (input) => { urls.push(input); return Response.json({}); },
  });

  expect([...tenants.keys()]).toEqual(["eli", "bruno", "finn", "lena"]);
  await tenants.get("lena")?.continuity.compile({ identity: "lena", surfaceId: "claude", message: "hello" });
  expect(urls).toEqual(["http://anima/internal/continuity/lena/compile"]);
  expect(tenants.get("lena")?.platform).toBe("macos");
  expect(tenants.get("lena")?.recallPolicy).toBeUndefined();
});
