import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The guard must work across the process boundary. The consumer (server process) only sets an environment
 * variable; the budget is adopted by the child that runs the GitHub tool. These tests run that child for real, with
 * the default shared registry and the real environment, and no injected budgets.
 */
let dir: string;
let script: string;
const SRC = resolve(import.meta.dir, "../../src/tools/github-app.ts");

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "review-budget-proc-"));
  script = join(dir, "child.ts");
  writeFileSync(script, `
import { generateKeyPairSync } from "node:crypto";
import { handleGithubTool } from ${JSON.stringify(SRC)};
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
let posts = 0;
const fetchFake = async (url: string, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  if (method === "GET" && url.endsWith("/installation")) return new Response(JSON.stringify({ id: 1 }));
  if (method === "POST" && url.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "t", expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
  if (method === "GET" && url.includes("/comments")) return new Response("[]");
  if (method === "POST" && url.endsWith("/issues/299/comments")) { posts++; return new Response(JSON.stringify({ html_url: "u" }), { status: 201 }); }
  return new Response("{}", { status: 404 });
};
const results: string[] = [];
for (const body of ["one", "two", "three"]) {
  results.push(await handleGithubTool({ action: "issue_comment", repo: "rfcclub/anima", issue: 299, body }, {
    agentName: "cleo", policy: { allowedTools: ["anima_github"] } as any, cwd: "/tmp",
    deps: { fetch: fetchFake as any, readKeyPem: () => pem, now: () => Date.now(), appendLog: () => {} },
  }));
}
console.log(JSON.stringify({ results, posts }));
`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function runChild(env: Record<string, string | undefined>): Promise<{ results: string[]; posts: number }> {
  const clean: Record<string, string | undefined> = { ...process.env };
  delete clean.ANIMA_INTENT_REVIEW;
  const proc = Bun.spawn([process.execPath, script], { env: { ...clean, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`child exited ${code}: ${err.slice(-300)}`);
  return JSON.parse(out.trim().split("\n").pop()!);
}

describe("review budget across the process boundary", () => {
  test("a child started for an intent review posts one comment and refuses the rest", async () => {
    const seen = await runChild({ ANIMA_INTENT_REVIEW: "rfcclub/anima#299" });
    expect(seen.posts).toBe(1);
    expect(seen.results[0]).toContain("ok");
    expect(seen.results[1]).toContain("verdict already recorded");
    expect(seen.results[2]).toContain("verdict already recorded");
  }, 20_000);

  test("a child with no target behaves as before: every comment posts", async () => {
    const seen = await runChild({});
    expect(seen.posts).toBe(3);
  }, 20_000);
});
