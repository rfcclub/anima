/**
 * Shared VN asset helpers — not feature-specific. Any feature that needs a
 * character portrait or a background (castle rooms, common rooms, future
 * surfaces) resolves URLs and checks asset existence through here, against
 * the /api/vn/assets list from src/ui/features/vn-assets.
 */

const stripExt = (file: string) => file.replace(/\.[a-zA-Z0-9]+$/, "");

/** The background scene id for an agent's own chamber. */
export function chamberSceneId(agentId: string): string {
  return `chamber_${agentId}`;
}

export function backgroundUrl(sceneId: string): string {
  return `/api/vn/background/${sceneId}`;
}

export function portraitUrl(agentId: string, emotion: string): string {
  return `/api/vn/portrait/${agentId}/${emotion}`;
}

/** Does a background for `sceneId` exist in the current /api/vn/assets list? */
export function hasBackground(sceneId: string, backgrounds: string[]): boolean {
  return backgrounds.some((f) => stripExt(f) === sceneId);
}

/**
 * Does a portrait for `agentId` exist? Portraits are listed either flat
 * ("bruno.png") or per-emotion under a folder ("bruno/neutral.png").
 */
export function hasPortrait(agentId: string, portraits: string[]): boolean {
  return portraits.some((f) => stripExt(f) === agentId || f.startsWith(`${agentId}/`));
}
