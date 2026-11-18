# ANIMA web chatbot bridge (experimental)

`anima_web_chat` lets an explicitly enabled ANIMA agent request one turn from a configured Claude, ChatGPT, Grok or Gemini **web account**. ANIMA orchestrates subsequent turns.

All four production adapters ship **UNVERIFIED**. Chromium fixtures prove the lifecycle engine, not today's service DOM, login, account acceptance or consumer-service permission. Candidate selectors can fail on current sites; update and review their explicit per-turn lifecycle contract, bump `ADAPTER_VERSION`, and validate again. Do not enable an adapter by simply editing `validatedVersion`.

## Prerequisites and maintenance

Initial supported host: macOS with functioning `/usr/bin/sandbox-exec`, Bun, Node, pinned Playwright **1.61.1**, and its matching Chromium installation (`bunx playwright install chromium` after installing dependencies). Linux/unsupported sandbox hosts fail activation. No sandbox-disable or stealth flags are used. Dedicated automation accounts are advisable; service terms and account restrictions remain operator responsibilities.

Runtime account windows are visible by default and require a logged-in GUI session. Playwright is a pinned production dependency, including installations where the bridge stays off. Validation challenge text is visible in the CLI arguments; use a non-secret challenge.

Use the source operator CLI below, or `bun ~/.anima/dist/web-chat-cli.js` with the same arguments after an authorized deployment. Maintenance requires the online bridge to be stopped. A live ownership lock refuses concurrent profile use; do not delete a live lock or open the profiles through another browser.

```sh
bun src/web-chat/cli.ts init
bun src/web-chat/cli.ts status
bun src/web-chat/cli.ts login chatgpt
# Deliberate LIVE action, only when the operator elects to submit a challenge:
bun src/web-chat/cli.ts validate chatgpt --prompt 'Reply exactly: unique-challenge-REPLACE-ME' --plan-tier 'operator-declared tier'
```

Repeat manual login and explicit validation separately for `claude`, `grok` and `gemini`. Complete login/2FA/CAPTCHA yourself; there is no automated bypass. The validation command accepts an explicit challenge, requires a matching new user turn and an explicitly completed new answer, and records a redacted receipt before enabling that version. A failed/uncertain attempt never resends. `planTier` is declared metadata; tokens and cost are unknown (`null`).

The CLI opens the service website in a dedicated Chromium window on the **bridge host**, not on the device running Telegram. Login uses the website's own sign-in flow; the bridge has no OAuth client, token exchange or API-key login. Website sign-in may involve an identity provider in the operator-controlled login window. Cookies and local storage remain in that account's private persistent profile, so a bridge restart can reuse the session; logging in through an unrelated phone/desktop browser does not populate this profile. The operator CLI login window permits manual website navigation; the agent-run conversation path has separate restricted navigation and closes popups.

### Chat and Connect console

After initialization, start the standalone console explicitly:

```sh
bun src/web-chat/cli.ts console
# Built installation, after an authorized deployment:
# bun ~/.anima/dist/web-chat-cli.js console
```

Open the printed `http://127.0.0.1:3080` address on the host. `--port 0` chooses a free port; `--root` selects the same private root as initialization. Unlock with the contents of `operator-token` in that root, a separate 0600 bootstrap secret generated on first console startup. The token is never printed, placed in a URL, or saved in browser storage. Keep it private. The console uses an HttpOnly SameSite cookie, a one-hour session and CSRF protection. Lock console logs out and closes that session's login windows; server shutdown invalidates every session.

**Connect** lists configured accounts and their real verification status. Choose **Open login**, finish the website's sign-in in the headed browser window on the host, then choose **Finish login** to close that window and release its account. A ten-minute limit closes an abandoned login. Login alone never enables chat. **Validate account** deliberately sends one public challenge with a unique nonce and your declared plan tier; proven completion writes a private receipt bound to the service and adapter version. Website login credentials never pass through console forms or HTTP endpoints.

**Chat** sends only to a verified account. It polls request state, offers cancellation and read-only late-answer checking, and shows website output as plain text. A lost send response is recovered by reading existing history, never automatic replay. Reload restores the last 20 requests per conversation, plus every running or uncertain request. All authenticated sessions represent the same operator for this private root: unlocking again after expiry, logout or console restart restores retained conversations and recovery controls. Prompt text is held only in page memory and disappears on reload, while functional answers follow the existing retention policy. There is no automatic resend after expiry or logout.

