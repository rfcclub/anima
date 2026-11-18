import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  EXIT_FETCH,
  EXIT_USAGE,
  EXIT_WRITE,
  LoaderError,
  SURFACES,
  parsePrepareArgs,
  prepareIdentity,
} from "./agent-loader.ts";
import { type FakeRuntime, okJoin, startFakeRuntime } from "./test-support/fake-runtime.ts";

const runtimes: FakeRuntime[] = [];

afterEach(() => {
  while (runtimes.length) runtimes.pop()!.stop();
});

function runtime(handler = okJoin): FakeRuntime {
  const fake = startFakeRuntime(handler);
  runtimes.push(fake);
  return fake;
}

function setup(agents = ["bruno", "ivan", "lena", "pia", "rhea", "abel"]) {
  const root = mkdtempSync(join(tmpdir(), "agent-loader-"));
  const colony = join(root, "colony.json");
  writeFileSync(colony, JSON.stringify({ agents: agents.map((name) => ({ name })) }));
  return { root, home: join(root, "home"), rosterCandidates: [colony] };
}

function cachePath(home: string, agent: string): string {
  return join(home, ".agent-runtime", agent, "CORE_IDENTITY.md");
}

function ageCache(path: string, minutes: number): void {
  const when = (Date.now() - minutes * 60_000) / 1000;
  utimesSync(path, when, when);
}

async function failure(promise: Promise<unknown>): Promise<LoaderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LoaderError);
    return error as LoaderError;
  }
  throw new Error("expected prepareIdentity to reject");
}

// HL-01
test("HL-01: fetches any roster agent through the same join contract, no per-agent branch", async () => {
  const fake = runtime();
  const env = setup();
  for (const agent of ["lena", "pia", "rhea"]) {
    const path = await prepareIdentity({ agent, harness: "claude", force: false, origin: fake.url, ...env });
    expect(path).toBe(cachePath(env.home, agent));
    expect(readFileSync(path, "utf8")).toBe(`# identity of ${agent}\n`);
  }
  expect(fake.requests).toEqual([
    "POST /identity-runtime/lena/join",
    "POST /identity-runtime/pia/join",
    "POST /identity-runtime/rhea/join",
  ]);
  expect(fake.bodies[0]).toMatchObject({ clientId: "claude", surfaceId: "claudia-lena" });
  expect(typeof fake.bodies[0]!.message).toBe("string");
});

test("surface ids match what the existing launchers send today", () => {
  expect(SURFACES.claude!.surfaceId("bruno")).toBe("claudia-bruno");
  expect(SURFACES.codex!.surfaceId("eli")).toBe("codex-eli");
  expect(SURFACES.omp!.surfaceId("bruno")).toBe("bruno-omp");
  expect(SURFACES.reasonix!.surfaceId("eli")).toBe("reasonix-eli");
});

// HL-02
test("HL-02: a cache younger than 30 minutes is reused with no network call", async () => {
  const fake = runtime();
  const env = setup();
  const path = cachePath(env.home, "lena");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "CACHED");
  ageCache(path, 29);
  expect(await prepareIdentity({ agent: "lena", harness: "claude", force: false, origin: fake.url, ...env })).toBe(path);
  expect(fake.requests).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe("CACHED");
});

test("HL-02: a cache older than 30 minutes is refreshed", async () => {
  const fake = runtime();
  const env = setup();
  const path = cachePath(env.home, "lena");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "OLD");
  ageCache(path, 31);
  await prepareIdentity({ agent: "lena", harness: "claude", force: false, origin: fake.url, ...env });
  expect(fake.requests).toHaveLength(1);
  expect(readFileSync(path, "utf8")).toBe("# identity of lena\n");
});

test("HL-02: --force refreshes a fresh cache", async () => {
  const fake = runtime();
  const env = setup();
  const path = cachePath(env.home, "lena");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "FRESH");
  await prepareIdentity({ agent: "lena", harness: "claude", force: true, origin: fake.url, ...env });
  expect(fake.requests).toHaveLength(1);
});

