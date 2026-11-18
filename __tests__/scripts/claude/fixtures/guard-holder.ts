import { writeFileSync } from "node:fs";
import { acquireRecallGuard } from "../../../../scripts/claude/recall-guard";
const [directory, session, ready] = process.argv.slice(2);
if (!directory || !session || !ready || process.env.RECALL_GUARD_FIXTURE !== "owned") throw Error("fixture only");
const release = acquireRecallGuard(directory, session);
if (!release) process.exit(2);
writeFileSync(ready, "ready", { flag: "wx", mode: 0o600 });
await new Promise(() => {});
