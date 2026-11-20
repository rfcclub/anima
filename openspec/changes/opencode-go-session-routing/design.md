# OpenCode Go client metadata

Source issue #291. Design and plan for review.

## Architecture

Extend `opencode-go-session-routing`: the original routing behavior already forwards an established conversation ID and uses `anima:<agent>` only for requests without one. Keep that contract on both HTTP paths. Add `anima/<version> (<agent>)` to the existing upstream request boundary. Source the version from the bundled package manifest, which is available from source and builds, using a validated version token. Use the request's existing agent identifier as a bounded, ASCII header token with a generic fallback for malformed values. Do not add prompt, conversation, credential or machine information to User-Agent. Canonicalize case-insensitive metadata via `Headers.set` on the targeted upstream so custom differently-cased values cannot append conflicting duplicates.

Use the configured provider id for `opencode-go-oai` and a parsed URL whose host and path match the existing OpenCode Go protocol variants. Do not rely on a raw substring for host detection. Keep recognition and header construction in one small provider helper after both paths are covered. Preserve the currently supported OpenAI and Anthropic upstream formats, native auth headers and generic-provider custom headers. No session data migration.

## Test strategy

A synthetic local HTTP server receives two messages with the same conversation ID and another with a different one. Capture wire User-Agent and session values for adapter and streaming paths. Verify malformed agent metadata does not break sending, and unrelated upstreams do not get either injected header.

## Non-goals

Changing provider routing, rotating conversation IDs, selecting models, and deploying to a live host are outside this work.
