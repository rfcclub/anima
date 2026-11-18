"""
AnimaMeshProvider — Hermes plugin for colony mesh bus v2.

Wraps the mesh SQLite database (ANIMA_MESH_DB, default ~/.anima/mesh.db) as Hermes tool provider.
v2 schema: messages, deliveries, subscriptions, recipients, presence.
Exposes: mesh_send, mesh_peek, mesh_pull, mesh_ack, mesh_status, mesh_thread,
         mesh_subscribe, mesh_unsubscribe, mesh_register_recipient, mesh_unregister_recipient.
"""

import json
import os
import sqlite3
import uuid
from pathlib import Path
from typing import Optional, List, Dict, Any
from datetime import datetime, timezone, timedelta

VALID_PATTERNS = ("work", "investigate", "debate", "direct")
DB_PATH = Path(os.environ.get("ANIMA_MESH_DB") or (Path.home() / ".anima" / "mesh.db"))
DEFAULT_CLAIM_TIMEOUT_MS = 30 * 60 * 1000  # 30 minutes
MAX_ATTEMPTS = 5


class AnimaMeshProvider:
    def __init__(self, agent_name: Optional[str] = None):
        self.agent_name = agent_name or os.environ.get("HERMES_AGENT_NAME", "agent")
        self.instance_id = f"hermes-{self.agent_name}"
        self._db: Optional[sqlite3.Connection] = None

    @property
    def name(self) -> str:
        return "anima_mesh"

    def is_available(self) -> bool:
        return DB_PATH.exists()

    def initialize(self) -> None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(DB_PATH), timeout=5)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA busy_timeout=5000")
        self._db.executescript("""
            CREATE TABLE IF NOT EXISTS messages (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                client_msg_id TEXT,
                thread_id     TEXT,
                pattern       TEXT NOT NULL,
                role          TEXT NOT NULL,
                from_id       TEXT NOT NULL,
                subject       TEXT NOT NULL DEFAULT '',
                content       TEXT NOT NULL DEFAULT '',
                round         INTEGER,
                context_only  INTEGER NOT NULL DEFAULT 0,
                created_at    TEXT NOT NULL,
                UNIQUE(from_id, client_msg_id)
            );
            CREATE TABLE IF NOT EXISTS deliveries (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id       INTEGER NOT NULL,
                recipient_id     TEXT NOT NULL,
                delivery_kind    TEXT NOT NULL,
                topic            TEXT,
                available_at     TEXT NOT NULL,
                claimed_at       TEXT,
                claim_expires_at TEXT,
                claim_token      TEXT,
                acked_at         TEXT,
                failed_at        TEXT,
                failure_reason   TEXT,
                attempts         INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY(message_id) REFERENCES messages(id),
                UNIQUE(message_id, recipient_id, delivery_kind, topic)
            );
            CREATE TABLE IF NOT EXISTS recipients (
                instance_id       TEXT PRIMARY KEY,
                platform          TEXT NOT NULL,
                active            INTEGER NOT NULL DEFAULT 1,
                broadcast_enabled INTEGER NOT NULL DEFAULT 0,
                created_at        TEXT NOT NULL,
                updated_at        TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS subscriptions (
                topic         TEXT NOT NULL,
                subscriber_id TEXT NOT NULL,
                created_at    TEXT NOT NULL,
                active        INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY(topic, subscriber_id)
            );
            CREATE TABLE IF NOT EXISTS presence (
                instance_id TEXT PRIMARY KEY,
                platform    TEXT NOT NULL,
                last_seen   TEXT NOT NULL,
                note        TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_deliveries_pending ON deliveries (recipient_id, acked_at, available_at);
            CREATE INDEX IF NOT EXISTS idx_deliveries_expired ON deliveries (recipient_id, claim_expires_at, acked_at);
            CREATE INDEX IF NOT EXISTS idx_messages_client ON messages (from_id, client_msg_id);
            CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id, id);
        """)
        # Auto-register self
        self._auto_register(self.instance_id, "hermes")

    def shutdown(self) -> None:
        if self._db:
            self._db.close()
            self._db = None

    # ── Tool interface ──────────────────────────────────────────────────────

    def system_prompt_block(self) -> str:
        return (
            "You have access to the colony mesh bus — a unified messaging system "
            "shared by all agents across CC, OC, ANIMA, Hermes, Codex, Gemini, Qwen, "
            "Antigravity, and Reasonix. Use mesh_send to message other agents. "
            "Use mesh_peek to inspect pending deliveries without consuming them. "
            "Use mesh_pull to claim deliveries, then mesh_ack after processing. "
            "Use mesh_status for a dashboard view."
        )

    def tools(self) -> List[Dict[str, Any]]:
        return [
            self._tool("mesh_send", "Send a message on the colony mesh bus.",
                        {"to_id": {"type": "string"}, "topic": {"type": "string"}, "content": {"type": "string"},
                         "subject": {"type": "string"}, "pattern": {"type": "string"}, "role": {"type": "string"},
                         "thread_id": {"type": "string"}, "client_msg_id": {"type": "string"},
                         "round": {"type": "integer"}, "context_only": {"type": "boolean"}, "include_self": {"type": "boolean"}},
                        ["content"]),
            self._tool("mesh_peek", "Inspect pending deliveries without claiming or acking.",
                        {"thread_id": {"type": "string"}}),
            self._tool("mesh_pull", "Claim pending deliveries. MUST call mesh_ack after processing.",
                        {"thread_id": {"type": "string"}, "claim_timeout_ms": {"type": "integer"}, "wait_ms": {"type": "integer"}}),
            self._tool("mesh_ack", "Acknowledge a claimed delivery.",
                        {"delivery_id": {"type": "integer"}, "claim_token": {"type": "string"}},
                        ["delivery_id", "claim_token"]),
            self._tool("mesh_status", "Show mesh presence and delivery counts."),
            self._tool("mesh_thread", "Read thread history without claiming or acking.",
                        {"thread_id": {"type": "string"}, "round": {"type": "integer"}},
                        ["thread_id"]),
            self._tool("mesh_subscribe", "Subscribe to an exact topic.",
                        {"topic": {"type": "string"}}, ["topic"]),
            self._tool("mesh_unsubscribe", "Unsubscribe from a topic.",
                        {"topic": {"type": "string"}}, ["topic"]),
            self._tool("mesh_register_recipient", "Register as mesh recipient.",
                        {"broadcast_enabled": {"type": "boolean"}}),
            self._tool("mesh_unregister_recipient", "Deactivate as mesh recipient."),
        ]

    def call_tool(self, tool_name: str, args: Dict[str, Any]) -> str:
        self.initialize()
        self._touch_presence()
        if tool_name == "mesh_send":
            return self._send(args)
        elif tool_name == "mesh_peek":
            return self._peek(args)
        elif tool_name == "mesh_pull":
            return self._pull(args)
        elif tool_name == "mesh_ack":
            return self._ack(args)
        elif tool_name == "mesh_status":
            return self._status()
        elif tool_name == "mesh_thread":
            return self._thread(args)
        elif tool_name == "mesh_subscribe":
            return self._subscribe(args)
        elif tool_name == "mesh_unsubscribe":
            return self._unsubscribe(args)
        elif tool_name == "mesh_register_recipient":
            return self._register_recipient(args)
        elif tool_name == "mesh_unregister_recipient":
            return self._unregister_recipient()
        return f"Unknown mesh tool: {tool_name}"

    # ── Implementations ─────────────────────────────────────────────────────

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _touch_presence(self) -> None:
        self._db.execute(
            "INSERT INTO presence (instance_id, platform, last_seen) VALUES (?, 'hermes', ?) "
            "ON CONFLICT(instance_id) DO UPDATE SET last_seen=excluded.last_seen, platform='hermes'",
            (self.instance_id, self._now()),
        )
        self._db.commit()

    def _auto_register(self, instance_id: str, platform: str) -> None:
        now = self._now()
        self._db.execute(
            "INSERT INTO recipients (instance_id, platform, active, broadcast_enabled, created_at, updated_at) "
            "VALUES (?, ?, 1, 0, ?, ?) "
            "ON CONFLICT(instance_id) DO UPDATE SET platform=excluded.platform, updated_at=excluded.updated_at",
            (instance_id, platform, now, now),
        )
        self._db.commit()

    def _send(self, args: Dict[str, Any]) -> str:
        pattern = args.get("pattern", "direct")
        if pattern not in VALID_PATTERNS:
            return f"Error: unknown pattern '{pattern}'. Valid: {', '.join(VALID_PATTERNS)}"

        content = args.get("content")
        if not content:
            return "Error: 'content' is required."

        to_id = args.get("to_id")
        topic = args.get("topic")
        if not to_id and not topic:
            return "Error: 'to_id' or 'topic' is required."

        # Normalize short agent names
        if to_id and "-" not in to_id and to_id != "all":
            to_id = f"anima-{to_id}"

        rnd = args.get("round")
        if rnd is not None:
            try:
                rnd = int(rnd)
            except (ValueError, TypeError):
                return f"Error: round must be a positive integer, got: {args.get('round')}"
            if rnd < 1:
                return f"Error: round must be a positive integer, got: {rnd}"

        client_msg_id = args.get("client_msg_id")
        now = self._now()

        # Idempotency check
        if client_msg_id:
            existing = self._db.execute(
                "SELECT id FROM messages WHERE from_id = ? AND client_msg_id = ?",
                (self.instance_id, client_msg_id),
            ).fetchone()
            if existing:
                return json.dumps({"status": "already_sent", "message_id": existing["id"]})

        # Thread ID
        thread_id = args.get("thread_id")
        if thread_id is None:
            thread_id = f"thread_{uuid.uuid4()}"

        # Insert message
        cur = self._db.execute(
            "INSERT INTO messages (client_msg_id, thread_id, pattern, role, from_id, subject, content, round, context_only, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (client_msg_id, thread_id, pattern, args.get("role", "message"), self.instance_id,
             args.get("subject", ""), content, rnd, 1 if args.get("context_only") else 0, now),
        )
        msg_id = cur.lastrowid

        # Expand deliveries
        delivery_ids = []
        if topic:
            subs = self._db.execute(
                "SELECT subscriber_id FROM subscriptions WHERE topic = ? AND active = 1", (topic,)
            ).fetchall()
            for sub in subs:
                did = self._insert_delivery(msg_id, sub["subscriber_id"], "subscription", topic, now)
                delivery_ids.append(did)
        elif to_id == "all":
            recipients = self._db.execute(
                "SELECT instance_id FROM recipients WHERE active = 1 AND broadcast_enabled = 1"
            ).fetchall()
            include_self = args.get("include_self", False)
            for r in recipients:
                if r["instance_id"] != self.instance_id or include_self:
                    did = self._insert_delivery(msg_id, r["instance_id"], "broadcast", None, now)
                    delivery_ids.append(did)
        elif to_id:
            did = self._insert_delivery(msg_id, to_id, "direct", None, now)
            delivery_ids.append(did)

        self._db.commit()
        self._touch_presence()

        return json.dumps({
            "status": "sent", "message_id": msg_id, "thread_id": thread_id,
            "delivery_ids": delivery_ids, "pattern": pattern, "role": args.get("role", "message"),
        })

    def _insert_delivery(self, msg_id: int, recipient_id: str, kind: str, topic: Optional[str], now: str) -> int:
        cur = self._db.execute(
            "INSERT INTO deliveries (message_id, recipient_id, delivery_kind, topic, available_at, attempts) "
            "VALUES (?, ?, ?, ?, ?, 0)",
            (msg_id, recipient_id, kind, topic, now),
        )
        return cur.lastrowid

    def _peek(self, args: Dict[str, Any]) -> str:
        thread_id = args.get("thread_id")
        if thread_id:
            rows = self._db.execute(
                "SELECT d.*, m.* FROM deliveries d JOIN messages m ON d.message_id = m.id "
                "WHERE d.recipient_id = ? AND d.acked_at IS NULL AND m.thread_id = ? ORDER BY d.id ASC",
                (self.instance_id, thread_id),
            ).fetchall()
        else:
            rows = self._db.execute(
                "SELECT d.*, m.* FROM deliveries d JOIN messages m ON d.message_id = m.id "
                "WHERE d.recipient_id = ? AND d.acked_at IS NULL ORDER BY d.id ASC",
                (self.instance_id,),
            ).fetchall()
        self._touch_presence()
        if not rows:
            return "No pending deliveries."
        return json.dumps({"deliveries": [self._format_delivery(r) for r in rows]})

    def _pull(self, args: Dict[str, Any]) -> str:
        claim_timeout_ms = args.get("claim_timeout_ms", DEFAULT_CLAIM_TIMEOUT_MS)
        wait_ms = args.get("wait_ms", 0)
        thread_id = args.get("thread_id")
        now = self._now()
        claim_expires = (datetime.now(timezone.utc) + timedelta(milliseconds=claim_timeout_ms)).isoformat()

        # Quarantine expired attempts
        self._db.execute(
            "UPDATE deliveries SET failed_at = ?, failure_reason = 'max_attempts_exceeded' "
            "WHERE recipient_id = ? AND acked_at IS NULL AND failed_at IS NULL AND attempts >= ?",
            (now, self.instance_id, MAX_ATTEMPTS),
        )
        self._db.commit()

        # Claim available deliveries
        if thread_id:
            rows = self._db.execute(
                "SELECT d.*, m.* FROM deliveries d JOIN messages m ON d.message_id = m.id "
                "WHERE d.recipient_id = ? AND d.acked_at IS NULL AND d.failed_at IS NULL "
                "AND (d.claimed_at IS NULL OR d.claim_expires_at <= ?) AND m.thread_id = ? "
                "ORDER BY d.id ASC",
                (self.instance_id, now, thread_id),
            ).fetchall()
        else:
            rows = self._db.execute(
                "SELECT d.*, m.* FROM deliveries d JOIN messages m ON d.message_id = m.id "
                "WHERE d.recipient_id = ? AND d.acked_at IS NULL AND d.failed_at IS NULL "
                "AND (d.claimed_at IS NULL OR d.claim_expires_at <= ?) "
                "ORDER BY d.id ASC",
                (self.instance_id, now),
            ).fetchall()

        results = []
        for r in rows:
            claim_token = str(uuid.uuid4())
            self._db.execute(
                "UPDATE deliveries SET claimed_at = ?, claim_expires_at = ?, claim_token = ?, attempts = attempts + 1 "
                "WHERE id = ?",
                (now, claim_expires, claim_token, r["id"]),
            )
            results.append({**self._format_delivery(r), "claim_token": claim_token, "claim_expires_at": claim_expires, "attempts": r["attempts"] + 1})

        self._db.commit()
        self._touch_presence()

        if not results:
            return "No new messages."
        return json.dumps({"deliveries": results})

    def _ack(self, args: Dict[str, Any]) -> str:
        delivery_id = args.get("delivery_id")
        claim_token = args.get("claim_token")
        if not delivery_id or not claim_token:
            return "Error: 'delivery_id' and 'claim_token' are required."

        row = self._db.execute(
            "SELECT * FROM deliveries WHERE id = ? AND recipient_id = ?",
            (delivery_id, self.instance_id),
        ).fetchone()
        if not row:
            return json.dumps({"ok": False, "error": "delivery not found for this recipient"})
        if row["claim_token"] != claim_token:
            return json.dumps({"ok": False, "error": "wrong claim token"})
        if row["acked_at"]:
            return json.dumps({"ok": False, "error": "already acked"})

        now = self._now()
        self._db.execute("UPDATE deliveries SET acked_at = ? WHERE id = ?", (now, delivery_id))
        self._db.commit()
        self._touch_presence()
        return json.dumps({"ok": True})

    def _status(self) -> str:
        now = self._now()
        presence = self._db.execute("SELECT * FROM presence ORDER BY last_seen DESC").fetchall()
        deliveries = self._db.execute(
            "SELECT recipient_id, "
            "SUM(CASE WHEN acked_at IS NULL AND failed_at IS NULL AND (claimed_at IS NULL OR claim_expires_at <= ?) THEN 1 ELSE 0 END) AS pending, "
            "SUM(CASE WHEN acked_at IS NULL AND failed_at IS NULL AND claimed_at IS NOT NULL AND claim_expires_at > ? THEN 1 ELSE 0 END) AS claimed, "
            "SUM(CASE WHEN acked_at IS NULL AND failed_at IS NULL AND claim_expires_at IS NOT NULL AND claim_expires_at <= ? THEN 1 ELSE 0 END) AS expired, "
            "SUM(CASE WHEN failed_at IS NOT NULL THEN 1 ELSE 0 END) AS failed, "
            "SUM(CASE WHEN acked_at IS NOT NULL THEN 1 ELSE 0 END) AS acked "
            "FROM deliveries GROUP BY recipient_id",
            (now, now, now),
        ).fetchall()
        recent = self._db.execute("SELECT * FROM messages ORDER BY id DESC LIMIT 20").fetchall()

        lines = ["## Colony Mesh Status", "", "### Presence"]
        if not presence:
            lines.append("(none)")
        for p in presence:
            lines.append(f"- **{p['instance_id']}** [{p['platform']}] {p['last_seen'][:16]}")

        lines.append("", "### Deliveries")
        if not deliveries:
            lines.append("(none)")
        for d in deliveries:
            lines.append(f"- {d['recipient_id']}: {d['pending']} pending, {d['claimed']} claimed, {d['expired']} expired, {d['failed']} failed, {d['acked']} acked")

        lines.append("", "### Recent")
        if not recent:
            lines.append("(none)")
        for m in recent:
            lines.append(f"- [{m['created_at'][:16]}] {m['from_id']} ({m['pattern']}/{m['role']}): {m['content'][:80]}")

        self._touch_presence()
        return "\n".join(lines)

    def _thread(self, args: Dict[str, Any]) -> str:
        thread_id = args["thread_id"]
        rnd = args.get("round")
        if rnd is not None:
            rows = self._db.execute(
                "SELECT * FROM messages WHERE thread_id = ? AND round = ? ORDER BY id ASC",
                (thread_id, int(rnd)),
            ).fetchall()
        else:
            rows = self._db.execute(
                "SELECT * FROM messages WHERE thread_id = ? ORDER BY id ASC",
                (thread_id,),
            ).fetchall()

        if not rows:
            return "No messages in thread."

        lines = [f"Thread {thread_id} ({len(rows)} messages):\n"]
        for m in rows:
            header = f"[{m['created_at'][:16]}] {m['from_id']} ({m['pattern']}/{m['role']}"
            if m["round"]:
                header += f", round: {m['round']}"
            header += ")"
            body = ""
            if m["subject"]:
                body += f"Subject: {m['subject']}\n"
            body += m["content"]
            lines.append(f"{header}\n{body}")
        return "\n\n---\n\n".join(lines)

    def _subscribe(self, args: Dict[str, Any]) -> str:
        topic = args.get("topic")
        if not topic:
            return "Error: 'topic' is required."
        now = self._now()
        self._db.execute(
            "INSERT INTO subscriptions (topic, subscriber_id, created_at, active) VALUES (?, ?, ?, 1) "
            "ON CONFLICT(topic, subscriber_id) DO UPDATE SET active = 1",
            (topic, self.instance_id, now),
        )
        self._db.commit()
        self._touch_presence()
        return json.dumps({"status": "subscribed", "topic": topic})

    def _unsubscribe(self, args: Dict[str, Any]) -> str:
        topic = args.get("topic")
        if not topic:
            return "Error: 'topic' is required."
        self._db.execute(
            "UPDATE subscriptions SET active = 0 WHERE topic = ? AND subscriber_id = ?",
            (topic, self.instance_id),
        )
        self._db.commit()
        self._touch_presence()
        return json.dumps({"status": "unsubscribed", "topic": topic})

    def _register_recipient(self, args: Dict[str, Any]) -> str:
        now = self._now()
        self._db.execute(
            "INSERT INTO recipients (instance_id, platform, active, broadcast_enabled, created_at, updated_at) "
            "VALUES (?, 'hermes', 1, ?, ?, ?) "
            "ON CONFLICT(instance_id) DO UPDATE SET broadcast_enabled=excluded.broadcast_enabled, updated_at=excluded.updated_at",
            (self.instance_id, 1 if args.get("broadcast_enabled") else 0, now, now),
        )
        self._db.commit()
        self._touch_presence()
        return json.dumps({"status": "registered", "instance_id": self.instance_id})

    def _unregister_recipient(self) -> str:
        now = self._now()
        self._db.execute(
            "UPDATE recipients SET active = 0, updated_at = ? WHERE instance_id = ?",
            (now, self.instance_id),
        )
        self._db.commit()
        self._touch_presence()
        return json.dumps({"status": "unregistered", "instance_id": self.instance_id})

    # ── Helpers ─────────────────────────────────────────────────────────────

    def _format_delivery(self, row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "delivery_id": row["id"],
            "message_id": row["message_id"],
            "recipient_id": row["recipient_id"],
            "delivery_kind": row["delivery_kind"],
            "topic": row["topic"],
            "available_at": row["available_at"],
            "claimed_at": row["claimed_at"],
            "claim_expires_at": row["claim_expires_at"],
            "claim_token": row["claim_token"],
            "acked_at": row["acked_at"],
            "failed_at": row["failed_at"],
            "failure_reason": row["failure_reason"],
            "attempts": row["attempts"],
            "message": {
                "id": row["id"] if "id" in row.keys() and "from_id" in row.keys() else row["message_id"],
                "thread_id": row["thread_id"],
                "pattern": row["pattern"],
                "role": row["role"],
                "from_id": row["from_id"],
                "subject": row["subject"],
                "content": row["content"],
                "round": row["round"],
                "context_only": bool(row["context_only"]),
                "created_at": row["created_at"],
            },
        }

    @staticmethod
    def _tool(name: str, description: str, properties: Optional[Dict] = None,
              required: Optional[List[str]] = None) -> Dict[str, Any]:
        schema: Dict[str, Any] = {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties or {},
            },
        }
        if required:
            schema["parameters"]["required"] = required
        return schema


def create_provider(agent_name: Optional[str] = None) -> AnimaMeshProvider:
    provider = AnimaMeshProvider(agent_name)
    provider.initialize()
    return provider
