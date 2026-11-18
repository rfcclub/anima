/**
 * Default autonomy level seeds for known colony agents.
 * Applied on first boot — agents not listed start at L0.
 *
 * L2 = trusted (code-change, review autonomous)
 * L1 = proving (code-change needs to earn trust)
 * L0 = approval required (default, not seeded)
 */
import type { AutonomySeed } from "./autonomy-ladder";

const TRUSTED_AGENTS = ["bruno", "eli", "cleo", "quin"];
const PROVING_AGENTS = ["lena", "sam", "milo", "ivan"];

export const DEFAULT_AUTONOMY_SEEDS: AutonomySeed[] = [
  // Trusted agents → L2 for code-change and review
  ...TRUSTED_AGENTS.flatMap((agentId) => [
    { agentId, actionClass: "code-change" as const, level: 2 as const },
    { agentId, actionClass: "review" as const, level: 2 as const },
  ]),
  // Proving agents → L1 for code-change only
  ...PROVING_AGENTS.map((agentId) => ({
    agentId,
    actionClass: "code-change" as const,
    level: 1 as const,
  })),
];
