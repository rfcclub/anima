/**
 * rfcclub/anima#103 slice 3: an agent's mesh tools. They reach Mesh only through the agent's own socket,
 * which the ANIMA server serves while the agent holds its mesh ID, so a send always carries that agent's
 * mesh ID as sender. Works the same from the server and from an `anima talk` child process.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sidecarClient } from "colony-mesh/a2a/mesh-sidecar-socket";
import { presenceSocketPath } from "./agent-presence";

export const MESH_TOOL_NAMES = new Set(["mesh_send", "mesh_agents"]);

/** A mesh ID is `<agent>-<harness>-<id>@<machine>`; a bare name or a role address (`finn@anima`) is not. */
function isMeshId(target: string): boolean {
  const [local, machine] = target.split("@");
  return Boolean(local && machine && local.includes("-"));
}

function animaHome(): string {
  return process.env.ANIMA_HOME ?? join(process.env.HOME ?? "~", ".anima");
}

export async function runMeshTool(name: string, args: Record<string, unknown>, agentName: string): Promise<string> {
  const socket = presenceSocketPath(animaHome(), agentName);
  if (!existsSync(socket)) return "Error: agent has no mesh ID: the ANIMA server is not running";
  const client = sidecarClient(socket);
  if (name === "mesh_agents") {
    const listed = await client.list();
    return listed.status === 200 ? JSON.stringify(listed.body, null, 2) : `Error: mesh list failed (${listed.status})`;
  }
  const target = String(args.to ?? args.to_id ?? "");
  const content = String(args.content ?? args.body ?? "");
  if (!isMeshId(target)) {
    return `Error: "${target}" is not a mesh ID. Send to a mesh ID listed by mesh_agents (agent-harness-id@machine); role addresses such as finn@anima are retired.`;
  }
  if (!content) return "Error: content is required";
  const sent = await client.send({ target, content });
  return sent.status === 200 ? JSON.stringify(sent.body, null, 2) : `Error: mesh send failed (${sent.status}): ${JSON.stringify(sent.body)}`;
}
