import type { Provider } from "../providers/interface";
import type { WorkerAdapter, WorkerAdapterInput, WorkerAdapterResult } from "./adapter";
import { completeWork, type TreeGit } from "./complete";
import type { StopCause } from "./consumer";
import { createSessionGateway } from "./gateway";
import { gitWithGeneratedExcludes } from "./generated-excludes";
import type { WorkRecord, WorkStore } from "./store";
import type { VmRunner } from "./vm";

const LOW_EXIT: Record<number, StopCause> = {
  0: "done", 1: "unverified", 3: "provider_error", 4: "question", 5: "max_reached",
};

/** Inspect the exact changed Git blobs after filters, without passing the secret as a process argument. */
function stagedTreeSafe(git: TreeGit, tree: string, staged: string, old: string, token: string): boolean {
  try {
    const raw = git(tree, ["--no-replace-objects", "diff-tree", "--no-commit-id", "--raw", "--no-abbrev", "--no-renames", "-r", "-z", old, staged]);
    if (raw.includes(token)) return false; // includes changed path names
    const records = raw.split("\0");
    for (let i = 0; i < records.length && records[i]; i += 2) {
      const match = /^:[0-7]{6} ([0-7]{6}) [0-9a-f]{40,64} ([0-9a-f]{40,64}) ([A-Z])$/.exec(records[i]);
      if (!match || records[i + 1] === undefined) return false;
      const [, mode, object, change] = match;
      if (change === "D") continue;
      if (mode === "160000") return false; // Cannot inspect another repository's object.
      if (git(tree, ["--no-replace-objects", "cat-file", "blob", object]).includes(token)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function lowStopCause(code: number | null): StopCause {
  return code !== null ? LOW_EXIT[code] ?? "worker_error" : "worker_error";
}

export interface LowAdapterDeps {
  store: WorkStore;
  runner: VmRunner;
  createProvider: (work: WorkRecord) => Promise<Provider>;
  buildTask: (input: WorkerAdapterInput) => Promise<string>;
  treeGit: TreeGit;
  author: (work: WorkRecord) => { name: string; email: string };
  killGraceMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export function createLowAdapter(deps: LowAdapterDeps): WorkerAdapter {
  return {
    kind: "low",
    async run(input): Promise<WorkerAdapterResult> {
      const { work, session } = input;
      const fence = () => !input.signal.aborted && deps.store.getWork(work.workId)?.generation === session.generation;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortListener: (() => void) | undefined;
      let gateway: ReturnType<typeof createSessionGateway> | undefined;
      const stop = new Promise<"deadline" | "interrupted">((resolve) => {
        abortListener = () => resolve("interrupted");
        if (input.signal.aborted) resolve("interrupted");
        else input.signal.addEventListener("abort", abortListener, { once: true });
        timer = setTimeout(() => resolve("deadline"), Math.max(0, input.deadlineMs));
      });
      try {
        if (!fence()) {
          return { stopCause: "interrupted", iterations: 0, cessation: "proven" };
        }
        const provider = await Promise.race([
          deps.createProvider(work).then((value) => ({ value } as const)),
          stop.then((cause) => ({ cause } as const)),
        ]);
        if ("cause" in provider) return { stopCause: provider.cause, iterations: 0, cessation: "proven" };
        gateway = createSessionGateway({
          provider: provider.value, model: work.model, budget: input.maxIterations,
          link: { workId: work.workId, jobId: input.claim.jobId, claimId: input.claim.id, sessionNo: session.no },
          admit: fence,
        });
        const ready = gateway.start();
        const startedGateway = await Promise.race([
          ready.then(() => ({ ready: true } as const)),
          stop.then((cause) => ({ cause } as const)),
        ]);
        if ("cause" in startedGateway) {
          const lateGateway = gateway;
          void ready.then(() => lateGateway.stop()).catch(() => {});
          return { stopCause: startedGateway.cause, iterations: 0, cessation: "proven" };
        }
        const order = await Promise.race([
          deps.buildTask(input).then((task) => ({ task } as const)),
          stop.then((cause) => ({ cause } as const)),
        ]);
        if ("cause" in order) return { stopCause: order.cause, iterations: gateway.stats().admitted, cessation: "proven" };
        if (!fence()) return { stopCause: "interrupted", iterations: gateway.stats().admitted, cessation: "proven" };
        let startingHead: string;
        try {
          startingHead = deps.treeGit(input.workspace.tree, ["rev-parse", "--verify", `refs/heads/${work.branch}^{commit}`]).trim();
        } catch {
          return { stopCause: "worker_error", iterations: gateway.stats().admitted, cessation: "proven" };
        }
        const starting = deps.runner.start({
          sessionId: session.sessionId, root: input.workspace.root, gatewayUrl: gateway.url,
          gatewayToken: gateway.token, model: work.model, task: order.task, timeoutMs: input.deadlineMs,
        });
        const started = await Promise.race([
          starting.then((vm) => ({ vm } as const), () => ({ failed: true } as const)),
          stop.then((cause) => ({ cause } as const)),
        ]);
        if ("failed" in started) {
          return { stopCause: "worker_error", iterations: gateway.stats().admitted, cessation: "unproven", cessationCheck: "vm-start-failed" };
        }
        if ("cause" in started) {
          gateway.revoke();
          // Startup may still succeed after the timeout. Stop that VM, but never claim it was already gone.
          void starting.then(async (vm) => {
            try {
              await vm.kill();
            } finally {
              await vm.gone();
            }
          }).catch(() => {});
          return { stopCause: started.cause, iterations: gateway.stats().admitted, cessation: "unproven", cessationCheck: "vm-start-unsettled" };
        }
        const vm = started.vm;
        const outcome = await Promise.race([
          vm.exited.then(({ code }) => ({ cause: lowStopCause(code), kill: false } as const),
            () => ({ cause: "worker_error" as const, kill: true } as const)),
          stop.then((cause) => ({ cause, kill: true } as const)),
        ]);
        gateway.revoke();
        const grace = deps.killGraceMs ?? 5000;
        if (outcome.kill) {
          await Promise.race([vm.kill().catch(() => {}), new Promise<void>((resolve) => setTimeout(resolve, grace))]);
        }
        const until = Date.now() + grace;
        let gone = false;
        do {
          gone = await Promise.race([vm.gone().catch(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), grace))]);
          if (gone || Date.now() >= until) break;
          await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(0, until - Date.now()))));
        } while (Date.now() < until);
        const cleanupError = gone ? vm.cleanupError?.() : undefined;
        if (cleanupError) {
          deps.log?.(cleanupError.replaceAll(gateway.token, "[redacted]"));
          return { stopCause: "worker_error", iterations: gateway.stats().admitted, cessation: "proven" };
        }
        if (gone && fence() && (outcome.cause === "done" || outcome.cause === "max_reached")) {
          let head: string;
          try {
            head = deps.treeGit(input.workspace.tree, ["rev-parse", "--verify", `refs/heads/${work.branch}^{commit}`]).trim();
          } catch (error) {
            deps.log?.(`host completion refused: ${String(error).replaceAll(gateway.token, "[redacted]")}`);
            return { stopCause: "worker_error", iterations: gateway.stats().admitted, cessation: "proven" };
          }
          if (head !== startingHead) {
            return { stopCause: "blocked", blockedReason: "worker moved the work branch; host cannot safely publish worker-created commits",
              iterations: gateway.stats().admitted, cessation: "proven" };
          }
          // The host policy hides only untracked generated files; tracked changes are still staged.
          const completion = completeWork({ git: (tree, args) =>
              args.includes("add") ? gitWithGeneratedExcludes(deps.treeGit, tree, args) : deps.treeGit(tree, args),
            }, {
              work,
              stop: {
                sessionId: session.sessionId, workId: work.workId, adapter: "low", stopCause: outcome.cause,
                cessation: "proven", cessationCheck: null, head, status: "unknown",
                evidence: "unavailable", trusted: false, interrupted: false, recordedAt: new Date().toISOString(),
              },
              guard: () => { if (!fence()) throw new Error("session lease or generation lost"); },
              author: deps.author(work),
              message: `work for #${work.issue} (session ${session.no})`,
              validateTree: (staged, old) => stagedTreeSafe(deps.treeGit, input.workspace.tree, staged, old, gateway!.token),
            });
          if (!completion.ok) {
            deps.log?.(`host completion refused: ${completion.reason.replaceAll(gateway.token, "[redacted]")}`);
            if (completion.reason === "staged tree failed the host publication safety check" ||
                completion.reason === "external Git filter configured; host completion refused" ||
                completion.reason === "executable Git configuration found; host completion refused") {
              return { stopCause: "blocked", blockedReason: completion.reason,
                iterations: gateway.stats().admitted, cessation: "proven" };
            }
            return { stopCause: "worker_error", iterations: gateway.stats().admitted, cessation: "proven" };
          }
        }
        return {
          stopCause: outcome.cause, iterations: gateway.stats().admitted,
          cessation: gone ? "proven" : "unproven",
          ...(gone ? {} : { cessationCheck: "vm-not-gone" }),
        };
      } finally {
        if (timer) clearTimeout(timer);
        if (abortListener) input.signal.removeEventListener("abort", abortListener);
        if (gateway) await gateway.stop();
      }
    },
  };
}
