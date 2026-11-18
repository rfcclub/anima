import { test, expect } from "bun:test";
import { backgroundUrl, chamberSceneId, hasBackground, hasPortrait, portraitUrl } from "../../src/ui/lib/vn-assets";

test("chamberSceneId builds the chamber_<agent> scene id", () => {
  expect(chamberSceneId("bruno")).toBe("chamber_bruno");
  expect(chamberSceneId("dana")).toBe("chamber_dana");
});

test("backgroundUrl builds the server route", () => {
  expect(backgroundUrl("chamber_bruno")).toBe("/api/vn/background/chamber_bruno");
});

test("portraitUrl builds the server route with emotion", () => {
  expect(portraitUrl("bruno", "neutral")).toBe("/api/vn/portrait/bruno/neutral");
});

test("hasBackground finds a chamber background regardless of extension", () => {
  const backgrounds = ["chamber_bruno.png", "chamber_eli.webp"];
  expect(hasBackground("chamber_bruno", backgrounds)).toBe(true);
  expect(hasBackground("chamber_dana", backgrounds)).toBe(false);
});

test("hasPortrait finds a flat portrait file (agentId.ext)", () => {
  const portraits = ["bruno.png", "eli.png"];
  expect(hasPortrait("bruno", portraits)).toBe(true);
  expect(hasPortrait("dana", portraits)).toBe(false);
});

test("hasPortrait finds a per-emotion portrait folder (agentId/emotion.ext)", () => {
  const portraits = ["bruno/neutral.png", "bruno/warm.png"];
  expect(hasPortrait("bruno", portraits)).toBe(true);
  expect(hasPortrait("kai", portraits)).toBe(false);
});
