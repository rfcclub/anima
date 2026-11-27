import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
const file = resolve(import.meta.dir, "../../.github/workflows/ci.yml");
function workflow(): any { return Bun.YAML.parse(readFileSync(file, "utf8")); }
test("review-ci: the macOS sandbox check requires and exercises the real sandbox", () => {
  const script = resolve(import.meta.dir, "../../scripts/check-progress-sandbox.sh");
  const result = Bun.spawnSync(["bash", script], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const output = result.stdout.toString() + result.stderr.toString();
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    expect(result.exitCode).toBe(0);
    expect(output).toContain("detects same-size changes to tracked and nonignored untracked files");
    expect(output).toContain("0 fail");
  } else {
    expect(result.exitCode).not.toBe(0);
    expect(output).toContain("macOS sandbox is unavailable");
  }
}, 20_000);
test("CI-1 PR/master workflow uses a clean container and one committed Bun pin", () => {
  const ci = workflow();
  expect(ci.on.pull_request).toBeDefined(); expect(ci.on.push.branches).toEqual(["master"]);
  expect(ci.on.pull_request_target).toBeUndefined();
  expect(ci.permissions).toEqual({ contents: "read" });
  const job = ci.jobs.install;
  expect(ci.jobs.test.needs).toBe("install");
  expect(ci.jobs.test.container).toBeUndefined();
  expect(ci.jobs.test["runs-on"]).toBe("ubuntu-22.04");
  expect(job.container.image).toBe("ubuntu:24.04"); expect(job["timeout-minutes"]).toBeLessThanOrEqual(20);
  expect(job.container.options).toBe("--init");
  const uses = job.steps.filter((s: any) => s.uses);
  for (const step of uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
  expect(uses.find((s: any) => s.uses.startsWith("oven-sh/setup-bun@")).with).toEqual({ "bun-version-file": ".bun-version" });
  expect(uses.find((s: any) => s.uses.startsWith("actions/checkout@")).with["persist-credentials"]).toBe(false);
});
test("CI-1 install secret is confined before lifecycle scripts in each job", () => {
  const ci = workflow();
  for (const job of Object.values(ci.jobs) as any[]) {
  const steps = job.steps;
  const index = steps.findIndex((s: any) => s.run === "bash .github/scripts/install-dependencies.sh");
  expect(index).toBeGreaterThan(0);
  expect(steps[index].env).toEqual({ COLONY_MESH_DEPLOY_KEY: "${{ secrets.COLONY_MESH_DEPLOY_KEY }}" });
  expect(ci.env).toBeUndefined(); expect(job.env).toBeUndefined();
  for (const [i, step] of steps.entries()) if (i !== index) expect(JSON.stringify(step)).not.toContain("secrets.COLONY_MESH_DEPLOY_KEY");
  const later = steps.slice(index + 1).map((s: any) => s.run ?? "").join("\n");
  expect(later).toContain("bun run skills:sync");
  expect(later).toContain('bash .github/scripts/pin-bun-runtime.sh "$(command -v bun)"');
  expect(later).toContain("bun run typecheck");
  if (job === ci.jobs.test) {
  expect(later).toContain("bun test");
  expect(later).toContain("playwright/cli.js install --with-deps chromium");
  expect(later).toContain("ANIMA_SHARED_CONVERSATIONS=0"); expect(later).toContain("ANIMA_MESH_PRESENCE=off");
  expect(later).toContain("mktemp -d"); expect(later).toContain("env -i");
  }
  }
});
test("CI-1 minimal container provides script runtimes and checkout trust inside owned HOME", () => {
  const steps = workflow().jobs.install.steps;
  const setup = steps.find((s: any) => s.uses?.startsWith("actions/setup-node@"));
  expect(setup?.with["node-version"]).toBe(22);
  const commands = steps.map((s: any) => s.run ?? "").join("\n");
  for (const tool of ["sqlite3", "jq", "python3"]) expect(commands).toMatch(new RegExp(`\\b${tool}\\b`));
  const hosted = workflow().jobs.test.steps.map((s: any) => s.run ?? "").join("\n");
  expect(hosted).toContain("GIT_CONFIG_COUNT=1");
  expect(hosted).toContain("GIT_CONFIG_KEY_0=safe.directory");
  expect(hosted).toContain('GIT_CONFIG_VALUE_0="$GITHUB_WORKSPACE"');
});
test("CI-1 browser tests run on the non-root hosted VM with UUID and enforced sandbox", () => {
  const commands = workflow().jobs.test.steps.map((s: any) => s.run ?? "").join("\n");
  expect(commands).toContain("uuid-runtime");
  expect(commands).not.toContain("useradd");
  expect(commands).not.toContain("runuser");
  expect(commands).not.toContain("--no-sandbox");
  expect(commands).toContain("probe-chromium.mjs");
  expect(commands).toContain('test "$(id -u)" -ne 0');
});

test("CI-1 cache saves registry children without the root or private Git trees", () => {
  for (const job of Object.values(workflow().jobs) as any[]) {
    const cache = job.steps.find((s: any) => s.uses?.startsWith("actions/cache@"));
    expect(cache.with.path.trim().split("\n")).toEqual(["~/.bun/install/cache/*", "!~/.bun/install/cache/@G@*"]);
    expect(cache.with.key).toContain("bun-registry-v2-");
  }
});
