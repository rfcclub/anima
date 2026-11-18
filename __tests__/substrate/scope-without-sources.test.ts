import { expect, test } from "bun:test";
import { MappedFilesystemAdapter } from "../../src/substrate/mapped-filesystem-adapter";

// Lena's map declares a `nocturne` scope shaped {sourcing, exposure, retention} with no `sources`
// list. That crashed listScopes() ("cfg.sources.map"), so her projection could not compile and she
// could not be an identity-runtime tenant. A scope without sources contributes nothing; it must not throw.
const map = JSON.stringify({
  version: 1,
  agent_id: "lena",
  substrate_type: "test",
  root: "/tmp/lena-nonexistent",
  required_scopes: ["identity_core"],
  scopes: {
    identity_core: { required: true, sources: [{ type: "paths", paths: ["SOUL.md"], trust: "high", weight: 1 }] },
    nocturne: { required: false, sourcing: "private", exposure: "none", retention: "session" },
  },
});

test("a scope with no sources lists as empty instead of throwing", () => {
  const adapter = new MappedFilesystemAdapter(map);
  const scopes = adapter.listScopes();
  expect(scopes.map((s) => s.name)).toEqual(["identity_core", "nocturne"]);
  expect(scopes.find((s) => s.name === "nocturne")?.sources).toEqual([]);
});

test("resolving a scope with no sources yields no files", () => {
  const adapter = new MappedFilesystemAdapter(map);
  expect(adapter.hasScope("nocturne")).toBe(true);
  expect(adapter.resolve("nocturne").files).toEqual([]);
});
