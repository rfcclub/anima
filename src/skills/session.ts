/**
 * Per-session skill activation. A skill is loaded once (deduplicated), its body and its resource listing are
 * kept for the rest of the session, and the rendered section is stable so it survives context compaction.
 */
import type { Skill } from "./discovery";
import { buildSkillCatalog } from "./catalog";

export interface SkillActivation {
  name: string;
  activated: boolean;
  skill?: Skill;
}

export interface SkillSessionOptions {
  /**
   * Clean (work/review) profiles pass the explicitly enabled skill names; only those are known to the session.
   * Omit for the default profile, where every discovered skill is available.
   */
  enabled?: string[];
}

export class SkillSession {
  private readonly available: Skill[];
  private readonly byName = new Map<string, Skill>();
  private readonly activated = new Map<string, Skill>();

  constructor(skills: Skill[], options: SkillSessionOptions = {}) {
    const enabled = options.enabled ? new Set(options.enabled) : undefined;
    this.available = enabled ? skills.filter((s) => enabled.has(s.name)) : skills;
    for (const skill of this.available) this.byName.set(skill.name, skill);
  }

  /** The compact catalog for the enabled skills — name and description only. */
  get catalog(): Skill[] {
    return [...this.available];
  }

  /** The catalog rendered for the prompt. */
  renderCatalog(): string {
    return buildSkillCatalog(this.available);
  }

  /** Names activated this session, in activation order. */
  get activatedNames(): string[] {
    return [...this.activated.keys()];
  }

  /** Activate by name. Activating an unknown or already-active skill is a no-op. */
  activate(name: string): SkillActivation {
    const skill = this.byName.get(name);
    if (!skill) return { name, activated: false };
    if (this.activated.has(name)) return { name, activated: false, skill };
    this.activated.set(name, skill);
    return { name, activated: true, skill };
  }

  /** Activate every enabled skill the message names (as a whole word). */
  activateFromMessage(message: string): SkillActivation[] {
    const found: SkillActivation[] = [];
    for (const skill of this.available) {
      const pattern = new RegExp(`(^|[^a-z0-9-])${escapeRegExp(skill.name)}($|[^a-z0-9-])`);
      if (pattern.test(message)) {
        const result = this.activate(skill.name);
        if (result.activated) found.push(result);
      }
    }
    return found;
  }

  /**
   * Render the activated skills for the prompt: each body once, followed by its resource listing. Empty when
   * nothing is active. Stable across turns and across compaction because it is derived from query state.
   */
  render(): string {
    if (this.activated.size === 0) return "";
    const sections: string[] = [];
    for (const skill of this.activated.values()) {
      const parts = [`# Skill: ${skill.name}`, skill.body];
      if (skill.resources.length > 0) {
        parts.push("## Resources", skill.resources.map((r) => `- ${r.path}`).join("\n"));
      }
      sections.push(parts.join("\n\n"));
    }
    return sections.join("\n\n");
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
