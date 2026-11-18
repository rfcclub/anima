/**
 * Memory Health API — exposes AgentMemoryStore health for all registered agents.
 * GET /api/memory/health → JSON array of per-store health status
 */

import { MemoryHealthRegistry } from "../../memory/health-registry";

export async function handleMemoryHealth(): Promise<Response> {
  const registry = MemoryHealthRegistry.getInstance();
  const results = await registry.checkHealth();
  return Response.json(results, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
