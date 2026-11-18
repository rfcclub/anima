import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SURFACES } from "./agent-loader.ts";
import { type FakeRuntime, okJoin, startFakeRuntime } from "./test-support/fake-runtime.ts";

const LOADER = join(import.meta.dir, "agent-loader.sh");

const runtimes: FakeRuntime[] = [];

afterEach(() => {
  while (runtimes.length) runtimes.pop()!.stop();
});

function runtime(handler = okJoin): FakeRuntime {
  const fake = startFakeRuntime(handler);
  runtimes.push(fake);
  return fake;
}

/** Records env + argv NUL-separated: AGENT_NAME, AGENT_IDENTITY_FILE, REASONIX_APPENDIX_FILE, then each argument. */
const STUB = `#!/bin/sh
out=\${STUB_OUT:?}
printf 'AGENT_NAME=%s\\0AGENT_IDENTITY_FILE=%s\\0REASONIX_APPENDIX_FILE=%s\\0' "\${AGENT_NAME-}" "\${AGENT_IDENTITY_FILE-}" "\${REASONIX_APPENDIX_FILE-}" > "$out"
for a in "$@"; do printf '%s\\0' "$a" >> "$out"; done
`;

function writeStub(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, STUB);
  chmodSync(path, 0o755);
}

function setup(options: { without?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agent-loader-dispatch-"));
  const launchDir = join(root, "scripts");
  const binDir = join(root, "bin");
  const stubs: Record<string, string> = {
    claude: join(launchDir, "claude", "claudia"),
    codex: join(launchDir, "codex", "codexia"),
    omp: join(launchDir, "omp", "omp-agent"),
    reasonix: join(binDir, "reasonix-patched"),
  };
  for (const [harness, path] of Object.entries(stubs)) if (!options.without?.includes(harness)) writeStub(path);
  return { root, home: join(root, "home"), launchDir, binDir, out: join(root, "stub.out") };
}

async function run(env: ReturnType<typeof setup>, fake: FakeRuntime, args: string[], loader = LOADER, extraEnv: Record<string, string> = {}, cwd?: string) {
  const proc = Bun.spawn(["sh", loader, ...args], {
    cwd,
    env: {
      ...process.env,
      // The Mesh sidecar has its own tests below; elsewhere it stays off so a real one never starts.
      AGENT_LOADER_MESH: "0",
      HOME: env.home,
      AGENT_LOADER_LAUNCH_DIR: env.launchDir,
      IDENTITY_RUNTIME_URL: fake.url,
      // Only the stub bin dir, bun and the system dirs: a real reasonix-patched on the developer's PATH must never be found.
      PATH: `${env.binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
      STUB_OUT: env.out,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

function recorded(env: ReturnType<typeof setup>): { env: string[]; argv: string[] } {
  const parts = readFileSync(env.out, "utf8").split("\0");
  parts.pop();
  return { env: parts.slice(0, 3), argv: parts.slice(3) };
}

function identityPath(env: ReturnType<typeof setup>, agent: string): string {
  return join(env.home, ".agent-runtime", agent, "CORE_IDENTITY.md");
}

// HL-06
test("HL-06: host arguments reach the launcher byte for byte, with the agent and identity file exported", async () => {
  const fake = runtime();
  const env = setup();
  const hostArgs = ["new", "--force", "", "a b", "$HOME", "line1\nline2", "-x", "--", "'quoted'", "*"];
  const result = await run(env, fake, ["lena", "claude", ...hostArgs]);
  expect(result.code).toBe(0);
  const { env: vars, argv } = recorded(env);
  expect(argv).toEqual(hostArgs);
  expect(vars[0]).toBe("AGENT_NAME=lena");
  expect(vars[1]).toBe(`AGENT_IDENTITY_FILE=${identityPath(env, "lena")}`);
  expect(fake.requests).toEqual(["POST /identity-runtime/lena/join"]);
});

test("HL-06: a leading --force refreshes a fresh cache, a --force after the harness is a host argument", async () => {
  const fake = runtime();
  const env = setup();
  const path = identityPath(env, "lena");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "FRESH");
  utimesSync(path, Date.now() / 1000, Date.now() / 1000);

  await run(env, fake, ["lena", "claude", "--force"]);
  expect(fake.requests).toEqual([]);
  expect(recorded(env).argv).toEqual(["--force"]);

  await run(env, fake, ["--force", "lena", "claude"]);
  expect(fake.requests).toEqual(["POST /identity-runtime/lena/join"]);
  expect(recorded(env).argv).toEqual([]);
});

test("HL-06: works when invoked through a symlink", async () => {
  const fake = runtime();
  const env = setup();
  const link = join(env.root, "agent-loader");
  symlinkSync(LOADER, link);
  expect((await run(env, fake, ["lena", "claude"], link)).code).toBe(0);
  expect(recorded(env).env[0]).toBe("AGENT_NAME=lena");
});

test("usage: fewer than two arguments exits 64", async () => {
  const fake = runtime();
  const env = setup();
  for (const args of [[], ["lena"], ["--force", "lena"]]) {
    const result = await run(env, fake, args);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("usage");
  }
  expect(fake.requests).toEqual([]);
});

// HL-07 / HL-08, end to end
test("HL-07: an unknown agent exits 64 naming it and launches nothing", async () => {
  const fake = runtime();
  const env = setup();
  const result = await run(env, fake, ["nobody", "claude"]);
  expect(result.code).toBe(64);
  expect(result.stderr).toContain("nobody");
  expect(existsSync(env.out)).toBe(false);
  expect(fake.requests).toEqual([]);
});

test("HL-08: an unsupported harness (including deferred crush) exits 64 naming it and launches nothing", async () => {
  const fake = runtime();
  const env = setup();
  for (const harness of ["vim", "crush"]) {
    const result = await run(env, fake, ["lena", harness]);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain(`'${harness}'`);
  }
  expect(existsSync(env.out)).toBe(false);
  expect(fake.requests).toEqual([]);
});

test("a missing launcher exits 64 before any network call", async () => {
  const fake = runtime();
  for (const harness of ["claude", "codex", "omp", "reasonix"]) {
    const env = setup({ without: [harness] });
    const result = await run(env, fake, ["lena", harness]);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("launcher");
    expect(existsSync(env.out)).toBe(false);
  }
  expect(fake.requests).toEqual([]);
});

// HL-03 / HL-05, end to end
test("HL-03: a failed identity fetch exits 69 and launches nothing", async () => {
  const fake = runtime(() => Response.json({ error: "down" }, { status: 503 }));
  const env = setup();
  const result = await run(env, fake, ["lena", "claude", "new"]);
  expect(result.code).toBe(69);
  expect(result.stderr).toContain("lena");
  expect(existsSync(env.out)).toBe(false);
});

test("HL-04: a stale cache is not served when the refresh fails", async () => {
  const fake = runtime(() => Response.json({ error: "down" }, { status: 503 }));
  const env = setup();
  const path = identityPath(env, "lena");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "OLD");
  utimesSync(path, (Date.now() - 3_600_000) / 1000, (Date.now() - 3_600_000) / 1000);
  const result = await run(env, fake, ["lena", "claude"]);
  expect(result.code).toBe(69);
  expect(existsSync(env.out)).toBe(false);
});

// Adapters
test("HL-09: codex gets the identity file as the first launcher argument, then the host arguments", async () => {
  const fake = runtime();
  const env = setup();
  expect((await run(env, fake, ["lena", "codex", "--model", "gpt", "exec", "hi there"])).code).toBe(0);
  expect(recorded(env).argv).toEqual([identityPath(env, "lena"), "--model", "gpt", "exec", "hi there"]);
  expect(fake.bodies[0]).toMatchObject({ clientId: "codex", surfaceId: "codex-lena" });
});

test("HL-10: claude goes through claudia with the agent and identity file in the environment", async () => {
  const fake = runtime();
  const env = setup();
  expect((await run(env, fake, ["pia", "claude", "ds", "resume"])).code).toBe(0);
  const { env: vars, argv } = recorded(env);
  expect(argv).toEqual(["ds", "resume"]);
  expect(vars.slice(0, 2)).toEqual(["AGENT_NAME=pia", `AGENT_IDENTITY_FILE=${identityPath(env, "pia")}`]);
  expect(fake.bodies[0]).toMatchObject({ clientId: "claude", surfaceId: "claudia-pia" });
});

test("HL-15: omp goes through omp-agent with the host arguments untouched", async () => {
  const fake = runtime();
  const env = setup();
  expect((await run(env, fake, ["rhea", "omp", "/work/repo", "--", "--model", "x"])).code).toBe(0);
  const { env: vars, argv } = recorded(env);
  expect(argv).toEqual(["/work/repo", "--", "--model", "x"]);
  expect(vars[1]).toBe(`AGENT_IDENTITY_FILE=${identityPath(env, "rhea")}`);
  expect(fake.bodies[0]).toMatchObject({ clientId: "omp", surfaceId: "rhea-omp" });
});

test("HL-16: reasonix gets REASONIX_APPENDIX_FILE and the host arguments untouched", async () => {
  const fake = runtime();
  const env = setup();
  expect((await run(env, fake, ["lena", "reasonix", "-p", "hello world"])).code).toBe(0);
  const { env: vars, argv } = recorded(env);
  expect(vars[2]).toBe(`REASONIX_APPENDIX_FILE=${identityPath(env, "lena")}`);
  expect(argv).toEqual(["-p", "hello world"]);
  expect(fake.bodies[0]).toMatchObject({ clientId: "reasonix", surfaceId: "reasonix-lena" });
});

test("the dispatcher's adapter table and the TypeScript surface table list the same harnesses", () => {
  const source = readFileSync(LOADER, "utf8");
  const dispatched = [...source.matchAll(/^ {2}([a-z]+)\) +launcher=/gm)].map((match) => match[1]).sort();
  expect(dispatched).toEqual(Object.keys(SURFACES).sort());
});

/** A sidecar stand-in that records its argv, and a launcher that records its pid (exec keeps the loader's pid). */
function meshSetup() {
  const env = setup();
  const sidecar = join(env.root, "fake-sidecar.ts");
  writeFileSync(sidecar, 'await Bun.write(process.env.SIDECAR_OUT!, JSON.stringify(Bun.argv.slice(2)));\n');
  const launcher = join(env.launchDir, "omp", "omp-agent");
  writeFileSync(launcher, '#!/bin/sh\nprintf %s "$$" > "${LAUNCHER_PID_OUT:?}"\n');
  chmodSync(launcher, 0o755);
  return { env, sidecar, sidecarOut: join(env.root, "sidecar.out"), pidOut: join(env.root, "launcher.pid") };
}

async function waitForFile(path: string, ms = 5_000): Promise<string> {
  const started = Date.now();
  while (!existsSync(path) || readFileSync(path, "utf8") === "") {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(25);
  }
  return readFileSync(path, "utf8");
}

test("starts the Mesh sidecar in the background with the agent, harness and the launched harness's pid", async () => {
  const fake = runtime();
  const mesh = meshSetup();
  const result = await run(mesh.env, fake, ["rhea", "omp"], LOADER, {
    AGENT_LOADER_MESH: "1", AGENT_LOADER_MESH_SIDECAR: mesh.sidecar, SIDECAR_OUT: mesh.sidecarOut, LAUNCHER_PID_OUT: mesh.pidOut,
  });
  expect(result.code).toBe(0);
  const pid = await waitForFile(mesh.pidOut);
  expect(JSON.parse(await waitForFile(mesh.sidecarOut))).toEqual(["--agent", "rhea", "--harness", "omp", "--parent", pid, "--cwd", realpathSync(process.cwd())]);
});

// Each independent launcher keeps the default five-second test budget. Combining
// all twelve launches in one test made fresh/cold runs race their aggregate time.
const projectDirectoryCases: Array<{
  label: string; harness: string;
  args: (projectA: string, projectB: string) => string[];
  expected: "a" | "b";
}> = [
  { label: "omp absolute", harness: "omp", args: (_a, b) => [b], expected: "b" },
  { label: "omp relative", harness: "omp", args: () => ["../project-b"], expected: "b" },
  { label: "omp flags", harness: "omp", args: () => ["--", "--model", "x/y"], expected: "a" },
  { label: "omp default", harness: "omp", args: () => [], expected: "a" },
  { label: "codex -C", harness: "codex", args: (_a, b) => ["-C", b], expected: "b" },
  { label: "codex relative --cd", harness: "codex", args: () => ["--cd", "../project-b", "--model", "m"], expected: "b" },
  { label: "codex --cd=", harness: "codex", args: (_a, b) => [`--cd=${b}`], expected: "b" },
  { label: "codex attached -C", harness: "codex", args: (_a, b) => [`-C${b}`], expected: "b" },
  { label: "codex literal --cd after --", harness: "codex", args: (_a, b) => ["--", `--cd=${b}`], expected: "a" },
  { label: "codex literal -C after --", harness: "codex", args: (_a, b) => ["--model", "m", "--", "-C", b], expected: "a" },
  { label: "codex -C before --", harness: "codex", args: (_a, b) => ["-C", b, "--", "prompt"], expected: "b" },
  { label: "claude default", harness: "claude", args: () => ["--resume", "x"], expected: "a" },
];
for (const scenario of projectDirectoryCases) {
  test(`passes the sidecar the project directory the launcher will use: ${scenario.label}`, async () => {
    const fake = runtime();
    const projects = mkdtempSync(join(tmpdir(), "agent-loader-projects-"));
    const projectA = join(projects, "project-a"), projectB = join(projects, "project-b");
    mkdirSync(projectA); mkdirSync(projectB);
    try {
      const mesh = meshSetup();
      const result = await run(mesh.env, fake, ["rhea", scenario.harness, ...scenario.args(projectA, projectB)], LOADER, {
        AGENT_LOADER_MESH: "1", AGENT_LOADER_MESH_SIDECAR: mesh.sidecar, SIDECAR_OUT: mesh.sidecarOut, LAUNCHER_PID_OUT: mesh.pidOut,
      }, projectA);
      expect(result.code).toBe(0);
      const argv = JSON.parse(await waitForFile(mesh.sidecarOut)) as string[];
      expect(argv[argv.indexOf("--cwd") + 1]).toBe(realpathSync(scenario.expected === "a" ? projectA : projectB));
    } finally { rmSync(projects, { recursive: true, force: true }); }
  });
}

test("still launches the harness when the selected project directory does not exist", async () => {
  const fake = runtime();
  const mesh = meshSetup();
  const result = await run(mesh.env, fake, ["rhea", "omp", "/nonexistent/project"], LOADER, {
    AGENT_LOADER_MESH: "1", AGENT_LOADER_MESH_SIDECAR: mesh.sidecar, SIDECAR_OUT: mesh.sidecarOut, LAUNCHER_PID_OUT: mesh.pidOut,
  });
  expect(result.code).toBe(0);
  expect(await waitForFile(mesh.pidOut)).toMatch(/^[0-9]+$/);
});

test("launches the harness unchanged when the Mesh sidecar is off or missing", async () => {
  const fake = runtime();
  const modes: Record<string, string>[] = [{ AGENT_LOADER_MESH: "0" }, { AGENT_LOADER_MESH: "1", AGENT_LOADER_MESH_SIDECAR: "/nonexistent/mesh-sidecar.ts" }];
  for (const extra of modes) {
    const mesh = meshSetup();
    const result = await run(mesh.env, fake, ["rhea", "omp"], LOADER, { ...extra, SIDECAR_OUT: mesh.sidecarOut, LAUNCHER_PID_OUT: mesh.pidOut });
    expect(result.code).toBe(0);
    expect(await waitForFile(mesh.pidOut)).toMatch(/^[0-9]+$/);
    await Bun.sleep(200);
    expect(existsSync(mesh.sidecarOut)).toBe(false);
  }
});

