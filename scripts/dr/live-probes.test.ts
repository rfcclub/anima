import { describe, expect, test } from "bun:test";
import { checkLaunchd, checkPorts } from "./checks.ts";
import { collectLiveProbes, type CommandResult, type CommandRunner } from "./live-probes.ts";

const owner = "org.example.owner";
const other = "org.example.other";
const launchd = (label: string, pid: string) => `${label} = {\n\tstate = running\n\tpid = ${pid}\n}\n`;
const socket = (pid: number, port: number, address = "*") =>
  `p${pid}\ncprocess\nf10u\nPTCP\nn${address}:${port}\nTST=LISTEN\n`;
const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });
const empty: CommandResult = { code: 1, stdout: "", stderr: "" };

type Overrides = { jobs?: Record<string, CommandResult>; ports?: Record<string, CommandResult>; hang?: boolean };
function fake(overrides: Overrides = {}) {
  const calls: { program: string; args: readonly string[]; timeoutMs: number; maxOutputBytes: number; shell: false }[] = [];
  const run: CommandRunner = async (program, args, options) => {
    calls.push({ program, args, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes, shell: options.shell });
    if (overrides.hang) return await new Promise<CommandResult>(() => {});
    if (program === "/bin/launchctl") {
      const label = args[1]!.split("/").at(-1)!;
      return overrides.jobs?.[label] ?? ok(launchd(args[1]!, label === owner ? "101" : "202"));
    }
    const port = args.find((arg) => arg.startsWith("-iTCP:"))!.slice(6);
    return overrides.ports?.[port] ?? empty;
  };
  return { calls, run };
}

async function collect(ports: Record<string, string>, overrides: Overrides = {}, owned = [owner, other]) {
  const exec = fake(overrides);
  const result = await collectLiveProbes({ owned, ports, uid: 501, timeoutMs: 50, run: exec.run });
  return { ...result, calls: exec.calls };
}

function status(ports: Record<string, string>, observation: Awaited<ReturnType<typeof collect>>["ports"][number]) {
  return observation.kind === "complete" ? checkPorts(ports, [observation.probe])[0]?.status : observation.kind;
}

describe("SC-001: complete listener observations", () => {
  test("accepts nested launchd state without misattribution", async () => {
    const root = `gui/501/${owner} = {\n\tstate = running\n\tpid = 101\n\truns = 2\n\tcoalition = {\n\t\tstate = active\n\t\truns = 50\n\t}\n\tother coalition = {\n\t\tstate = active\n\t}\n}\n`;
    const result = await collect({ "3101": owner }, {
      jobs: { [owner]: ok(root) }, ports: { "3101": ok(socket(101, 3101)) },
    });
    expect(checkLaunchd([result.launchd[0]!])[0]?.status).toBe("pass");
    expect(status({ "3101": owner }, result.ports[0]!)).toBe("pass");
    expect(result.launchd[0]?.output).not.toContain("state = active");
    expect(result.launchd[0]?.output).not.toContain("runs = 50");
  });

  test("recognizes owner, foreign, mixed, dual-stack and confirmed no listeners", async () => {
    const ports = Object.fromEntries([3101, 3102, 3103, 3104, 3105].map((p) => [String(p), owner]));
    const { launchd: jobs, ports: observations } = await collect(ports, { ports: {
      "3101": ok(socket(101, 3101)),
      "3102": ok(socket(202, 3102)),
      "3103": ok(socket(101, 3103) + socket(999, 3103)),
      "3104": ok(socket(101, 3104, "127.0.0.1") + socket(101, 3104, "[::1]").replace(/^p101\ncprocess\n/, "")),
      "3105": empty,
    } });
    expect(jobs.every((job) => job.output !== null)).toBe(true);
    expect(observations.map((item) => status(ports, item))).toEqual(["pass", "fail", "fail", "pass", "fail"]);
    expect(observations[4]).toEqual({ kind: "complete", probe: { port: 3105, listeners: [] } });
    const mixed = observations[2];
    expect(mixed?.kind === "complete" && mixed.probe.listeners).toEqual([`${owner} 101`, "? 999"]);
    const dualStack = observations[3];
    expect(dualStack?.kind === "complete" && dualStack.probe.listeners).toEqual([`${owner} 101`, `${owner} 101`]);
  });
});

