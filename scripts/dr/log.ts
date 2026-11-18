import type { Fs } from "./types.ts";

const LOG_FIELDS = ["ts", "level", "msg", "check", "subject", "status", "reason", "incident", "action"] as const;
type LogFields = Partial<Record<(typeof LOG_FIELDS)[number], unknown>> & Record<string, unknown>;

export interface Log {
  write(fields: LogFields): void;
}

const encoder = new TextEncoder();
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
/** Smallest limit that always holds a minimal entry (a timestamp and the other fields emptied). */
export const MIN_LOG_BYTES = 256;
const bytes = (text: string): number => encoder.encode(text).byteLength;

/**
 * One log line within `maxBytes` (newline included). An oversized entry has its longest string value cut, one
 * character at a time from the end, until it fits; a line that cannot fit even with every string empty is kept
 * as it is, because the entry is what the log exists to hold.
 */
function fit(entry: Record<string, unknown>, maxBytes: number): string {
  const copy = { ...entry };
  let line = JSON.stringify(copy);
  while (bytes(line) + 1 > maxBytes) {
    let longest: string | undefined;
    for (const [key, value] of Object.entries(copy)) {
      if (key !== "ts" && typeof value === "string" && value.length > 0 && (longest === undefined || value.length > (copy[longest] as string).length)) longest = key;
    }
    if (longest === undefined) break;
    const value = copy[longest] as string;
    // Cut about half of what is over the bound, at least one character, never splitting a surrogate pair.
    const cut = Math.max(1, Math.floor((bytes(line) + 1 - maxBytes) / 2));
    let next = value.slice(0, Math.max(0, value.length - cut));
    if (/[\ud800-\udbff]$/.test(next)) next = next.slice(0, -1);
    copy[longest] = next;
    line = JSON.stringify(copy);
  }
  return line;
}

/** Strings, booleans and null are kept; numbers and anything else are written as strings so `fit` can bound them. */
function scalar(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return String(value); // a string, so `fit` can shorten it
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

export function createLog(fs: Fs, path: string, maxBytes: number): Log {
  if (!Number.isInteger(maxBytes) || maxBytes < MIN_LOG_BYTES) throw new Error(`maxBytes must be an integer of at least ${MIN_LOG_BYTES}`);

  return {
    write(fields) {
      const entry: Record<string, unknown> = {};
      for (const key of LOG_FIELDS) {
        if (key === "ts") continue;
        if (Object.prototype.hasOwnProperty.call(fields, key)) entry[key] = scalar(fields[key]);
      }
      // A timestamp is ASCII and short by construction (ISO 8601); anything else is replaced, so no field can defeat the bound.
      entry.ts = typeof fields.ts === "string" && ISO_TS.test(fields.ts) ? fields.ts : new Date().toISOString();
      const line = fit(entry, maxBytes);
      const lines = (fs.read(path) ?? "").split("\n").filter(Boolean);
      lines.push(line);
      // Over the bound: keep the newest half of the lines, then keep dropping the oldest until the bytes fit.
      // The newest line always stays.
      let total = lines.reduce((sum, l) => sum + bytes(l) + 1, 0);
      if (total > maxBytes && lines.length > 1) {
        lines.splice(0, lines.length - Math.max(1, Math.floor(lines.length / 2)));
        total = lines.reduce((sum, l) => sum + bytes(l) + 1, 0);
      }
      while (lines.length > 1 && total > maxBytes) total -= bytes(lines.shift() as string) + 1;
      fs.write(path, `${lines.join("\n")}\n`);
    },
  };
}
