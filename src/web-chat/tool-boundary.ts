import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
function canonical(path: string): string {
  const absolute = resolve(path);
  let current = absolute,
    tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  return join(realpathSync(current), ...tail);
}
const inside = (path: string, root: string) =>
  path === root || path.startsWith(root + sep);
const quote = (path: string) => JSON.stringify(path);
function ancestors(path: string): string[] {
  const result: string[] = [];
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    result.push(parent);
    if (dirname(parent) === parent) break;
  }
  return result;
}
export class ToolBoundary {
  readonly privatePaths: string[];
  readonly readOnlyPaths: string[];
  constructor(privatePaths: string[], readOnlyPaths: string[]) {
    this.privatePaths = privatePaths.map(canonical);
    this.readOnlyPaths = readOnlyPaths.map(canonical);
  }
  fileAllowed(path: string, write = false) {
    const p = canonical(path);
    return (
      !this.privatePaths.some((r) => inside(p, r)) &&
      (!write ||
        ![...this.privatePaths, ...this.readOnlyPaths].some(
          (r) => inside(p, r) || inside(r, p),
        ))
    );
  }
  command(argv: string[], cwd: string): string[] {
    const privateRules = this.privatePaths
      .map((p) => `(subpath ${quote(p)})`)
      .join(" ");
    const readonly = [...this.privatePaths, ...this.readOnlyPaths];
    const readonlyRules = [
      ...readonly.map((p) => `(subpath ${quote(p)})`),
      ...[...new Set(readonly.flatMap(ancestors))].map(
        (p) => `(literal ${quote(p)})`,
      ),
    ].join(" ");
    // Only dirhelper lookup is allowed for Darwin's temporary-directory API.
    // Launch services and network remain denied; children inherit Seatbelt.
    const profile = `(version 1)(deny default)(allow process-exec)(allow process-fork)(allow signal (target same-sandbox))(allow sysctl-read)
      (allow mach-lookup (global-name "com.apple.bsd.dirhelper"))
      (allow file-read* ${privateRules ? `(require-not (require-any ${privateRules}))` : ""})
      (allow file-write* (literal "/dev/null"))
      (allow file-write* (require-all (require-any (subpath ${quote(canonical(cwd))}) (subpath ${quote(canonical(tmpdir()))}) (subpath ${quote(canonical("/tmp"))})) ${readonlyRules ? `(require-not (require-any ${readonlyRules}))` : ""}))`;
    return ["/usr/bin/sandbox-exec", "-p", profile, ...argv];
  }
}
export async function createToolBoundary(
  privatePaths: string[],
  readOnlyPaths: string[],
): Promise<ToolBoundary> {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))
    throw Error("web chat requires enforced OS tool isolation");
  const boundary = new ToolBoundary(privatePaths, readOnlyPaths);
  const p = Bun.spawn(
    boundary.command(["/bin/echo", "sandbox-ready"], process.cwd()),
    { stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin" } },
  );
  if (
    (await new Response(p.stdout).text()).trim() !== "sandbox-ready" ||
    (await p.exited) !== 0
  )
    throw Error("OS tool isolation unavailable");
  return boundary;
}
let active: ToolBoundary | undefined;
export function installToolBoundary(boundary: ToolBoundary | undefined) {
  active = boundary;
}
export function currentToolBoundary() {
  return active;
}
export function sandboxToolCommand(
  argv: string[],
  cwd = process.cwd(),
): string[] {
  return active ? active.command(argv, cwd) : argv;
}
export function denyNativeCarrier() {
  if (active)
    throw Error(
      "native tool carriers unavailable while web chat isolation is active",
    );
}

export function sandboxToolEnvironment(): NodeJS.ProcessEnv | undefined {
  if (!active) return undefined;
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    TZ: process.env.TZ,
  };
}
