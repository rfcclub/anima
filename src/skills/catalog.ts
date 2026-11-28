/**
 * The compact skill catalog that enters the prompt: only each skill's name and description, never its body.
 * Progressive disclosure — the body is loaded only when the model activates the skill.
 */
import type { Skill } from "./discovery";

/** Render the catalog. Skills are sorted by name so the block is stable within a session. */
export function buildSkillCatalog(skills: Skill[]): string {
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  const lines = sorted.map((skill) => `- ${skill.name}: ${skill.description}`);
  return lines.join("\n");
}
