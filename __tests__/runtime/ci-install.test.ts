import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const installer = resolve(import.meta.dir, "../../.github/scripts/install-dependencies.sh");
async function runInstaller(exit: number, missing = false) {
  const root = mkdtempSync(join(tmpdir(), "anima-ci-install-"));
  const key = "fixture-private-key-never-log";
  try {
    const bin = join(root, "bin"), temporary = join(root, "temporary");
    mkdirSync(bin); mkdirSync(temporary);
    const fixture = join(root, "fake.ts"), invoked = join(root, "bun-invoked");
    writeFileSync(fixture, `import { readFileSync, statSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(invoked)}, 'invoked');
const command = process.env.GIT_SSH_COMMAND ?? '';
const keyPath = /-i "([^"]+)"/.exec(command)?.[1];
if (!keyPath) throw new Error('missing identity path');
console.log(JSON.stringify({
 argv: process.argv.slice(2), keyPath,
 mode: statSync(keyPath).mode & 0o777,
 keyMatches: readFileSync(keyPath, 'utf8').trim() === 'fixture-private-key-never-log',
 secretAbsent: process.env.COLONY_MESH_DEPLOY_KEY === undefined,
 strictHost: command.includes('StrictHostKeyChecking=yes'),
 identitiesOnly: command.includes('IdentitiesOnly=yes'),
 knownHosts: readFileSync(keyPath.replace(/key$/, 'known_hosts'), 'utf8').startsWith('github.com ssh-ed25519 '),
}));
process.exit(Number(process.env.FIXTURE_EXIT));`);
    writeFileSync(join(bin, "bun"), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fixture.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
    const child = Bun.spawn(["/bin/bash", installer], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, TMPDIR: temporary, FIXTURE_EXIT: String(exit), ...(missing ? {} : { COLONY_MESH_DEPLOY_KEY: key }) },
      stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 5000);
    let code: number, stdout: string, stderr: string;
    try { [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); }
    finally { clearTimeout(timer); }
    expect(stdout + stderr).not.toContain(key);
    expect(readdirSync(temporary)).toEqual([]);
    if (missing) {
      expect(code).not.toBe(0); expect(stdout).toBe("");
      expect(stderr).toContain("COLONY_MESH_DEPLOY_KEY is required");
      expect(existsSync(invoked)).toBe(false);
      console.log("missing-key installer refusal receipt", JSON.stringify({
        rawExit: code, bunInvoked: existsSync(invoked), temporaryFiles: readdirSync(temporary),
        stdoutEmpty: stdout === "", stderr, outputContainsKey: (stdout + stderr).includes(key),
      }));
    } else {
      expect(existsSync(invoked)).toBe(true);
      expect({ code, stderr }).toEqual({ code: exit, stderr: "" });
      const receipt = JSON.parse(stdout);
      expect(receipt.argv).toEqual(["install", "--frozen-lockfile", "--ignore-scripts"]);
      expect(receipt.mode).toBe(0o600);
      for (const field of ["keyMatches", "secretAbsent", "strictHost", "identitiesOnly", "knownHosts"]) expect(receipt[field]).toBe(true);
      expect(existsSync(receipt.keyPath)).toBe(false);
      console.log("instrumented fixture Bun installer command receipt", JSON.stringify({
        argv: receipt.argv, mode: receipt.mode, keyMatches: receipt.keyMatches,
        secretAbsent: receipt.secretAbsent, strictHost: receipt.strictHost,
        identitiesOnly: receipt.identitiesOnly, knownHosts: receipt.knownHosts,
        keyRemoved: !existsSync(receipt.keyPath), rawExit: code,
        temporaryFiles: readdirSync(temporary), outputContainsKey: (stdout + stderr).includes(key),
      }));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test("CI-4 security: installer confines the read-only identity and cleans it on success", () => runInstaller(0));
test("CI-5 installer preserves raw install failure and cleans credentials", () => runInstaller(23));
test("CI-5 unauthorized install without credentials refuses before key writes or Bun invocation", () => runInstaller(0, true));

for (const shape of ["outside", "traversal", "symlink", "name"] as const) {
  test(`CI-4 regression: forbidden ${shape} credential path refuses before writes or cleanup`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "anima-ci-path-")));
    const key = "fixture-private-key-never-log";
    try {
      const bin = join(root, "bin"), temporary = join(root, "temporary");
      const foreign = shape === "name" ? join(temporary, "operator-data") : join(root, "anima-ci-key.IJKLMNOP");
      mkdirSync(bin); mkdirSync(temporary); mkdirSync(foreign);
      const sentinel = join(foreign, "sentinel");
      writeFileSync(sentinel, "preserve fixture operator data");
      const alias = join(temporary, "anima-ci-key.ABCDEFGH");
      if (shape === "symlink") symlinkSync(foreign, alias);
      const returned = shape === "traversal" ? `${temporary}/../anima-ci-key.IJKLMNOP` : shape === "symlink" ? alias : foreign;
      writeFileSync(join(bin, "mktemp"), "#!/bin/sh\nprintf '%s\\n' \"$FIXTURE_RETURNED_PATH\"\n", { mode: 0o700 });
      writeFileSync(join(bin, "bun"), "#!/bin/sh\nprintf 'BUN_INVOKED\\n'\n", { mode: 0o700 });
      const child = Bun.spawn(["/bin/bash", installer], {
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, TMPDIR: temporary, FIXTURE_RETURNED_PATH: returned, COLONY_MESH_DEPLOY_KEY: key },
        stdout: "pipe", stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill(), 5000);
      let code: number, stdout: string, stderr: string;
      try { [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); }
      finally { clearTimeout(timer); }
      expect(code).not.toBe(0);
      expect(stdout + stderr).not.toContain(key);
      expect(stdout).not.toContain("BUN_INVOKED");
      expect(stderr).toContain("refusing unowned credential directory");
      expect(existsSync(sentinel)).toBe(true);
      expect(readFileSync(sentinel, "utf8")).toBe("preserve fixture operator data");
      expect(existsSync(join(foreign, "key"))).toBe(false);
      expect(existsSync(join(foreign, "known_hosts"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
