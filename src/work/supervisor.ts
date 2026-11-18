/**
 * Supervision of a work session's processes (anima #135, WL-3 and WL-10).
 *
 * - A session runs as its own process group, so one signal reaches the whole tree.
 * - An abort signal or an elapsed grace period is not proof that anything stopped. `stopAndProve`
 *   terminates the group, escalates to SIGKILL, then looks for any process still working inside the
 *   work root (a child that started its own session leaves the group) and only reports `proven`
 *   when nothing is left. If something cannot be removed the answer is `cessation-unproven` and the
 *   caller must block the work instead of starting another writer.
 * - An exclusive lock file and the store's generation number keep a second or stale writer out.
 */

import { closeSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { join, sep } from "node:path";
import type { WorkStore } from "./store";

export interface SpawnSessionInput {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** The work root; used to find processes that escaped the group. */
  root: string;
  /** Wall limit for the session; when it passes the session is stopped and reported timed out. */
  deadlineMs?: number;
  /** Text written to the child's standard input (then closed). */
  stdin?: string;
  /** Capture stdout and stderr together, keeping at most this many characters (the rest is read and dropped). */
  captureChars?: number;
}

export interface CapturedOutput { text: string; truncated: boolean }

export type Kill = (target: number, signal: "SIGTERM" | "SIGKILL" | 0) => void;

export interface StopOptions {
  /** Time between SIGTERM and SIGKILL. Default 2000. */
  graceMs?: number;
  /** How signals are sent; tests replace it to simulate a process that cannot be killed. */
  signal?: Kill;
}

export interface StopResult {
  proven: boolean;
  reason?: "cessation-unproven";
  /** Pids found still working in the root after the group was gone. */
  swept: number[];
  survivors: number[];
}

export interface SessionExit {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
}

export interface SessionHandle {
  pid: number;
  pgid: number;
  exited: Promise<SessionExit>;
  /** With `captureChars`: what the child printed, resolved once it has exited and its pipes have drained (or a short grace). */
  output: Promise<CapturedOutput>;
  stopAndProve(options?: StopOptions): Promise<StopResult>;
}

const defaultKill: Kill = (target, signal) => { process.kill(target, signal); };

function tryKill(kill: Kill, target: number, signal: "SIGTERM" | "SIGKILL" | 0): boolean {
  try {
    kill(target, signal);
    return true;
  } catch (error) {
    // ESRCH: nothing there. EPERM: something there that we may not signal, which still counts as alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitUntil(done: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (done()) return true;
    await sleep(20);
  }
  return done();
}

/**
 * Kills whatever is still working inside `root` after a session's group is gone and reports whether anything
 * survived. Used by `stopAndProve` and by a caller that wants a final check after many short children.
 */
export async function sweepRoot(root: string, kill: Kill = defaultKill): Promise<{ swept: number[]; survivors: number[]; checked: boolean }> {
  const swept: number[] = [];
  let found = processesInRoot(root);
  if (found && found.length > 0) {
    for (const pid of found) {
      swept.push(pid);
      tryKill(kill, pid, "SIGKILL");
    }
    await sleep(100);
    found = processesInRoot(root);
    if (found) found = found.filter((pid) => tryKill(kill, pid, 0));
  }
  return { swept, survivors: found ?? [], checked: found !== null };
}

/** Pids whose working directory is inside `root`, or null when the check could not be made. */
function processesInRoot(root: string): number[] | null {
  const base = realpathSync(root);
  const r = Bun.spawnSync(["lsof", "-nP", "-d", "cwd", "-Fpn"], { stdout: "pipe", stderr: "ignore" });
  if (r.exitCode !== 0 && r.stdout.length === 0) return null;
  const pids: number[] = [];
  let pid = 0;
  for (const line of r.stdout.toString().split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== process.pid) {
      const path = line.slice(1);
      if (path === base || path.startsWith(base + sep)) pids.push(pid);
    }
  }
  return [...new Set(pids)];
}

export function spawnSession(input: SpawnSessionInput): SessionHandle {
  const proc = Bun.spawn(input.argv, {
    cwd: input.cwd,
    env: input.env,
    detached: true, // its own session and process group
    stdin: input.stdin !== undefined ? new Blob([input.stdin]) : "ignore",
    stdout: input.captureChars !== undefined ? "pipe" : "ignore",
    stderr: input.captureChars !== undefined ? "pipe" : "ignore",
  });
  let captured = "";
  let truncated = false;
  const cap = input.captureChars ?? 0;
  const readers: Promise<void>[] = [];
  if (input.captureChars !== undefined) {
    for (const stream of [proc.stdout, proc.stderr] as ReadableStream<Uint8Array>[]) {
      const decoder = new TextDecoder();
      readers.push((async () => {
        const reader = stream.getReader();
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          const text = decoder.decode(chunk, { stream: true });
          if (captured.length < cap) {
            captured += text.slice(0, cap - captured.length);
            if (text.length > cap) truncated = true;
          } else truncated = true; // keep reading so the child never blocks on a full pipe
        }
      })().catch(() => {}));
    }
  }
  const pgid = proc.pid;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stopAndProve = async (options: StopOptions = {}): Promise<StopResult> => {
    const kill = options.signal ?? defaultKill;
    const grace = options.graceMs ?? 2000;
    const groupGone = () => !tryKill(kill, -pgid, 0);

    tryKill(kill, -pgid, "SIGTERM");
    if (!(await waitUntil(groupGone, grace))) tryKill(kill, -pgid, "SIGKILL");
    await waitUntil(groupGone, 2000);

    const { swept, survivors, checked } = await sweepRoot(input.root, kill);
    const proven = groupGone() && checked && survivors.length === 0;
    return proven ? { proven, swept, survivors } : { proven, reason: "cessation-unproven", swept, survivors };
  };

  const output: Promise<CapturedOutput> = proc.exited.then(async () => {
    await Promise.race([Promise.all(readers), sleep(150)]); // a descendant holding the pipe open must not hold us
    return { text: captured, truncated };
  });

  const exited = proc.exited.then((code) => {
    if (timer) clearTimeout(timer);
    return { code, signal: proc.signalCode ?? null, timedOut } as SessionExit;
  });

  if (input.deadlineMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      void stopAndProve();
    }, input.deadlineMs);
  }

  return { pid: proc.pid, pgid, exited, output, stopAndProve };
}

// ---- exclusive workspace lock ------------------------------------------------------------

export interface WorkLock {
  release(): void;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One local supervisor per work root. Returns null while another live process holds it. */
export function acquireWorkLock(root: string): WorkLock | null {
  const path = join(root, ".work.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try {
            if (readFileSync(path, "utf-8").trim() === String(process.pid)) unlinkSync(path);
          } catch {
            // already gone
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder = NaN;
      try { holder = Number(readFileSync(path, "utf-8").trim()); } catch { continue; }
      if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) return null;
      try { unlinkSync(path); } catch { /* another process took it over first */ }
    }
  }
  return null;
}

// ---- generation fence ----------------------------------------------------------------------

export class StaleGenerationError extends Error {
  constructor(workId: string, expected: number, actual: number | null) {
    super(`stale writer for work ${workId}: generation ${expected}, current ${actual ?? "unknown"}`);
    this.name = "StaleGenerationError";
  }
}

/** Throws unless `generation` is the work's current one. Called before any host write or publication. */
export function assertCurrentGeneration(store: WorkStore, workId: string, generation: number): void {
  const work = store.getWork(workId);
  if (!work || work.generation !== generation) throw new StaleGenerationError(workId, generation, work?.generation ?? null);
}
