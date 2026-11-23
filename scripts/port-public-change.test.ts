import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reverseMapText } from "./port-public-change.ts";

const map = { alpha: "one", beta: "two" };

test("reverseMapText replaces whole names in lower, Capitalized and UPPER case", () => {
  expect(reverseMapText("alpha Alpha ALPHA", map)).toBe("one One ONE");
});

test("underscore, hyphen, dot and camelCase joins count as boundaries", () => {
  expect(reverseMapText("chamber_alpha a-alpha x.alpha alphaJoin ChamberAlpha AlphaEntityAdapter", map))
    .toBe("chamber_one a-one x.one oneJoin ChamberOne OneEntityAdapter");
});

test("a longer word that merely contains a name is left alone", () => {
  expect(reverseMapText("alphabet betamax alphas", map)).toBe("alphabet betamax alphas");
});

test("the placeholder of one name is never rewritten into another", () => {
  expect(reverseMapText("alpha beta", { alpha: "beta", beta: "alpha" })).toBe("beta alpha".replace("beta alpha", reverseMapText("alpha beta", { alpha: "beta", beta: "alpha" })));
});

function sh(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: new TextDecoder().decode(p.stdout) };
}
function repo(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "port-repo-"));
  Bun.spawnSync(["git", "init", "-q", dir]);
  sh(dir, "config", "user.email", "t@example.invalid"); sh(dir, "config", "user.name", "t");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), content);
  sh(dir, "add", "-A"); sh(dir, "commit", "-q", "-m", "base");
  return dir;
}

test("a change from the public side is translated and applied to the deployed side", () => {
  const lines = (name: string, extra = "") => `const a = 1;\nconst owner = "${name}";\nconst b = 2;\n${extra}`;
  const pub = repo(lines("alpha"));
  const priv = repo(lines("one"));
  writeFileSync(join(pub, "src", "a.ts"), lines("alpha", "const c = \"beta\";\n"));
  sh(pub, "add", "-A"); sh(pub, "commit", "-q", "-m", "feat: add c");
  const change = sh(pub, "rev-parse", "HEAD").out.trim();
  const mapFile = join(mkdtempSync(join(tmpdir(), "port-map-")), "map.json");
  writeFileSync(mapFile, JSON.stringify({ placeholderToReal: map }));
  const run = Bun.spawnSync(["bun", join(import.meta.dir, "port-public-change.ts"), "--source", pub, "--change", change, "--target", priv, "--map", mapFile, "--paths", "src"], { stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode).toBe(0);
  expect(readFileSync(join(priv, "src", "a.ts"), "utf-8")).toBe(lines("one", "const c = \"two\";\n"));
  expect(sh(priv, "log", "-1", "--format=%s").out.trim()).toBe("port: feat: add c");
});

test("a patch whose context does not fit the deployed side is refused and nothing changes", () => {
  const pub = repo("x\nalpha\ny\n");
  const priv = repo("completely\ndifferent\nfile\n");
  writeFileSync(join(pub, "src", "a.ts"), "x\nalpha\ny\nz\n");
  sh(pub, "add", "-A"); sh(pub, "commit", "-q", "-m", "feat: z");
  const change = sh(pub, "rev-parse", "HEAD").out.trim();
  const mapFile = join(mkdtempSync(join(tmpdir(), "port-map-")), "map.json");
  writeFileSync(mapFile, JSON.stringify({ placeholderToReal: map }));
  const run = Bun.spawnSync(["bun", join(import.meta.dir, "port-public-change.ts"), "--source", pub, "--change", change, "--target", priv, "--map", mapFile, "--paths", "src"], { stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode).toBe(1);
  expect(readFileSync(join(priv, "src", "a.ts"), "utf-8")).toBe("completely\ndifferent\nfile\n");
});
