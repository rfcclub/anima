import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ADAPTER_VERSION } from "../../src/web-chat/types";
test("WB-8: operator init is private, unverified, and refuses destructive reinitialization", async () => {
  const base = mkdtempSync(join(tmpdir(), "webchat-cli-")),
    root = join(base, "private");
  const run = async () => {
    const p = Bun.spawn(
      [process.execPath, "src/web-chat/cli.ts", "init", "--root", root],
      { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
    );
    await new Response(p.stdout).text();
    return p.exited;
  };
  try {
    expect(await run()).toBe(0);
    const content = readFileSync(join(root, "config.json"), "utf8"),
      config = JSON.parse(content);
    expect(config.accounts).toEqual([
      { id: "claude", service: "claude" },
      { id: "chatgpt", service: "chatgpt" },
      { id: "grok", service: "grok" },
      { id: "gemini", service: "gemini" },
    ]);
    expect(config.accounts.every((a: any) => !a.validatedVersion)).toBe(true);
    expect(statSync(join(root, "config.json")).mode & 0o777).toBe(0o600);
    expect(await run()).not.toBe(0);
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe(content);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("SC-2 regression: CLI status refuses legacy and mismatched validation service", async () => {
  const root = mkdtempSync(join(tmpdir(), "webchat-status-"));
  try {
    writeFileSync(
      join(root, "config.json"),
      JSON.stringify({
        accounts: [
          {
            id: "legacy",
            service: "claude",
            validatedVersion: ADAPTER_VERSION,
          },
          {
            id: "relabeled",
            service: "grok",
            validatedVersion: ADAPTER_VERSION,
            validatedService: "qwen",
          },
          {
            id: "bound",
            service: "chatgpt",
            validatedVersion: ADAPTER_VERSION,
            validatedService: "chatgpt",
          },
        ],
        privateSources: [],
      }),
      { mode: 0o600 },
    );
    const p = Bun.spawn(
      [process.execPath, "src/web-chat/cli.ts", "status", "--root", root],
      { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect(JSON.parse(output).map((a: any) => a.verified)).toEqual([
      false,
      false,
      true,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
