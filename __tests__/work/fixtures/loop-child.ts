/**
 * Child process for recovery tests: runs a loop session against file databases and then either hangs inside
 * the first provider call (so the parent can kill it for real) or finishes.
 *   bun loop-child.ts <dir> <workId> hang|finish
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLoopMode } from "../../../src/agents/loop";
import { SessionStore } from "../../../src/memory/session-store";
import { SessionManager } from "../../../src/session/manager";
import { NullMemoryAdapter } from "../../../src/memory/null-adapter";
import { WorkStore } from "../../../src/work/store";
import { createLoopHost } from "../../../src/work/runner";
import type { LoadedAgent } from "../../../src/agents/loader";
import type { Provider, ProviderRequest, ProviderResponse } from "../../../src/providers/interface";

const [dir, workId, mode] = process.argv.slice(2) as [string, string, string];
const store = new SessionStore(join(dir, "sessions.db"));
const manager = new SessionManager({ store, maxTokens: 200_000 });
const work = WorkStore.open(join(dir, "work.db"), { rootBase: join(dir, "roots") });

const agent = {
  name: "finn", label: "Finn", roomDir: dir, geneContent: "Core.", soulContent: "Soul.", soulPath: join(dir, "soul.md"),
  sessionContextFiles: [], additionalContent: [], memoryAdapter: new NullMemoryAdapter(),
  config: {
    provider: { type: "claude", model: "claude-test", modeMap: {} },
    policy: { allowedRoots: [], readOnlyRoots: [], allowedTools: [] },
    session: { defaultMode: "auto", compactThreshold: 60000 },
    memory: undefined,
  },
} as unknown as LoadedAgent;

const provider: Provider = {
  name: "claude",
  async query(_request: ProviderRequest): Promise<ProviderResponse> {
    if (mode === "hang") {
      writeFileSync(join(dir, "ready"), String(process.pid));
      await new Promise<never>(() => setInterval(() => {}, 1000)); // never settles; the parent kills this process
    }
    return { message: { role: "assistant", content: '<DONE reason="finished" />' } };
  },
};

const host = createLoopHost(work, workId, async () => "child reconcile");
await runLoopMode(agent, "goal", provider, manager, store, { maxIterations: 5, checkpoints: true, resume: true, host });
work.close();
store.close();
process.exit(0);
