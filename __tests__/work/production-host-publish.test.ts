import { describe, expect, test } from "bun:test";
import { buildHostPublish, hostBaseSha } from "../../src/work/production";
import type { Publisher } from "../../src/work/publish";
import type { WorkRecord } from "../../src/work/store";

const publisher = {} as unknown as Publisher;
const work = { root: "/w/r/w0123456" } as unknown as WorkRecord;

describe("buildHostPublish", () => {
  test("is absent unless work.hostPublish is true, so production keeps declining a dirty tree", () => {
    expect(buildHostPublish({ hostPublish: false }, publisher)).toBeUndefined();
  });

  test("is a function when work.hostPublish is true", () => {
    expect(typeof buildHostPublish({ hostPublish: true }, publisher)).toBe("function");
  });
});

describe("hostBaseSha", () => {
  test("reads the base commit the host recorded at clone time, next to the work root, and never asks the author's tree", () => {
    const paths: string[] = [];
    const read = hostBaseSha((path) => { paths.push(path); return `${"a".repeat(40)}\n`; });

    expect(read(work)).toBe("a".repeat(40));
    expect(paths).toEqual(["/w/r/w0123456.base-sha"]);
  });

  test("a work without a recorded base declines (fail closed)", () => {
    const read = hostBaseSha(() => { throw new Error("ENOENT"); });
    expect(() => read(work)).toThrow("no recorded base commit");
  });

  test("a recorded value that is not a full commit id is refused", () => {
    for (const bad of ["master", "abc123", `${"g".repeat(40)}`, `${"a".repeat(41)}`, ""]) {
      expect(() => hostBaseSha(() => bad)(work)).toThrow("not a commit id");
    }
  });
});
