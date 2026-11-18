# Garden — Scaffolding (not yet wired)

The modules in this directory (`tick-engine`, `GardenHub`, `autonomy-ladder`, `event-store`, `projection`, etc.) are design scaffolding for a future game-loop/narrative layer. They are exercised by their own unit tests but are **not imported by any production code outside `src/garden`** as of the current codebase.

Do not treat these as live runtime dependencies. Re-wire them deliberately when the Castle narrative/game-loop integration is ready.
