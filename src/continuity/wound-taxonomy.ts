export type WoundType = "pattern" | "relational" | "substrate";

export interface WoundEscalation {
  escalate: boolean;
  blockAutoMerge: boolean;
  reason: string;
}

export const PATTERN_WOUND_ESCALATION_REPEATS = 3;

export function normalizeWoundType(value: unknown): WoundType | undefined {
  if (value === "pattern" || value === "relational" || value === "substrate") {
    return value;
  }
  return undefined;
}

export function woundSignature(reasoning: string): string {
  return reasoning.trim().toLowerCase() || "pattern";
}

export function evaluateWoundEscalation(woundType: WoundType, repeats = 1): WoundEscalation {
  if (woundType === "relational") {
    return {
      escalate: true,
      blockAutoMerge: false,
      reason: "relational wound escalates immediately",
    };
  }

  if (woundType === "substrate") {
    return {
      escalate: true,
      blockAutoMerge: true,
      reason: "substrate wound escalates immediately and blocks auto-merge",
    };
  }

  return {
    escalate: repeats >= PATTERN_WOUND_ESCALATION_REPEATS,
    blockAutoMerge: false,
    reason: `pattern wound repeat ${repeats}/${PATTERN_WOUND_ESCALATION_REPEATS}`,
  };
}
