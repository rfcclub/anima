# Identity Runtime operations

## Authority ownership and binding

Run exactly one `IdentityRuntime` authority beside the durable continuity database. The authority is the only process that opens SQLite, a raw memory adapter, `LeaseStore`, or the privileged promotion writer. Register it under the identity it serves and expose `VersionedIdentityTransport.listen()` on a private-network address, for example `192.0.2.10`, using `/v1/identity`.

Do not bind the authority to a public address. The endpoint is reachable by its clients over a private network; the transport itself is HTTP, so rely on the private-network boundary or add a TLS-terminating proxy before any broader exposure. Tests may use `127.0.0.1` with an ephemeral port only. The API accepts `POST` JSON only and rejects any other path, version, or malformed payload.

## Authentication and credential rotation

`IDENTITY_RUNTIME_BOOTSTRAP_TOKEN` authenticates `join`. Each successful join returns a fresh lease-and-client-bound capability token; follow-up recall, non-locked remember, proposal, promotion-status, and bounded-event calls require it. Promotion uses a separate actor-bound approval credential. Keep all values in local process configuration, never in manifests or logs. Configure the endpoint through `IDENTITY_RUNTIME_ENDPOINT`.

Rotate the bootstrap token by updating the authority and every opted-in client, then restart the authority. Restarting clears in-memory capability tokens, so clients must join again. On suspected disclosure, rotate immediately and restart; do not attempt to reuse an old capability token.

Promotion additionally requires an authority-configured, actor-bound approval credential; the authority derives the approver identity from that credential and ignores request-body actor claims. A normal surface capability cannot promote. Locked scopes never use `remember`: they remain `proposal -> held -> explicit approver -> receipt`.

## Opting a surface in

Set `continuity.identityRuntime: true` for a surface to use the server projection. The ANIMA bridge joins before provider invocation and compares the server projection with the legacy prompt byte-for-byte. A mismatch fails the opted-in turn rather than silently falling back. Disabling `continuity.identityRuntime` returns the surface to the legacy prompt path, which is unchanged.

## Observability and recovery

Inspect only bounded event metadata: projection id, state hash, lease id, source client, outcome, and timestamps. Event records deliberately exclude prompts, recalled memories, proposal content, database paths, and capability tokens. Events returned to a client are restricted to that client's active lease.

Runtime state revisions and idempotency records are persisted in the continuity SQLite database. Mutations are serialized per identity; a client whose state hash is stale must join again. A crash while a mutation is pending fails new joins closed with a recovery-required diagnostic rather than accepting ambiguous state. Inspect and reconcile the pending mutation against the durable store before clearing it; never simply resume writes.

To verify an installation, bind a test identity to a private-network address, join once from a remote client, verify the projection has no database path, submit a locked proposal and confirm it is held, then confirm a direct locked `remember` is rejected. Record only non-sensitive status, lease, and projection identifiers.
