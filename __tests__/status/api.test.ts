import { test, expect } from "bun:test";
import { handleStatus } from "../../src/ui/features/status/routes";
import { join } from "node:path";

const FIXTURE_ROOT = join(import.meta.dir, "__fixtures__", "openspec");

test("status API returns JSON with the snapshot shape", async () => {
  const res = await handleStatus(new Request("http://localhost/api/projects"), FIXTURE_ROOT);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.generatedAt).toBeTruthy();
  expect(Array.isArray(body.activeChanges)).toBe(true);
  expect(Array.isArray(body.archivedChanges)).toBe(true);
  expect(body.summary.active).toBeGreaterThan(0);
});

test("status API still returns a snapshot when a change is malformed", async () => {
  const res = await handleStatus(new Request("http://localhost/api/projects"), FIXTURE_ROOT);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.activeChanges.map((c: { name: string }) => c.name)).toContain("active-malformed");
});

test("status API returns 200 with empty snapshot for a missing root", async () => {
  const res = await handleStatus(new Request("http://localhost/api/projects"), "/nonexistent/openspec");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.activeChanges).toEqual([]);
  expect(body.summary.active).toBe(0);
});

test("feature routes wire /api/projects through the UI server", async () => {
  const { routes } = await import("../../src/ui/features/status/routes");
  const res = await routes(new Request("http://localhost/api/projects", { method: "GET" }), "/api/projects");
  expect(res).not.toBeNull();
  expect(res!.status).toBe(200);
});
