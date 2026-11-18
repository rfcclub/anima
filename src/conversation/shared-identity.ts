/**
 * Shared-speech identity text — the identity-content half of
 * AgentSession.prepareTurn's non-cartridge fallback branch
 * (src/agents/session.ts, the "## Soul" section of buildSystemPrompt,
 * src/agents/prompter.ts), extracted as a standalone function.
 *
 * Deliberately does not call prepareTurn, buildSystemPrompt,
 * buildSystemPromptFromPlan, or anything cartridge/execution-plan/
 * identity-runtime related — those wire capability (tools, memory
 * retrieval, a leased remote projection) that the room-scoped shared speech
 * path deliberately keeps out. This module reads
 * only "who this agent is": its SOUL content, optionally synthesized
 * against live substrate scopes (scars/current_state/relationship) the
 * same way Town already does. Most agents have no
 * continuity.identityRuntime configured, so this fallback path is the one
 * they actually run in Town.
 */
import { tierSoul } from "../identity/engine";
import { buildCurrentIdentitySummary } from "../identity-runtime/current-identity-summary";
import { estimateTokens } from "@anima/context-engine";
import type { LoadedAgent } from "../agents/loader";

/** Headroom added on top of the raw soul's own estimated size when
 *  budgeting the substrate-synthesized summary (see the regression
 *  note below) — enough room for scars/current_state/relationship
 *  note below) — enough room for scars/current_state/relationship
 *  content to genuinely add to the soul, not so tight that a soul this
 *  size alone gets truncated by its own budget. */
const SUBSTRATE_SUMMARY_HEADROOM_TOKENS = 1_000;

/**
 * Returns the agent's identity text for shared speech, or `undefined` if
 * the agent has no SOUL content at all (name/label-only, same
 * graceful-degrade shape the old `loadPublicIdentity` had for a missing
 * file).
 *
 * Mirrors `buildSystemPrompt`'s "## Soul" section exactly: prefer a
 * substrate-synthesized Current Identity Summary; fall back to the raw
 * SOUL content if no substrate adapter is configured or retrieval fails.
 *
 * **Regression, fixed here:** Town's own `session.ts` caps this
 * summary at a fixed 800 tokens — fine for its UI turn budget, but far
 * smaller than a full axioms-style SOUL document (~1,700 tokens). Copying
 * that fixed 800 verbatim truncates the summary partway through the
 * document, so later axioms never reach the prompt at all and the agent can
 * answer in ways its own soul says not to. The cap here is sized to the
 * soul's own length plus headroom for substrate content, not a fixed
 * number disconnected from what's actually being summarized — this path's
 * real ceiling is the shared-speech budget (`computeInputBudgetTokens`,
 * ~12k tokens), not Town's UI-turn-specific 800.
 */
export async function buildSharedIdentityText(agent: LoadedAgent): Promise<string | undefined> {
  const soulContent = agent.soulContent ?? "";
  const tiered = tierSoul(soulContent);
  const maxTokens = estimateTokens(soulContent) + SUBSTRATE_SUMMARY_HEADROOM_TOKENS;

  let currentIdentitySummary: string | undefined;
  try {
    currentIdentitySummary = await buildCurrentIdentitySummary(agent.substrateAdapter, tiered, maxTokens);
  } catch {
    currentIdentitySummary = undefined;
  }

  const soul = currentIdentitySummary?.trim() || soulContent.trim();
  return soul || undefined;
}
