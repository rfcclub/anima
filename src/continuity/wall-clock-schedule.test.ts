import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkDailySlot,
  checkWeeklySlot,
  fireDailyIfDue,
  fireWeeklyIfDue,
} from "./wall-clock-schedule";

// checkDailySlot / checkWeeklySlot — pure decision logic, no I/O.

test("checkDailySlot fires when local hour matches and no prior fire today", () => {
  const now = new Date(2026, 8, 14, 23, 5); // Sep 14 2026, 23:05 local
  const result = checkDailySlot(now, 23, {});
  expect(result.shouldFire).toBe(true);
  expect(result.nextKey).toBe("2026-8-14");
});

test("checkDailySlot does not fire when local hour doesn't match", () => {
  const now = new Date(2026, 8, 14, 22, 59);
  const result = checkDailySlot(now, 23, {});
  expect(result.shouldFire).toBe(false);
});

test("checkDailySlot does not re-fire the same day even mid-hour polling", () => {
  const now = new Date(2026, 8, 14, 23, 40);
  const result = checkDailySlot(now, 23, { lastFiredKey: "2026-8-14" });
  expect(result.shouldFire).toBe(false);
});

test("checkDailySlot fires again the next day at the same hour", () => {
  const now = new Date(2026, 8, 15, 23, 5);
  const result = checkDailySlot(now, 23, { lastFiredKey: "2026-8-14" });
  expect(result.shouldFire).toBe(true);
  expect(result.nextKey).toBe("2026-8-15");
});

test("checkWeeklySlot fires only on the target day of week and hour", () => {
  // 2026-09-13 is a Sunday
  const sunday1am = new Date(2026, 8, 13, 1, 10);
  expect(checkWeeklySlot(sunday1am, 1, 0, {}).shouldFire).toBe(true);

  const monday1am = new Date(2026, 8, 14, 1, 10);
  expect(checkWeeklySlot(monday1am, 1, 0, {}).shouldFire).toBe(false);

  const sundayWrongHour = new Date(2026, 8, 13, 2, 10);
  expect(checkWeeklySlot(sundayWrongHour, 1, 0, {}).shouldFire).toBe(false);
});

test("checkWeeklySlot does not re-fire within the same day", () => {
  const sunday1am = new Date(2026, 8, 13, 1, 40);
  const result = checkWeeklySlot(sunday1am, 1, 0, { lastFiredKey: "2026-8-13" });
  expect(result.shouldFire).toBe(false);
});

// fireDailyIfDue / fireWeeklyIfDue — FS-backed marker persistence.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wall-clock-schedule-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("fireDailyIfDue returns true once at the target hour, then false on re-poll", async () => {
  const markerPath = join(dir, ".deep-dream-schedule.json");
  const at2305 = new Date(2026, 8, 14, 23, 5);
  const at2310 = new Date(2026, 8, 14, 23, 10);

  expect(await fireDailyIfDue(markerPath, 23, at2305)).toBe(true);
  expect(await fireDailyIfDue(markerPath, 23, at2310)).toBe(false);
});

test("fireDailyIfDue fires again on a later day at the target hour", async () => {
  const markerPath = join(dir, ".deep-dream-schedule.json");
  const day1 = new Date(2026, 8, 14, 23, 5);
  const day2 = new Date(2026, 8, 15, 23, 5);

  expect(await fireDailyIfDue(markerPath, 23, day1)).toBe(true);
  expect(await fireDailyIfDue(markerPath, 23, day2)).toBe(true);
});

test("fireDailyIfDue survives a missing/corrupt marker file", async () => {
  const markerPath = join(dir, "nested", "does-not-exist.json");
  const at2305 = new Date(2026, 8, 14, 23, 5);
  expect(await fireDailyIfDue(markerPath, 23, at2305)).toBe(true);
});

test("fireWeeklyIfDue fires only once on the target weekday+hour, not on other polls that day", async () => {
  const markerPath = join(dir, ".lucid-sweep-schedule.json");
  const sunday1am = new Date(2026, 8, 13, 1, 5);
  const sundayLater = new Date(2026, 8, 13, 1, 45);
  const nextSunday = new Date(2026, 8, 20, 1, 5);

  expect(await fireWeeklyIfDue(markerPath, 1, 0, sunday1am)).toBe(true);
  expect(await fireWeeklyIfDue(markerPath, 1, 0, sundayLater)).toBe(false);
  expect(await fireWeeklyIfDue(markerPath, 1, 0, nextSunday)).toBe(true);
});
