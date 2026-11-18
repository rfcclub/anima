import type { IdentityRuntime } from "./runtime.ts";

/** One authority per canonical identity database path. */
export class IdentityRuntimeRegistry {
  private readonly byAgentId = new Map<string, { dbPath: string; runtime: IdentityRuntime }>();
  private readonly byDbPath = new Map<string, IdentityRuntime>();

  register(runtime: IdentityRuntime, dbPath: string): void {
    const existing = this.byDbPath.get(dbPath);
    if (existing && existing !== runtime) throw new Error(`identity authority already registered for ${dbPath}`);
    this.byDbPath.set(dbPath, runtime);
    this.byAgentId.set(runtime.agentId, { dbPath, runtime });
  }

  get(agentId: string): IdentityRuntime | undefined {
    return this.byAgentId.get(agentId)?.runtime;
  }
}
