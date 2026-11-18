import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRosterAgentIds, resolveColonyPath } from "../src/roster.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const write = (name: string, body: unknown) => {
  dir ??= mkdtempSync(join(tmpdir(), "roster-"));
  const path = join(dir, name);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
};

test("reads the agent ids in roster order and drops names that are not safe tenant ids", () => {
  const path = write("colony.json", { agents: [{ name: "bruno" }, { name: "abel" }, { name: "../evil" }, { name: "Has Space" }, { name: "milo" }, {}] });
  expect(readRosterAgentIds(path)).toEqual(["bruno", "abel", "milo"]);
});

test("a missing or malformed roster yields no agents instead of throwing", () => {
  expect(readRosterAgentIds("/nonexistent/colony.json")).toEqual([]);
  expect(readRosterAgentIds(write("bad.json", "{not json"))).toEqual([]);
  expect(readRosterAgentIds(write("noagents.json", { agents: "nope" }))).toEqual([]);
});

test("resolveColonyPath prefers the explicit path, then the first existing candidate", () => {
  const first = write("a.json", { agents: [] });
  const second = write("b.json", { agents: [] });
  expect(resolveColonyPath({ explicit: second, candidates: [first] })).toBe(second);
  expect(resolveColonyPath({ candidates: ["/nonexistent/x.json", first, second] })).toBe(first);
  expect(resolveColonyPath({ candidates: ["/nonexistent/x.json"] })).toBeUndefined();
});
