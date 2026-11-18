import { describe, test, expect } from "bun:test";
import { resolveApiEndpoints, healthUrl, type ResolvedEndpoints } from "./endpoints";
import type { ApiProfile } from "./settings";

describe("resolveApiEndpoints", () => {
  const base: ApiProfile = {
    name: "prod",
    type: "api",
    baseUrl: "https://host.example.ts.net",
  };

  test("derives town/openclaw/chat/api from baseUrl", () => {
    const e: ResolvedEndpoints = resolveApiEndpoints(base);
    expect(e.town).toBe("https://host.example.ts.net/town/");
    expect(e.openclaw).toBe("https://host.example.ts.net/openclaw/");
    expect(e.chat).toBe("https://host.example.ts.net/chat/");
    expect(e.api).toBe("https://host.example.ts.net");
  });

  test("strips trailing slash from baseUrl before joining", () => {
    const e = resolveApiEndpoints({ ...base, baseUrl: "http://localhost:8443/" });
    expect(e.town).toBe("http://localhost:8443/town/");
    expect(e.api).toBe("http://localhost:8443");
  });

  test("chatUrl overrides the chat endpoint only", () => {
    const e = resolveApiEndpoints({ ...base, chatUrl: "https://chat.example.com/nexus" });
    expect(e.chat).toBe("https://chat.example.com/nexus");
    expect(e.town).toBe("https://host.example.ts.net/town/");
  });
});

describe("healthUrl", () => {
  test("appends /anima/health to the api endpoint", () => {
    expect(healthUrl("https://x.dev")).toBe("https://x.dev/anima/health");
    expect(healthUrl("http://127.0.0.1:50003")).toBe("http://127.0.0.1:50003/anima/health");
    expect(healthUrl("https://x.dev/")).toBe("https://x.dev/anima/health");
  });
});
