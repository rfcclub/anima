/**
 * Route inventory — baseline regression net for the route refactor
 *
 * Captures pre-refactor behavior for every route in src/ui/server.ts BEFORE any
 * file moves, so every extraction step has a real "did I break
 * anything" check. Import path updates only as the refactor progresses
 * (src/ui/server.ts -> src/ui/app/router.ts in the final task).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleUIRequest } from "../../src/ui/app/router";

let roomsDir: string;

beforeAll(async () => {
  roomsDir = await mkdtemp(join(tmpdir(), "ui-route-inventory-"));
});

afterAll(async () => {
  await rm(roomsDir, { recursive: true, force: true });
});

describe("route inventory — page routes serve the SPA shell (re-baselined for ui-react-spa-tailwind)", () => {
  test("GET / serves index.html (SPA shell)", async () => {
    const res = await handleUIRequest(new Request("http://localhost:3000/", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("GET /castle serves the SPA shell (Castle2 grounds hub)", async () => {
    const res = await handleUIRequest(new Request("http://localhost:3000/castle", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("GET /cost serves the SPA shell", async () => {
    const res = await handleUIRequest(new Request("http://localhost:3000/cost", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("GET /vn-assets serves the SPA shell", async () => {
    const res = await handleUIRequest(new Request("http://localhost:3000/vn-assets", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("GET /narrative serves the SPA shell", async () => {
    const res = await handleUIRequest(new Request("http://localhost:3000/narrative", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("GET /logs serves the SPA shell", async () => {
    const res = await handleUIRequest(new Request("http://localhost:3000/logs", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(200);
  });

  test("GET /hall serves the SPA shell", async () => {
    const res = await handleUIRequest(new Request("http://localhost:3000/hall", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("GET /rooms/bruno serves the SPA shell (Pixi-VN via client router)", async () => {
    const res = await handleUIRequest(new Request("http://localhost:3000/rooms/bruno", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("GET /stage/bruno serves the SPA shell (same as /rooms/:agent)", async () => {
    const res = await handleUIRequest(new Request("http://localhost:3000/stage/bruno", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("GET /castle2 has no dedicated route — falls through to the SPA shell", async () => {
    // The castle2 bundle-serving route was removed with packages/castle-vn
    // . /castle2 is no longer special; it's just an unmatched
    // path, served like any other client-side route.
    const res = await handleUIRequest(new Request("http://localhost:3000/castle2", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("GET /castle2/../../../etc/passwd is normalized to a harmless route (no internal file leak)", async () => {
    // URL parsing normalizes /castle2/../../../etc/passwd → /etc/passwd, which is just a
    // route name. The server serves the SPA shell (safe), never reads /etc/passwd off disk.
    const res = await handleUIRequest(new Request("http://localhost:3000/castle2/../../../etc/passwd", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain('<div id="root">'); // SPA shell, not /etc/passwd contents
    expect(body).not.toContain("root:"); // not /etc/passwd
  });

  test("GET /components/App.tsx is served as JS (static transpile)", async () => {
    const res = await handleUIRequest(new Request("http://localhost:3000/components/App.tsx", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  test("GET /styles/town.css falls back to SPA shell (town.css archived)", async () => {
    // town.css migrated to Tailwind + archived. Path no longer serves a stylesheet;
    // SPA fallback returns index.html.
    const res = await handleUIRequest(new Request("http://localhost:3000/styles/town.css", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct.includes("text/html") || ct.includes("text/css")).toBe(true);
  });
});

describe("route inventory — API routes respond with expected status", () => {
  test("GET /api/status returns agents + meetingTopics shape", async () => {
    const res = await handleUIRequest(new Request("http://localhost:3000/api/status", { headers: { host: "localhost:3000" } }), { roomsDir });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("agents");
    expect(body).toHaveProperty("meetingTopics");
  });

  test("GET /api/mode returns a mode string", async () => {
    const res = await handleUIRequest(new Request("http://localhost:3000/api/mode", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("mode");
  });

  test("GET /api/cost with no cost DB returns the no-data shape", async () => {
    const res = await handleUIRequest(new Request("http://localhost:3000/api/cost", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("summary");
  });

  test("GET /api/vn/assets returns an assets listing", async () => {
    const res = await handleUIRequest(new Request("http://localhost:3000/api/vn/assets", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(200);
  });

  test("GET /api/castle/presence returns an agents array", async () => {
    const res = await handleUIRequest(new Request("http://localhost:3000/api/castle/presence", { headers: { host: "localhost:3000" } }), { roomsDir });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("agents");
  });

  test("GET /api/nonexistent returns 404 not_found", async () => {
    const res = await handleUIRequest(new Request("http://localhost:3000/api/nonexistent", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "not_found" });
  });

  test("GET /api/models returns a models list", async () => {
    const res = await handleUIRequest(new Request("http://localhost:3000/api/models", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(200);
  });
});
