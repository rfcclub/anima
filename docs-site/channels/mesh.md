# Mesh Channel

The colony mesh is a message bus that agents use to talk to each other, including agents in other runtimes. ANIMA talks to the mesh through the `colony-mesh` package. That package isn't in this repo. It's linked from `../colony-mesh` (see [Getting Started](../guide/getting-started.md#prerequisites)).

## How ANIMA agents receive mesh messages

Each agent in `data/colony.json` receives mesh requests through its A2A inbox (`src/mesh-a2a/`). Each delivery is classified by its `role` and `pattern` (`classifyMeshDelivery()` in `src/continuity/mesh-ingress.ts`):

1. Terminal roles (`result`, `response`, `reply`, `finding`, `synthesis`) are acknowledged and treated as informational.
2. `knock` wakes the agent's reflection loop.
3. A `request`, or a `direct` message from another sender addressed to an ANIMA agent, is stored durably as an attention item and wakes the agent.
4. A delivery is acknowledged only after it was stored; if storing fails, it is left for retry.

With `ANIMA_ACTIVATION_MODE` set to `gate` or `enforce`, mesh messages go through the activation broker first, sharing one queue and budget with reflection.

## How agents send

Agents use the built-in mesh tools (allow them in `policy.allowedTools`):

| Tool | Does |
|------|------|
| `mesh_send` | Send a message (`to_id`, `content`, `subject`, ...) |
| `mesh_peek` | Look at pending messages without claiming them |
| `mesh_pull` | Claim pending messages |
| `mesh_ack` | Acknowledge a claimed message |
| `mesh_status` | Bus status |
| `mesh_thread` | Read a thread |
| `mesh_subscribe`, `mesh_unsubscribe` | Topic subscriptions |
| `mesh_register_recipient`, `mesh_unregister_recipient` | Recipient registry |
| `agent` | Shorthand: sends `{ to, subject, body }` as a `mesh_send` |

From the shell, use `anima send-mail` and `anima check-mail` (see the [CLI Reference](../cli/reference.md#send-mail)). Another process can also post to `POST /api/mesh/notify`, which adds the message to the agent's `mesh` session.

## Instance ids

Messages are addressed by mesh ID. `anima send-mail --to` takes the mesh ID of the recipient as is.

## More

- [Colony Mesh](../colony/mesh-bus.md): patterns, claim and ack, threads
- [Cross-Runtime](../colony/cross-runtime.md): reaching agents in other runtimes
