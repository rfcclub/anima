import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ScheduleMarker {
  lastFiredKey?: string;
}

export interface SlotCheckResult {
  shouldFire: boolean;
  nextKey: string;
}

function dateKey(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

/**
 * Daily wall-clock slot check: fires once when `now`'s local hour matches
 * `targetHour`, gated by `marker.lastFiredKey` so repeated polling within
 * the same hour (or day, if the process is re-checked more than once) does
 * not re-fire. Pure — callers persist the returned `nextKey` themselves.
 */
export function checkDailySlot(now: Date, targetHour: number, marker: ScheduleMarker): SlotCheckResult {
  const nextKey = dateKey(now);
  const shouldFire = now.getHours() === targetHour && marker.lastFiredKey !== nextKey;
  return { shouldFire, nextKey };
}

/**
 * Weekly wall-clock slot check: fires once when `now`'s local hour and
 * day-of-week (0=Sunday) both match, gated the same way as checkDailySlot.
 */
export function checkWeeklySlot(
  now: Date,
  targetHour: number,
  targetDayOfWeek: number,
  marker: ScheduleMarker,
): SlotCheckResult {
  const nextKey = dateKey(now);
  const shouldFire =
    now.getHours() === targetHour && now.getDay() === targetDayOfWeek && marker.lastFiredKey !== nextKey;
  return { shouldFire, nextKey };
}

async function readMarker(markerPath: string): Promise<ScheduleMarker> {
  if (!existsSync(markerPath)) return {};
  try {
    const parsed = JSON.parse(await readFile(markerPath, "utf-8"));
    return typeof parsed?.lastFiredKey === "string" ? { lastFiredKey: parsed.lastFiredKey } : {};
  } catch {
    return {};
  }
}

async function writeMarker(markerPath: string, marker: ScheduleMarker): Promise<void> {
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, JSON.stringify(marker), "utf-8");
}

/**
 * FS-backed daily gate — reboot/redeploy-safe (state lives on disk, keyed by
 * calendar date, not process-uptime like a naive setInterval(fn, 24h) would
 * be). Intended to be polled every few minutes; only returns true once per
 * calendar day at `targetHour`.
 */
export async function fireDailyIfDue(markerPath: string, targetHour: number, now: Date = new Date()): Promise<boolean> {
  const marker = await readMarker(markerPath);
  const { shouldFire, nextKey } = checkDailySlot(now, targetHour, marker);
  if (!shouldFire) return false;
  await writeMarker(markerPath, { lastFiredKey: nextKey });
  return true;
}

/** FS-backed weekly gate — same idea as fireDailyIfDue, gated on day-of-week too. */
export async function fireWeeklyIfDue(
  markerPath: string,
  targetHour: number,
  targetDayOfWeek: number,
  now: Date = new Date(),
): Promise<boolean> {
  const marker = await readMarker(markerPath);
  const { shouldFire, nextKey } = checkWeeklySlot(now, targetHour, targetDayOfWeek, marker);
  if (!shouldFire) return false;
  await writeMarker(markerPath, { lastFiredKey: nextKey });
  return true;
}
