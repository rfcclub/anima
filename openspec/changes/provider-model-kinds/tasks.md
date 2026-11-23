# Implementation plan for Provider model kinds

Follow the slices in order. Each slice needs its own approval. Capture assertion failures before editing production code, then run the same focused test and the project build on the resulting head. Preserve Orca plan and code gate verdicts.

## Slice 1 — Declare provider model kinds

- [ ] RED. In `__tests__/config/types.test.ts`, add the assertions below and run `bun test __tests__/config/types.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/config/types.ts`. Add optional `kind` and the shared literal union. Add compile-time examples for valid values and existing literals without `kind`.
- [ ] Run `bun test __tests__/config/types.test.ts` again, then `bun run typecheck && bun run build`.

- An omitted kind remains source-compatible and unsupported kind literals fail typechecking.

## Slice 2 — Validate kinds at the registry

- [ ] RED. In `test/registry.test.ts`, add the assertions below and run `bun test test/registry.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/providers/registry.ts`. Parse supported kinds, normalize omitted kinds to chat and reject decision definitions with an unsafe parsed origin before key resolution. Keep existing failure isolation between provider files.
- [ ] Run `bun test test/registry.test.ts` again, then `bun run typecheck && bun run build`.

- Supported kinds resolve from fixtures and invalid kinds or unsafe decision origins skip only the invalid provider.

## Slice 3 — Resolve one named TypeSafe decision model

- [ ] RED. In `test/registry.test.ts`, add the assertions below and run `bun test test/registry.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/providers/registry.ts`. Add a typed resolver over the existing `resolve` method that refuses every wrong-kind reference and returns only the validated endpoint, model id and credential.
- [ ] Run `bun test test/registry.test.ts` again, then `bun run typecheck && bun run build`.

- A named decision reference yields a descriptor with the fixed SystemOne path. Chat, image and unresolved references fail with no transport fallback.

## Slice 4 — Keep chat queries on chat models

- [ ] RED. In `test/openai-v1-chat.test.ts`, add the assertions below and run `bun test test/openai-v1-chat.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/providers/openai-v1-chat.ts`. At the provider adapter choose the first chat model for a default query, reject a declared non-chat id, and retain existing uncatalogued chat override behavior.
- [ ] Run `bun test test/openai-v1-chat.test.ts` again, then `bun run typecheck && bun run build`.

- A mixed provider selects its chat model for implicit chat and sends no fetch for a declared decision or image id.

## Slice 5 — Keep streaming proxy queries on chat models

- [ ] RED. In `src/proxy/proxy.test.ts`, add the assertions below and run `bun test src/proxy/proxy.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/proxy/stream.ts`. At the proxy upstream boundary apply the same chat default and explicit wrong-kind behavior before constructing the HTTP body.
- [ ] Run `bun test src/proxy/proxy.test.ts` again, then `bun run typecheck && bun run build`.

- Proxy streaming selects the first chat model and emits no upstream request for a declared non-chat id.

## Slice 6 — Accept a resolved decision descriptor

- [ ] RED. In `packages/identity-*/tests/jev-choice.test.ts`, add the assertions below and run `bun test packages/identity-*/tests/jev-choice.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `packages/identity-*/src/jev-choice.ts`. Add an injectable descriptor to the package decision transport while preserving the current caller default during migration. Reuse query and response validation.
- [ ] Run `bun test packages/identity-*/tests/jev-choice.test.ts` again, then `bun run typecheck && bun run build`.

- A stub observes the injected endpoint, model and credential, with redirects rejected and existing answer validation intact.

## Slice 7 — Inject the identity recall decision descriptor

- [ ] RED. In the direct recall policy test suite under `packages/identity-*/tests/`, add the assertions below and run `bun test packages/identity-*/tests`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `createDirectRecallPolicy` in the identity runtime source under `packages/identity-*/src/`. Give the recall policy a typed dependency for resolved decision configuration. When missing, retain the existing no-decision fallback. Expose the typed option for the tenant composition slice.
- [ ] Run `bun test packages/identity-*/tests` again, then `bun run typecheck && bun run build`.

- Recall decision traffic uses the passed descriptor and missing configuration preserves the existing fallback.

## Slice 8 — Forward decision configuration through tenant composition

- [ ] RED. In `packages/identity-*/tests/default-tenants.test.ts`, add the assertions below and run `bun test packages/identity-*/tests/default-tenants.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `packages/identity-*/src/default-tenants.ts`. Pass the optional decision descriptor from definitions options to the recall policy.
- [ ] Run `bun test packages/identity-*/tests/default-tenants.test.ts` again, then `bun run typecheck && bun run build`.

