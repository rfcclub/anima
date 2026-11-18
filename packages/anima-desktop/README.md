# ANIMA Desktop

Native desktop client for the ANIMA system — a Tauri v2 shell (Rust backend,
React/TypeScript frontend) that hosts the three ANIMA web UIs (**Agent Town**,
**OpenClaw**, **Chat**) behind a Hermes-style left-rail interface, with a
command palette, system tray, and two selectable transports: **API** (direct
HTTPS) and **SSH** (tunneled port forwards).

It reimplements no agent logic; everything runs on the ANIMA server.

## Layout

- **Left rail** — Town / OpenClaw / Chat navigation, Settings pinned at the
  bottom, collapsible.
- **Top strip** — current view title + connection status pill
  (● Connected / ● Reconnecting / ● Disconnected) + manual refresh.
- **Command palette** — `Cmd/Ctrl+K`: jump between views, switch profiles,
  refresh, toggle theme.
- **Shortcuts** — `Cmd/Ctrl+1/2/3` switch views; last view is restored on
  launch; window size/position persist across restarts.
- Closing the window hides to the system tray; use tray → **Quit** to exit.

## Connection profiles

Settings (gear icon) manages named **profiles**; one is active at a time.
Profiles are stored (without secrets) in the app-data dir:
`~/Library/Application Support/com.anima.desktop/settings.json` on macOS,
`%APPDATA%/com.anima.desktop/settings.json` on Windows.

### API transport (default)

Direct HTTP(S) to the ANIMA server.

| Field | Default |
|---|---|
| `baseUrl` | `https://host.example.ts.net` |
| `chatUrl` | *(optional)* `{baseUrl}/chat/` |

Views load `{baseUrl}/town/`, `{baseUrl}/openclaw/`, and the chat URL.
Health: `GET {baseUrl}/anima/health` every 30 s; on failure the app retries
every 5 s, shows a "Reconnecting…" overlay, and reloads views on recovery.

### SSH transport

Connects to a remote host with the pure-Rust `russh` client (no system `ssh`
required) and opens local port forwards to the ANIMA service ports, so the app
works without a public HTTPS endpoint.

| Field | Default |
|---|---|
| `host`, `user` | — (required) |
| `port` | `22` |
| `keyPath` | `~/.ssh/id_ed25519` |
| `agent` | `false` (set true to use ssh-agent) |
| remote ports | town `3000`, openclaw `18789`, api `3700`, chat `3700` |

On activation the Rust backend forwards each unique remote port to an
ephemeral `127.0.0.1` port and the views load through the tunnel. A watchdog
probes the forwarded API port every 5 s; on drop it tears down the forwards
and reconnects with backoff (5 s flat, then doubling, capped at 30 s),
emitting `connection-status` events that drive the status pill.

**Secrets:** key material is read from disk only at connect time and never
logged or persisted. If the key is encrypted, the app prompts for the
passphrase and keeps it only in memory (needed for auto-reconnect).

**Host keys:** server keys are currently accepted without pinning — hosts are
user-configured (typically Tailscale peers). Add known-hosts pinning before
using over untrusted networks.

### Adding an SSH profile

Settings → **+ New profile** → transport **SSH** → fill host/user (key path or
ssh-agent) → **Save profile** → click its radio button to activate.

## Development

```sh
bun install
bun run tauri:dev     # full app (vite + tauri)
bun run dev           # frontend only, http://localhost:1420
```

## Tests

```sh
bun test                      # frontend: settings, endpoints, health, fuzzy
cd src-tauri && cargo test    # backend: forward planning, endpoints, backoff,
                              # proxy data path (mocked remote), probe
```

The SSH forward/copy loop is exercised in `cargo test` against a mocked
remote TCP service; live-tunnel behavior additionally depends on a reachable
SSH host.

## Building

```sh
bun run build:mac     # macOS .dmg  → src-tauri/target/release/bundle/dmg/
bun run build:win     # Windows .msi (requires the msvc target)
bun run build:linux   # Linux .AppImage/.deb (on a Linux host)
```

Windows cross-target setup (build itself is best done on Windows or CI, since
`.msi` bundling needs WiX):

```sh
rustup target add x86_64-pc-windows-msvc
bun run build:win     # → src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/
```

## Implementation notes / defaults chosen

- Profile renames are not supported (delete + recreate) to keep active-profile
  bookkeeping trivial.
- Services sharing a remote port (chat = api by default) share one forward.
- In a plain browser (vite dev without Tauri) settings fall back to
  localStorage and the SSH transport is unavailable.
