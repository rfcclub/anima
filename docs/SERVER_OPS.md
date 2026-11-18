# Server Operations

Running ANIMA in production — deployment, monitoring, and troubleshooting.

## Running 24/7

### systemd Service

Create a user service file at `~/.config/systemd/user/anima.service`:

```ini
[Unit]
Description=ANIMA Agent Nexus
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/work/anima
Environment=ANIMA_UI_ENABLED=true
Environment=PORT=3700
Environment=ANIMA_UI_PORT=3710
Environment=ANIMA_TELEGRAM_BOT_TOKEN=...
Environment=ANIMA_TELEGRAM_WEBHOOK_SECRET=...
Environment=ANIMA_TELEGRAM_WEBHOOK_URL=https://<tunnel>.trycloudflare.com
ExecStart=%h/.bun/bin/bun run src/server.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=anima

[Install]
WantedBy=default.target
```

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable anima.service
systemctl --user start anima.service

# Check status
systemctl --user status anima.service

# View logs
journalctl --user -u anima.service -f
```

### Environment Variables in systemd

Set API keys and configuration in the service file or use `EnvironmentFile`:

```ini
EnvironmentFile=%h/.config/anima/env
```

```bash
# ~/.config/anima/env
ANTHROPIC_API_KEY=sk-ant-api03-...
GEMINI_API_KEY=...
ANIMA_UI_ENABLED=true
ANIMA_TELEGRAM_BOT_TOKEN=123:abc
ANIMA_TELEGRAM_WEBHOOK_SECRET=my-secret
ANIMA_TELEGRAM_WEBHOOK_URL=https://example.trycloudflare.com
```

## Logging

ANIMA uses structured JSON logging. Every log line is a JSON object:

```json
{
  "level": "info",
  "ts": "2026-05-17T12:00:00.000Z",
  "msg": "request",
  "method": "GET",
  "path": "/health"
}
```

### Log Levels

| Level | Meaning |
|-------|---------|
| `info` | Normal operations: requests, query start/complete, server start |
| `error` | Failures: provider errors, unhandled exceptions |

### Key Log Messages

**Request logging:**
```json
{"level":"info","ts":"...","msg":"request","method":"GET","path":"/status"}
```

**Provider query start:**
```json
{"level":"info","ts":"...","msg":"claude query start","agent":"bruno","mode":"plan"}
```

**Provider query complete:**
```json
{"level":"info","ts":"...","msg":"claude query complete","agent":"bruno","mode":"plan","durationMs":1234}
```

**Provider query failed:**
```json
{"level":"error","ts":"...","msg":"claude query failed","agent":"bruno","mode":"plan","code":"AUTH_ERROR","retryable":false,"durationMs":234}
```

**Server lifecycle:**
```json
{"level":"info","ts":"...","msg":"server started","port":3700}
```

### Viewing Logs

With systemd:
```bash
# Follow logs
journalctl --user -u anima.service -f

# Last 100 lines
journalctl --user -u anima.service -n 100

# Errors only
journalctl --user -u anima.service -p err

# Since today
journalctl --user -u anima.service --since today
```

With direct output (development):
```bash
bun start 2>&1 | tee anima.log
```

## Health Monitoring

### Health Endpoint

```
GET /health
```

Response:
```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime": 86400.5,
  "agents": ["bruno", "cleo", "eli", "sam", "milo", "lena", "ivan"]
}
```

**Fields:**
- `status` — `"ok"` if server is running
- `version` — ANIMA version
- `uptime` — seconds since server start
- `agents` — list of configured agent names

### Status Endpoint

```
GET /status
```

Response:
```json
{
  "agents": [
    {
      "name": "bruno",
      "label": "Bruno",
      "provider": "claude",
      "mount": "ok",
      "lastSession": "2026-05-17T14:30:00.000Z"
    }
  ]
}
```

### Monitoring Script

```bash
#!/bin/bash
# check-anima.sh — basic health check