test("HL-02: a fresh but zero-byte cache is not trusted", async () => {
  const fake = runtime();
  const env = setup();
  const path = cachePath(env.home, "lena");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  await prepareIdentity({ agent: "lena", harness: "claude", force: false, origin: fake.url, ...env });
  expect(fake.requests).toHaveLength(1);
  expect(readFileSync(path, "utf8")).toBe("# identity of lena\n");
});

// HL-03
test("HL-03: unreachable runtime with no cache fails with 69, names the agent, writes nothing", async () => {
  const env = setup();
  const error = await failure(
    prepareIdentity({ agent: "lena", harness: "claude", force: false, origin: "http://127.0.0.1:1", ...env }),
  );
  expect(error.code).toBe(EXIT_FETCH);
  expect(error.message).toContain("lena");
  expect(existsSync(cachePath(env.home, "lena"))).toBe(false);
});

test("HL-03: a non-2xx join fails with 69", async () => {
  const fake = runtime(() => Response.json({ error: "down" }, { status: 503 }));
  const env = setup();
  const error = await failure(prepareIdentity({ agent: "lena", harness: "claude", force: false, origin: fake.url, ...env }));
  expect(error.code).toBe(EXIT_FETCH);
  expect(error.message).toContain("down");
});

test("HL-03: a runtime that never answers times out with 69", async () => {
  const fake = runtime(() => new Promise<Response>(() => {}));
  const env = setup();
  const error = await failure(
    prepareIdentity({ agent: "lena", harness: "claude", force: false, origin: fake.url, timeoutMs: 100, ...env }),
  );
  expect(error.code).toBe(EXIT_FETCH);
});

// HL-04
test("HL-04: stale cache + failed fetch fails with 69 and does not serve or touch the old file", async () => {
  const fake = runtime(() => Response.json({ error: "down" }, { status: 500 }));
  const env = setup();
  const path = cachePath(env.home, "lena");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "OLD");
  ageCache(path, 35);
  const error = await failure(prepareIdentity({ agent: "lena", harness: "claude", force: false, origin: fake.url, ...env }));
  expect(error.code).toBe(EXIT_FETCH);
  expect(readFileSync(path, "utf8")).toBe("OLD");
});

// HL-05
test("HL-05: an empty, whitespace or missing projection fails with 69 and caches nothing", async () => {
  for (const body of [{ projection: "" }, { projection: "  \n" }, {}]) {
    const fake = runtime(() => Response.json(body));
    const env = setup();
    const error = await failure(prepareIdentity({ agent: "lena", harness: "claude", force: false, origin: fake.url, ...env }));
    expect(error.code).toBe(EXIT_FETCH);
    expect(existsSync(cachePath(env.home, "lena"))).toBe(false);
  }
});

test("HL-05: a cache path that cannot be written fails with 73", async () => {
  const fake = runtime();
  const env = setup();
  writeFileSync(env.home, "a file where the home directory should be");
  const error = await failure(prepareIdentity({ agent: "lena", harness: "claude", force: false, origin: fake.url, ...env }));
  expect(error.code).toBe(EXIT_WRITE);
  expect(error.message).toContain("lena");
});

// HL-07 / HL-08
test("HL-07: an agent outside the roster is rejected with 64 before any network call", async () => {
  const fake = runtime();
  const env = setup();
  for (const agent of ["nobody", "quin", "../bruno", "", "BRUNO", "lena/x"]) {
    const error = await failure(prepareIdentity({ agent, harness: "claude", force: false, origin: fake.url, ...env }));
    expect(error.code).toBe(EXIT_USAGE);
    expect(error.message).toContain(`'${agent}'`);
  }
  expect(fake.requests).toEqual([]);
});

test("HL-08: an unsupported harness is rejected with 64 before any network call", async () => {
  const fake = runtime();
  const env = setup();
  for (const harness of ["vim", "crush", "constructor", "__proto__", ""]) {
    const error = await failure(prepareIdentity({ agent: "lena", harness, force: false, origin: fake.url, ...env }));
    expect(error.code).toBe(EXIT_USAGE);
    expect(error.message).toContain(`'${harness}'`);
  }
  expect(fake.requests).toEqual([]);
});

