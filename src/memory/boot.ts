/**
 * Boot Protocol — 4-step agent boot sequence.
 *
 * Executes: beforeSoulRead → afterSoulRead → bootstrap() → afterBootstrap
 * Each step is optional; hooks that are undefined are skipped.
 */

import type { AgentMemoryStore, AgentBootHooks } from "./contract";
import type { AgentMemoryEntry } from "./contract";

/**
 * Run the 4-step agent boot sequence.
 *
 * @param store  — the agent's AgentMemoryStore
 * @param hooks  — optional AgentBootHooks for per-agent customization
 * @returns Combined context entries from the bootstrap process
 */
export async function runAgentBoot(
  store: AgentMemoryStore,
  hooks?: AgentBootHooks,
): Promise<AgentMemoryEntry[]> {
  // Step 1: beforeSoulRead
  if (hooks?.beforeSoulRead) {
    await hooks.beforeSoulRead();
  }

  // Step 2: afterSoulRead
  if (hooks?.afterSoulRead) {
    await hooks.afterSoulRead();
  }

  // Step 3: bootstrap()
  const entries = await store.bootstrap();

  // Step 4: afterBootstrap
  if (hooks?.afterBootstrap) {
    return hooks.afterBootstrap(entries);
  }

  return entries;
}