If an explicit validation ends in `unknown_submission`, the error includes its durable request ID. Keep that ID, stop the console, inspect the website on the host, and follow the offline `mark-sent` / `mark-not-sent` attestation commands below using the same `--root`. Validation uncertainty keeps the account fenced; it does not enable the adapter or authorize another send. The validation conversation is closed and cannot be reconciled through Chat.

The console binds loopback by default. To access it through your Tailscale network, explicitly bind all IPv4 interfaces and pin the exact browser origin:

```sh
bun src/web-chat/cli.ts console --host 0.0.0.0 --port 3080 --origin http://192.0.2.10:3080
```

Replace the address with the console host's Tailscale IP or DNS name. A fixed port and exact HTTP origin are required in this mode; wildcard origins, paths and alternate Host/Origin values are refused. Open that exact address from a device connected to the tailnet and unlock with the same private console token. `0.0.0.0` listens on every IPv4 interface, including LAN; Tailscale does not restrict the listener to its own interface. Console authentication and CSRF checks still apply. HTTP through the Tailscale address uses Tailscale's encrypted transport.

An operator-managed SSH/local port forward remains an alternative with the browser address still loopback. Browser login windows appear on the host desktop in either mode. Remote screenshot/keyboard controls and automatic discussion rounds between chatbots are not implemented. Do not publish browser debugging ports or copy profile cookies.

The standalone console owns the root lock, service and browser child. Stop the agent bridge before starting it; stop the console before activating the bridge on that root. A second owner is explicitly refused. This keeps operator HTTP authentication out of the agent worker and leaves the worker without a listening socket. Within the console, account maintenance refuses queued, running or uncertain work before opening login, and fences new chat/reconciliation until cleanup finishes. Console launch alone does not activate an ANIMA tool or validate an account.

Validation is bound to both the adapter version and the service name (`validatedService`). Legacy version-only config entries are intentionally unavailable: run explicit validation again to establish the service binding. A service rename cannot reuse the prior validation.

Default private root is `~/.anima/web-chat`; `--root` or `ANIMA_WEB_CHAT_ROOT` selects another operator-owned directory. `init` creates four disabled account aliases in `config.json` and refuses overwrite. Example config structure (availability is written only by successful validation):

```json
{
  "accounts": [{ "id": "chatgpt", "service": "chatgpt", "deadlineMs": 300000 }],
  "privateSources": ["/absolute/operator/private-source.txt"],
  "limits": {
    "global": 2,
    "queue": 8,
    "promptChars": 16000,
    "answerChars": 32000,
    "deadlineMs": 300000
  }
}
```

Keep config/files mode 0600, root/profiles 0700, owned by the server user, without symlinks/hardlinks. Private source files are loaded by the trusted bridge for conservative egress refusal, and inaccessible to agent tools. Do not list an entire application/rooms tree as a private source: each source must be a readable file, at most 1 MB. Trusted ANIMA boot text is also registered separately. Store API credentials under the protected ANIMA secrets directory, and register any additional credential/private locations before enabling the bridge.

## Opt-in activation and agent permission

**Use a dedicated ANIMA server for this experimental bridge. Enabling it changes shell/file permissions for every agent on that server, including agents without `anima_web_chat`. Native SDK, MCP and non-`sharedSafe` carriers are refused. Do not enable it on a production server hosting those agents.** Local git init/add/commit/show is covered by the same sandbox tests; networked shell commands and general Mach access remain unavailable.

Set `ANIMA_WEB_CHAT=on` and optionally `ANIMA_WEB_CHAT_ROOT` on the ANIMA **server**. `ANIMA_HOME` selects the default root for host startup. Initialization/validation should use an explicit matching `--root` if that home differs. Startup awaits the private worker before starting gateways. Default is off; initialization alone does not activate a tool or change agent policies.

Add `anima_web_chat` to the chosen agent's `policy.allowedTools`. Permission is mandatory even with general enforcement `off` or `warn`. Agent/session identity comes from AgentSession, never tool arguments. Supported operations:

| Operation              | Arguments                                              |
| ---------------------- | ------------------------------------------------------ |
| `list`                 | none                                                   |
| `create`               | `account`                                              |
| `resume` / `close`     | `conversationId`                                       |
| `send`                 | `conversationId`, stable `retryKey`, explicit `prompt` |
| `result`               | `requestId`, optional `after` cursor from that request |
| `cancel` / `reconcile` | `requestId`                                            |

`send` returns a request immediately; poll `result` with a bounded agent workflow. Reuse the **same key and same prompt** after transport uncertainty; changing the prompt under the key fails. No automatic history, files, SOUL, next round, fallback account or fallback model is sent. Results are structured **untrusted website text**, not instructions with extra authority.

