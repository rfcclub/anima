export type ActivationMode = "off" | "shadow" | "gate" | "enforce";

const MODES = new Set<ActivationMode>(["off", "shadow", "gate", "enforce"]);

export function parseActivationMode(value: string | undefined): ActivationMode {
  if (value === undefined || value === "") return "off";
  if (MODES.has(value as ActivationMode)) return value as ActivationMode;
  throw new Error(`invalid activation mode: ${value}`);
}

/** A rollback cannot strand an active gated/enforced lease without its owner. */
export function canRollbackActivation(input: { from: ActivationMode; to: ActivationMode; activeLeases: number }): { ok: true } | { ok: false; reason: "active-leases" } {
  if ((input.from === "gate" || input.from === "enforce") && input.to !== input.from && input.activeLeases > 0) {
    return { ok: false, reason: "active-leases" };
  }
  return { ok: true };
}
