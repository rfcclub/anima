import { expect, test } from "bun:test";
import { canonicalRoster, chooseRoster, isInsidePath, isPrivateMode, validRoster } from "./deploy-roster.ts";

const roster = (names: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ companies: { a: { members: names.map((agentId) => ({ agentId })) } }, agents: names.map((name) => ({ name })), ...extra });
const repo = roster(["alpha", "beta"]);
const sameShuffled = JSON.stringify({ agents: [{ name: "alpha" }, { name: "beta" }], companies: { a: { members: [{ agentId: "alpha" }, { agentId: "beta" }] } } });
const sameNamesOtherMembers = roster(["alpha", "beta"], { companies: { a: { members: [{ agentId: "alpha" }] } } });
const other = roster(["gamma", "delta"]);

test("validRoster needs an agents array of named objects, as the runtime loads it", () => {
  expect(validRoster(repo)).toBe(true);
  expect(validRoster(JSON.stringify({ agents: { alpha: {} } }))).toBe(false);
  expect(validRoster(JSON.stringify({ agents: ["alpha"] }))).toBe(false);
  expect(validRoster(JSON.stringify({ agents: [] }))).toBe(false);
  expect(validRoster(JSON.stringify({ agents: [{ name: "" }] }))).toBe(false);
  expect(validRoster("not json")).toBe(false);
});

test("validRoster rejects a company member the server could not read", () => {
  expect(validRoster(JSON.stringify({ agents: [{ name: "a" }], companies: { c: { members: [null] } } }))).toBe(false);
  expect(validRoster(JSON.stringify({ agents: [{ name: "a" }], companies: { c: { members: [{}] } } }))).toBe(false);
  expect(validRoster(JSON.stringify({ agents: [{ name: "a" }], companies: { c: { members: [{ agentId: "a" }] } } }))).toBe(true);
});

test("an existing runtime roster that is corrupt, legacy or empty is replaced only with consent", () => {
  for (const runtime of ["oops", JSON.stringify([{ name: "x" }]), JSON.stringify({ agents: [] })]) {
    expect(chooseRoster({ repo, runtime }).action).toBe("refuse");
    expect(chooseRoster({ repo, runtime, accept: true })).toEqual({ action: "repo" });
  }
});

test("canonicalRoster ignores key order but not content", () => {
  expect(canonicalRoster(repo)).toBe(canonicalRoster(sameShuffled));
  expect(canonicalRoster(repo)).not.toBe(canonicalRoster(sameNamesOtherMembers));
});

test("a configured valid overlay wins over the repository roster", () => {
  expect(chooseRoster({ repo, runtime: roster(["alpha", "beta"]), overlay: sameShuffled })).toEqual({ action: "overlay" });
});

test("an overlay with other members than the runtime roster is refused unless accepted", () => {
  expect(chooseRoster({ repo, runtime: other, overlay: repo }).action).toBe("refuse");
  expect(chooseRoster({ repo, runtime: other, overlay: repo, accept: true })).toEqual({ action: "overlay" });
});

test("an overlay the server cannot load stops the deploy", () => {
  expect(chooseRoster({ repo, runtime: null, overlay: JSON.stringify({ agents: { alpha: {} } }) }).action).toBe("refuse");
  expect(chooseRoster({ repo, runtime: other, overlay: "oops", accept: true }).action).toBe("refuse");
});

test("without an overlay the repository roster is installed on a first install", () => {
  expect(chooseRoster({ repo, runtime: null })).toEqual({ action: "repo" });
});

test("without an overlay an identical roster installs the repository roster", () => {
  expect(chooseRoster({ repo, runtime: sameShuffled })).toEqual({ action: "repo" });
});

test("same agent names with different members or metadata are not the same roster", () => {
  const choice = chooseRoster({ repo, runtime: sameNamesOtherMembers });
  expect(choice.action).toBe("refuse");
  expect((choice as { reason: string }).reason).toContain("overlay");
});

test("a different roster is refused unless the change is accepted on purpose", () => {
  expect(chooseRoster({ repo, runtime: other }).action).toBe("refuse");
  expect(chooseRoster({ repo, runtime: other, accept: true })).toEqual({ action: "repo" });
});

test("an unreadable repository roster stops the deploy", () => {
  expect(chooseRoster({ repo: "oops", runtime: other, accept: true }).action).toBe("refuse");
});

test("isInsidePath detects a directory inside another and not a sibling with the same prefix", () => {
  expect(isInsidePath("/work/repo/overlay", "/work/repo")).toBe(true);
  expect(isInsidePath("/work/repo", "/work/repo")).toBe(true);
  expect(isInsidePath("/work/repo-private", "/work/repo")).toBe(false);
  expect(isInsidePath("/home/x/overlay", "/work/repo")).toBe(false);
});

test("isPrivateMode accepts owner-only modes and rejects any group or other access", () => {
  expect(isPrivateMode(0o700)).toBe(true);
  expect(isPrivateMode(0o600)).toBe(true);
  expect(isPrivateMode(0o640)).toBe(false);
  expect(isPrivateMode(0o604)).toBe(false);
  expect(isPrivateMode(0o755)).toBe(false);
});
