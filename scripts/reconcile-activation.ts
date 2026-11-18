import { reconcileActivation } from "../src/continuity/activation-reconciliation";

const activationDbPath = Bun.env.ANIMA_ACTIVATION_DB ?? `${Bun.env.ANIMA_ROOMS_DIR ?? "rooms"}/_shared/memory.db`;
const meshDbPath = Bun.env.MESH_DB_PATH;
if (!meshDbPath) {
  console.error("MESH_DB_PATH must point at the mesh database");
  process.exit(2);
}
const recipientId = Bun.argv[2];

const report = reconcileActivation({ activationDbPath, meshDbPath, now: Date.now(), recipientId });
for (const row of report) console.log(JSON.stringify(row));
