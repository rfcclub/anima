import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MeshBus } from "colony-mesh";
import { HttpAnimaContinuityClient } from "./anima-continuity-client";
import { startEliRuntimeHttp } from "./http";
import { EliRuntime } from "./runtime";

const dbPath = Bun.env.ELI_RUNTIME_DB ?? join(homedir(), ".anima", "agents", "eli", "eli-runtime.db");
mkdirSync(dirname(dbPath), { recursive: true });
const mesh = new MeshBus(Bun.env.ELI_RUNTIME_MESH_DB);
const runtime = new EliRuntime({
  dbPath,
  continuity: new HttpAnimaContinuityClient(Bun.env.ANIMA_CONTINUITY_URL ?? "http://127.0.0.1:3700"),
  mesh,
  platform: Bun.env.ELI_RUNTIME_PLATFORM ?? "macos",
});
const server = startEliRuntimeHttp(runtime, Bun.env.ELI_RUNTIME_HOST ?? "0.0.0.0", Number(Bun.env.ELI_RUNTIME_PORT ?? "13541"));
console.log(`eli-runtime listening on http://${server.hostname}:${server.port}`);