- Tenant composition forwards the optional descriptor and leaves unrelated tenants unchanged.

## Slice 9 — Define the explicit decision startup selection

- [ ] RED. In a new `packages/identity-*/tests/decision-startup.test.ts`, add the assertions below and run `bun test packages/identity-*/tests/decision-startup.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify a new `packages/identity-*/src/decision-startup.ts`. Add a pure helper that accepts a registry loader, existing registry directory and optional named ref. Refuse a missing or wrong-kind ref and return only the descriptor.
- [ ] Run `bun test packages/identity-*/tests/decision-startup.test.ts` again, then `bun run typecheck && bun run build`.

- Absent configuration never opens the registry and an explicit valid ref returns only a decision descriptor.

## Slice 10 — Resolve the decision model at package startup

- [ ] RED. In a new `packages/identity-*/tests/decision-startup.test.ts`, add the assertions below and run `bun test packages/identity-*/tests/decision-startup.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `packages/identity-*/src/main.ts`. In `main`, invoke that helper with the ANIMA registry loader and pass only the resolved descriptor to tenant composition. Use the repository Bun build/package contract to confirm the executable entry can reach the ANIMA registry; do not change the package library import graph.
- [ ] Run `bun test packages/identity-*/tests/decision-startup.test.ts` again, then `bun run typecheck && bun run build`.

- The standalone runtime uses the configured decision model reference and keeps its no-configuration fallback.

## Slice 11 — Use shared decision transport for relevance

- [ ] RED. In `scripts/claude/relevance-filter.test.ts`, add the assertions below and run `bun test scripts/claude/relevance-filter.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `scripts/claude/relevance-filter.ts`. Change the pure relevance adapter to receive the descriptor and call the package transport. Keep threshold, truncation and all-item fallback. Keep a compatibility overload for `apiKey` that returns the existing keep-all fallback until hook composition switches.
- [ ] Run `bun test scripts/claude/relevance-filter.test.ts` again, then `bun run typecheck && bun run build`.

- The migrated filter has no OpenRouter target and preserves confidence threshold and fallback behavior.

## Slice 12 — Wire the hook to the shared registry

- [ ] RED. In `scripts/claude/identity-client.test.ts`, add the assertions below and run `bun test scripts/claude/identity-client.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `scripts/claude/identity-client.ts`. At hook startup resolve the configured named decision descriptor from the same registry directory. Use the registry-resolved decision credential exclusively, retaining the existing relevance disable and sensitive-content checks.
- [ ] Run `bun test scripts/claude/identity-client.test.ts` again, then `bun run typecheck && bun run build`.

- An explicitly configured decision model reaches the hook filter; missing or disabled configuration makes no decision call.

## Slice 13 — Complete decision transport migration

- [ ] RED. In `packages/identity-*/tests/jev-choice.test.ts`, add the assertions below and run `bun test packages/identity-*/tests/jev-choice.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `packages/identity-*/src/jev-choice.ts`. Make the configured descriptor the sole source of the decision model, endpoint and key. Treat an absent descriptor as no decision.
- [ ] Run `bun test packages/identity-*/tests/jev-choice.test.ts` again, then `bun run typecheck && bun run build`.

- Missing descriptor makes no request and configured calls still reject redirect and invalid responses.

## Approved issue criteria

- **SC-1** — Slices 1 and 2 test each `kind` value and confirm that an omitted kind is chat in existing definitions.
- **SC-2** — Slices 3 and 6–13 trace both consumers to the configured decision descriptor. Inspect `packages/identity-*/src/jev-choice.ts` and `scripts/claude/relevance-filter.ts` for endpoint selection and test that both use the injectable credential, model and endpoint with no consumer-local fallback URL.
- **SC-3** — Slices 10–13 assert the relevance request reaches the TypeSafe SystemOne route, with no OpenRouter fallback. Use injected fetch and synthetic data.
- **SC-4** — Slice 2 rejects a non-TypeSafe decision origin during configuration load and before resolving a key or sending a request.

## Rollback

Disable the named decision model references to return to each caller's conservative no-decision behavior. Keep chat definitions and existing request routes valid. Preserve the hosted decision origin check and the no-redirect transport. A rollback of decision integration must not reactivate an alternate decision provider.
