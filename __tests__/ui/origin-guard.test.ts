import { describe, expect, test } from "bun:test";
import { checkRequest, guardConfig } from "../../src/ui/app/origin-guard";

const config = guardConfig(3000, { ANIMA_UI_ALLOWED_ORIGINS: "http://100.64.0.7:3000, https://colony.example" });

function req(method: string, headers: Record<string, string> = {}, host = "127.0.0.1:3000") {
  return new Request("http://127.0.0.1:3000/api/mode", { method, headers: { host, ...headers } });
}
const status = (r: Request) => checkRequest(r, config)?.status ?? 200;

describe("trusted Host", () => {
  test("untrusted Host gets 403 for GET and POST, even when Origin equals it", () => {
    expect(status(req("GET", {}, "evil.example:3000"))).toBe(403);
    expect(status(req("POST", { origin: "http://evil.example:3000" }, "evil.example:3000"))).toBe(403);
  });
  test("loopback names, a listed tailnet address and a listed https host are trusted", () => {
    for (const host of ["127.0.0.1:3000", "localhost:3000", "[::1]:3000", "100.64.0.7:3000", "colony.example"]) {
      expect(status(req("GET", {}, host))).toBe(200);
    }
  });
  test("a loopback Host is trusted on any port (SSH tunnel and desktop forwards pick a random local port)", () => {
    for (const host of ["127.0.0.1:50001", "localhost:50001", "[::1]:50001"]) {
      expect(status(req("GET", {}, host))).toBe(200);
    }
  });
  test("a listed host on the wrong port is untrusted", () => {
    expect(status(req("GET", {}, "100.64.0.7:3001"))).toBe(403);
  });
  test("a missing Host gets 403 whatever the URL says", () => {
    for (const url of ["http://evil.example:3000/api/mode", "http://127.0.0.1:3000/api/mode"]) {
      for (const method of ["GET", "POST"]) {
        expect(status(new Request(url, { method }))).toBe(403);
      }
    }
  });
});

describe("state-changing requests", () => {
  test("same-origin and listed origins pass; listed origin passes even with cross-site metadata", () => {
    expect(status(req("POST", { origin: "http://127.0.0.1:3000" }))).toBe(200);
    expect(status(req("POST", { origin: "http://100.64.0.7:3000", "sec-fetch-site": "cross-site" }, "100.64.0.7:3000"))).toBe(200);
  });
  test("a request with no Origin and no Fetch Metadata (CLI) passes; same-origin metadata passes", () => {
    expect(status(req("POST"))).toBe(200);
    expect(status(req("POST", { "sec-fetch-site": "same-origin" }))).toBe(200);
  });
  test("a foreign Origin gets 403, with and without Fetch Metadata", () => {
    expect(status(req("POST", { origin: "http://evil.example" }))).toBe(403);
    expect(status(req("DELETE", { origin: "http://evil.example", "sec-fetch-site": "cross-site" }))).toBe(403);
  });
  test("a tunnel's own origin passes: Host 127.0.0.1:50001 with Origin http://127.0.0.1:50001", () => {
    expect(status(req("POST", { origin: "http://127.0.0.1:50001" }, "127.0.0.1:50001"))).toBe(200);
    expect(status(req("POST", { origin: "http://localhost:50001" }, "localhost:50001"))).toBe(200);
  });
  test("a page on another origin still gets 403 when the Host is a tunnel port", () => {
    expect(status(req("POST", { origin: "http://127.0.0.1:50002" }, "127.0.0.1:50001"))).toBe(403);
    expect(status(req("POST", { origin: "http://localhost:50001" }, "127.0.0.1:50001"))).toBe(403);
    expect(status(req("POST", { origin: "https://127.0.0.1:50001" }, "127.0.0.1:50001"))).toBe(403);
  });
  test("a configured remote origin keeps its scheme: http Origin with only https configured gets 403, even with cross-site metadata", () => {
    expect(status(req("POST", { origin: "http://colony.example" }, "colony.example"))).toBe(403);
    expect(status(req("POST", { origin: "http://colony.example", "sec-fetch-site": "cross-site" }, "colony.example"))).toBe(403);
    expect(status(req("POST", { origin: "https://colony.example" }, "colony.example"))).toBe(200);
  });
  test("a listed tailnet address on another port gets no same-Host exception", () => {
    expect(status(req("POST", { origin: "http://100.64.0.7:3001" }, "100.64.0.7:3000"))).toBe(403);
  });
  test("look-alike origins get 403: other localhost port, other scheme, other port", () => {
    for (const origin of ["http://localhost:5173", "https://127.0.0.1:3000", "http://127.0.0.1:3001"]) {
      expect(status(req("POST", { origin }))).toBe(403);
    }
  });
  test("Origin null gets 403 and a malformed Origin gets 400", () => {
    expect(status(req("POST", { origin: "null" }))).toBe(403);
    expect(status(req("POST", { origin: "http://" }))).toBe(400);
  });
  test("no Origin with cross-site or same-site metadata gets 403", () => {
    expect(status(req("POST", { "sec-fetch-site": "cross-site" }))).toBe(403);
    expect(status(req("PUT", { "sec-fetch-site": "same-site" }))).toBe(403);
  });
});

describe("safe methods", () => {
  test("GET, HEAD and OPTIONS pass whatever the Origin, when the Host is trusted", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(status(req(method, { origin: "http://evil.example", "sec-fetch-site": "cross-site" }))).toBe(200);
    }
  });
});

describe("guardConfig", () => {
  test("drops unparsable allow-list entries and normalizes the rest", () => {
    const c = guardConfig(3000, { ANIMA_UI_ALLOWED_ORIGINS: "not a url, HTTP://Example.com:80/path" });
    expect(c.allowedOrigins).toContain("http://example.com");
    expect(c.allowedOrigins.some((o) => o.includes("not a url"))).toBe(false);
  });
});
