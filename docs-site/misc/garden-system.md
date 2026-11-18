# Garden System

"Garden" is the name for the shared knowledge that agents can draw on: cartridges, skills and substrate that live outside any one agent's room. Most of it lives in `~/agora/` (see [Agora](../colony/agora.md)).

::: tip Not the Garden Hub
The planned Garden Hub control plane and tick engine are a different thing. See [Castle System](./castle-system.md#planned-autonomous-work-loop).
:::

## Layout

```
~/agora/
├── cartridges/
│   ├── shared/           # colony-wide cartridges (scope: shared)
│   ├── pluggable/        # colony-wide pluggable cartridges
│   └── dynamic/          # legacy, loaded as pluggable
├── skills/               # skills referenced by guides/rules
│   └── <name>.md
└── familia/
    └── <agent>/
        └── substrate.map.yaml
```

Only these folders are read by `CartridgeRegistry` and `AgentLoader`. Other folders under `~/agora/` are ignored by them.

## Cartridge tiers

Cartridges are loaded from four tiers. When two have the same `name` and `category`, the higher tier wins:

| Priority | Tier | Path |
|----------|------|------|
| Highest | Agent | `<project root>/rooms/<agent>/cartridges/` |
| | Project | `<project root>/cartridges/{shared,pluggable,dynamic}/` |
| | Global | `~/.anima/cartridges/{shared,pluggable,dynamic}/` |
| Lowest | Colony | `~/agora/cartridges/{shared,pluggable,dynamic}/` |

Skills (`skills/<name>.md`) are searched in the project, global and colony roots, in that order. Agent rooms don't have their own skills folder.

## Shared, pluggable and agent cartridges

- **Shared** (`cartridges/shared/` in any tier): in legacy activation, always loaded for every agent.
- **Pluggable** (`cartridges/pluggable/` or `dynamic/`): in legacy activation, at most one per turn, chosen by category.
- **Agent** (`rooms/<agent>/cartridges/`): always loaded for that agent only.

With the execution plan, all of them are candidates for the layers. See [Activation](../cartridge/activation.md).

## Seeding the colony tier

```bash
bash scripts/seed-agora-cartridges.sh
```

This copies `seeds/agora-cartridges/shared/creative.md`, `seeds/agora-cartridges/shared/marketing.md` and `cartridges/shared/programming.md` into `~/agora/cartridges/shared/` (set `AGORA_ROOT` to use another folder). It also creates an empty `~/agora/cartridges/skills/`. Note that the registry reads skills from `~/agora/skills/`, not from that folder.

## The metaphor

- **Cartridges** are plants: they grow, change and can be shared.
- **Skills** are seeds: reusable and composable.
- **Substrate** is soil: the persistent knowledge base.
- **Identity** is roots: deep, stable and foundational.
