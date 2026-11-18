import { test, expect } from "bun:test";
import { main, restartCommand, type ProcessRunner } from "../src/cli";

interface RunnerCall {
  cmd: string;
  args: string[];
}

class FakeRunner implements ProcessRunner {
  calls: RunnerCall[] = [];
  results: Array<{ exitCode: number; stdout: string; stderr: string }> = [];

  async run(cmd: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.calls.push({ cmd, args });
    return this.results.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
  }

  queue(result: { exitCode: number; stdout: string; stderr: string }): void {
    this.results.push(result);
  }
}

interface CaptureResult {
  stdout: string;
  stderr: string;
  exitCode?: number;
}

async function captureRestart(runner: FakeRunner, flags: Record<string, string | boolean> = {}): Promise<CaptureResult> {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutLines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrLines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const exitCode = await restartCommand({ positional: [], flags }, runner);
    return { stdout: stdoutLines.join(""), stderr: stderrLines.join(""), exitCode };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

test("SC-003: stops dev server when present", async () => {
  const runner = new FakeRunner();
  runner.queue({ exitCode: 0, stdout: "", stderr: "" }); // pkill success
  runner.queue({ exitCode: 0, stdout: "", stderr: "" }); // launchctl success

  const { stdout, exitCode } = await captureRestart(runner);

  expect(exitCode).toBe(0);
  expect(runner.calls[0]).toEqual({ cmd: "pkill", args: ["-f", "bun src/server.ts"] });
  expect(stdout).toContain("[anima] dev server stopped");
});

test("SC-004: continues when no dev server is found", async () => {
  const runner = new FakeRunner();
  runner.queue({ exitCode: 1, stdout: "", stderr: "no matching processes" }); // pkill no match
  runner.queue({ exitCode: 0, stdout: "", stderr: "" }); // launchctl success

  const { stdout, exitCode } = await captureRestart(runner);

  expect(exitCode).toBe(0);
  expect(stdout).toContain("[anima] no dev server found");
  expect(runner.calls[1]).toEqual({ cmd: "launchctl", args: ["kickstart", "-k", "gui/501/com.owner.anima"] });
});

test("SC-005: restarts production service", async () => {
  const runner = new FakeRunner();
  runner.queue({ exitCode: 0, stdout: "", stderr: "" }); // pkill success
  runner.queue({ exitCode: 0, stdout: "", stderr: "" }); // launchctl success

  const { stdout, exitCode } = await captureRestart(runner);

  expect(exitCode).toBe(0);
  expect(runner.calls[1]).toEqual({ cmd: "launchctl", args: ["kickstart", "-k", "gui/501/com.owner.anima"] });
  expect(stdout).toContain("[anima] production restarted");
});

test("SC-006: fails and prints launchctl error", async () => {
  const runner = new FakeRunner();
  runner.queue({ exitCode: 0, stdout: "", stderr: "" }); // pkill success
  runner.queue({ exitCode: 1, stdout: "", stderr: "Could not find service" }); // launchctl failure

  const { stderr, exitCode } = await captureRestart(runner);

  expect(exitCode).toBe(1);
  expect(stderr).toContain("Could not find service");
});

test("SC-006: main exits non-zero when launchctl fails", async () => {
  const runner = new FakeRunner();
  runner.queue({ exitCode: 0, stdout: "", stderr: "" }); // pkill success
  runner.queue({ exitCode: 1, stdout: "", stderr: "Could not find service" }); // launchctl failure

  const originalExit = process.exit;
  let exitCalled: number | undefined;
  process.exit = ((code?: number) => {
    exitCalled = code ?? 0;
    throw new Error(`exit:${code}`);
  }) as typeof process.exit;

  const stderrLines: string[] = [];
  const originalStderrWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrLines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    await main(["restart"], runner);
  } catch {
    // process.exit is stubbed above.
  } finally {
    process.stderr.write = originalStderrWrite;
    process.exit = originalExit;
  }

  expect(exitCalled).toBe(1);
  expect(stderrLines.join("")).toContain("Could not find service");
});

test("SC-008: --dev-only skips production restart", async () => {
  const runner = new FakeRunner();
  runner.queue({ exitCode: 0, stdout: "", stderr: "" }); // pkill success

  const { stdout, exitCode } = await captureRestart(runner, { "dev-only": true });

  expect(exitCode).toBe(0);
  expect(runner.calls).toHaveLength(1);
  expect(stdout).toContain("[anima] dev server stopped");
});

test("SC-001: parser recognizes restart command", async () => {
  const runner = new FakeRunner();
  runner.queue({ exitCode: 0, stdout: "", stderr: "" }); // pkill
  runner.queue({ exitCode: 0, stdout: "", stderr: "" }); // launchctl

  const originalExit = process.exit;
  let exitCalled: number | undefined;
  process.exit = ((code?: number) => {
    exitCalled = code ?? 0;
    throw new Error(`exit:${code}`);
  }) as typeof process.exit;

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutLines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrLines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    await main(["restart"], runner);
  } catch {
    // main may exit on usage for unknown command before implementation
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exit = originalExit;
  }

  expect(exitCalled).toBeUndefined();
  expect(runner.calls.length).toBeGreaterThan(0);
});

test("SC-002: usage text lists anima restart", async () => {
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as typeof process.exit;

  const stderrLines: string[] = [];
  const originalStderrWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrLines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    await main([]);
  } catch {
    // usage exits
  } finally {
    process.stderr.write = originalStderrWrite;
    process.exit = originalExit;
  }

  const stderr = stderrLines.join("");
  expect(stderr).toContain("anima restart");
});
