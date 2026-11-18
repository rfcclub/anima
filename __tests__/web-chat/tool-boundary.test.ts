import { seatbeltTest } from "../helpers/seatbelt";
import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolBoundary } from "../../src/web-chat/tool-boundary";
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
seatbeltTest("WB-4: inherited OS boundary denies private reads through aliases and interpreters", async () => {
  const root = mkdtempSync(join(tmpdir(), "webchat-boundary-"));
  roots.push(root);
  const secret = join(root, "private");
  writeFileSync(secret, "do-not-expose");
  const alias = join(root, "alias");
  symlinkSync(secret, alias);
  const boundary = await createToolBoundary([secret], []);
  expect(boundary.fileAllowed(alias)).toBe(false);
  expect(boundary.fileAllowed(root, true)).toBe(false);
  const command = async (cmd: string[]) => {
    const p = Bun.spawn(boundary.command(cmd, root), {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH! },
    });
    return { text: await new Response(p.stdout).text(), code: await p.exited };
  };
  expect(
    (await command(["/bin/bash", "-c", `/bin/cat '${alias}'`])).text,
  ).not.toContain("do-not-expose");
  expect(
    (
      await command([
        process.execPath,
        "-e",
        `console.log(require('fs').readFileSync(${JSON.stringify(secret)},'utf8'))`,
      ])
    ).text,
  ).not.toContain("do-not-expose");
  expect((await command(["/bin/bash", "-c", "echo public-ok"])).text).toContain(
    "public-ok",
  );
  const label = "com.anima.webchat.probe." + crypto.randomUUID(),
    output = join(root, "escaped");
  try {
    expect(
      (
        await command([
          "/bin/launchctl",
          "submit",
          "-l",
          label,
          "-o",
          output,
          "--",
          "/bin/cat",
          secret,
        ])
      ).code,
    ).not.toBe(0);
    expect(
      existsSync(output) &&
        readFileSync(output, "utf8").includes("do-not-expose"),
    ).toBe(false);
  } finally {
    await Bun.spawn(["/bin/launchctl", "remove", label], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
  }
});

seatbeltTest("WB-4: OS isolation blocks private Unix IPC and renaming a protected ancestor", async () => {
  const root = mkdtempSync(join(tmpdir(), "webchat-ipc-isolation-"));
  roots.push(root);
  const { mkdirSync } = await import("node:fs");
  const privateDir = join(root, "protected");
  mkdirSync(privateDir);
  const socket = join(privateDir, "bridge.sock");
  const listener = Bun.listen({
    unix: socket,
    socket: {
      open(s) {
        s.end("CONTROL_EXPOSED");
      },
      data() {},
    },
  });
  const boundary = await createToolBoundary([privateDir], []);
  const run = async (argv: string[]) => {
    const p = Bun.spawn(boundary.command(argv, root), {
      cwd: root,
      stdout: "pipe",
      stderr: "ignore",
      env: { PATH: process.env.PATH },
    });
    return { text: await new Response(p.stdout).text(), code: await p.exited };
  };
  try {
    const probe = `const n=require('node:net');const s=n.connect(${JSON.stringify(socket)});s.on('data',d=>console.log(String(d)));s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(2),500);`;
    expect((await run([process.execPath, "-e", probe])).text).not.toContain(
      "CONTROL_EXPOSED",
    );
    expect(
      (await run(["/bin/mv", privateDir, join(root, "moved")])).code,
    ).not.toBe(0);
    expect(existsSync(socket)).toBe(true);
  } finally {
    listener.stop(true);
  }
});

seatbeltTest("WB-11: ordinary git can initialize, commit and read inside the private boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "webchat-git-"));
  roots.push(root);
  const boundary = await createToolBoundary([], []);
  const p = Bun.spawn(
    boundary.command(
      [
        "/bin/sh",
        "-c",
        `
    set -eu
    /usr/bin/git init -q .
    echo public > public.txt
    /usr/bin/git add public.txt
    /usr/bin/git -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit -qm initial
    /usr/bin/git show HEAD:public.txt
    /usr/bin/git diff --exit-code
  `,
      ],
      root,
    ),
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH!,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(out).toContain("public");
});
