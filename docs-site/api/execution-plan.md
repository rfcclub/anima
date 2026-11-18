# ExecutionPlan

`ExecutionPlan` is the output of `resolveExecutionPlan()` (`src/cartridge/activation.ts`): the cartridges and retrieval plan for one turn. See [Activation](../cartridge/activation.md#execution-plan) for how it's built and when it's used.

## Interface

```typescript
// src/cartridge/types.ts
interface ExecutionPlan {
  identity: string;                    // agent name
  interactionPersona?: CartridgeBlock; // persona layer winner
  workingRole?: CartridgeBlock;        // role layer winner
  defaultRole?: string;                // from the cartridges config
  dependencies: CartridgeBlock[];      // the role's `requires`, expanded
  language?: CartridgeBlock;
  framework?: CartridgeBlock;
  project?: CartridgeBlock;
  task?: CartridgeBlock;
  universal: CartridgeBlock[];         // cartridges named in `universal`
  substrateRetrievalPlan?: SubstrateRetrievalPlan;
  budget: { estimated: number; limit: number };
  events: Array<Record<string, unknown> & { type: string }>;
}

interface CartridgeBlock {
  name: string;
  scope: string;
  category: CartridgeCategory;
  content: string;                     // expanded text (skills + persona + body)
}
```

## Example

With the repo cartridges, `universal: [engineering-common-lite]`, and the message "refactor the parser in TypeScript":

```typescript
const plan: ExecutionPlan = {
  identity: "bruno",
  interactionPersona: { name: "creative", scope: "shared", category: "create", content: "..." },
  workingRole: { name: "programming", scope: "shared", category: "craft", content: "..." },
  defaultRole: undefined,
  dependencies: [],
  language: { name: "typescript", scope: "pluggable", category: "craft", content: "..." },
  universal: [
    { name: "engineering-common-lite", scope: "shared", category: "craft", content: "..." },
  ],
  substrateRetrievalPlan: { requests: [/* one per active cartridge with retrieval.scopes */], globalBudget: 5000 },
  budget: { estimated: 3100, limit: 5000 },
  events: [/* cartridge_* events */],
};
```

The token numbers are illustrative.

## How it's used

1. `AgentSession.prepareTurn()` calls `resolveExecutionPlan()` and writes `plan.events` to the event log.
2. If there's a `substrateRetrievalPlan`, the session runs it (see [Substrate Retrieval](../substrate/retrieval.md)).
3. The memory write scopes for the turn are the intersection of the persona's, role's and task's `memory.write_scopes`. Without any of these, the defaults apply.
4. `buildSystemPromptFromPlan()` (`src/agents/prompter.ts`) builds the prompt. The universal, dependency, persona, role, language, framework, project and task blocks all go into the **static** prefix. The date and memory sections go into the dynamic suffix. See [Context Engine](../sessions/context-engine.md).
