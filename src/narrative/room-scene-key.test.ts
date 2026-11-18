import { test, expect } from "bun:test";
import { sortedAgentKey, roomSceneFileName } from "./room-scene-key";

test("sortedAgentKey sorts regardless of input order", () => {
  expect(sortedAgentKey(["gus", "bruno"])).toBe("bruno_gus");
  expect(sortedAgentKey(["bruno", "gus"])).toBe("bruno_gus");
});

test("sortedAgentKey handles a single agent", () => {
  expect(sortedAgentKey(["gus"])).toBe("gus");
});

test("roomSceneFileName joins placeId with the sorted agent key", () => {
  expect(roomSceneFileName("library", ["gus"])).toBe("library_gus");
  expect(roomSceneFileName("hall_main", ["gus", "bruno"])).toBe("hall_main_bruno_gus");
});
