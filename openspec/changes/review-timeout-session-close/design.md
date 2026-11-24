# Design: close interrupted review sessions

After creating a headless review session, install a SIGTERM listener bound to that process and that exact session ID. Close the session synchronously, then exit 143, matching the current externally observable timeout exit code. Remove the listener during ordinary cleanup. Enclose post-session setup in the same cleanup boundary so an exception after session creation still ends the review session. Preserve non-headless loop handling and its existing auto-guard lifecycle.

Synthetic integration tests start real `anima talk --headless-review` subprocesses against a local fake provider and isolated SQLite stores. One test holds two separate provider requests and proves that terminating one closes only that session. Another rejects auto mode after creating a session. The existing success path asserts its review session ends.

## Limitations
SIGKILL, a process crash, a blocked JavaScript event loop, termination before the listener is installed, and session database errors can still prevent cleanup. Closing a session is not proof a review was completed and does not determine why a review timed out. Existing historical sessions are not modified.
