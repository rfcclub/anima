import { describe, test, expect } from "bun:test";
import { slugifyInstanceId } from "./instance-id";

describe("slugifyInstanceId", () => {
  test("SC-001: identical inputs produce identical output", () => {
    expect(slugifyInstanceId("eli", "windows-codex")).toBe(slugifyInstanceId("eli", "windows-codex"));
  });

  test("SC-002: different surfaceId produces a different instance_id", () => {
    expect(slugifyInstanceId("eli", "example-host")).not.toBe(slugifyInstanceId("eli", "windows-project-x"));
  });

  test("SC-003: output is lowercase, [a-z0-9-] only, no consecutive/edge dashes", () => {
    const out = slugifyInstanceId("eli", "Windows Project X!!");
    expect(out).toBe("eli-windows-project-x");
    expect(out).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test("examples table", () => {
    expect(slugifyInstanceId("eli", "windows-codex")).toBe("eli-windows-codex");
    expect(slugifyInstanceId("eli", "example-host")).toBe("eli-example-host");
  });
});
