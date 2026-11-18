import { expect, test } from "bun:test";
import { loadRoomConfig } from "../src/config/types";

const baseConfig = `
identity:
  name: bruno
  label: Bruno
provider:
  type: claude
policy:
  allowedRoots: []
session:
  defaultMode: plan
boot:
  gene: SOUL.md
  sessionContext:
    - AGENTS.md
`;

test("loadRoomConfig defaults continuity to undefined when absent from YAML", () => {
  const config = loadRoomConfig(baseConfig);
  expect(config.continuity).toBeUndefined();
});

test("loadRoomConfig wires continuity.incarnationPort from real YAML", () => {
  const config = loadRoomConfig(`${baseConfig}\ncontinuity:\n  incarnationPort: true\n`);
  expect(config.continuity?.incarnationPort).toBe(true);
});

test("loadRoomConfig treats continuity.incarnationPort: false explicitly", () => {
  const config = loadRoomConfig(`${baseConfig}\ncontinuity:\n  incarnationPort: false\n`);
  expect(config.continuity?.incarnationPort).toBe(false);
});

test("loadRoomConfig wires the identity-runtime canary flag from YAML", () => {
  const config = loadRoomConfig(`${baseConfig}\ncontinuity:\n  identityRuntime: true\n`);
  expect(config.continuity?.identityRuntime).toBe(true);
});