While active, the host imposes a global tool boundary: private reads are hard-denied, application code is read-only to agent tools, and shell descendants inherit default-deny Seatbelt restrictions with **no network access** and only the specific Darwin temporary-directory helper Mach lookup required by local git. Shell environments omit credentials. Standard SSH, GitHub CLI, AWS, GnuPG, netrc and macOS Keychain locations are also protected. Native SDK tool carriers and MCP-enabled AgentSessions fail closed; supported API providers must explicitly declare `sharedSafe`. Operator-owned processes outside ANIMA remain trusted and outside this model. File-tool path checks resolve aliases before dispatch; an operator-controlled concurrent filesystem mutation is outside their atomicity guarantee.

## Uncertainty, recovery and retention

Default scheduling is two active accounts globally, one active request per account and eight queued; deadline includes queue time. Maximum configured bounds: global 4, queue 64, prompt 64k characters, answer 128k characters, deadline 10 minutes. Metadata capacity is 256 conversations and 10,000 requests; backpressure refuses more rather than dropping uncertain records. Events are capped at 128 per request; foreign/pruned cursors fail explicitly.

Private-source registration is cumulative for one bridge lifetime, shared across owners, and has no eviction. Unchanged boot chunks are deduplicated; changed boot/journal content consumes new capacity. The service holds at most 80,000 excerpt entries: a typical 8KB chunk consumes roughly 250–500 entries (content and line structure can increase that), so this limit can be reached after roughly 0.6–2.5 MB of new unique boot windows. A separate client limit is 40,000 distinct chunks; the service limit normally arrives first. The server logs one content-free `web_chat_private_registry_capacity` warning above 50% of the service ceiling. At capacity, registration fails closed with counts and recovery instructions; the opted-in agent's turn cannot start. Previously registered excerpts remain protected.

For recovery, stop the dedicated ANIMA server, inspect/reconcile any uncertain submissions using the existing offline maintenance workflow, reduce registered boot/private sources if necessary, then restart the server and its bridge. Restart clears the in-memory registration budget; current configured sources and each agent's current boot content must register again. Sources that still exceed the budget will fail again. Never bypass a failed registration, delete private entries, or restart automatically to retry a possibly submitted prompt.
Cancellation closes the local page and settles its actions before freeing its slot. It cannot prove the website stopped generation. A possibly submitted turn becomes `unknown_submission`, blocks further sends on its conversation, and is never replayed on restart. Queued work fails on restart. The worker stops after host exit; Node owns Playwright in a private stdio child, with no public browser control socket.

Try owner-scoped `reconcile`: it reads the existing thread, compares the persisted baseline/counts and prompt digest, and either attaches a late completed answer to the **same request**, reports `still_generating`, or stays uncertain. Missing or multiple turns cannot be guessed. Explicit `close` permanently abandons that conversation.

If automatic reconciliation cannot prove state, stop the bridge and inspect the dedicated profile manually before an offline attestation:

```sh
bun src/web-chat/cli.ts mark-sent REQUEST_ID
bun src/web-chat/cli.ts mark-not-sent REQUEST_ID
```

`mark-sent` leaves the conversation blocked. `mark-not-sent` records the operator's attestation and permits a **new explicit key**; neither command clicks Send. Agent tools cannot invoke these administrative operations.

The private SQLite database stores prompt digests/lengths, identity, destination, state/timing, bounded events and the functional answer. Answer bodies expire after 24 hours; idle conversations and their retry/event metadata expire after seven days. Expiration is enforced at startup/access, rather than a precise background deletion clock. Uncertain conversations are retained, subject to capacity limits, until resolved. Raw prompt diagnostics and answer diagnostics are not written. Browser profile storage is the website's own state; deleting an ANIMA answer does not erase website history, profile data, backups or forensic media copies.

Secret refusal covers recognizable credentials/private keys, exact registered private excerpts, and recognizable base64/split forms. It cannot prove universal DLP against paraphrasing, arbitrary encodings, transformed secrets or prompt injection. Keep access narrow and review explicit prompts for sensitive work. The HMAC capability exists only in host/bridge memory and an inherited pipe; no key file, tool result, environment variable or argv entry contains it.

## Verification boundary

`bun test __tests__/web-chat` runs local fixtures only, including real Unix IPC, macOS shell isolation, Chromium, process loss and both real AgentSession query/stream tool paths. `bun run build` builds the server/CLI, Bun bridge worker, Node browser worker and offline operator CLI. Source and compiled smoke checks do not start a live ANIMA server or contact a chatbot.

Fixtures are not evidence of a current production DOM or successful external chatbot exchange; validate each service separately before relying on it.
