"""
AnimaMemoryStore — Python-native per-agent memory backed by shared SQLite.

Reads and writes the SAME database as the TypeScript AnimaMemoryStore:
  ~/.anima/agents/<agent_name>/memory.db

Schema mirrors anima-entity-store.ts:
  neurons, neurons_fts (FTS5), embeddings, synapses

Concurrent-safe via SQLite WAL mode. Multiple Hermes/ANIMA/OC instances
can read/write the same DB simultaneously.
"""

import sqlite3
import json
import os
import hashlib
import threading
import time
import uuid
import struct
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any, Tuple

# ── Default paths ──────────────────────────────────────────────────────────

DEFAULT_DATA_DIR = Path.home() / ".anima" / "agents"

# ── Thread-local connections ───────────────────────────────────────────────

_connections: Dict[str, sqlite3.Connection] = {}
_conn_lock = threading.Lock()


def _resolve_db_path(agent_name: str) -> Path:
    """Resolve the per-agent memory database path."""
    return DEFAULT_DATA_DIR / agent_name / "memory.db"


# ── AnimaMemoryStore ───────────────────────────────────────────────────────

class AnimaMemoryStore:
    """
    Python-native per-agent memory store.

    Reads/writes ~/.anima/agents/<name>/memory.db — the same database
    used by ANIMA (TypeScript/bun) and OpenClaw (TypeScript/node).
    """

    def __init__(self, agent_name: str, db_path: Optional[str] = None):
        self.agent_name = agent_name
        self.db_path = str(db_path or _resolve_db_path(agent_name))
        self._conn: Optional[sqlite3.Connection] = None
        self._write_lock = threading.Lock()  # serialize writes across threads

    # ── Lifecycle ──────────────────────────────────────────────────────────

    def initialize(self) -> None:
        """Open SQLite connection, create schema if needed."""
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)

        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA foreign_keys=ON")

        # ── Schema (mirrors anima-entity-store.ts) ─────────────────────
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS neurons (
                id           TEXT PRIMARY KEY,
                type         TEXT NOT NULL,
                content      TEXT NOT NULL,
                scope        TEXT,
                tags         TEXT NOT NULL DEFAULT '[]',
                source       TEXT,
                confidence   REAL NOT NULL DEFAULT 0.5,
                metadata     TEXT NOT NULL DEFAULT '{}',
                access_count INTEGER NOT NULL DEFAULT 0,
                created_at   TEXT NOT NULL,
                updated_at   TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS synapses (
                id         TEXT PRIMARY KEY,
                source_id  TEXT NOT NULL REFERENCES neurons(id) ON DELETE CASCADE,
                target_id  TEXT NOT NULL REFERENCES neurons(id) ON DELETE CASCADE,
                type       TEXT NOT NULL,
                weight     REAL NOT NULL DEFAULT 1.0,
                metadata   TEXT NOT NULL DEFAULT '{}'
            );

            CREATE TABLE IF NOT EXISTS embeddings (
                neuron_id TEXT NOT NULL REFERENCES neurons(id) ON DELETE CASCADE,
                embedding BLOB NOT NULL,
                model     TEXT NOT NULL,
                PRIMARY KEY (neuron_id, model)
            );

            CREATE TABLE IF NOT EXISTS embedding_retry_queue (
                neuron_id  TEXT PRIMARY KEY REFERENCES neurons(id) ON DELETE CASCADE,
                attempts   INTEGER NOT NULL,
                last_error TEXT,
                queued_at  TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_neurons_type ON neurons(type);
            CREATE INDEX IF NOT EXISTS idx_neurons_scope ON neurons(scope);
            CREATE INDEX IF NOT EXISTS idx_synapses_source ON synapses(source_id);
            CREATE INDEX IF NOT EXISTS idx_synapses_target ON synapses(target_id);
        """)

        # FTS5 — may fail if sqlite compiled without it
        try:
            conn.executescript("""
                CREATE VIRTUAL TABLE IF NOT EXISTS neurons_fts USING fts5(
                    content, content='neurons', content_rowid='rowid'
                );

                CREATE TRIGGER IF NOT EXISTS neurons_ai AFTER INSERT ON neurons BEGIN
                    INSERT INTO neurons_fts(rowid, content) VALUES (new.rowid, new.content);
                END;

                CREATE TRIGGER IF NOT EXISTS neurons_ad AFTER DELETE ON neurons BEGIN
                    INSERT INTO neurons_fts(neurons_fts, rowid, content) VALUES('delete', old.rowid, old.content);
                END;

                CREATE TRIGGER IF NOT EXISTS neurons_au AFTER UPDATE ON neurons BEGIN
                    INSERT INTO neurons_fts(neurons_fts, rowid, content) VALUES('delete', old.rowid, old.content);
                    INSERT INTO neurons_fts(rowid, content) VALUES (new.rowid, new.content);
                END;
            """)
        except sqlite3.OperationalError:
            pass  # FTS5 not available — recall falls back to LIKE

        self._conn = conn

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None

    # ── Embedding support ─────────────────────────────────────────────────

    EMBEDDING_MODEL = "models/gemini-embedding-2"
    EMBEDDING_DIM = 3072  # gemini-embedding-2 output dimension
    _embeddings_available: Optional[bool] = None

    def _check_embeddings(self) -> bool:
        """Check if Gemini API key is configured for embeddings."""
        if self._embeddings_available is not None:
            return self._embeddings_available
        key = os.environ.get("GEMINI_API_KEY", "")
        self._embeddings_available = bool(key and len(key) > 10)
        return self._embeddings_available

    def _generate_embedding(self, text: str) -> Optional[List[float]]:
        """Generate embedding vector via Gemini REST API."""
        if not self._check_embeddings():
            return None
        api_key = os.environ["GEMINI_API_KEY"]
        url = f"https://generativelanguage.googleapis.com/v1beta/{self.EMBEDDING_MODEL}:embedContent?key={api_key}"
        body = json.dumps({
            "model": self.EMBEDDING_MODEL.replace("models/", ""),
            "content": {"parts": [{"text": text[:8000]}]},
        }).encode("utf-8")

        try:
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode())
                values = data.get("embedding", {}).get("values", [])
                return values if values else None
        except Exception:
            return None

    # ── Embedding retry policy ─────────────────────────────────────────────
    # Background embedding threads can fail transiently (rate limit, network).
    # We retry up to 3 times with exponential backoff. After that, the neuron
    # is recorded in the embedding_retry_queue table; a separate
    # backfill job drains the queue.
    EMBEDDING_RETRY_MAX = 3
    EMBEDDING_RETRY_DELAYS = (2, 4, 8)  # seconds, exponential-ish

    def _store_embedding(self, neuron_id: str, text: str) -> None:
        """Generate + store embedding for a neuron. Fire-and-forget with retry."""
        import time
        last_err = None
        for attempt in range(self.EMBEDDING_RETRY_MAX):
            try:
                values = self._generate_embedding(text)
                if not values:
                    last_err = "empty embedding returned"
                    time.sleep(self.EMBEDDING_RETRY_DELAYS[min(attempt, len(self.EMBEDDING_RETRY_DELAYS) - 1)])
                    continue
                blob = struct.pack(f"{len(values)}f", *values)
                with self._write_lock:
                    self._conn.execute(
                        "INSERT OR REPLACE INTO embeddings (neuron_id, embedding, model) VALUES (?, ?, ?)",
                        (neuron_id, blob, self.EMBEDDING_MODEL),
                    )
                    self._conn.commit()
                return  # success
            except Exception as e:
                last_err = str(e)
                if attempt < self.EMBEDDING_RETRY_MAX - 1:
                    time.sleep(self.EMBEDDING_RETRY_DELAYS[min(attempt, len(self.EMBEDDING_RETRY_DELAYS) - 1)])
        # All retries exhausted — queue for cron to drain
        try:
            with self._write_lock:
                self._conn.execute(
                    "INSERT OR IGNORE INTO embedding_retry_queue (neuron_id, attempts, last_error, queued_at) VALUES (?, ?, ?, ?)",
                    (neuron_id, self.EMBEDDING_RETRY_MAX, last_err or "unknown", datetime.now(timezone.utc).isoformat()),
                )
                self._conn.commit()
        except Exception:
            pass  # neuron may have been deleted by consolidation

    def _get_embedding(self, neuron_id: str) -> Optional[List[float]]:
        """Retrieve stored embedding for a neuron."""
        row = self._conn.execute(
            "SELECT embedding FROM embeddings WHERE neuron_id = ? AND model = ?",
            (neuron_id, self.EMBEDDING_MODEL),
        ).fetchone()
        if not row:
            return None
        blob = row["embedding"]
        count = len(blob) // 4
        return list(struct.unpack(f"{count}f", blob)) if count > 0 else None

    def _vector_search(self, query_embedding: List[float], limit: int = 10) -> List[Tuple[str, float]]:
        """Cosine similarity search against stored embeddings."""
        rows = self._conn.execute(
            "SELECT neuron_id, embedding FROM embeddings WHERE model = ?",
            (self.EMBEDDING_MODEL,),
        ).fetchall()

        scored: List[Tuple[str, float]] = []
        for row in rows:
            blob = row["embedding"]
            count = len(blob) // 4
            if count == 0:
                continue
            stored = list(struct.unpack(f"{count}f", blob))
            if len(stored) != len(query_embedding):
                continue
            sim = self._cosine_similarity(query_embedding, stored)
            scored.append((row["neuron_id"], sim))

        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:limit]

    @staticmethod
    def _cosine_similarity(a: List[float], b: List[float]) -> float:
        if len(a) != len(b) or len(a) == 0:
            return 0.0
        dot = sum(x * y for x, y in zip(a, b))
        mag_a = sum(x * x for x in a) ** 0.5
        mag_b = sum(x * x for x in b) ** 0.5
        return dot / (mag_a * mag_b) if mag_a and mag_b else 0.0

    # ── AgentMemoryStore contract ──────────────────────────────────────────

    # Patterns that identify OC native auto-write garbage
    _GARBAGE_PREFIXES = ("[auto] assistant:", "[auto] user:")
    _GARBAGE_SIGNALS = ('"toolCall"', '"type":"toolCall"', '"type": "toolCall"',
                        "Conversation info (untrusted metadata)")

    def _is_garbage(self, content: str) -> bool:
        """Return True if content is OC native auto-write noise, not a semantic memory."""
        if not content:
            return False
        stripped = content.strip()
        if any(stripped.startswith(p) for p in self._GARBAGE_PREFIXES):
            return True
        # Raw Telegram/OC conversation dumps (episode type but JSON)
        if stripped.startswith('[{"type"') and any(s in stripped for s in self._GARBAGE_SIGNALS):
            return True
        return False

    def remember(self, content: str, scope: str = "observation",
                 tags: Optional[List[str]] = None, confidence: float = 0.5,
                 source: Optional[str] = None,
                 metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Store a new memory entry. Rejects OC native auto-write garbage."""
        # Fix #1: filter [auto] garbage before it pollutes the DB
        if self._is_garbage(content):
            return {"id": "", "content": content, "scope": scope,
                    "tags": tags or [], "confidence": 0.0,
                    "source": source or self.agent_name,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "_filtered": True}

        entry_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        tags_json = json.dumps(tags or [])
        meta = dict(metadata or {})
        meta["_scope"] = scope  # cross-platform compat with TS store
        meta_json = json.dumps(meta)

        with self._write_lock:
            self._conn.execute(
                """INSERT INTO neurons (id, type, content, scope, tags, source, confidence,
                   metadata, access_count, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)""",
                (entry_id, scope, content, scope, tags_json,
                 source or self.agent_name, confidence, meta_json, now, now)
            )
            self._conn.commit()

        # Fire-and-forget embedding generation (non-blocking)
        if self._check_embeddings():
            t = threading.Thread(target=self._store_embedding, args=(entry_id, content), daemon=True)
            t.start()

        return {
            "id": entry_id, "content": content, "scope": scope,
            "tags": tags or [], "confidence": confidence,
            "source": source or self.agent_name, "created_at": now
        }

    RRF_K = 60  # Reciprocal Rank Fusion constant

    def recall(self, query: str, top_k: int = 10,
               scopes: Optional[List[str]] = None,
               min_confidence: Optional[float] = None) -> List[Dict[str, Any]]:
        """Search memories using RRF hybrid search: FTS5 + vector similarity."""

        # ── FTS5 search ──
        fts_results: Dict[str, float] = {}  # id → rank (1-based)
        try:
            safe = query.translate(str.maketrans('', '', '"*+^:~()-')).strip()
            if safe:
                rows = self._conn.execute(
                    """SELECT n.id FROM neurons n
                       JOIN neurons_fts f ON n.rowid = f.rowid
                       WHERE neurons_fts MATCH ?
                       ORDER BY rank LIMIT ?""",
                    (f'"{safe}"', top_k * 3)
                ).fetchall()
                for i, row in enumerate(rows):
                    fts_results[row["id"]] = float(i + 1)
        except (sqlite3.OperationalError, sqlite3.ProgrammingError):
            pass

        # ── Vector search ──
        vec_results: Dict[str, float] = {}  # id → rank (1-based)
        if self._check_embeddings():
            query_vec = self._generate_embedding(query)
            if query_vec:
                scored = self._vector_search(query_vec, top_k * 3)
                for i, (neuron_id, _) in enumerate(scored):
                    vec_results[neuron_id] = float(i + 1)

        # ── LIKE channel (always runs — participates in RRF fusion) ──
        like_results: Dict[str, float] = {}
        words = [w for w in query.split() if len(w) > 1]
        if words:
            clauses = " OR ".join(["content LIKE ?" for _ in words])
            params = [f"%{w}%" for w in words]
            rows = self._conn.execute(
                f"SELECT id FROM neurons WHERE {clauses} ORDER BY created_at DESC LIMIT ?",
                params + [top_k * 3]
            ).fetchall()
            for i, row in enumerate(rows):
                like_results[row["id"]] = float(i + 1)

        # ── RRF fusion ──
        all_ids = set(fts_results.keys()) | set(vec_results.keys()) | set(like_results.keys())
        if not all_ids:
            return []

        scored: List[Tuple[str, float]] = []
        for nid in all_ids:
            score = 0.0
            if nid in fts_results:
                score += 1.0 / (self.RRF_K + fts_results[nid])
            if nid in vec_results:
                score += 1.0 / (self.RRF_K + vec_results[nid])
            if nid in like_results:
                score += 0.5 / (self.RRF_K + like_results[nid])  # half weight for LIKE
            scored.append((nid, score))

        scored.sort(key=lambda x: x[1], reverse=True)

        # ── Fetch full entries ──
        top_ids = [s[0] for s in scored[:top_k * 2]]
        if not top_ids:
            return []

        placeholders = ",".join(["?" for _ in top_ids])
        rows = self._conn.execute(
            f"SELECT * FROM neurons WHERE id IN ({placeholders})",
            top_ids
        ).fetchall()

        results = [self._row_to_entry(r) for r in rows]

        # Filter
        if scopes:
            results = [r for r in results if r["scope"] in scopes]
        if min_confidence is not None:
            results = [r for r in results if r["confidence"] >= min_confidence]

        # Preserve RRF score ordering
        score_map = {s[0]: s[1] for s in scored}
        for r in results:
            r["_score"] = score_map.get(r["id"], 0)

        results.sort(key=lambda r: r.get("_score", 0), reverse=True)

        # Increment access counts (with write lock + commit)
        with self._write_lock:
            for r in results[:top_k]:
                self._conn.execute(
                    "UPDATE neurons SET access_count = access_count + 1 WHERE id = ?",
                    (r["id"],)
                )
            self._conn.commit()

        # Apply context budget guard (cap total chars)
        results = self._apply_context_budget(results[:top_k])
        return results

    # ── Context budget guard ──────────────────────────────────────────────
    # Hard cap on total chars returned by recall() so a single search
    # can't blow the system prompt. Defaults to 2000 chars (≈500 tokens).
    # If top_k results exceed the cap, lower-priority entries are dropped
    # (priority = RRF score, then recency).
    RECALL_MAX_CHARS = 2000

    def _apply_context_budget(self, results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Trim results list so total content chars <= RECALL_MAX_CHARS.

        Fills cap as much as possible — keeps adding while budget remains.
        Sorts short-first when forced to drop, so a small useful entry
        isn't replaced by a bloated one mid-list.
        """
        if not results:
            return results
        # First pass: keep everything that fits
        total = 0
        kept: List[Dict[str, Any]] = []
        deferred: List[Tuple[int, Dict[str, Any]]] = []  # (content_len, entry) that don't fit yet
        for r in results:
            content_len = len(r.get("content", "") or "")
            if total + content_len <= self.RECALL_MAX_CHARS:
                kept.append(r)
                total += content_len
            else:
                deferred.append((content_len, r))
        # Second pass: try to fill remaining budget with small deferred entries
        remaining = self.RECALL_MAX_CHARS - total
        if remaining > 0 and deferred:
            deferred.sort(key=lambda x: x[0])  # shortest first
            for content_len, r in deferred:
                if content_len <= remaining:
                    kept.append(r)
                    remaining -= content_len
                else:
                    break
        return kept

    def bootstrap(self, max_entries: int = 10) -> List[Dict[str, Any]]:
        """Load startup context: top accessed + most recent, preferring semantic types."""
        # Fix #4: prioritize non-observation types for bootstrap quality
        top = self._conn.execute(
            """SELECT * FROM neurons
               ORDER BY CASE WHEN type = 'observation' THEN 1 ELSE 0 END ASC,
                        access_count DESC, created_at DESC LIMIT ?""",
            (max_entries,)
        ).fetchall()
        recent = self._conn.execute(
            """SELECT * FROM neurons
               ORDER BY CASE WHEN type = 'observation' THEN 1 ELSE 0 END ASC,
                        created_at DESC LIMIT ?""",
            (max_entries,)
        ).fetchall()

        seen = set()
        results = []
        for rows in [top, recent]:
            for r in rows:
                if r["id"] not in seen:
                    seen.add(r["id"])
                    results.append(self._row_to_entry(r))
        # Cap total chars to RECALL_MAX_CHARS (session-start shouldn't blow prompt)
        return self._apply_context_budget(results[:max_entries])

    def forget(self, entry_id: str) -> None:
        """Delete a memory entry by ID."""
        with self._write_lock:
            self._conn.execute("DELETE FROM neurons WHERE id = ?", (entry_id,))
            self._conn.commit()

    # ── CRUD extensions ────────────────────────────────────────────────────

    def update(self, entry_id: str, content: Optional[str] = None,
               confidence: Optional[float] = None,
               tags: Optional[List[str]] = None) -> Optional[Dict[str, Any]]:
        """Update an existing entry."""
        existing = self._conn.execute(
            "SELECT * FROM neurons WHERE id = ?", (entry_id,)
        ).fetchone()
        if not existing:
            return None

        now = datetime.now(timezone.utc).isoformat()
        new_content = content or existing["content"]
        new_confidence = confidence if confidence is not None else existing["confidence"]
        new_tags = json.dumps(tags) if tags is not None else existing["tags"]

        with self._write_lock:
            self._conn.execute(
                """UPDATE neurons SET content = ?, confidence = ?, tags = ?,
                   updated_at = ? WHERE id = ?""",
                (new_content, new_confidence, new_tags, now, entry_id)
            )
            self._conn.commit()
        return self._row_to_entry(
            self._conn.execute("SELECT * FROM neurons WHERE id = ?", (entry_id,)).fetchone()
        )

    def invalidate(self, entry_id: str, reason: str = "") -> None:
        """Mark entry as superseded (confidence → 0)."""
        with self._write_lock:
            self._conn.execute(
                "UPDATE neurons SET confidence = 0, metadata = json_set(metadata, '$.invalidated_reason', ?) WHERE id = ?",
                (reason, entry_id)
            )
            self._conn.commit()

    # ── Knowledge graph (synapses) ─────────────────────────────────────────

    def triple_add(self, source_id: str, target_id: str,
                   rel_type: str, weight: float = 1.0) -> str:
        """Add a synapse (knowledge graph edge)."""
        sid = str(uuid.uuid4())
        with self._write_lock:
            self._conn.execute(
                """INSERT INTO synapses (id, source_id, target_id, type, weight, metadata)
                   VALUES (?, ?, ?, ?, ?, '{}')""",
                (sid, source_id, target_id, rel_type, weight)
            )
            self._conn.commit()
        return sid

    def triple_query(self, neuron_id: str) -> List[Dict[str, Any]]:
        """Get all synapses connected to a neuron."""
        rows = self._conn.execute(
            "SELECT * FROM synapses WHERE source_id = ? OR target_id = ?",
            (neuron_id, neuron_id)
        ).fetchall()
        return [dict(r) for r in rows]

    # ── Scratchpad ─────────────────────────────────────────────────────────

    def scratchpad_write(self, key: str, content: str) -> None:
        """Write to temporary scratchpad (stored as ephemeral neuron)."""
        self.remember(
            content=content,
            scope="scratchpad",
            tags=[f"scratchpad:{key}"],
            confidence=1.0,
            metadata={"scratchpad_key": key, "ephemeral": True}
        )

    def scratchpad_read(self, key: str) -> Optional[str]:
        """Read from scratchpad."""
        rows = self._conn.execute(
            """SELECT content FROM neurons
               WHERE scope = 'scratchpad'
               AND json_extract(tags, '$[0]') = ?
               ORDER BY created_at DESC LIMIT 1""",
            (f"scratchpad:{key}",)
        ).fetchall()
        return rows[0]["content"] if rows else None

    def scratchpad_clear(self, key: Optional[str] = None) -> int:
        """Clear scratchpad entries."""
        if key:
            cursor = self._conn.execute(
                "DELETE FROM neurons WHERE scope = 'scratchpad' AND json_extract(tags, '$[0]') = ?",
                (f"scratchpad:{key}",)
            )
        else:
            cursor = self._conn.execute("DELETE FROM neurons WHERE scope = 'scratchpad'")
        self._conn.commit()
        return cursor.rowcount

    # ── Import/Export ──────────────────────────────────────────────────────

    def export_all(self) -> List[Dict[str, Any]]:
        """Export all memories as JSON."""
        rows = self._conn.execute(
            "SELECT * FROM neurons ORDER BY created_at"
        ).fetchall()
        return [self._row_to_entry(r) for r in rows]

    def import_entries(self, entries: List[Dict[str, Any]]) -> int:
        """Import entries from JSON. Deduplicates by content hash."""
        count = 0
        for entry in entries:
            content_hash = hashlib.sha256(
                entry["content"].encode()
            ).hexdigest()[:16]

            existing = self._conn.execute(
                "SELECT id FROM neurons WHERE id = ?", (f"import_{content_hash}",)
            ).fetchone()
            if existing:
                continue

            self._conn.execute(
                """INSERT INTO neurons (id, type, content, scope, tags, source,
                   confidence, metadata, access_count, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)""",
                (
                    f"import_{content_hash}",
                    entry.get("scope", "observation"),
                    entry["content"],
                    entry.get("scope", "observation"),
                    json.dumps(entry.get("tags", [])),
                    entry.get("source", "import"),
                    entry.get("confidence", 0.5),
                    json.dumps(entry.get("metadata", {})),
                    entry.get("created_at", datetime.now(timezone.utc).isoformat()),
                    datetime.now(timezone.utc).isoformat(),
                )
            )
            count += 1
        self._conn.commit()
        return count

    # ── Stats & Diagnostics ────────────────────────────────────────────────

    def stats(self) -> Dict[str, Any]:
        """Memory statistics for this agent."""
        total = self._conn.execute("SELECT COUNT(*) as c FROM neurons").fetchone()["c"]
        by_scope = self._conn.execute(
            "SELECT scope, COUNT(*) as c FROM neurons GROUP BY scope ORDER BY c DESC"
        ).fetchall()
        synapses = self._conn.execute("SELECT COUNT(*) as c FROM synapses").fetchone()["c"]
        avg_confidence = self._conn.execute(
            "SELECT AVG(confidence) as c FROM neurons"
        ).fetchone()["c"] or 0

        return {
            "agent": self.agent_name,
            "total_entries": total,
            "synapses": synapses,
            "avg_confidence": round(avg_confidence, 2),
            "by_scope": {r["scope"]: r["c"] for r in by_scope},
            "db_path": self.db_path,
        }

    def diagnose(self) -> Dict[str, Any]:
        """Run diagnostics — check DB health, orphans, FTS state."""
        issues = []

        # Check DB exists
        if not Path(self.db_path).exists():
            return {"healthy": False, "issues": ["Database file not found"]}

        # Check FTS
        try:
            fts_count = self._conn.execute(
                "SELECT COUNT(*) as c FROM neurons_fts"
            ).fetchone()["c"]
        except sqlite3.OperationalError:
            fts_count = -1
            issues.append("FTS5 not available")

        # Check orphan synapses
        orphans = self._conn.execute("""
            SELECT COUNT(*) as c FROM synapses s
            WHERE NOT EXISTS (SELECT 1 FROM neurons n WHERE n.id = s.source_id)
               OR NOT EXISTS (SELECT 1 FROM neurons n WHERE n.id = s.target_id)
        """).fetchone()["c"]
        if orphans > 0:
            issues.append(f"{orphans} orphan synapses")

        return {
            "healthy": len(issues) == 0,
            "issues": issues,
            "fts_entries": fts_count,
            "db_size_bytes": Path(self.db_path).stat().st_size if Path(self.db_path).exists() else 0,
        }

    def list_all(self, scope: Optional[str] = None, limit: int = 100,
                 offset: int = 0) -> List[Dict[str, Any]]:
        """List all memory entries, optionally filtered by scope."""
        if scope:
            rows = self._conn.execute(
                "SELECT * FROM neurons WHERE scope = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (scope, limit, offset)
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM neurons ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (limit, offset)
            ).fetchall()
        return [self._row_to_entry(r) for r in rows]

    def agent_status(self) -> Dict[str, Any]:
        """Overall agent memory health."""
        stats = self.stats()
        diag = self.diagnose()
        return {
            "agent": self.agent_name,
            "healthy": diag["healthy"],
            "stats": stats,
            "diagnostics": diag,
        }

    # ── Helpers ────────────────────────────────────────────────────────────

    def _row_to_entry(self, row: sqlite3.Row) -> Dict[str, Any]:
        d = dict(row)
        tags = []
        try:
            tags = json.loads(d.get("tags") or "[]")
        except (json.JSONDecodeError, TypeError):
            pass
        metadata = {}
        try:
            metadata = json.loads(d.get("metadata") or "{}")
        except (json.JSONDecodeError, TypeError):
            pass
        return {
            "id": d["id"],
            "content": d["content"],
            "scope": d.get("scope") or d.get("type", "observation"),
            "tags": tags,
            "confidence": d.get("confidence", 0.5),
            "source": d.get("source") or self.agent_name,
            "created_at": d.get("created_at", ""),
            "updated_at": d.get("updated_at"),
            "access_count": d.get("access_count", 0),
            "metadata": metadata,
        }
