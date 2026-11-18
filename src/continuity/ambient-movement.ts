export interface AmbientMovementPolicyOptions {
  cooldownMs: number;
}

export type AmbientMovementResult = { moved: true } | { moved: false; reason: "cooldown" };

/** T0 idle behavior, intentionally outside broker-driven purposeful actions. */
export class AmbientMovementPolicy {
  private readonly lastMovedAt = new Map<string, number>();

  constructor(private readonly options: AmbientMovementPolicyOptions) {}

  async attempt(input: { agentId: string; now: number; move(): Promise<void> }): Promise<AmbientMovementResult> {
    const last = this.lastMovedAt.get(input.agentId);
    if (last !== undefined && input.now - last < this.options.cooldownMs) return { moved: false, reason: "cooldown" };
    await input.move();
    this.lastMovedAt.set(input.agentId, input.now);
    return { moved: true };
  }
}
