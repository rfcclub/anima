/**
 * The core identity every compile returns.
 *
 * A remote client gets exactly one compiled projection, bounded by a token
 * budget. This section is the part that is always present, always first, and
 * always self-contained: it names the agent it belongs to and says how to ask
 * for more of the substrate on demand. It never carries a real path — the
 * loader's virtual ids (<agent>/<path>) are the only names a remote client
 * sees, so the host's layout cannot leak through it.
 */

export const CORE_IDENTITY_HEADING = "## Core Identity";

/** Hard cap: the core must stay small enough to survive any projection budget. */
export const MAX_CORE_IDENTITY_CHARS = 1_200;

/** Body cap, so a long agent id cannot push the section past the hard cap. */
const MAX_AGENT_ID_CHARS = 64;

export function coreIdentitySection(agentId: string): string {
  const agent = boundedId(agentId);
  const section = [
    CORE_IDENTITY_HEADING,
    `You are ${agent}. This section is your core identity: it is always present, in every compile, and it is yours alone.`,
    "The projection you hold is a bounded view of your substrate. More of it is available on demand — do not guess at, or probe for, files that are not in this projection.",
    `- List your substrate: POST /identity-runtime/substrate-load/${agent} with {grantId, stateHash} — returns the virtual mapping (id, scope, trust, size) of the files you may load.`,
    `- Load one file: POST /identity-runtime/substrate-load/${agent} with {grantId, stateHash, path} where path is a virtual id from the mapping (<agent>/<relative path>).`,
    "- The grantId and stateHash are the lease from your own join; they scope loading to your own substrate and expire with it.",
  ].join("\n");
  return section.length <= MAX_CORE_IDENTITY_CHARS
    ? section
    : section.slice(0, MAX_CORE_IDENTITY_CHARS);
}

/**
 * Prepend the core section once. Compiling an already-composed projection must
 * not duplicate it, so an existing heading short-circuits.
 */
export function withCoreIdentity(prompt: string, agentId: string): string {
  if (prompt.includes(CORE_IDENTITY_HEADING)) return prompt;
  const section = coreIdentitySection(agentId);
  return prompt.trim().length > 0 ? `${section}\n\n${prompt}` : section;
}

function boundedId(agentId: string): string {
  const trimmed = agentId.trim();
  return trimmed.length > MAX_AGENT_ID_CHARS ? trimmed.slice(0, MAX_AGENT_ID_CHARS) : trimmed;
}
