import { describe, test, expect } from "bun:test";
import { handleUIRequest } from "../../../src/ui/app/router";

describe("SC-006/007/008 (spa-shell) + SC-006 (backend-preservation): SPA fallback", () => {
  test("GET /unknown-client-route returns SPA shell (index.html)", async () => {
    const res = await handleUIRequest(new Request("http://localhost:3000/unknown-client-route", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain('<div id="root">');
  });

  test("GET /api/nonexistent returns JSON 404, not SPA shell", async () => {
    const res = await handleUIRequest(new Request("http://localhost:3000/api/nonexistent", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });

  test("GET /vn/engines/character-engine.js serves asset OR SPA shell (engines archived in source)", async () => {
    // Legacy stage engines are archived in source (_archive/). The deployed copy
    // at ~/.anima/ui/engines/ may linger until redeploy — either way is acceptable:
    // the asset (if deployed) or the SPA shell (if not).
    const res = await handleUIRequest(new Request("http://localhost:3000/vn/engines/character-engine.js", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct.includes("javascript") || ct.includes("text/html")).toBe(true);
  });
});

