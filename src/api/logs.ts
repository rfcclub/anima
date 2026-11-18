import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LOG_PATH = join(homedir(), ".anima", "logs", "server.log");

export interface LogEntry {
  level: string;
  ts: string;
  msg: string;
  [key: string]: unknown;
}

export interface LogFilter {
  level?: string;
  q?: string;
}

export async function readLastLines(filePath: string, count: number): Promise<string[]> {
  if (!existsSync(filePath)) return [];
  const file = Bun.file(filePath);
  const size = file.size;
  if (size === 0) return [];
  const readBytes = Math.min(size, 512 * 1024);
  const text = await file.slice(size - readBytes, size).text();
  const lines = text.split("\n").filter(l => l.trim().length > 0);
  return lines.slice(-count);
}

export function parseLogLine(line: string): LogEntry | null {
  if (!line.trim()) return null;
  try {
    const obj = JSON.parse(line);
    if (typeof obj !== "object" || obj === null) return null;
    if (typeof obj.level !== "string" || typeof obj.ts !== "string" || typeof obj.msg !== "string") return null;
    return obj as LogEntry;
  } catch {
    return null;
  }
}

export function filterEntries(entries: LogEntry[], filter: LogFilter): LogEntry[] {
  let result = entries;
  if (filter.level) {
    result = result.filter(e => e.level === filter.level);
  }
  if (filter.q) {
    const q = filter.q.toLowerCase();
    result = result.filter(e =>
      Object.values(e).some(v => typeof v === "string" && v.toLowerCase().includes(q))
    );
  }
  return result;
}

export async function handleApiLogs(req: Request, filePath?: string): Promise<Response> {
  const url = new URL(req.url);
  const lines = Number(url.searchParams.get("lines") ?? "200");
  const level = url.searchParams.get("level") ?? undefined;
  const q = url.searchParams.get("q") ?? undefined;
  const entries = await getLogEntries({ filePath, lines, level, q });
  return new Response(JSON.stringify(entries), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function getLogEntries(opts: {
  filePath?: string;
  lines?: number;
  level?: string;
  q?: string;
}): Promise<LogEntry[]> {
  const filePath = opts.filePath ?? DEFAULT_LOG_PATH;
  const count = Math.min(opts.lines ?? 200, 1000);
  const rawLines = await readLastLines(filePath, count * 5);
  const allEntries = rawLines.map(parseLogLine).filter((e): e is LogEntry => e !== null);
  const filtered = filterEntries(allEntries, { level: opts.level, q: opts.q });
  return filtered.slice(-count);
}
