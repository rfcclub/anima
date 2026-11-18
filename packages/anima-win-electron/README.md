# ANIMA Windows Client (Electron)

API-first native desktop client for ANIMA. **Electron + Vite + React + TypeScript
+ Tailwind**, dark theme, zero iframes — every view is native React fetching the
ANIMA REST API directly.

## Views

- **Overview** — `GET {api}/health`: uptime, agent count, version, colony roster.
- **Entities** — `GET {api}/api/colony`: agent cards (substrate, platform, trust
  bar); clicking a card fetches `GET {api}/api/agent/:id` into a detail panel.
- **Settings** — Backend API URL form (default `http://localhost:3000`), saved to
  localStorage. Invalid URLs (no http/https scheme) are rejected inline. Saving
  re-targets the health poll and all views **immediately**.

## Connectivity

- Health poll: `GET {api}/health` every **10 s** → status pill (green ●
  Connected / red ● Disconnected).
- All HTTP goes through an **Electron IPC fetch proxy** (main process performs
  the request), so browser CORS can never block a backend. Falls back to plain
  `fetch` outside Electron.

## Develop

```sh
bun install
bun run dev        # electron-vite dev (opens the Electron window)
bun test           # unit tests: settings, api client, poller, formatting
```

## Build Windows .exe (from macOS)

```sh
bun run build:win
# → release/ANIMA Setup 0.1.0.exe  (NSIS one-click installer, x64)
```

`electron-builder` can cross-compile the NSIS installer directly on macOS.
On Apple Silicon it uses the system NSIS (`brew install makensis`) because the
bundled `makensis` binary is x86-only — hence `USE_SYSTEM_MAKENSIS=true` in the
script.
`bun run build:mac` produces the macOS bundle if needed.

## Point it at the real server

Default backend is `http://localhost:3000`. The ANIMA API listens on port
`3700` by default — set the backend URL in Settings to point at whichever
host runs the server.
