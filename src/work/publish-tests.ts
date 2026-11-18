export type TestOutcome =
  | { ok: true; output: string }
  | { ok: false; check: "no-tests" | "tests-failed" | "tests-timeout"; output: string };

const TEST_FILE = /\.test\.tsx?$/;
const SAFE_TEST_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/@-]+\.test\.tsx?$/;
const ISSUE_TEST_COMMAND = /^bun test\s+([A-Za-z0-9._/@-]+(?:\s+[A-Za-z0-9._/@-]+)*)$/;
const OUTPUT_LIMIT = 64 * 1024;

function isExistingTestPath(path: string, exists: (path: string) => boolean): boolean {
  return SAFE_TEST_PATH.test(path) && exists(path);
}

function commandFromPaths(paths: string[]): string[] | null {
  const selected = [...new Set(paths)].slice(0, 20);
  return selected.length ? ["bun", "test", ...selected.map((path) => `./${path}`)] : null;
}

export function deriveTestCommand(
  issueBody: string,
  changedPaths: string[],
  exists: (path: string) => boolean,
): string[] | null {
  const issuePaths: string[] = [];
  for (const rawLine of issueBody.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^```/.test(line)) continue;
    const match = ISSUE_TEST_COMMAND.exec(line);
    if (!match) continue;
    const paths = match[1]!.split(/\s+/);
    if (paths.some((path) => path.startsWith("/") || path.includes(".."))) continue;
    for (const path of paths) {
      if (isExistingTestPath(path, exists)) issuePaths.push(path);
    }
  }
  if (issuePaths.length) return commandFromPaths(issuePaths);

  const candidates: string[] = [];
  for (const changed of changedPaths) {
    if (TEST_FILE.test(changed)) {
      if (isExistingTestPath(changed, exists)) candidates.push(changed);
      continue;
    }

    const slash = changed.lastIndexOf("/");
    const directory = slash < 0 ? "" : changed.slice(0, slash + 1);
    const filename = changed.slice(slash + 1);
    const basename = filename.replace(/\.[^/.]*$/, "");
    candidates.push(`${directory}${basename}.test.ts`);
    const mirrored = changed.replace(/^src\//, "").replace(/\.[^/.]*$/, "");
    candidates.push(`__tests__/${mirrored}.test.ts`);
  }
  return commandFromPaths(candidates.filter((path) => isExistingTestPath(path, exists)));
}

export async function runTests(
  argv: string[],
  options: {
    cwd: string;
    timeoutMs?: number;
    run: (argv: string[], cwd: string, timeoutMs: number) => Promise<{ code: number | null; timedOut: boolean; output: string }>;
  },
): Promise<TestOutcome> {
  const result = await options.run(argv, options.cwd, options.timeoutMs ?? 120_000);
  const output = result.output.split(/\r?\n/).slice(-40).join("\n").trimEnd();
  if (result.timedOut) return { ok: false, check: "tests-timeout", output };
  if (result.code !== 0) return { ok: false, check: "tests-failed", output };
  if (!/^\s*(\d+) pass\b/m.test(output) || Number(/^\s*(\d+) pass\b/m.exec(output)?.[1]) < 1) {
    return { ok: false, check: "no-tests", output };
  }
  return { ok: true, output };
}

export async function spawnRun(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  options: { env?: Record<string, string | undefined>; wrap?: (argv: string[]) => string[] } = {},
): Promise<{ code: number | null; timedOut: boolean; output: string }> {
  const sourceEnv = options.env ?? process.env;
  const env: Record<string, string> = {};
  for (const name of ["PATH", "LANG"] as const) {
    const value = sourceEnv[name];
    if (value !== undefined) env[name] = value;
  }
  if (options.env?.HOME !== undefined) env.HOME = options.env.HOME;
  if (options.env?.TMPDIR !== undefined) env.TMPDIR = options.env.TMPDIR;

  const child = Bun.spawn(options.wrap ? options.wrap(argv) : argv, {
    cwd,
    env,
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  const captured: number[] = [];
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const reading = ([child.stdout, child.stderr] as ReadableStream<Uint8Array>[]).map(async (stream) => {
    const reader = stream.getReader();
    readers.push(reader);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length >= OUTPUT_LIMIT) {
        captured.length = 0;
        for (const byte of value.subarray(value.length - OUTPUT_LIMIT)) captured.push(byte);
      } else {
        const excess = captured.length + value.length - OUTPUT_LIMIT;
        if (excess > 0) captured.splice(0, excess);
        for (const byte of value) captured.push(byte);
      }
    }
  });

  const allReaders = Promise.all(reading);
  void allReaders.catch(() => {});
  let resolveTimeout!: () => void;
  const timeoutReached = new Promise<void>((resolve) => { resolveTimeout = resolve; });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    resolveTimeout();
    for (const reader of readers) void reader.cancel().catch(() => {});
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }
  }, timeoutMs);
  let code: number | null;
  try {
    code = await Promise.race([child.exited, timeoutReached.then(() => null)]);
    if (!timedOut) await Promise.race([allReaders, timeoutReached]);
  } finally {
    clearTimeout(timer);
  }
  return { code, timedOut, output: new TextDecoder().decode(new Uint8Array(captured)) };
}
