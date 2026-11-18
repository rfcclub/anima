# ANIMA — Build & Deploy Guide

*Intensive reference for building from source, configuring, and deploying to production.*

---

## Quick Start (TL;DR)

```bash
# 1. Prerequisites: Bun >= 1.3.11
curl -fsSL https://bun.sh/install | bash

# 2. Clone & install
git clone <repo-url> anima && cd anima
bun install

# 3. Set API keys
export ANTHROPIC_API_KEY="sk-ant-..."
export GEMINI_API_KEY="AIza..."

# 4. Seed rooms
bun run scripts/seed-room.ts

# 5. Run
bun start

# 6. Test
bun cli talk bruno "hello"
```

Server now running on port 3700.

---

## Prerequisites

| Dependency | Minimum | Purpose |
|-----------|---------|---------|
| [Bun](https://bun.sh) | 1.3.11 | Runtime, bundler, test runner |
| Claude API key | — | Primary provider (Anthropic) |
| Gemini API key | — | Secondary provider (Google) |
| Cloudflare Tunnel | latest | Telegram webhook (optional) |

### Install Bun

```bash
# Via script
curl -fsSL https://bun.sh/install | bash

# Or via npm
npm install -g bun

# Verify
bun --version   # >= 1.3.11
```

### Install Cloudflare Tunnel

```bash
# macOS
brew install cloudflared

# Linux (Debian/Ubuntu)
curl -L https://pkg.cloudflare.com/cloudflare-main.gpg | sudo apt-key add -
echo "deb https://pkg.cloudflare.com/ buster main" | sudo tee /etc/apt/sources.list.d/cloudflare.list
sudo apt update && sudo apt install cloudflared

# Windows (scoop)
scoop install cloudflared
```

---

## Build From Source

### 1. Clone Repository

```bash
git clone <repo-url> anima
cd anima
```

### 2. Install Dependencies

```bash
bun install
```

Dependencies (from `package.json`):
- `js-yaml` — YAML config parsing (`.yaml` agent configs)
- `@anthropic-ai/sdk` — Claude provider
- `@google/generative-ai` — Gemini provider
- Bun built-ins used for: SQLite (`bun:sqlite`), HTTP server (`Bun.serve`), file I/O (`Bun.file`)

### 3. TypeScript Compilation (Optional)

ANIMA uses `bun run` which does JIT transpilation. For type checking only:

```bash
bun run tsc --noEmit
```

No build step required — Bun runs `.ts` files directly.

### 4. Verify Build

```bash
# Run test suite
bun test

# Expected: 0 failures

# Verify CLI
bun run src/cli.ts status
```

---

## Configuration

### Required: Provider API Keys

ANIMA needs at least one provider configured. Set via environment variables or `.env` file (Bun loads `.env` automatically).

```bash
# .env (in project root)
ANTHROPIC_API_KEY="sk-ant-api03-..."
GEMINI_API_KEY="AIza..."
```

Provider configuration per agent: `rooms/{agent}/config.yaml`

```yaml
provider:
  type: claude          # claude | gemini | openai_compat
  model: claude-sonnet-4-6
  fallback:
    type: gemini
    model: gemini-2.5-pro

session:
  defaultMode: auto
  autoModeOptIn: true
```

See `docs/PROVIDER_SETUP.md` for detailed provider configuration.

### Required: Seed Agent Rooms

```bash
bun run scripts/seed-room.ts
```

Creates a room for each colony member listed in `data/colony.json` under `rooms/`, plus:
- `_meeting/` — meeting room

Each room contains:
- `SOUL.md` — agent identity (symlinked or copied from substrate)
- `config.yaml` — provider, session, cartridge config
- `trust.json` — Phase 7 trust scores (6 domains, auto-initialized)
- `allowlist.json` — Phase 7 boundary rules (auto-seeded)

### Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3700` | HTTP server port |
| `HOST` | `0.0.0.0` | Bind address |
| `ANIMA_ROOMS_DIR` | `./rooms` | Path to rooms directory |
| `ANIMA_UI_ENABLED` | `false` | Enable Agent Town Web UI |
| `ANIMA_UI_PORT` | `3000` | Web UI port |
| `ANIMA_UI_STATE_DIR` | `./.anima-ui-state` | UI state persistence |
| `ANTHROPIC_API_KEY` | — | Claude API key |
| `GEMINI_API_KEY` | — | Gemini API key |
| `ANIMA_TELEGRAM_BOT_TOKEN` | — | Telegram bot token |
| `ANIMA_TELEGRAM_WEBHOOK_SECRET` | — | Webhook validation secret |
| `ANIMA_TELEGRAM_WEBHOOK_URL` | — | Public HTTPS URL for webhook |
| `ANIMA_WORKSPACE_DIR` | — | Workspace directory (default: cwd) |

---

## Running

### Development

```bash
# Dev mode with hot reload (bun --hot)
bun dev

# Server only
bun start

# With UI
ANIMA_UI_ENABLED=true bun start
```

### CLI Mode

```bash
# One-shot ask
bun run src/cli.ts talk bruno "Hello"

# Check status
bun run src/cli.ts status

# List agents
bun run src/cli.ts list

# Cartridge management
bun run src/cli.ts /cartridge qa-code --agent bruno

# Seed rooms
bun run scripts/seed-room.ts
```

### Server Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (returns `{"status":"ok"}`) |
| `/colony` | GET | Colony manifest (JSON) |
| `/api/colony` | GET | Phase 7 colony state + trust scores |
| `/api/agent/:id` | GET | Phase 7 single agent detail |
| `/webhook/telegram` | POST | Telegram bot webhook |
| `/dream` | POST | Trigger lucid dream for agent |
| `/api/room/:id/memory` | GET | Agent memory recall |
| `/api/room/:id/sessions` | GET | Agent session history |

---

## Deployment

### Option A: systemd User Service (Recommended for Linux/WSL)

Create `~/.config/systemd/user/anima.service`:

```ini
[Unit]
Description=ANIMA Agent Nexus
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/work/anima
ExecStart=%h/.bun/bin/bun run src/server.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=anima

# Environment
Environment=PORT=3700
Environment=ANIMA_UI_ENABLED=true
Environment=ANIMA_UI_PORT=3710
Environment=ANTHROPIC_API_KEY=sk-ant-...
Environment=GEMINI_API_KEY=AIza...
Environment=ANIMA_TELEGRAM_BOT_TOKEN=...
Environment=ANIMA_TELEGRAM_WEBHOOK_SECRET=...
Environment=ANIMA_TELEGRAM_WEBHOOK_URL=https://...

[Install]
WantedBy=default.target
```

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable anima.service
systemctl --user start anima.service

# Verify
systemctl --user status anima.service
journalctl --user -u anima.service -f

# Enable lingering (so service runs when user is not logged in)
sudo loginctl enable-linger $USER
```

### Option B: Cloudflare Tunnel (Telegram Webhook)

When running behind NAT (WSL, home network), Cloudflare Tunnel provides a public HTTPS endpoint:

```bash
# Start tunnel (one-shot quick test)
cloudflared tunnel --url http://localhost:3700

# Output: https://<random>.trycloudflare.com
# Set ANIMA_TELEGRAM_WEBHOOK_URL to this URL
```

For permanent tunnel:

```bash
# Create named tunnel
cloudflared tunnel create anima

# Configure ~/.cloudflared/config.yml
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: <tunnel-id>
credentials-file: /home/user/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: anima.yourdomain.com
    service: http://localhost:3700
  - service: http_status:404
EOF

# Start as service
cloudflared tunnel route dns anima anima.yourdomain.com
sudo cloudflared service install
```

### Option C: pm2 (Alternative to systemd)

```bash
npm install -g pm2

pm2 start --name anima "bun run src/server.ts"
pm2 save
pm2 startup
```

### Option D: Launchd (macOS)

Create `~/Library/LaunchAgents/com.anima.server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.anima.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/user/.bun/bin/bun</string>
        <string>run</string>
        <string>src/server.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/user/work/anima</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>3700</string>
        <key>ANTHROPIC_API_KEY</key>
        <string>sk-ant-...</string>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/anima.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/anima-err.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.anima.server.plist
launchctl start com.anima.server
```

---

## Monitoring

### Health Check

```bash
curl http://localhost:3700/health
# → {"status":"ok"}

# Colony status
curl http://localhost:3700/api/colony | jq .

# Single agent
curl http://localhost:3700/api/agent/bruno | jq .
```

### Logs

```bash
# systemd
journalctl --user -u anima.service -f
journalctl --user -u anima.service --since "1 hour ago"

# pm2
pm2 logs anima

# Direct
tail -f /tmp/anima.log
```

### Test Suite

```bash
# Full suite
bun test

# Specific component
bun test test/evaluation/
bun test test/telegram-session.test.ts

# With coverage
bun test --coverage
```

---

## Troubleshooting

### Server won't start

```bash
# Check port
lsof -i :3700

# Check API key
echo $ANTHROPIC_API_KEY

# Check node_modules
rm -rf node_modules && bun install
```

### Tests failing

```bash
# Run with verbose output
bun test --verbose

# Check TypeScript
bun run tsc --noEmit 2>&1 | head -50

# Check specific test
bun test test/evaluation/
```

### Telegram webhook not receiving

```bash
# Check tunnel
curl https://<your-tunnel>.trycloudflare.com/health

# Check secret
grep ANIMA_TELEGRAM_WEBHOOK_SECRET .env

# Verify webhook registration
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"

# Set webhook manually
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<tunnel>/webhook/telegram&secret_token=<SECRET>"
```

### Memory issues on WSL

Add to `%USERPROFILE%\.wslconfig` on Windows:

```ini
[wsl2]
memory=8GB
processors=4
```

---

## Directory Layout After Install

```
anima/
├── src/              # TypeScript source
│   ├── agents/       # Agent loader, prompter, session, reviewer
│   ├── agora/        # Agora client + Legio dispatcher
│   ├── cartridge/    # Cartridge loader + registry
│   ├── channels/     # Telegram gateway + session
│   ├── config/       # Config types
│   ├── continuity/   # Crossing, gate, staging, merge, maturation, wounds
│   ├── dream/        # Light nap, deep dream, lucid dream
│   ├── evaluation/   # Phase 7: pipeline, trust, drift, allowlist, escalation
│   ├── meeting/      # Meeting room + daemon
│   ├── memory/       # JSONL store, adapter, thread-store, entity-store
│   ├── providers/    # Claude, Gemini, OpenAI-compat, registry, router
│   ├── session/      # Compactor, manager, lifecycle, types
│   ├── sovereignty/  # Platform adapter
│   ├── ui/           # Agent Town UI (React SPA)
│   ├── cli.ts        # CLI entry point
│   └── server.ts     # Server entry point
├── cartridges/       # Shared cartridges
│   ├── shared/       # qa-*, ts, python, csharp, writing, proofreading
│   ├── agent/        # Agent-specific cartridge overrides
│   └── dynamic/      # Runtime-generated cartridges
├── data/             # Colony manifest (colony.json)
├── docs/             # All documentation
├── rooms/            # Agent rooms (generated by seed-room.ts)
│   └── {agent}/      # SOUL.md, config.yaml, trust.json, allowlist.json, sessions/
├── scripts/          # seed-room.ts, rotate-sessions.ts, publish-batch.ts
├── test/             # Test suite
└── openspec/         # OpenSpec changes + archive
```

---

## Phase 7 Configuration Per Agent

After seeding, each room has:

### `rooms/{agent}/trust.json`
```json
{
  "version": 1,
  "domains": {
    "code_review":     { "score": 0.50, "samples": 0, "lastUpdated": "..." },
    "memory_write":    { "score": 0.50, "samples": 0, "lastUpdated": "..." },
    "external_action": { "score": 0.50, "samples": 0, "lastUpdated": "..." },
    "architecture":    { "score": 0.50, "samples": 0, "lastUpdated": "..." },
    "communication":   { "score": 0.50, "samples": 0, "lastUpdated": "..." },
    "private_mode":           { "score": 0.50, "samples": 0, "lastUpdated": "..." }
  }
}
```

### `rooms/{agent}/allowlist.json`
```json
{
  "version": 1,
  "rules": {
    "substrate_write":      { "threshold": 0.70, "domain": "memory_write" },
    "telegram_send":    { "threshold": 0.80, "domain": "communication" },
    "spawn_legio":      { "threshold": 0.65, "domain": "architecture" },
    "external_api":     { "threshold": 0.85, "domain": "external_action" },
    "axiom_write":      { "threshold": null,    "domain": "memory_write" },
    "git_push_main":    { "threshold": null,    "domain": "code_review" },
    "modify_eval_config": { "threshold": null,  "domain": "architecture" }
  }
}
```

---

## Complete Deployment Checklist

- [ ] Bun >= 1.3.11 installed
- [ ] `bun install` completed
- [ ] `bun test` passes (0 fail)
- [ ] `.env` configured with API keys
- [ ] `bun run scripts/seed-room.ts` ran
- [ ] `curl http://localhost:3700/health` returns ok
- [ ] `bun run src/cli.ts talk bruno "test"` works
- [ ] systemd service created and enabled (production)
- [ ] `loginctl enable-linger` run (production, WSL)
- [ ] Cloudflare tunnel configured (if using Telegram webhook)
- [ ] Telegram webhook URL + secret set
- [ ] `/api/colony` returns the colony roster with trust data
- [ ] Port 3700 accessible (firewall/NAT if needed)
