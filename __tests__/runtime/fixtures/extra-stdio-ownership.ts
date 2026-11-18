import { closeSync, fstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
const root = process.argv[2];
if (!root || !isAbsolute(root) || !basename(root).startsWith("anima-extra-stdio-") || process.env.HOME !== root || process.env.ANIMA_HOME !== root) throw Error("unsafe fixture root");
if (["RUNTIME_PARENT_CANARY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"].some((key) => process.env[key])) throw Error("unsafe fixture environment");
const denyNetwork = () => { throw Error("fixture network forbidden"); };
globalThis.fetch = Object.assign(denyNetwork, { preconnect: denyNetwork });
const victimPath = join(root, "victim.txt");
writeFileSync(victimPath, "owned diagnostic victim");
const rows: { fd: number; victim: number; error: string | null }[] = [];
let hits = 0;
// Ownership regression from oven-sh/bun#33828; the process owns every fd/file.
for (let round = 0; round < 4; round++) {
  let child: ReturnType<typeof Bun.spawn> | null = Bun.spawn({
    cmd: ["/bin/sh", "-c", "printf hi >&3"],
    stdio: ["ignore", "ignore", "ignore", "pipe"],
    env: { PATH: process.env.PATH ?? "", HOME: root, NODE_ENV: "test" },
  });
  if (await child.exited !== 0) throw Error("shell fixture failed");
  const fd = child.stdio[3];
  if (typeof fd !== "number") throw Error("missing extra raw fd");
  const bytes = Buffer.alloc(8);
  if (readSync(fd, bytes) !== 2 || bytes.subarray(0, 2).toString() !== "hi") throw Error("extra fd unreadable");
  closeSync(fd);
  const victim = openSync(victimPath, "r");
  if (victim !== fd) { closeSync(victim); throw Error("fixture did not recycle fd; result inconclusive"); }
  child = null;
  Bun.gc(true);
  await Bun.sleep(0);
  Bun.gc(true);
  let error: string | null = null;
  try { fstatSync(victim); } catch (cause) { hits++; error = (cause as NodeJS.ErrnoException).code ?? "unknown"; }
  rows.push({ fd, victim, error });
  try { closeSync(victim); } catch { /* old runtime already closed this owned victim */ }
}
console.log(JSON.stringify({ version: Bun.version, rows, hits }));
if (hits) throw Error(`finalizer closed ${hits}/4 recycled fds`);
