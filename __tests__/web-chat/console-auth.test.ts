import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsoleAuth } from "../../src/web-chat/console-auth";

const roots: string[] = [];
const origin = "http://127.0.0.1:3080";
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "console-auth-"));
  roots.push(root);
  let now = 1000;
  const auth = new ConsoleAuth({ root, origin, now: () => now });
  const secret = readFileSync(join(root, "operator-token"), "utf8").trim();
  const request = (
    method = "GET",
    headers: Record<string, string> = {},
    body?: string,
  ) =>
    new Request(`${origin}/api/accounts`, {
      method,
      headers: { host: "127.0.0.1:3080", ...headers },
      body,
    });
  const login = (token = secret) =>
    auth.login(
      request(
        "POST",
        { origin, "content-type": "application/json" },
        JSON.stringify({ token }),
      ),
    );
  return {
    root,
    auth,
    secret,
    request,
    login,
    advance: () => (now += 3_600_001),
  };
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("SC-1: bootstrap secret is private, persistent, and never a URL credential", async () => {
  const s = setup();
  expect(statSync(join(s.root, "operator-token")).mode & 0o777).toBe(0o600);
  const again = new ConsoleAuth({ root: s.root, origin });
  expect(readFileSync(join(s.root, "operator-token"), "utf8").trim()).toBe(
    s.secret,
  );
  expect(s.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const query = new Request(`${origin}/api/accounts?token=${s.secret}`, {
    headers: { host: "127.0.0.1:3080" },
  });
  expect((again.authorize(query) as Response).status).toBe(401);
  expect((await s.login("wrong")).status).toBe(401);
});

test("SC-1/SC-5: authenticated session, CSRF, expiry and logout are enforced", async () => {
  const s = setup();
  expect((s.auth.authorize(s.request()) as Response).status).toBe(401);
  const response = await s.login();
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie")!;
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Strict");
  expect(setCookie).toContain("Path=/");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.clone().text()).not.toContain(s.secret);
  const { csrf } = await response.json();
  const cookie = setCookie.split(";")[0]!;
  const session = s.auth.authorize(s.request("GET", { cookie }));
  expect(session).not.toBeInstanceOf(Response);
  expect(
    (s.auth.authorize(s.request("POST", { cookie, origin })) as Response)
      .status,
  ).toBe(403);
  expect(
    (
      s.auth.authorize(
        s.request("POST", { cookie, origin, "x-console-csrf": "wrong" }),
      ) as Response
    ).status,
  ).toBe(403);
  expect(
    s.auth.authorize(
      s.request("POST", { cookie, origin, "x-console-csrf": csrf }),
    ),
  ).not.toBeInstanceOf(Response);
  expect(
    (
      s.auth.authorize(
        s.request("GET", { cookie, "sec-fetch-site": "cross-site" }),
      ) as Response
    ).status,
  ).toBe(403);
  const logout = s.auth.logout(
    s.request("POST", { cookie, origin, "x-console-csrf": csrf }),
  );
  expect(logout.status).toBe(200);
  expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(
    (s.auth.authorize(s.request("GET", { cookie })) as Response).status,
  ).toBe(401);
  const second = await s.login();
  const secondCookie = second.headers.get("set-cookie")!.split(";")[0]!;
  s.advance();
  expect(
    (s.auth.authorize(s.request("GET", { cookie: secondCookie })) as Response)
      .status,
  ).toBe(401);
});

test("SC-1: foreign Host/Origin, duplicate cookies and forged owner fields are refused", async () => {
  const s = setup();
  for (const headers of [
    { host: "evil.test", origin },
    { host: "127.0.0.1:3080", origin: "https://evil.test" },
    { host: "127.0.0.1:3080" },
  ]) {
    const response = await s.auth.login(
      new Request(`${origin}/api/login`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ token: s.secret }),
      }),
    );
    expect(response.status).toBe(403);
  }
  const forged = await s.auth.login(
    s.request(
      "POST",
      {
        origin,
        "content-type": "application/json",
      },
      JSON.stringify({ token: s.secret, agent: "eli", session: "forged" }),
    ),
  );
  expect(forged.status).toBe(400);
  const response = await s.login();
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  expect(
    (
      s.auth.authorize(
        s.request("GET", { cookie: `${cookie}; ${cookie}` }),
      ) as Response
    ).status,
  ).toBe(401);
  expect(
    (
      s.auth.authorize(
        s.request("GET", { cookie, host: "evil.test" }),
      ) as Response
    ).status,
  ).toBe(403);
});

test("SC-1: malformed/oversized login bodies and session capacity fail closed", async () => {
  const s = setup();
  for (const body of [
    "{",
    "null",
    JSON.stringify({ token: "x".repeat(5000) }),
  ]) {
    const response = await s.auth.login(
      s.request(
        "POST",
        {
          origin,
          "content-type": "application/json",
        },
        body,
      ),
    );
    expect([400, 413]).toContain(response.status);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  for (let i = 0; i < 8; i++) expect((await s.login()).status).toBe(200);
  expect((await s.login()).status).toBe(429);
  s.advance();
  expect((await s.login()).status).toBe(200);
});

test("SC-1/SC-5: unsafe bootstrap paths are rejected without modifying targets", () => {
  const root = mkdtempSync(join(tmpdir(), "console-unsafe-"));
  roots.push(root);
  const target = join(root, "original");
  writeFileSync(target, "do not alter", { mode: 0o600 });
  symlinkSync(target, join(root, "operator-token"));
  expect(() => new ConsoleAuth({ root, origin })).toThrow();
  expect(readFileSync(target, "utf8")).toBe("do not alter");
  rmSync(join(root, "operator-token"));
  writeFileSync(join(root, "operator-token"), "x".repeat(43), { mode: 0o600 });
  chmodSync(join(root, "operator-token"), 0o644);
  expect(() => new ConsoleAuth({ root, origin })).toThrow();
});

test("SC-1: authentication is loopback-only and login/logout require same-origin POST", async () => {
  const s = setup();
  for (const invalid of [
    "http://0.0.0.0:3080",
    "http://192.168.1.2:3080",
    "http://127.0.0.1:3080/path",
    "http://user@127.0.0.1:3080",
  ])
    expect(() => new ConsoleAuth({ root: s.root, origin: invalid })).toThrow();
  expect((await s.auth.login(s.request())).status).toBe(405);
  const response = await s.login();
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  expect(s.auth.logout(s.request("GET", { cookie })).status).toBe(405);
  expect(
    (
      s.auth.authorize(
        s.request("GET", { cookie, origin: "https://evil.test" }),
      ) as Response
    ).status,
  ).toBe(403);
  const noType = await s.auth.login(
    s.request("POST", { origin }, JSON.stringify({ token: s.secret })),
  );
  expect(noType.status).toBe(415);
  chmodSync(join(s.root, "operator-token"), 0o600);
  writeFileSync(join(s.root, "operator-token"), "invalid");
  expect(() => new ConsoleAuth({ root: s.root, origin })).toThrow();
});
