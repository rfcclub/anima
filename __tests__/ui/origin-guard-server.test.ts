import { afterEach, describe, expect, test } from "bun:test";
import { startUIServer } from "../../src/ui/app/server";

const saved = { host: Bun.env.ANIMA_UI_HOST, port: Bun.env.ANIMA_UI_PORT };
let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  for (const [key, value] of [["ANIMA_UI_HOST", saved.host], ["ANIMA_UI_PORT", saved.port]] as const) {
    if (value === undefined) delete Bun.env[key]; else Bun.env[key] = value;
  }
});

describe("startUIServer bind", () => {
  test("listens on 127.0.0.1 by default", () => {
    delete Bun.env.ANIMA_UI_HOST;
    Bun.env.ANIMA_UI_PORT = "0";
    server = startUIServer();
    expect(server.hostname).toBe("127.0.0.1");
  });

  test("listens on ANIMA_UI_HOST when it is set", () => {
    Bun.env.ANIMA_UI_HOST = "0.0.0.0";
    Bun.env.ANIMA_UI_PORT = "0";
    server = startUIServer();
    expect(server.hostname).toBe("0.0.0.0");
  });

  test("the bound port is trusted and a foreign Host is refused", async () => {
    delete Bun.env.ANIMA_UI_HOST;
    Bun.env.ANIMA_UI_PORT = "0";
    server = startUIServer();
    const ok = await fetch(`http://127.0.0.1:${server.port}/api/version`);
    expect(ok.status).toBe(200);
    const rebind = await fetch(`http://127.0.0.1:${server.port}/api/version`, { headers: { host: "evil.example" } });
    expect(rebind.status).toBe(403);
  });
});