describe("SC-002: unknown evidence is never a valid port probe", () => {
  test("missing and ambiguous owner PIDs remain unknown", async () => {
    for (const jobs of [
      { [owner]: ok(`gui/501/${owner} = {\n\tstate = waiting\n}\n`) },
      { [owner]: ok(launchd(`gui/501/${owner}`, "101") + "pid = 102\n") },
      { [other]: ok(launchd(`gui/501/${other}`, "101")) },
      { [owner]: { code: 1, stdout: "", stderr: "private diagnostic" } },
      { [other]: { code: 1, stdout: "", stderr: "private diagnostic" } },
    ]) {
      const result = await collect({ "3101": owner }, { jobs, ports: { "3101": ok(socket(101, 3101)) } });
      expect(result.ports[0]?.kind).toBe("unknown");
      expect(JSON.stringify(result.ports)).not.toContain("private diagnostic");
    }
  });

  test("rejects incomplete lsof fields and the invalid-host regression", async () => {
    for (const result of [
      { code: 1, stdout: "", stderr: "permission denied: sensitive details" },
      { code: 2, stdout: "", stderr: "" },
      ok("p101\nf9u\nPTCP\nn*:3101\n"),
      ok(socket(101, 3101).trimEnd()),
      ok(socket(101, 3102)),
      ok(socket(101, 3101, "unresolved-host")),
      ok(socket(101, 3101).replace("TST=LISTEN", "TST=ESTABLISHED")),
      ok("p101\nf9u\nPTCP\nn*:3101\nTST=LISTEN\np202\n"),
      { code: 0, stdout: "", stderr: "" },
      ok("x".repeat(70_000)),
    ]) {
      const observed = await collect({ "3101": owner }, { ports: { "3101": result } });
      expect(observed.ports[0]?.kind).toBe("unknown");
      expect(JSON.stringify(observed.ports)).not.toContain("sensitive details");
    }
  });

  test("a nested launchd PID cannot masquerade as a job PID", async () => {
    const nested = `gui/501/${owner} = {\n\tstate = waiting\n\tendpoint = {\n\t\tpid = 101\n\t\tstate = running\n\t}\n}\n`;
    const result = await collect({ "3101": owner }, { jobs: { [owner]: ok(nested) } });
    expect(result.launchd[0]?.output).not.toBeNull();
    expect(result.launchd[0]?.output).not.toContain("pid = 101");
    expect(result.launchd[0]?.output).not.toContain("state = running");
    expect(checkLaunchd([result.launchd[0]!])[0]?.status).toBe("fail");
    expect(result.ports[0]?.kind).toBe("unknown");
  });

  test("failed launchd output is null and cannot turn another port healthy", async () => {
    const result = await collect({ "3101": owner, "3102": other }, {
      jobs: { [other]: { code: 1, stdout: "", stderr: "denied" } },
      ports: { "3101": ok(socket(101, 3101)), "3102": ok(socket(202, 3102)) },
    });
    expect(result.launchd.find((job) => job.label === other)?.output).toBeNull();
    expect(result.ports.every((p) => p.kind === "unknown")).toBe(true);
  });
});

describe("SC-003: bounded read-only commands", () => {
  test("uses only configured labels and ports, argument arrays, no shell, and finite bounds", async () => {
    const { calls } = await collect({ "3101": owner });
    expect(calls).toHaveLength(3);
    expect(calls.filter((c) => c.program === "/bin/launchctl").map((c) => c.args)).toEqual([
      ["print", `gui/501/${owner}`], ["print", `gui/501/${other}`],
    ]);
    expect(calls.find((c) => c.program === "/usr/sbin/lsof")?.args).toEqual([
      "-nP", "-iTCP:3101", "-sTCP:LISTEN", "-FpcfPnT",
    ]);
    for (const call of calls) {
      expect(call.shell).toBe(false);
      expect(call.timeoutMs).toBe(50);
      expect(call.maxOutputBytes).toBeGreaterThan(0);
      expect(call.maxOutputBytes).toBeLessThanOrEqual(65_536);
    }
  });

  test("rejects invalid input and the excessive-probe regression before starting commands", async () => {
    for (const input of [
      { owned: ["../bad"], ports: { "3101": "../bad" }, uid: 501, timeoutMs: 50 },
      { owned: [owner], ports: { "3101;bad": owner }, uid: 501, timeoutMs: 50 },
      { owned: [owner], ports: { "03101": owner }, uid: 501, timeoutMs: 50 },
      { owned: [owner], ports: { "3101": other }, uid: 501, timeoutMs: 50 },
      { owned: [owner], ports: { "3101": owner }, uid: -1, timeoutMs: 50 },
      { owned: [owner], ports: { "3101": owner }, uid: 501, timeoutMs: 0 },
      { owned: ["101"], ports: { "3101": "101" }, uid: 501, timeoutMs: 50 },
      { owned: [owner, owner], ports: { "3101": owner }, uid: 501, timeoutMs: 50 },
      { owned: Array.from({ length: 129 }, (_, n) => `org.example.job${n}`), ports: {}, uid: 501, timeoutMs: 50 },
    ]) {
      const exec = fake();
      await expect(collectLiveProbes({ ...input, run: exec.run })).rejects.toThrow();
      expect(exec.calls).toHaveLength(0);
    }
  });

  test("bounds the wait even when an injected executor hangs", async () => {
    const before = Date.now();
    const result = await collect({ "3101": owner }, { hang: true });
    expect(Date.now() - before).toBeLessThan(1_000);
    expect(result.ports[0]?.kind).toBe("unknown");
  });
});
