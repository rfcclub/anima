# Design — Discover and activate trusted Agent Skills

Parent intent: #274.

## Architecture

Discover skills from explicit user roots and trusted project roots. Feed names and descriptions into prompt assembly for interactive agents and into the separate headless work/review prompt path only under explicit profile allowlists. Resolve both named requests and model activation to one session-scoped handler that reads immutable, bounded content relative to the canonical skill root. Resolve on-demand resources separately; activation never executes scripts. At message rebuild, re-inject pinned activations from session state so lossy summaries cannot remove or change them. Existing policy retains tool authority.

## Integration points

Reuse `src/agents/prompter.ts`, `src/cartridge/headless-profile.ts`, `src/agents/loop.ts` and the [Agent Skills format](https://agentskills.io/specification). Preserve one pinned entry per session and skip invalid and escaping files.

## Test strategy

Use synthetic inputs, explicit negative cases, and existing process and permission boundaries. No live rollout is part of this design.

- **S1. Validate local skill metadata.** A pure parser validates required metadata and directory-name equality, rejects excessive input and malformed YAML, and never widens grants. Cover duplicate keys, valid unquoted text, length limits, and optional metadata.
- **S2. Discover enabled roots and resolve name collisions.** Enumerate only configured trusted roots, prefer project before user and report rejected entries without absolute paths. Compare real paths after symlink resolution and verify an unreadable root leaves other roots usable.
- **S3. Render catalog metadata in interactive prompts.** Render validated names and descriptions only. Verify content from SKILL.md bodies and optional metadata are absent before activation.
- **S4. Wire the clean profile allowlist.** Keep clean work and review catalogs empty by default. Resolve enabled sets from trusted profile configuration and verify the work executor uses the filtered catalog.
- **S5. Resolve explicit session activations once.** Use one handler for named user requests and model activation. Reject unknown ids and escaping paths, pin bounded content once, and return a bounded listing without reading resources or running scripts.
- **S6. Read bundled skill resources on demand.** Resolve bounded resource reads under the selected skill directory. Verify escaping paths and unknown resources are refused and a resource script is never executed by a read.
- **S7. Retain active skill content across message rebuild.** Render the pinned entries when session messages are rebuilt, outside the lossy summary. Test repeated activation, compaction, and no permission changes.

## Rollback

Disable the skill catalog and activation through the profile configuration. Existing interactive, work and review prompts then contain no skill context. Activation state is session-local and receives no new durable migration in this change. On implementation rollback, clear only the in-memory activation projection and preserve ordinary session messages and cartridge settings.
