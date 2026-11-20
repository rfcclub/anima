# Bounded work-tool argument repairs

Source issue #277. Design and plan for review.

## Architecture

Classify at the work tool argument boundary before execution in `src/work/tools.ts`. Add a typed, internal discriminator that records a rejected shape, a unique declared replacement and a schema digest. Only case-only key or enum differences are automatically learnable initially. A miss must have exactly one compatible schema candidate and must not collide with an already supplied key. Keep semantic failures, invalid JSON, permission refusals, or tool output outside this classifier. Never learn a correction for bash commands, arbitrary free text or writes outside the tree. Add path support only for lossless lexical normalization of fields already declared work-relative, where existing sandbox admission still independently accepts the canonical path. Do not infer paths from prior sessions or translate an absolute path to a relative one.

Use the existing WorkStore as the owner of bounded local records. Key by local tenant/agent + catalog digest + tool + argument slot + HMAC fingerprint of the miss, with a host-owned local key. Store the declared replacement, classifier reason, timestamps and first observation id. Discard stale-schema lookups, cap rows per scope and keep the table inspectable without revealing raw arguments. An operator can remove an entry or turn off a profile. The original shape failure always returns once. A subsequent miss, freshly classified to that same unique candidate, may retry exactly once through the regular tool entry point and all sandbox gates. Record replay deduplication by tool step id. Attempted and successful repairs are distinguishable work events. Report recurrence per schema digest under both enabled and disabled profiles, without raw arguments or high-cardinality paths.

## Test strategy

Use an in-memory work store and fake supervised children for key and enum classification, repeat learning, simultaneous attempts, catalog digest rotation, logging once and cap/eviction. Run narrow local sandbox tests proving that out-of-root and symlink-denied operands still fail. Measure repeats on a fixed sanitized call fixture.

## Non-goals

Prompt changes, capability pruning, repair of semantic or policy failures, model-controlled persistence and sharing observations between tenants are outside this work.