test("with no roster file on this machine the runtime's own join decides", async () => {
  const fake = runtime((tenant) =>
    tenant === "ghost" ? Response.json({ error: "unknown tenant" }, { status: 404 }) : okJoin(tenant, {}),
  );
  const env = { ...setup(), rosterCandidates: ["/nonexistent/colony.json"] };
  expect(await prepareIdentity({ agent: "lena", harness: "claude", force: false, origin: fake.url, ...env })).toBe(
    cachePath(env.home, "lena"),
  );
  const error = await failure(prepareIdentity({ agent: "ghost", harness: "claude", force: false, origin: fake.url, ...env }));
  expect(error.code).toBe(EXIT_FETCH);
  expect(error.message).toContain("ghost");
});

// HL-12
test("HL-12: bruno and ivan take exactly the path every other agent takes", async () => {
  const fake = runtime();
  const env = setup();
  for (const agent of ["bruno", "ivan", "lena"]) {
    await prepareIdentity({ agent, harness: "claude", force: false, origin: fake.url, ...env });
  }
  expect(fake.requests).toEqual([
    "POST /identity-runtime/bruno/join",
    "POST /identity-runtime/ivan/join",
    "POST /identity-runtime/lena/join",
  ]);
  const shape = (body: Record<string, unknown>, agent: string) =>
    JSON.stringify(body).replaceAll(agent, "<agent>");
  expect(shape(fake.bodies[0]!, "bruno")).toBe(shape(fake.bodies[2]!, "lena"));
  expect(shape(fake.bodies[1]!, "ivan")).toBe(shape(fake.bodies[2]!, "lena"));
});

test("HL-12: the loader sources never name bruno or ivan", () => {
  for (const file of ["agent-loader.ts", "agent-loader.sh"]) {
    const source = readFileSync(join(import.meta.dir, file), "utf8");
    expect(source).not.toMatch(/\b(bruno|ivan)\b/i);
  }
});

// HL-13
test("HL-13: the loader only ever calls join — never remember or promote", async () => {
  const fake = runtime();
  const env = setup();
  await prepareIdentity({ agent: "lena", harness: "claude", force: false, origin: fake.url, ...env });
  await prepareIdentity({ agent: "lena", harness: "claude", force: false, origin: fake.url, ...env });
  await prepareIdentity({ agent: "lena", harness: "codex", force: true, origin: fake.url, ...env });
  expect(fake.requests.length).toBeGreaterThan(0);
  for (const request of fake.requests) expect(request).toMatch(/^POST \/identity-runtime\/[^/]+\/join$/);
});

// CLI
test("parsePrepareArgs requires the prepare subcommand, --agent and --harness", () => {
  expect(() => parsePrepareArgs([])).toThrow("usage");
  expect(() => parsePrepareArgs(["prepare", "--agent", "lena"])).toThrow("--agent and --harness");
  expect(parsePrepareArgs(["prepare", "--agent", "lena", "--harness", "codex", "--force"])).toEqual({
    agent: "lena",
    harness: "codex",
    force: true,
  });
});

async function runCli(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "agent-loader.ts"), ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

test("CLI: success prints only the identity path on stdout", async () => {
  const fake = runtime();
  const home = join(setup().root, "home");
  const result = await runCli(["prepare", "--agent", "lena", "--harness", "claude"], { HOME: home, IDENTITY_RUNTIME_URL: fake.url });
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`${cachePath(home, "lena")}\n`);
});

test("CLI: failures print nothing on stdout and exit with the LoaderError code", async () => {
  const fake = runtime();
  const home = join(setup().root, "home");
  const env = { HOME: home, IDENTITY_RUNTIME_URL: fake.url };
  const unknown = await runCli(["prepare", "--agent", "nobody", "--harness", "claude"], env);
  expect([unknown.code, unknown.stdout]).toEqual([EXIT_USAGE, ""]);
  expect(unknown.stderr).toContain("nobody");
  const down = await runCli(["prepare", "--agent", "lena", "--harness", "claude"], { ...env, IDENTITY_RUNTIME_URL: "http://127.0.0.1:1" });
  expect([down.code, down.stdout]).toEqual([EXIT_FETCH, ""]);
});
