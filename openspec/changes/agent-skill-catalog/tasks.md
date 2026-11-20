# Tasks — Discover and activate trusted Agent Skills

Each unchecked item is a separate proposed work order. Require the preceding item to land before approving a dependent slice. Each code slice targets about 40 production lines and at most two production files. If the proposed behavior cannot fit safely, narrow the next slice before worker approval. For production slices capture a failing focused test before edits, run that test and `bun run build`, and preserve Orca gate results.

- [ ] **S1 – Validate local skill metadata**
  - Files: `src/skills/catalog.ts`.
  - Implementation: A pure parser validates required metadata and directory-name equality, rejects excessive input and malformed YAML, and never widens grants. Cover duplicate keys, valid unquoted text, length limits, and optional metadata.
  - Verification: `bun test __tests__/skills/catalog.test.ts`
- [ ] **S2 – Discover enabled roots and resolve name collisions**
  - Files: `src/skills/discovery.ts`.
  - Implementation: Enumerate only configured trusted roots, prefer project before user and report a rejected entry by relative skill file without printing absolute paths. Compare real paths after symlink resolution and verify an unreadable root leaves other roots usable.
  - Verification: `bun test __tests__/skills/discovery.test.ts`
- [ ] **S3 – Render catalog metadata in interactive prompts**
  - Files: `src/agents/prompter.ts`.
  - Implementation: Render validated names and descriptions only. Verify content from SKILL.md bodies and optional metadata are absent before activation.
  - Verification: `bun test __tests__/agents/prompter.test.ts`
- [ ] **S4 – Wire the clean profile allowlist**
  - Files: `src/cartridge/headless-profile.ts`, `src/work/executor.ts`.
  - Implementation: Keep clean work and review catalogs empty by default. Resolve enabled sets from trusted host profile configuration. Verify the shared clean profile used by review and the work executor both honor the allowlist. Never infer workspace trust from repository or skill text.
  - Verification: `bun test __tests__/work/headless-skills.test.ts`
- [ ] **S5 – Resolve explicit session activations once**
  - Files: `src/skills/activation.ts`.
  - Implementation: Expose a typed resolver shared by the eventual explicit user and model activation entry points. Reject permission requests from skill metadata. Reject unknown ids and escaping paths, pin bounded content once, and return a bounded listing without reading resources or running scripts.
  - Verification: `bun test __tests__/skills/activation.test.ts`
- [ ] **S6 – Read bundled skill resources on demand**
  - Files: `src/skills/resources.ts`.
  - Implementation: Resolve bounded resource reads under the selected skill directory. Verify escaping paths and unknown resources are refused and a resource script is never executed by a read.
  - Verification: `bun test __tests__/skills/resources.test.ts`
- [ ] **S7 – Retain active skill content across message rebuild**
  - Files: `src/agents/loop.ts`.
  - Implementation: Render the pinned entries when session messages are rebuilt, outside the lossy summary. Keep the state scoped to the current session and unchanged by new turns. Test repeated activation, compaction, session separation, and no permission changes.
  - Verification: `bun test __tests__/agents/skill-compaction.test.ts`

- [ ] **S8 – Wire explicit user-named skill activation**
  - Files: `src/cli.ts`.
  - Implementation: Route an explicit local skill activation request through the shared session resolver. Test an unknown identifier, repeated activation, and ordinary messages that merely mention a skill without activating it.
  - Verification: `bun test __tests__/skills/cli-activation.test.ts`
- [ ] **S9 – Expose model skill activation in trusted enabled work sessions**
  - Files: `src/work/tools.ts`, `src/work/executor.ts`.
  - Implementation: Expose a host activation tool only with a non-empty approved skill catalog. Accept only a catalog ID, resolve within the session, and route the resulting pinned context to the message rebuild. Verify a skill cannot change tool grants.
  - Verification: `bun test __tests__/work/skill-activation-tools.test.ts`

## Success Criteria

| Criterion | Tasks | Acceptance evidence |
| --- | --- | --- |
| SC-1 | S1, S3, S4 | A valid skill contributes its name and description only in an enabled profile. A clean profile with no enablement contributes nothing. |
| SC-2 | S1, S2 | A malformed file or invalid/mismatched directory name is skipped. The warning identifies the relative skill file without exposing local paths. |
| SC-3 | S5, S6, S7, S8, S9 | Two activations load the body once, list bounded resource paths, and retain the pinned content after compaction. A resource is read only on request. |
| SC-4 | S2 | Project precedence wins a duplicate name, the defeated user skill is reported, and other entries stay available. |
| SC-5 | S1, S2, S5, S7 | Run explicit valid, malformed-YAML, collision, activation, and compaction cases. |

## References

- Specification: https://agentskills.io/specification
