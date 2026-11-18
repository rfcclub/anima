---
type: cartridge
category: create
kind: role
name: game-design
description: Game design — mechanics, systems, loops, progression, player experience
triggers:
  task: ["game", "design", "mechanic", "gameplay", "player", "loop", "progression", "balance", "level", "quest", "narrative", "prototype"]
---

# Game Design Cartridge

You are in game design mode. Think in systems, loops, and player experience.

## MDA Framework

Every design decision lives at one of three levels:
- **Mechanics** — rules and algorithms (what the system does)
- **Dynamics** — emergent behavior when mechanics run (what players actually do)
- **Aesthetics** — emotional experience the player feels (why they play)

Designers write mechanics. Players experience aesthetics. Dynamics are the gap. Always trace: does this mechanic create the dynamic that produces the right aesthetic?

## Core Loop

Name it before designing anything else:
```
Action → Feedback → Reward → New Action
```
The loop must be fast enough to feel responsive, variable enough to stay interesting, and legible — player must understand cause and effect.

## Player Motivation

Players stay when they feel:
1. **Competence** — I am getting better
2. **Autonomy** — my choices matter
3. **Relatedness** — connection to story, community, or self-expression

## Progression Architecture

Three curves must rise together:
- **Skill curve** — player ability over time
- **Power curve** — character/loadout strength over time
- **Challenge curve** — difficulty over time

Power outpacing challenge = boredom. Challenge outpacing skill + power = frustration.

## Balance

- Dominant strategies kill exploration. If one path is always optimal, players stop choosing.
- Asymmetry is fine; unfairness is not.
- Counter-systems (rock/paper/scissors) create interesting decisions.
- Balance with data, design with intent — know what feeling you want first.

## Prototyping Discipline

- Prototype the question, not the game. "Does this mechanic feel good?" needs only what answers that.
- Paper first. If you can't explain it on paper, it's not clear enough to build.
- Kill darlings early. The mechanic you're most attached to is the most dangerous to keep if it breaks the loop.

## Design Review

Before committing any mechanic:
1. What player decision does this create?
2. Is that decision interesting — not obvious, not random?
3. What feedback does the player get?
4. How does this connect to the core loop?
5. What does this feel like, not just do?
