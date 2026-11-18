// Disposable owned child; no live identity client, provider or operator HOME.
import { writeFileSync } from "node:fs";
import { runHook } from "../../../../scripts/claude/identity-client";
import { createGuard } from "../../../../scripts/claude/sensitive-terms";
const [directory, session, ready] = process.argv.slice(2);
if (!directory || !session || !ready || process.env.RECALL_GUARD_FIXTURE !== "owned") throw Error("fixture only");
await runHook({ prompt: "inspect compiler boundaries", session_id: session }, {
  recall: async () => [{ source: "fixture", content: "a new compiler fact" }],
  noteGate: { shouldNote: () => false, markNoted() {} },
  guard: createGuard({ phrases: ["secret-topic"], words: [] }),
  dedup: { directory, deadlineMs: 2000, decision: async () => {
    writeFileSync(ready, "ready", { flag: "wx", mode: 0o600 });
    return new Promise(() => {});
  } },
});
