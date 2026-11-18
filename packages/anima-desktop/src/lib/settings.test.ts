import { describe, test, expect } from "bun:test";
import {
  defaultSettings,
  parseSettings,
  serializeSettings,
  validateProfile,
  upsertProfile,
  removeProfile,
  setActiveProfile,
  getActiveProfile,
  DEFAULT_SERVER_URL,
  type Settings,
  type Profile,
} from "./settings";

describe("defaultSettings", () => {
  test("has one API profile pointing at the default Tailscale URL", () => {
    const s = defaultSettings();
    expect(s.profiles.length).toBe(1);
    const p = s.profiles[0]!;
    expect(p.type).toBe("api");
    if (p.type === "api") expect(p.baseUrl).toBe(DEFAULT_SERVER_URL);
    expect(s.activeProfile).toBe(p.name);
  });

  test("defaults to dark theme, town view", () => {
    const s = defaultSettings();
    expect(s.theme).toBe("dark");
    expect(s.lastView).toBe("town");
  });
});

describe("validateProfile", () => {
  test("accepts a valid API profile", () => {
    const p: Profile = { name: "prod", type: "api", baseUrl: "https://example.com" };
    expect(validateProfile(p)).toEqual([]);
  });

  test("rejects API baseUrl without http/https scheme", () => {
    const p: Profile = { name: "bad", type: "api", baseUrl: "ftp://example.com" };
    expect(validateProfile(p).length).toBeGreaterThan(0);
    const p2: Profile = { name: "bad2", type: "api", baseUrl: "example.com" };
    expect(validateProfile(p2).length).toBeGreaterThan(0);
  });

  test("rejects invalid chatUrl but allows it absent", () => {
    const ok: Profile = { name: "a", type: "api", baseUrl: "http://x.dev" };
    expect(validateProfile(ok)).toEqual([]);
    const bad: Profile = { name: "a", type: "api", baseUrl: "http://x.dev", chatUrl: "nope" };
    expect(validateProfile(bad).length).toBeGreaterThan(0);
  });

  test("rejects empty profile name", () => {
    const p: Profile = { name: "  ", type: "api", baseUrl: "https://x.dev" };
    expect(validateProfile(p).length).toBeGreaterThan(0);
  });

  test("accepts a valid SSH profile", () => {
    const p: Profile = {
      name: "host-1",
      type: "ssh",
      host: "192.0.2.10",
      port: 22,
      user: "user",
      keyPath: "~/.ssh/id_ed25519",
      remotePorts: { town: 3000, openclaw: 18789, api: 3700, chat: 3700 },
    };
    expect(validateProfile(p)).toEqual([]);
  });

  test("rejects SSH profile with missing host or user, bad port", () => {
    const base = {
      name: "x",
      type: "ssh" as const,
      host: "h",
      port: 22,
      user: "u",
      remotePorts: { town: 3000, openclaw: 18789, api: 3700, chat: 3700 },
    };
    expect(validateProfile({ ...base, host: "" }).length).toBeGreaterThan(0);
    expect(validateProfile({ ...base, user: "" }).length).toBeGreaterThan(0);
    expect(validateProfile({ ...base, port: 0 }).length).toBeGreaterThan(0);
    expect(validateProfile({ ...base, port: 70000 }).length).toBeGreaterThan(0);
  });
});

describe("profile operations", () => {
  const ssh: Profile = {
    name: "tunnel",
    type: "ssh",
    host: "host-1.local",
    port: 22,
    user: "user",
    agent: true,
    remotePorts: { town: 3000, openclaw: 18789, api: 3700, chat: 3700 },
  };

  test("upsertProfile adds a new profile", () => {
    const s = defaultSettings();
    const s2 = upsertProfile(s, ssh);
    expect(s2.profiles.length).toBe(2);
    expect(s2.profiles.find((p) => p.name === "tunnel")).toBeDefined();
    // original untouched (immutability)
    expect(s.profiles.length).toBe(1);
  });

  test("upsertProfile replaces an existing profile by name", () => {
    const s = upsertProfile(defaultSettings(), ssh);
    const s2 = upsertProfile(s, { ...ssh, host: "other.host" });
    expect(s2.profiles.length).toBe(2);
    const got = s2.profiles.find((p) => p.name === "tunnel");
    expect(got && got.type === "ssh" ? got.host : "").toBe("other.host");
  });

  test("removeProfile removes and falls back active profile", () => {
    let s = upsertProfile(defaultSettings(), ssh);
    s = setActiveProfile(s, "tunnel");
    const s2 = removeProfile(s, "tunnel");
    expect(s2.profiles.find((p) => p.name === "tunnel")).toBeUndefined();
    expect(s2.activeProfile).toBe(s2.profiles[0]!.name);
  });

  test("removeProfile refuses to remove the last profile", () => {
    const s = defaultSettings();
    const s2 = removeProfile(s, s.profiles[0]!.name);
    expect(s2.profiles.length).toBe(1);
  });

  test("setActiveProfile ignores unknown names", () => {
    const s = defaultSettings();
    const s2 = setActiveProfile(s, "ghost");
    expect(s2.activeProfile).toBe(s.activeProfile);
  });

  test("getActiveProfile returns the active profile object", () => {
    let s = upsertProfile(defaultSettings(), ssh);
    s = setActiveProfile(s, "tunnel");
    expect(getActiveProfile(s).name).toBe("tunnel");
  });
});

describe("parse / serialize round-trip", () => {
  test("round-trips settings", () => {
    let s = upsertProfile(defaultSettings(), {
      name: "local",
      type: "api",
      baseUrl: "http://localhost:8443",
    });
    s = setActiveProfile(s, "local");
    const s2 = parseSettings(serializeSettings(s));
    expect(s2).toEqual(s);
  });

  test("parseSettings falls back to defaults on garbage", () => {
    expect(parseSettings("not json")).toEqual(defaultSettings());
    expect(parseSettings("{}")).toEqual(defaultSettings());
    expect(parseSettings('{"profiles": []}')).toEqual(defaultSettings());
  });

  test("parseSettings drops invalid profiles but keeps valid ones", () => {
    const raw = JSON.stringify({
      profiles: [
        { name: "good", type: "api", baseUrl: "https://ok.dev" },
        { name: "bad", type: "api", baseUrl: "no-scheme" },
      ],
      activeProfile: "bad",
      lastView: "chat",
      theme: "light",
    });
    const s: Settings = parseSettings(raw);
    expect(s.profiles.length).toBe(1);
    expect(s.profiles[0]!.name).toBe("good");
    // active pointed at a dropped profile -> falls back to first valid
    expect(s.activeProfile).toBe("good");
    expect(s.lastView).toBe("chat");
    expect(s.theme).toBe("light");
  });
});
