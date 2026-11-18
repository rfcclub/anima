import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MeshBus } from "colony-mesh";
import { HttpBrunoContinuityClient } from "./anima-continuity-client";
import { startBrunoRuntimeHttp } from "./http";
import { BrunoRuntime } from "./runtime";

const dbPath = Bun.env.BRUNO_RUNTIME_DB ?? join(homedir(), ".anima", "agents", "bruno", "bruno-runtime.db");
mkdirSync(dirname(dbPath), { recursive: true });
const mesh = new MeshBus(Bun.env.BRUNO_RUNTIME_MESH_DB);
const runtime = new BrunoRuntime({
  dbPath,
  // Canonical compilation and canonical writes live inside ANIMA
  // (server.ts, /internal/continuity/bruno/*); this process is the
  // Incarnation authority only — leases, admission, outbox. Same split as
  // eli-runtime, same env var name.
  continuity: new HttpBrunoContinuityClient(Bun.env.ANIMA_CONTINUITY_URL ?? "http://127.0.0.1:3700"),
  mesh,
  platform: Bun.env.BRUNO_RUNTIME_PLATFORM ?? "macos",
});
const server = startBrunoRuntimeHttp(runtime, Bun.env.BRUNO_RUNTIME_HOST ?? "0.0.0.0", Number(Bun.env.BRUNO_RUNTIME_PORT ?? "13542"));
console.log(`bruno-runtime listening on http://${server.hostname}:${server.port}`);
