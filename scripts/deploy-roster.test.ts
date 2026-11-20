import { expect, test } from "bun:test";
import { chooseRoster, rosterNames } from "./deploy-roster.ts";

const repo = JSON.stringify({ agents: [{ name: "alpha" }, { name: "beta" }] });
const same = JSON.stringify({ agents: [{ name: "beta" }, { name: "alpha" }], extra: 1 });
const other = JSON.stringify({ agents: [{ name: "gamma" }, { name: "delta" }] });

test("rosterNames reads names from a list of objects, a list of strings or a keyed object", () => {
  expect(rosterNames(repo)).toEqual(["alpha", "beta"]);
  expect(rosterNames(JSON.stringify({ agents: ["b", "a"] }))).toEqual(["a", "b"]);
  expect(rosterNames(JSON.stringify({ agents: { b: {}, a: {} } }))).toEqual(["a", "b"]);
  expect(rosterNames("not json")).toBeNull();
});

test("a configured overlay roster wins over the repository roster", () => {
  const choice = chooseRoster({ repo, runtime: other, overlay: same });
  expect(choice).toEqual({ action: "overlay" });
});

test("without an overlay the repository roster is installed on a first install", () => {
  expect(chooseRoster({ repo, runtime: null })).toEqual({ action: "repo" });
});

test("without an overlay the same set of names installs the repository roster", () => {
  expect(chooseRoster({ repo, runtime: same })).toEqual({ action: "repo" });
});

test("without an overlay a different roster stops the deploy before anything is copied", () => {
  const choice = chooseRoster({ repo, runtime: other });
  expect(choice.action).toBe("refuse");
  expect((choice as { reason: string }).reason).toContain("overlay");
});

test("an unreadable repository roster stops the deploy", () => {
  expect(chooseRoster({ repo: "oops", runtime: other }).action).toBe("refuse");
});

test("an unreadable overlay stops the deploy instead of falling back", () => {
  expect(chooseRoster({ repo, runtime: other, overlay: "oops" }).action).toBe("refuse");
});
