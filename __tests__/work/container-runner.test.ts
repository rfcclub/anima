import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionGateway } from "../../src/work/gateway";

describe("container runner (cartridge-worker-dispatch S7)", () => {
  test("container command refuses an unspecified relay socket", async () => {
    const { containerCommand } = await import("../../src/work/container-runner");
    const input = { sessionId: "s1", root: "/tmp/work-s1", gatewayUrl: "http://127.0.0.1:12345",
      gatewayToken: "token", model: "model", task: "task", timeoutMs: 5000 };
    expect(() => (containerCommand as any)(input, "worker:test")).toThrow();
  });
  test("session home is removed if provider config creation fails", async () => {
    const { createContainerRunner } = await import("../../src/work/container-runner");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "runner-config-failure-")));
    for (const part of ["tree", "tmp", "home"]) mkdirSync(join(root, part));
    const binary = join(root, "fake-container");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    try {
      await expect(createContainerRunner({ binary }).start({
        sessionId: "setup", root, gatewayUrl: "http://127.0.0.1:12345",
        gatewayToken: "token", model: 1n as any, task: "task", timeoutMs: 1000,
      })).rejects.toThrow();
      expect(readdirSync(join(root, "home"))).toEqual([]);
      await expect(createContainerRunner({ binary }).start({
        sessionId: "bad-url", root, gatewayUrl: "not a URL",
        gatewayToken: "token", model: "model", task: "task", timeoutMs: 1000,
      })).rejects.toThrow();
      expect(readdirSync(join(root, "home"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("container-runner-boundary", async () => {
    const { containerCommand, createContainerRunner } = await import("../../src/work/container-runner");
    const token = "test-session-token-never-in-process-arguments";
    const input = {
      sessionId: "s1", root: "/tmp/work-s1", gatewayUrl: "http://127.0.0.1:12345",
      gatewayToken: token, model: "model", task: "test task", timeoutMs: 5000,
    };
    const args = containerCommand(input, "worker:test", "/tmp/private-relay/gw.sock");
    expect(args).toContain("--network");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args).toContain("/tmp/work-s1:/tmp/work-s1");
    expect(args).toContain("--publish-socket");
    expect(args).toContain("--yolo");
    expect(args).not.toContain(token);
    expect(JSON.stringify(args)).not.toContain(token);
    expect(JSON.stringify(args)).not.toContain("GITHUB_TOKEN");
    expect(JSON.stringify(args)).not.toContain("OPENAI_API_KEY");

    const root = realpathSync(mkdtempSync(join(tmpdir(), "runner-unavailable-")));
    mkdirSync(join(root, "tree"));
    mkdirSync(join(root, "home"));
    mkdirSync(join(root, "tmp"));
    try {
      expect(typeof createContainerRunner).toBe("function");
      const runner = createContainerRunner({ binary: "/nonexistent/container" });
      await expect(runner.start({ ...input, root })).rejects.toThrow();
      expect(readdirSync(join(root, "home"))).toEqual([]);
      const fakeBinary = join(root, "fake-container");
      writeFileSync(fakeBinary, `#!/bin/sh\nif [ "$1" = "inspect" ]; then echo "Error: container not found: $2" >&2; fi\nexit 1\n`, { mode: 0o755 });
      await expect(createContainerRunner({ binary: fakeBinary }).start({ ...input, root })).rejects.toThrow();
      expect(readdirSync(join(root, "home"))).toEqual([]);
      const missingImage = join(root, "missing-image");
      writeFileSync(missingImage, `#!/bin/sh\nif [ "$1" = "run" ] || [ "$1" = "image" ]; then echo "Error: image not found: anima-worker:missing" >&2; fi\nif [ "$1" = "inspect" ]; then echo "Error: container not found" >&2; fi\nexit 1\n`, { mode: 0o755 });
      await expect(createContainerRunner({ binary: missingImage, image: "anima-worker:missing" }).start({ ...input, root }))
        .rejects.toThrow("worker image anima-worker:missing is unavailable");
      expect(readdirSync(join(root, "home"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reject insecure relay socket parent", async () => {
    const { assertPrivateSocketDir } = await import("../../src/work/container-runner") as any;
    const parent = mkdtempSync(join(tmpdir(), "runner-socket-parent-"));
    try {
      expect(typeof assertPrivateSocketDir).toBe("function");
      expect(() => assertPrivateSocketDir(parent)).not.toThrow();
      const { chmodSync } = await import("node:fs");
      chmodSync(parent, 0o755);
      expect(() => assertPrivateSocketDir(parent)).toThrow();
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  test("cleanup failures are reported after VM cessation", async () => {
    const { createContainerRunner } = await import("../../src/work/container-runner");
    const { chmodSync } = await import("node:fs");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "runner-cleanup-")));
    for (const part of ["tree", "tmp", "home"]) mkdirSync(join(root, part));
    const binary = join(root, "fake-container");
    writeFileSync(binary, `#!/usr/bin/python3
import os, sys, time
if sys.argv[1] == "run":
    home = next(x[5:] for x in sys.argv if x.startswith("HOME="))
    relay = sys.argv[sys.argv.index("--publish-socket") + 1].split(":", 1)[0]
    relay_dir = os.path.dirname(relay)
    open(os.path.join(os.path.dirname(os.path.dirname(home)), "relay-dir"), "w").write(relay_dir)
    open(os.path.join(relay_dir, "locked"), "w").close()
    os.chmod(relay_dir, 0)
    os.mkdir(os.path.join(home, "locked"))
    open(os.path.join(home, "locked", "file"), "w").close()
    os.chmod(os.path.join(home, "locked"), 0)
    open(os.path.join(home, ".relay-ready"), "w").close()
    time.sleep(0.2)
elif sys.argv[1] == "inspect":
    print("Error: container not found: " + sys.argv[2], file=sys.stderr)
    sys.exit(1)
`, { mode: 0o755 });
    let vm: any;
    try {
      vm = await createContainerRunner({ binary }).start({ sessionId: "cleanup", root, gatewayUrl: "http://127.0.0.1:12345", gatewayToken: "token", model: "model", task: "task", timeoutMs: 5000 });
      await vm.exited;
      expect(await vm.gone()).toBe(true);
      expect(vm.cleanupError()).toContain("relay cleanup failed");
      expect(vm.cleanupError()).toContain("session cleanup failed");
    } finally {
      if (vm) await vm.kill();
      const marker = join(root, "relay-dir");
      if (existsSync(marker)) {
        const relayDir = readFileSync(marker, "utf8");
        chmodSync(relayDir, 0o700);
        rmSync(relayDir, { recursive: true, force: true });
      }
      for (const name of readdirSync(join(root, "home"))) {
        const locked = join(root, "home", name, "locked");
        if (existsSync(locked)) chmodSync(locked, 0o700);
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an ambiguous inspect uses the complete container list before cleanup", async () => {
    const { createContainerRunner } = await import("../../src/work/container-runner");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "runner-inspect-fallback-")));
    for (const part of ["tree", "tmp", "home"]) mkdirSync(join(root, part));
    const binary = join(root, "fake-container");
    writeFileSync(binary, `#!/usr/bin/python3
import json, os, sys, time
if sys.argv[1] == "run":
    home = next(x[5:] for x in sys.argv if x.startswith("HOME="))
    open(os.path.join(home, ".relay-ready"), "w").close()
    time.sleep(0.2)
elif sys.argv[1] == "inspect":
    print("unexpected inspection error", file=sys.stderr)
    sys.exit(1)
elif sys.argv[1] == "list":
    print(open(${JSON.stringify(join(root, "list.json"))}).read())
`, { mode: 0o755 });
    writeFileSync(join(root, "list.json"), '[{"id":"anima-w-fallback"}]');
    const vm = await createContainerRunner({ binary }).start({
      sessionId: "fallback", root, gatewayUrl: "http://127.0.0.1:12345",
      gatewayToken: "token", model: "model", task: "task", timeoutMs: 5000,
    });
    try {
      await vm.exited;
      expect(await vm.gone()).toBe(false);
      expect(readdirSync(join(root, "home"))).toHaveLength(1);
      writeFileSync(join(root, "list.json"), "not json");
      expect(await vm.gone()).toBe(false);
      expect(readdirSync(join(root, "home"))).toHaveLength(1);
      writeFileSync(join(root, "list.json"), "[]");
      expect(await vm.gone()).toBe(true);
      expect(readdirSync(join(root, "home"))).toEqual([]);
    } finally {
      await vm.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("output cutoff never exposes a token fragment", async () => {
    const { createContainerRunner } = await import("../../src/work/container-runner");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "runner-cutoff-")));
    for (const part of ["tree", "tmp", "home"]) mkdirSync(join(root, part));
    const binary = join(root, "fake-container");
    const token = "cutoff-secret-token";
    writeFileSync(binary, `#!/usr/bin/python3
import os, sys, time
if sys.argv[1] == "run":
    home = next(x[5:] for x in sys.argv if x.startswith("HOME="))
    open(os.path.join(home, ".relay-ready"), "w").close()
    sys.stdout.write("x" * (128 * 1024 - 8) + "${token}")
    sys.stdout.flush()
    time.sleep(0.3)
elif sys.argv[1] == "inspect":
    print("Error: container not found: " + sys.argv[2], file=sys.stderr)
    sys.exit(1)
`, { mode: 0o755 });
    let vm: Awaited<ReturnType<ReturnType<typeof createContainerRunner>["start"]>> | undefined;
    try {
      vm = await createContainerRunner({ binary }).start({
        sessionId: "cutoff", root, gatewayUrl: "http://127.0.0.1:12345",
        gatewayToken: token, model: "model", task: "task", timeoutMs: 5000,
      });
      await vm.exited;
      const output = await vm.output();
      expect(output).not.toContain(token);
      expect(output).not.toContain(token.slice(0, 8));
      expect(await vm.gone()).toBe(true);
    } finally {
      if (vm) await vm.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Opt in only after building the actual worker image; the unit check above is not isolation evidence.
test.skipIf(process.env.ANIMA_S7_VM_TEST !== "1")("real VM isolates the worker and killing it stops a detached writer", async () => {
  const { createContainerRunner } = await import("../../src/work/container-runner");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "s7-vm-real-")));
  const outside = join(tmpdir(), `s7-outside-${crypto.randomUUID()}`);
  for (const part of ["tree", "tmp", "home"]) mkdirSync(join(root, part));
  writeFileSync(outside, "host-only");
  const init = Bun.spawnSync(["git", "init", "-q", "--separate-git-dir", join(root, "git"), join(root, "tree")]);
  expect(init.exitCode).toBe(0);
  let calls = 0;
  const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("host") });
  const code = `
import json, os, socket, subprocess, time
def reachable(host, port):
    try:
        s = socket.create_connection((host, port), timeout=1)
        s.close()
        return True
    except OSError:
        return False
result = {
    "uid": os.geteuid(),
    "internet": reachable("1.1.1.1", 443),
    "host_port": reachable("127.0.0.1", ${portProbe.port}),
    "host_file_visible": os.path.exists(${JSON.stringify(outside)}),
    "key_env": sorted(k for k in os.environ if k.endswith("_API_KEY") or k == "GITHUB_TOKEN"),
    "git_ok": subprocess.run(["git", "rev-parse", "--git-dir"], capture_output=True).returncode == 0,
}
try:
    with open(${JSON.stringify(outside)}, "w") as f: f.write("worker tried to overwrite host")
except OSError:
    pass
with open("boundary.json", "w") as f: json.dump(result, f)
pid = os.fork()
if pid == 0:
    os.setsid()
    os.close(1)
    os.close(2)
    while True:
        with open("writer.txt", "a") as f: f.write("x")
        time.sleep(0.05)
`;
  const gateway = createSessionGateway({
    model: "s7-test-model", budget: 5,
    link: { workId: "test", jobId: "test", claimId: "test", sessionNo: 1 },
    admit: () => true,
    provider: {
      name: "test",
      async query(request) {
        calls++;
        if (calls === 1) return { message: { role: "assistant", content: "" }, tool_calls: [{ id: "probe", name: "run", arguments: JSON.stringify({ code }) }] };
        await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
        return { message: { role: "assistant", content: "stopped" } };
      },
    },
  });
  await gateway.start();
  let vm: Awaited<ReturnType<ReturnType<typeof createContainerRunner>["start"]>> | undefined;
  try {
    vm = await createContainerRunner({ image: process.env.ANIMA_S7_VM_IMAGE ?? "anima-worker:s7-test", readinessMs: 30_000 }).start({
      sessionId: `s7test${Date.now()}`, root, gatewayUrl: gateway.url, gatewayToken: gateway.token,
      model: "s7-test-model", task: "Run the supplied diagnostic.", timeoutMs: 90_000,
    });
    const boundary = join(root, "tree", "boundary.json");
    const writer = join(root, "tree", "writer.txt");
    const until = Date.now() + 45_000;
    while ((!existsSync(boundary) || !existsSync(writer)) && Date.now() < until) await Bun.sleep(100);
    expect(existsSync(boundary)).toBe(true);
    expect(existsSync(writer)).toBe(true);
    expect(JSON.parse(readFileSync(boundary, "utf8"))).toEqual({
      uid: 1000, internet: false, host_port: false, host_file_visible: false, key_env: [], git_ok: true,
    });
    const before = statSync(writer).size;
    await Bun.sleep(250);
    expect(statSync(writer).size).toBeGreaterThan(before);
    expect(readFileSync(outside, "utf8")).toBe("host-only");
    gateway.revoke();
    await vm.kill();
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) { gone = await vm.gone(); if (!gone) await Bun.sleep(100); }
    expect(gone).toBe(true);
    const stoppedAt = statSync(writer).size;
    await Bun.sleep(300);
    expect(statSync(writer).size).toBe(stoppedAt);
    expect(calls).toBeGreaterThanOrEqual(1);
  } finally {
    gateway.revoke();
    if (vm) await vm.kill();
    await gateway.stop();
    portProbe.stop(true);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
}, 120_000);

// The worker can spend longer than the gateway's TCP idle timeout in a tool call.
test.skipIf(process.env.ANIMA_S7_VM_TEST !== "1")("real VM relay survives an idle gap longer than 12 seconds", async () => {
  const { createContainerRunner } = await import("../../src/work/container-runner");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "s7-vm-idle-")));
  for (const part of ["tree", "tmp", "home"]) mkdirSync(join(root, part));
  expect(Bun.spawnSync(["git", "init", "-q", "--separate-git-dir", join(root, "git"), join(root, "tree")]).exitCode).toBe(0);
  let calls = 0;
  const gateway = createSessionGateway({
    model: "s7-idle-model", budget: 10, link: { workId: "test", jobId: "test", claimId: "test", sessionNo: 1 }, admit: () => true,
    provider: { name: "test", async query() {
      calls++;
      if (calls === 1) return { message: { role: "assistant", content: "" }, tool_calls: [{ id: "sleep", name: "run", arguments: JSON.stringify({ code: "import time\ntime.sleep(15)\nprint('gap complete')" }) }] };
      return { message: { role: "assistant", content: "Done." } };
    } },
  });
  await gateway.start();
  let vm: Awaited<ReturnType<ReturnType<typeof createContainerRunner>["start"]>> | undefined;
  try {
    vm = await createContainerRunner({ image: process.env.ANIMA_S7_VM_IMAGE ?? "anima-worker:s7-test", readinessMs: 30_000 }).start({
      sessionId: `s7idle${Date.now()}`, root, gatewayUrl: gateway.url, gatewayToken: gateway.token,
      model: "s7-idle-model", task: "Run the supplied diagnostic.", timeoutMs: 60_000,
    });
    const result = await Promise.race([vm.exited, Bun.sleep(50_000).then(() => ({ code: null }))]);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result.code).toBe(0);
  } finally {
    gateway.revoke();
    if (vm) await vm.kill();
    await gateway.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 80_000);
