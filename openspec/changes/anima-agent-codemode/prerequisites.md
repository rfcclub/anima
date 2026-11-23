# Agent code mode slice 1 prerequisites

Parent intent: #414. This note records design inputs for the later work-loop slice.

| Input | Required handoff |
| --- | --- |
| #427, guest trust and measurement | Record the approved isolation boundary, fail-closed capability checks, and repeatable direct-tool baseline before designing slice 1. The slice 1 engine must run outside the host process. Resolve any conflict between the #427 decision and that boundary before design. Reuse the fixed workload, scoring, and measurements of rounds, wall time, tokens, and correctness. |
| #428, durable decisions | Reuse the approved lifecycle and authority contract where slice 1 needs any decision. Keep decision identity, expiry, and answer authority outside the guest. Cancellation or an invalid answer must deny the effect. Keep the decision store and new waiting behavior in their own slice. |

The future slice 1 design must keep the tool off by default and route every enabled inner call through the existing supervised work tools with the same restrictions and step recording as a direct call. Owners must resolve the carrier overlap with #273 before scheduling shared work.

Design and implementation of slice 1 remain pending until #427 is approved and complete. No worker order is ready for this slice.
