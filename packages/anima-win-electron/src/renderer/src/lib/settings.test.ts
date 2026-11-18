import { describe, test, expect } from "bun:test";
import {
  DEFAULT_API_URL,
  normalizeApiUrl,
  createSettingsStore,
} from "./settings";

describe("normalizeApiUrl", () => {
  test("accepts http/https URLs and strips trailing slash", () => {
    expect(normalizeApiUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeApiUrl("http://localhost:3700/")).toBe("http://localhost:3700");
    expect(normalizeApiUrl("https://x.dev/api/")).toBe("https://x.dev/api");
  });

  test("trims whitespace", () => {
    expect(normalizeApiUrl("  http://a.dev  ")).toBe("http://a.dev");
  });

  test("rejects non-http schemes and garbage", () => {
    expect(normalizeApiUrl("ftp://x.dev")).toBeNull();
    expect(normalizeApiUrl("localhost:3000")).toBeNull();
    expect(normalizeApiUrl("")).toBeNull();
    expect(normalizeApiUrl("not a url")).toBeNull();
  });
});

describe("createSettingsStore", () => {
  const memoryBackend = () => {
    const m = new Map<string, string>();
    return {
      get: (k: string) => m.get(k) ?? null,
      set: (k: string, v: string) => void m.set(k, v),
    };
  };

  test("defaults to DEFAULT_API_URL when empty", () => {
    const store = createSettingsStore(memoryBackend());
    expect(store.getApiUrl()).toBe(DEFAULT_API_URL);
    expect(DEFAULT_API_URL).toBe("http://localhost:3000");
  });

  test("persists a valid URL and returns it", () => {
    const backend = memoryBackend();
    const store = createSettingsStore(backend);
    expect(store.setApiUrl("http://localhost:3700/")).toBe(true);
    expect(store.getApiUrl()).toBe("http://localhost:3700");
    // survives a fresh store on the same backend
    expect(createSettingsStore(backend).getApiUrl()).toBe("http://localhost:3700");
  });

  test("rejects an invalid URL and keeps the old value", () => {
    const store = createSettingsStore(memoryBackend());
    store.setApiUrl("http://good.dev");
    expect(store.setApiUrl("garbage")).toBe(false);
    expect(store.getApiUrl()).toBe("http://good.dev");
  });

  test("notifies subscribers on change", () => {
    const store = createSettingsStore(memoryBackend());
    const seen: string[] = [];
    store.subscribe((url) => seen.push(url));
    store.setApiUrl("http://one.dev");
    store.setApiUrl("bad"); // no notification
    store.setApiUrl("http://two.dev/");
    expect(seen).toEqual(["http://one.dev", "http://two.dev"]);
  });
});
