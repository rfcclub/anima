import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { WorkCaps } from "./config";
import { RecoveryTreeError, verifyRecoveryTree } from "./recovery-tree";
import type { WorkRecord, WorkStore } from "./store";
import type { TreeRead } from "./stops";
import { acquireWorkLock } from "./supervisor";

/** Recover a blocked work, without starting a session or dispatching a job. */
export async function recoverWork(
  deps: { store: WorkStore; read: TreeRead },
  input: { workId: string; caps: Partial<WorkCaps>; base: string },
): Promise<WorkRecord> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(input.base)) {
    throw new Error("recovery requires the independently verified full base SHA");
  }
  const base = input.base.toLowerCase();
  const work = deps.store.getWork(input.workId);
  if (!work) throw new Error(`work ${input.workId} not found`);
  if (work.state !== "blocked") throw new Error(`work ${work.workId} is ${work.state}, not blocked`);
  mkdirSync(work.root, { recursive: true, mode: 0o700 });
  const lock = acquireWorkLock(work.root);
  if (!lock) throw new Error("recovery refused: another supervisor holds the work lock");
  try {
    return deps.store.recoverBlockedWork({
      workId: work.workId, root: work.root, caps: input.caps, base,
      check: (current) => {
        try {
          const session = deps.store.latestEndedSession(current.workId);
          const stop = session && deps.store.getStop(session.sessionId);
          if (!stop) throw new Error("checkpoint is unavailable");
          const tree = join(current.root, "tree");
          const head = deps.read(tree, ["rev-parse", "HEAD"]).trim().toLowerCase();
          if (head !== stop.head.toLowerCase()) throw new RecoveryTreeError("tree head differs from the checkpoint");
          if (head !== base) {
            // A work-writable graft can make unrelated commits appear to be descendants.
            try {
              lstatSync(join(current.root, "git", "info", "grafts"));
              throw new RecoveryTreeError("Git grafts prevent verifying the original base");
            } catch (error) {
              if (error instanceof RecoveryTreeError) throw error;
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw new RecoveryTreeError("Git history cannot be verified");
              }
            }
            try {
              deps.read(tree, ["merge-base", "--is-ancestor", base, head]);
            } catch {
              throw new RecoveryTreeError("the operator-supplied base is not an ancestor of the checkpoint, or history cannot be verified");
            }
            if (typeof current.prNumber !== "number" || !Number.isSafeInteger(current.prNumber) ||
                current.prNumber < 1 || !current.prHead || current.prHead.toLowerCase() !== head) {
              throw new RecoveryTreeError("recorded PR head is missing or differs from the checkpoint");
            }
            const branch = `refs/heads/${current.branch}`;
            let actualBranch: string;
            let branchHead: string;
            try {
              actualBranch = deps.read(tree, ["symbolic-ref", "--quiet", "HEAD"]).trim();
              branchHead = deps.read(tree, ["rev-parse", "--verify", `${branch}^{commit}`]).trim().toLowerCase();
            } catch {
              throw new RecoveryTreeError("work branch head cannot be verified");
            }
            if (actualBranch !== branch || branchHead !== head) {
              throw new RecoveryTreeError("checkpoint is not the current work branch head");
            }
          }
          verifyRecoveryTree(tree, head, deps.read);
        } catch (error) {
          if (error instanceof RecoveryTreeError) return { ok: false, reason: `recovery refused: ${error.message}` };
          return { ok: false, reason: "recovery refused: work tree, Git index, or checkpoint contents cannot be verified" };
        }
        return { ok: true };
      },
    });
  } finally {
    lock.release();
  }
}

/** Parse repeatable `--caps key=value` without silently discarding a duplicate or unknown flag. */
export function parseRecoveryArgs(args: string[]): { workId: string; caps: Partial<WorkCaps>; base: string } {
  if (args[0] !== "recover" || !args[1] || args[1].startsWith("-")) {
    throw new Error("usage: anima work recover <workId> --base <full SHA> [--caps key=value ...]");
  }
  const caps: Record<string, number> = Object.create(null);
  let base: string | undefined;
  for (let i = 2; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--base" || flag.startsWith("--base=")) {
      if (base !== undefined) throw new Error("duplicate --base");
      base = flag === "--base" ? args[++i] : flag.slice("--base=".length);
      if (!base || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(base)) {
        throw new Error("--base requires the independently verified full base SHA");
      }
      continue;
    }
    let entry: string | undefined;
    if (flag === "--caps") entry = args[++i];
    else if (flag.startsWith("--caps=")) entry = flag.slice("--caps=".length);
    else throw new Error(`unknown work recovery option ${flag}`);
    const match = entry?.match(/^([A-Za-z][A-Za-z0-9]*)=([1-9][0-9]*)$/);
    if (!match) throw new Error("--caps requires key=positive-integer");
    const [, key, raw] = match as [string, string, string];
    if (Object.hasOwn(caps, key)) throw new Error(`duplicate work cap ${key}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new Error(`work cap ${key} must be a safe positive integer`);
    caps[key] = value;
  }
  if (!base) throw new Error("recovery requires --base <full SHA>");
  return { workId: args[1], caps, base: base.toLowerCase() };
}
