import { describe, expect, test } from "bun:test";
import {
  buildHeadlessPrompt,
  buildHeadlessPromptParts,
  headlessCacheKey,
  headlessCartridgeNames,
  headlessReviewTools,
} from "../../src/cartridge/headless-profile";
import { CartridgeRegistry } from "../../src/cartridge/registry";

const identity = { name: "finn", label: "Iron Will", repo: "rfcclub/anima" };

describe("headless profiles", () => {
  test("work and revision select only their explicit role cartridges", () => {
    expect(headlessCartridgeNames("work")).toEqual(["work-engineer", "typescript-bun"]);
    expect(headlessCartridgeNames("revise")).toEqual(["work-engineer", "typescript-bun", "work-revise"]);
    const prompt = buildHeadlessPrompt({ ...identity, profile: "revise" });
    expect(prompt).toContain("You are finn (Iron Will), a software engineer on rfcclub/anima.");
    for (const forbidden of ["warmth", "PERSONA_ONLY", "SOUL_ONLY", "MEMORY_ONLY", "TRAJECTORY_ONLY"]) {
      expect(prompt).not.toContain(forbidden);
    }
    expect(prompt).toContain("the current goal supersedes prior goals and earlier reviews");
    expect(prompt).toContain("Do not redo a finding already resolved");
  });

  test("work profile describes the exact loop and blocked signals", () => {
    const prompt = buildHeadlessPrompt({ ...identity, profile: "work" });
    expect(prompt).toContain("Do not ask the user");
    expect(prompt).toContain('<LOOP reason="');
    expect(prompt).toContain('<DONE reason="');
    expect(prompt).toContain('blocked:');
  });

  test("review selects only the evidence-first review role", () => {
    expect(headlessCartridgeNames("review")).toEqual(["work-review"]);
    const prompt = buildHeadlessPrompt({ ...identity, profile: "review" });
    expect(prompt).toContain("INCOMPLETE");
    expect(prompt).not.toContain("warmth");
    expect(prompt).not.toContain("work-engineer");
    expect(prompt).toMatchSnapshot();
  });

  test("the static work prefix is byte-identical across agents, repositories and revisions", () => {
    const first = buildHeadlessPrompt({ name: "Finn", label: "Iron Will", repo: "rfcclub/anima", profile: "work" });
    const second = buildHeadlessPrompt({ name: "Cleo", label: "Luminous", repo: "rfcclub/other", profile: "work" });
    const revised = buildHeadlessPrompt({ name: "Cleo", label: "Luminous", repo: "rfcclub/other", profile: "revise" });
    const prefix = (text: string) => text.slice(0, text.indexOf("You are "));
    expect(prefix(first).length).toBeGreaterThan(0);
    expect(prefix(second)).toBe(prefix(first));
    expect(prefix(revised).startsWith(prefix(first))).toBe(true);
    expect(prefix(first)).not.toContain("Finn");
    expect(prefix(first)).not.toContain("rfcclub/anima");
    expect(prefix(first)).toMatchSnapshot();
  });

  test("review prefixes and effective tool grants share a key only when their schemas match", () => {
    const first = buildHeadlessPromptParts({ ...identity, profile: "review" });
    const second = buildHeadlessPromptParts({ name: "Cleo", label: "Luminous", repo: "rfcclub/other", profile: "review" });
    expect(first.staticPrefix).toBe(second.staticPrefix);
    expect(first.staticHash).toBe(second.staticHash);
    expect(first.full.startsWith(first.staticPrefix)).toBe(true);
    const tools = ["read", "bash", "anima_github"];
    expect(headlessReviewTools(tools)).toEqual(headlessReviewTools([...tools].reverse()));
    expect(headlessReviewTools(["read", "publish"])).toEqual(["read"]);
    const read = { name: "read", description: "read a file", input_schema: { type: "object" } };
    const bash = { name: "bash", description: "run a command", input_schema: { type: "object" } };
    expect(headlessCacheKey(first.staticPrefix, [read])).toBe(headlessCacheKey(second.staticPrefix, [read]));
    expect(headlessCacheKey(first.staticPrefix, [read])).not.toBe(headlessCacheKey(second.staticPrefix, [read, bash]));
  });

  test("headless roles are not candidates in the ordinary chat cartridge registry", async () => {
    const registry = new CartridgeRegistry({ projectRoot: process.cwd(), globalRoot: "/nonexistent-anima-test", colonyRoot: "/nonexistent-agora-test" });
    const names = (await registry.list("example")).map((entry) => entry.name);
    for (const role of ["work-engineer", "typescript-bun", "work-revise", "work-review"]) {
      expect(names).not.toContain(role);
    }
  });
});
