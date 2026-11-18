import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvKeys } from "../src/load-env-keys.ts";

// The identity-runtime service definition carries no embedded provider credential.
// The key is loaded from ~/.anima/anima.env. The runtime loads ONLY the keys it names from that file —
// never the whole file — and never puts a credential in the plist or source.

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "load-env-keys-"));
  file = join(dir, "anima.env");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (text: string) => writeFileSync(file, text);

describe("loadEnvKeys", () => {
  test("loads a named key into the environment and reports its name, not its value", () => {
    write("TYPESAFE_API_KEY=sk-test-123\n");
    const env: Record<string, string | undefined> = {};
    const loaded = loadEnvKeys(file, ["TYPESAFE_API_KEY"], env);
    expect(env.TYPESAFE_API_KEY).toBe("sk-test-123");
    expect(loaded).toEqual(["TYPESAFE_API_KEY"]);
    expect(JSON.stringify(loaded)).not.toContain("sk-test-123");
  });

  test("loads only the allowed keys — every other secret in the file stays out", () => {
    write("OPENAI_API_KEY=other-secret\nTYPESAFE_API_KEY=sk-test\nANTHROPIC_API_KEY=another\n");
    const env: Record<string, string | undefined> = {};
    loadEnvKeys(file, ["TYPESAFE_API_KEY"], env);
    expect(Object.keys(env)).toEqual(["TYPESAFE_API_KEY"]);
  });

  test("handles quotes, an export prefix, comments, blank lines and CRLF", () => {
    write('# a comment\r\n\r\nexport TYPESAFE_API_KEY="sk-quoted"\r\nOTHER=x\r\n');
    const env: Record<string, string | undefined> = {};
    loadEnvKeys(file, ["TYPESAFE_API_KEY"], env);
    expect(env.TYPESAFE_API_KEY).toBe("sk-quoted");
  });

  test("single-quoted values lose their quotes; values may contain '='", () => {
    write("TYPESAFE_API_KEY='sk-a=b=c'\n");
    const env: Record<string, string | undefined> = {};
    loadEnvKeys(file, ["TYPESAFE_API_KEY"], env);
    expect(env.TYPESAFE_API_KEY).toBe("sk-a=b=c");
  });

  test("never overrides a value already in the environment", () => {
    write("TYPESAFE_API_KEY=from-file\n");
    const env: Record<string, string | undefined> = { TYPESAFE_API_KEY: "from-launchd" };
    const loaded = loadEnvKeys(file, ["TYPESAFE_API_KEY"], env);
    expect(env.TYPESAFE_API_KEY).toBe("from-launchd");
    expect(loaded).toEqual([]);
  });

  test("an empty existing value counts as unset", () => {
    write("TYPESAFE_API_KEY=from-file\n");
    const env: Record<string, string | undefined> = { TYPESAFE_API_KEY: "" };
    loadEnvKeys(file, ["TYPESAFE_API_KEY"], env);
    expect(env.TYPESAFE_API_KEY).toBe("from-file");
  });

  test("a missing file, an unreadable file, or an absent key is not an error", () => {
    const env: Record<string, string | undefined> = {};
    expect(loadEnvKeys(join(dir, "nope.env"), ["TYPESAFE_API_KEY"], env)).toEqual([]);
    write("SOMETHING_ELSE=1\n");
    expect(loadEnvKeys(file, ["TYPESAFE_API_KEY"], env)).toEqual([]);
    expect(env).toEqual({});
  });

  test("an empty value in the file is ignored rather than set", () => {
    write("TYPESAFE_API_KEY=\n");
    const env: Record<string, string | undefined> = {};
    expect(loadEnvKeys(file, ["TYPESAFE_API_KEY"], env)).toEqual([]);
    expect(env.TYPESAFE_API_KEY).toBeUndefined();
  });
});
