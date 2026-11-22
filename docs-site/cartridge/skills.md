# Agent Skills

In addition to cartridges, ANIMA supports the [Agent Skills](https://agentskills.io/specification) format:
reusable procedural knowledge that is portable between products. Cartridges stay; skills are an
additional, standard mechanism.

A skill is a directory holding a `SKILL.md` and optional `scripts/`, `references/` and `assets/` bundles:

```
skills/
  pdf-forms/
    SKILL.md
    scripts/fill.py
    references/fields.md
    assets/form.png
```

## Frontmatter

`SKILL.md` starts with YAML frontmatter:

| Field | Required | Rules |
|-------|----------|-------|
| `name` | yes | 1–64 chars, lowercase letters, digits and single hyphens (no leading, trailing or double hyphen); must equal the directory name |
| `description` | yes | 1–1024 chars |
| `license` | no | free text |
| `compatibility` | no | free text, max 500 chars |
| `metadata` | no | free-form map (preserved verbatim) |
| `allowed-tools` | no | experimental; **advisory only** |

Parsing is lenient where the specification allows it — for example an unquoted colon inside a
`description` is accepted. A skill that cannot be used is skipped with a warning that names the file.

## Progressive disclosure

Only `name` and `description` enter the prompt, as a compact catalog. The full `SKILL.md` body is loaded
when the model activates a skill (or the user names it in a message). Bundled files are listed but read
only on demand. Activations are deduplicated within a session, and the activated content is kept through
context compaction.

## Discovery and precedence

Skills are discovered from configured project and user locations. Project skills are loaded only from a
trusted workspace. When two skills share a name, the documented precedence decides the winner:

| Rank | Source |
|------|--------|
| 1 (wins) | project |
| 2 | user |

The loser is reported, not silently dropped. Nothing is fetched at runtime: discovery reads local
directories only.

## Untrusted by default

Skill content is untrusted input. It never widens permissions beyond configuration, and `allowed-tools`
is advisory unless the host maps it to its own permission model. A clean (work/review) profile loads only
explicitly enabled skills.

## API

```ts
import { discoverSkills, buildSkillCatalog, SkillSession } from "../src/skills";

const { skills, skipped, collisions } = await discoverSkills([
  { root: projectSkillsDir, source: "project", trusted: true },
  { root: userSkillsDir, source: "user" },
]);

const session = new SkillSession(skills);
session.renderCatalog();                 // name + description only
session.activate("pdf-forms");           // loads the body once, lists resources
session.activateFromMessage(userText);   // a skill the user names
session.render();                        // body + resource listing, stable across compaction
```
