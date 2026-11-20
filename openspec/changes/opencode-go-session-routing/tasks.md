# Implementation plan for OpenCode Go client metadata

Follow the slices in order. Each slice needs its own approval. Capture assertion failures before editing production code, then run the same focused test and the project build on the resulting head. Preserve Orca plan and code gate verdicts.

## Slice 1 — Identify OpenCode Go adapter requests

- [ ] RED. In `test/openai-v1-chat.test.ts`, add the assertions below and run `bun test test/openai-v1-chat.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/providers/openai-v1-chat.ts`. Export a small pure metadata helper beside the adapter, source the bundled build version, and use that helper to set exactly one safe versioned User-Agent while preserving the routing header. Cover the canonical provider id and the parsed OpenCode Go URL variants.
- [ ] Run `bun test test/openai-v1-chat.test.ts` again, then `bun run typecheck && bun run build`.

- Two requests for one conversation produce the same session header and versioned agent token at a fake server.
- Unrelated providers and hostname lookalikes receive no injected metadata.

## Slice 2 — Identify direct-streaming OpenCode Go requests

- [ ] RED. In `src/proxy/proxy.test.ts`, add the assertions below and run `bun test src/proxy/proxy.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/proxy/stream.ts`. Import the already-exported adapter metadata helper from the streaming path. Use it at the final outbound header construction so both paths share fallback and provider recognition.
- [ ] Run `bun test src/proxy/proxy.test.ts` again, then `bun run typecheck && bun run build`.

- The direct-streaming path emits the same headers for both upstream protocols while preserving unrelated-provider metadata.