RESPONSE=$(curl -s http://localhost:3700/health)
STATUS=$(echo "$RESPONSE" | jq -r '.status')

if [ "$STATUS" != "ok" ]; then
  echo "ANIMA health check FAILED: $RESPONSE"
  exit 1
fi

AGENT_COUNT=$(echo "$RESPONSE" | jq '.agents | length')
echo "ANIMA OK — $AGENT_COUNT agents running"
```

## Session Management

### Colony Endpoint

```
GET /colony
```

Returns the full colony manifest with all agents, substrates, boot sequences, and squads, as defined in `data/colony.json`.

### Session Storage

Sessions are stored as JSONL files:
```
rooms/<agent>/sessions/
├── 2026-05-15.jsonl
├── 2026-05-16.jsonl
└── 2026-05-17.jsonl
```

Each line is a JSON event with at least:
```json
{"timestamp":"...","type":"message","sessionId":"uuid","role":"user","content":"..."}
```

### Session Compaction

When a session exceeds the `compactThreshold` (default: 60,000 tokens), the compactor:

1. Takes all turns up to the current point
2. Sends them to the provider with a summarization prompt
3. Saves the summary as a "baseline" event
4. Future turns reference the baseline instead of full history

This keeps context windows manageable for long-running agents.

### Checking Session Status

```bash
bun cli session status bruno
```

Returns the current session ID, turn count, estimated tokens, and whether a baseline exists.

### Viewing Session History

```bash
# Read today's session file
cat rooms/bruno/sessions/$(date +%Y-%m-%d).jsonl | jq .
```

## Backup & Restore

### What to Backup

```
rooms/                  # Agent rooms + sessions
├── */config.yaml       # Agent configs
├── */sessions/         # Session history
└── _meeting/           # Meeting transcripts

~/.anima/               # Global config
├── providers.d/        # External provider registry
└── mode-map.yaml       # Global mode routing
```

### Backup Script

```bash
#!/bin/bash
# backup-anima.sh

BACKUP_DIR="/home/user/backups/anima"
DATE=$(date +%Y-%m-%d)
tar -czf "$BACKUP_DIR/anima-$DATE.tar.gz" \
  -C /home/user/work/anima rooms/ \
  -C /home/user .anima/
```

### Restore

```bash
tar -xzf anima-2026-05-17.tar.gz -C /tmp/restore
cp -r /tmp/restore/rooms/* /home/user/work/anima/rooms/
cp -r /tmp/restore/.anima/* /home/user/.anima/
```

## Troubleshooting

### Server Won't Start

```bash
# Check port is available
lsof -i :3700

# Check Bun version
bun --version    # should be >= 1.3.11

# Check dependencies
bun install
```

### Agent Mount Missing

```bash
# Check mount symlink
ls -la rooms/bruno/mount/

# If broken, recreate
ln -sf /path/to/substrate rooms/bruno/mount/bruno
```

### Provider Errors

See [Provider Setup](PROVIDER_SETUP.md#debugging-provider-issues) for provider-specific troubleshooting.

### Session File Corruption

If a JSONL file gets corrupted (e.g., partial write during crash):

```bash
# The system auto-recovers on next read:
# - Last truncated line is discarded
# - A recovery event is logged
# - The session continues normally

# Check for recovery events
grep '"type":"recovery"' rooms/*/sessions/*.jsonl
```

### High Token Usage

If agents are consuming too many tokens:

1. Lower the `compactThreshold` in room config
2. Reduce `maxTokens` to cap responses
3. Check for large boot files in `boot.additional`
4. Review meeting transcripts — old transcripts can be archived

### Mail Circuit Breaker Triggered

If you see: `mail circuit breaker: <agent> has N unread A2A messages`

- The agent has >50 unread messages
- Run `bun cli check-mail <agent>` to clear them
- Or manually delete old meeting transcripts

## Directory Layout Reference

```
anima/
├── src/                 # Source code (don't touch in production)
├── rooms/               # Runtime data — backup this!
│   ├── _meeting/        # Meeting transcripts (git-tracked)
│   │   └── <topic>/
│   │       └── <date>.md
│   ├── bruno/
│   │   ├── config.yaml
│   │   ├── SOUL.md      # (or symlink to substrate)
│   │   ├── mount/       # (symlink to substrate)
│   │   └── sessions/
│   │       └── <date>.jsonl
│   ├── cleo/
│   └── ...
├── docs/                # Documentation
├── test/                # Tests
└── openspec/            # Spec registry
```
