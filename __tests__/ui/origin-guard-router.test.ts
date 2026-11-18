import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleUIRequest } from "../../src/ui/app/router";
import { guardConfig } from "../../src/ui/app/origin-guard";

const dir = mkdtempSync(join(tmpdir(), "origin-guard-"));
const deps = { roomsDir: join(dir, "rooms"), stateDir: dir, guard: guardConfig(3000, {}) };
const post = (path: string, headers: Record<string, string>, body?: BodyInit) =>
  handleUIRequest(new Request(`http://127.0.0.1:3000${path}`, { method: "POST", headers: { host: "127.0.0.1:3000", ...headers }, body }), deps);

describe("the guard runs before every feature module", () => {
  for (const path of ["/api/talk/milo", "/api/castle/presence/enter", "/api/vn/assets/delete", "/api/mode"]) {
    test(`cross-origin POST ${path} gets the guard's 403`, async () => {
      const res = await post(path, { origin: "http://evil.example", "content-type": "application/json" }, "{}");
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("origin_not_allowed");
    });
  }

  test("a DNS-rebinding GET never reaches the SPA shell or the API", async () => {
    const res = await handleUIRequest(new Request("http://evil.example:3000/api/mode", { headers: { host: "evil.example:3000" } }), deps);
    expect(res.status).toBe(403);
  });

  test("a same-origin multipart upload is not stopped by the guard", async () => {
    const form = new FormData();
    form.append("file", new File(["x"], "x.png", { type: "image/png" }));
    const res = await post("/api/vn/assets/upload", { origin: "http://127.0.0.1:3000" }, form);
    expect((await res.clone().text()).includes("origin_")).toBe(false);
    expect(res.status).not.toBe(403);
  });

  test("a same-origin and a headerless POST reach the handler", async () => {
    for (const headers of [{ origin: "http://127.0.0.1:3000" }, {}]) {
      const res = await post("/api/mode", { "content-type": "application/json", ...headers }, JSON.stringify({ mode: "plan" }));
      expect(res.status).toBe(200);
    }
  });
});
