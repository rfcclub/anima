import { describe, expect, test } from "bun:test";
import { buildMatcher, createGuard, loadSensitiveTerms, termsFilePath } from "./sensitive-terms.ts";

const read = (files: Record<string, string>) => (path: string) => {
  if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  return files[path];
};

describe("termsFilePath", () => {
  test("uses ANIMA_SENSITIVE_TERMS_FILE when set", () => {
    expect(termsFilePath({ ANIMA_SENSITIVE_TERMS_FILE: "/x/terms.json" }, "/home/user")).toBe("/x/terms.json");
  });
  test("defaults to ~/.anima/sensitive-terms.json", () => {
    expect(termsFilePath({}, "/home/user")).toBe("/home/user/.anima/sensitive-terms.json");
  });
});

describe("loadSensitiveTerms", () => {
  const path = "/home/user/.anima/sensitive-terms.json";
  const load = (files: Record<string, string>) => loadSensitiveTerms({ env: {}, home: "/home/user", read: read(files) });

  test("reads phrases and words from the file", () => {
    expect(load({ [path]: JSON.stringify({ phrases: ["secret-topic"], words: ["hush"] }) })).toEqual({
      phrases: ["secret-topic"],
      words: ["hush"],
    });
  });
  test("a missing key means an empty list", () => {
    expect(load({ [path]: JSON.stringify({ words: ["hush"] }) })).toEqual({ phrases: [], words: ["hush"] });
  });
  test("a missing file gives null (the guard is not available)", () => {
    expect(load({})).toBeNull();
  });
  test.each([
    ["invalid JSON", "{not json"],
    ["a non-object", JSON.stringify(["a"])],
    ["phrases that are not strings", JSON.stringify({ phrases: [1] })],
    ["words that are not an array", JSON.stringify({ words: "hush" })],
    ["a term that is not a valid regular expression", JSON.stringify({ phrases: ["(unclosed"] })],
  ])("%s gives null", (_label, body) => {
    expect(load({ [path]: body })).toBeNull();
  });
  test("honours the env override", () => {
    const terms = loadSensitiveTerms({
      env: { ANIMA_SENSITIVE_TERMS_FILE: "/custom.json" },
      home: "/home/user",
      read: read({ "/custom.json": JSON.stringify({ phrases: ["p"] }) }),
    });
    expect(terms).toEqual({ phrases: ["p"], words: [] });
  });
});

describe("buildMatcher", () => {
  const m = buildMatcher({ phrases: ["secret-topic", "\\bsx\\b"], words: ["hush", "two\\s+words", "caf\u00e9"] });

  test("a phrase matches anywhere, case-insensitively", () => {
    expect(m("notes on the SECRET-TOPIC file")).toBe(true);
    expect(m("a sx scene")).toBe(true);
  });
  test("a phrase written with a word boundary does not match inside a longer word", () => {
    expect(m("Essx county")).toBe(false);
  });
  test("a word matches only as a whole word", () => {
    expect(m("please hush now")).toBe(true);
    expect(m("Hush")).toBe(true);
    expect(m("hushed voices")).toBe(false);
    expect(m("shush")).toBe(false);
  });
  test("a multi-word term tolerates any whitespace", () => {
    expect(m("two   words here")).toBe(true);
  });
  test("matching ignores Unicode composition (decomposed accents)", () => {
    expect(m("a café visit")).toBe(true);
  });
  test("with no terms nothing is ever flagged", () => {
    expect(buildMatcher({ phrases: [], words: [] })("anything at all")).toBe(false);
  });
});

describe("createGuard", () => {
  test("without terms the guard is not ready and flags nothing", () => {
    const g = createGuard(null);
    expect(g.ready).toBe(false);
    expect(g.isSensitive("secret-topic")).toBe(false);
  });
  test("with terms the guard is ready and uses the matcher", () => {
    const g = createGuard({ phrases: ["secret-topic"], words: [] });
    expect(g.ready).toBe(true);
    expect(g.isSensitive("a secret-topic note")).toBe(true);
    expect(g.isSensitive("a normal note")).toBe(false);
  });
});
