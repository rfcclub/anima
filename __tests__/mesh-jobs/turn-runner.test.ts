import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../../src/cli";
import { cliTurnRunner } from "../../src/mesh-jobs/start";

let dir: string;
let fakeCli: string;
let out: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mesh-jobs-cli-"));
  fakeCli = join(dir, "fake-cli.ts");
  out = join(dir, "out.json");
  // Stands in for ~/.anima/dist/cli.js: records its argv and stdin.
  writeFileSync(fakeCli, `const stdin = await Bun.stdin.text();\nawait Bun.write(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), stdin, intent: process.env.ANIMA_INTENT_REVIEW ?? null }));\n`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("cliTurnRunner", () => {
  test("a PR review is dispatched with the explicit headless review profile", async () => {
    await cliTurnRunner(fakeCli)({
      agent: "jade", message: "review", signal: new AbortController().signal,
      profile: "review", repo: "rfcclub/anima",
    });
    const seen = JSON.parse(readFileSync(out, "utf-8")) as { argv: string[] };
    expect(seen.argv).toContain("--headless-review");
    expect(seen.argv.slice(-2)).toEqual(["--review-repo", "rfcclub/anima"]);
  });

  test("an intent review's child is told the issue under review through the environment", async () => {
    await cliTurnRunner(fakeCli)({ agent: "cleo", message: "x", signal: new AbortController().signal, intent: { repo: "rfcclub/anima", issue: 299 } });
    expect((JSON.parse(readFileSync(out, "utf-8")) as { intent: string | null }).intent).toBe("rfcclub/anima#299");
  });

  test("any other turn gets no intent target, even if the server's own environment has one", async () => {
    const before = process.env.ANIMA_INTENT_REVIEW;
    process.env.ANIMA_INTENT_REVIEW = "rfcclub/anima#1";
    try {
      await cliTurnRunner(fakeCli)({ agent: "cleo", message: "x", signal: new AbortController().signal });
      expect((JSON.parse(readFileSync(out, "utf-8")) as { intent: string | null }).intent).toBeNull();
    } finally {
      if (before === undefined) delete process.env.ANIMA_INTENT_REVIEW; else process.env.ANIMA_INTENT_REVIEW = before;
    }
  });

  test("forwards only valid review metadata while the child is running", async () => {
    const child = join(dir, "profile-cli.ts"), ack = join(dir, "profile-ack");
    const sessionId = "7f4b376f-bf4a-47d2-9f64-9553c8fca76a", hash = "a".repeat(64);
    const event = { level: "info", msg: "headless profile", profile: "work-review", promptStaticHash: hash, sessionId, leak: "PRIVATE_REVIEW_TEXT" };
    writeFileSync(child, `import { existsSync } from "node:fs";\nconsole.error(${JSON.stringify(JSON.stringify({ ...event, promptStaticHash: "invalid" }))});\nconsole.error(${JSON.stringify(JSON.stringify({ ...event, sessionId: "invalid" }))});\nconsole.error(${JSON.stringify(JSON.stringify({ ...event, profile: "work-engineer" }))});\nconsole.error("UNRELATED_SECRET");\nconsole.error(${JSON.stringify(JSON.stringify(event))});\nconsole.error(${JSON.stringify(JSON.stringify(event))});\nconst deadline = Date.now() + 3500;\nwhile (!existsSync(${JSON.stringify(ack)}) && Date.now() < deadline) await Bun.sleep(20);\nif (!existsSync(${JSON.stringify(ack)})) process.exit(2);\n`);
    const logs: Array<{ level: string; message: string; fields: Record<string, unknown> }> = [];
    await cliTurnRunner(child, (level, message, fields) => {
      logs.push({ level, message, fields: fields ?? {} });
      writeFileSync(ack, "observed");
    })({ agent: "jade", message: "PRIVATE_REVIEW_TEXT", profile: "review", repo: "rfcclub/anima", signal: new AbortController().signal });
    expect(logs).toEqual([{ level: "info", message: "headless profile", fields: {
      agent: "jade", sessionId, profile: "work-review", promptStaticHash: hash,
    } }]);
    expect(JSON.stringify(logs)).not.toContain("PRIVATE_REVIEW_TEXT");
    expect(JSON.stringify(logs)).not.toContain("UNRELATED_SECRET");
  }, 8_000);

  test("ordinary talk does not forward a fake headless record", async () => {
    const child = join(dir, "plain-cli.ts");
    writeFileSync(child, `console.error(JSON.stringify({level:"info", msg:"headless profile", profile:"work-review", promptStaticHash:"a".repeat(64), sessionId:"7f4b376f-bf4a-47d2-9f64-9553c8fca76a"}));\n`);
    const logs: unknown[] = [];
    await cliTurnRunner(child, (...entry: unknown[]) => { logs.push(entry); })({ agent: "jade", message: "x", signal: new AbortController().signal });
    expect(logs).toEqual([]);
  });

  test("review metadata is preserved when the child subsequently fails", async () => {
    const child = join(dir, "failing-cli.ts");
    writeFileSync(child, `console.error(JSON.stringify({level:"info", msg:"headless profile", profile:"work-review", promptStaticHash:"b".repeat(64), sessionId:"7f4b376f-bf4a-47d2-9f64-9553c8fca76a"}));\nconsole.error("provider failed");\nprocess.exit(17);\n`);
    const logs: unknown[] = [];
    await expect(cliTurnRunner(child, (...entry: unknown[]) => { logs.push(entry); })({
      agent: "jade", message: "x", signal: new AbortController().signal, profile: "review", repo: "rfcclub/anima",
    })).rejects.toThrow("provider failed");
    expect(logs).toHaveLength(1);
  });

  test("a 200000-character message goes through stdin with -m -, not through argv", async () => {
    const message = `REVIEW ${"z".repeat(200_000)}`;
    await cliTurnRunner(fakeCli)({ agent: "jade", message, signal: new AbortController().signal });
    const seen = JSON.parse(readFileSync(out, "utf-8")) as { argv: string[]; stdin: string };
    expect(seen.argv).toEqual(["talk", "-a", "jade", "-m", "-", "--permission", "auto"]);
    expect(seen.stdin).toBe(message);
  });

  test("the spawned argv, read by the real CLI parser, asks talk to read stdin", async () => {
    // resolveTalkMessage("-") alone was tested, not the parser in front of it, and
    // the parser turned `-m -` into m=true (the agent got the message "true").
    await cliTurnRunner(fakeCli)({ agent: "jade", message: "x", signal: new AbortController().signal });
    const [command, ...rest] = (JSON.parse(readFileSync(out, "utf-8")) as { argv: string[] }).argv;
    const { flags } = parseArgs(rest);
    expect(command).toBe("talk");
    expect(flags.m).toBe("-");
    expect(flags.a).toBe("jade");
    expect(flags.permission).toBe("auto");
  });

  test("WM-5 a worker's review model reaches talk as --provider and --model, read by the real parser", async () => {
    await cliTurnRunner(fakeCli)({ agent: "finn", message: "x", signal: new AbortController().signal, provider: "hypercharm", model: "prism" });
    const [command, ...rest] = (JSON.parse(readFileSync(out, "utf-8")) as { argv: string[] }).argv;
    expect([command, ...rest]).toEqual(["talk", "-a", "finn", "-m", "-", "--permission", "auto", "--provider", "hypercharm", "--model", "prism"]);
    const { flags } = parseArgs(rest);
    expect(flags.provider).toBe("hypercharm");
    expect(flags.model).toBe("prism");
    expect(flags.m).toBe("-");
  });
});
