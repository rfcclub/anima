/**
 * Naming convention for dynamically-blended common-room backgrounds: with two
 * or more agents the file follows the template library_agent1_agent2.png, and
 * the agent ids are sorted alphabetically so that (gus, bruno) and
 * (bruno, gus) both resolve to library_bruno_gus.png. Pure, no node/fs
 * imports — shared by the client (lookup) and the server (generate+cache).
 */
export function sortedAgentKey(agentIds: string[]): string {
  return [...agentIds].sort().join("_");
}

/** The background sceneId (no extension) for a room's current occupant
 *  combination, e.g. roomSceneFileName("library", ["gus"]) === "library_gus",
 *  roomSceneFileName("library", ["gus", "bruno"]) === "library_bruno_gus". */
export function roomSceneFileName(roomId: string, agentIds: string[]): string {
  return `${roomId}_${sortedAgentKey(agentIds)}`;
}
