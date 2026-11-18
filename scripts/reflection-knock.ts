/**
 * Knock a reflection-enabled agent so it ticks immediately.
 *
 * Usage:
 *   bun scripts/reflection-knock.ts eli "Please review the colony-mesh bridge"
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { MeshBus } from "colony-mesh";

const agentId = process.argv[2];
const intent = process.argv[3] ?? "knock";

if (!agentId) {
  console.error("Usage: bun scripts/reflection-knock.ts <agentId> [intent]");
  process.exit(1);
}

const roomsDir = process.env.ANIMA_ROOMS_DIR ?? join(homedir(), ".anima", "rooms");
const bus = new MeshBus();

bus.publish({
  from_id: "owner",
  to_id: `anima-${agentId}`,
  content: intent,
  subject: "knock",
  role: "knock",
  pattern: "direct",
}, "manual");

console.log(`Knocked anima-${agentId}: ${intent}`);
