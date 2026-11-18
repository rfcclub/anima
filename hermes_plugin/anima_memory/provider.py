"""
AnimaMemoryProvider — Hermes MemoryProvider plugin.

Wraps AnimaMemoryStore (Python-native SQLite) as a Hermes memory provider.
Exposes 23 tools + 3 hooks (pre_llm_call, on_session_start, post_tool_call).

Pattern follows mnemosyne's Hermes memory provider integration.
"""

import hashlib
import json
import os
from pathlib import Path
from typing import Optional, List, Dict, Any

from .store import AnimaMemoryStore


class AnimaMemoryProvider:
    """
    Hermes memory provider backed by AnimaMemoryStore.

    Implements the Hermes MemoryProvider interface:
      - get_tool_schemas() → 23 tool definitions
      - handle_tool_call(name, args) → dispatch to store method
      - system_prompt_block() → static guidance text
      - prefetch(query) → recall memory context
      - sync_turn(user_msg, assistant_msg) → record cross-session summary
    """

    def __init__(self, agent_name: Optional[str] = None):
        self.agent_name = agent_name or os.environ.get("HERMES_AGENT_NAME", "hermes-agent")
        self.store = AnimaMemoryStore(self.agent_name)
        self._initialized = False
        self._session_id: Optional[str] = None

    @property
    def name(self) -> str:
        """Short identifier for this provider (Hermes MemoryProvider abstract).

        Required by `agent.memory_provider.MemoryProvider` ABC. The plugin
        discovery loader probes this attribute during init — missing it
        causes `AttributeError: 'X' object has no attribute 'name'` and
        silently falls back to BuiltinMemoryProvider.
        """
        return "anima_memory"

    def is_available(self) -> bool:
        """Hermes plugin loader probes this to decide if the provider is usable.

        Returns True if the underlying AnimaMemoryStore was constructed and
        the SQLite database is reachable. We don't require initialize() to
        have been called — that's lazy.
        """
        try:
            return self.store is not None and Path(self.store.db_path).exists()
        except Exception:
            return False

    # ── Lifecycle ───────────────────────────────────────────────────────────

    def initialize(self, session_id: str = "", **kwargs) -> None:
        """Called once at agent startup by Hermes MemoryProvider ABC.

        Signature matches the abstract method: (session_id, **kwargs).
        kwargs may include hermes_home, platform, agent_context, agent_identity,
        agent_workspace, parent_session_id, user_id — we accept but don't
        require them (AnimaMemoryStore is per-agent at ~/.anima/agents/<name>/).
        """
        self._session_id = session_id or None
        if not self._initialized:
            self.store.initialize()
            self._initialized = True

    def shutdown(self) -> None:
        self.store.close()

    # ── MemoryProvider interface ───────────────────────────────────────────

    def system_prompt_block(self) -> str:
        return (
            "You have access to AnimaMemoryStore — a cross-platform memory system "
            "shared with your instances on ANIMA, OpenClaw, and CLI. "
            "Use anima_remember to persist important facts and preferences. "
            "Use anima_recall to search your memory before asking the user to repeat themselves. "
            "Use anima_bootstrap at session start to load recent context."
        )

    # Scopes worth surfacing in context (excludes raw observations)
    _QUALITY_SCOPES = {
        "semantic", "episodic", "episode", "fact", "preference",
        "insight", "aspiration", "scar", "identity", "decision",
        "project", "growth_ring",
    }

    def prefetch(self, query: str, *, session_id: Optional[str] = None) -> str:
        """Called before each LLM call. Returns memory context to inject."""
        if not self._initialized:
            return ""

        try:
            # Fix #3: fetch more candidates, then filter to quality scopes only
            top_k = max(8, min(15, len(query.split()) // 3 + 6))
            entries = self.store.recall(query, top_k=top_k)
            # Prefer quality scopes; fall back to any if nothing matches
            quality = [e for e in entries if e.get("scope") in self._QUALITY_SCOPES]
            display = quality[:6] if quality else entries[:4]
            if not display:
                return ""
            lines = ["[Memory Context]"]
            for e in display:
                scope_tag = f"[{e['scope']}]" if e.get("scope") else ""
                lines.append(f"- {scope_tag} {e['content']}")
            return "\n".join(lines)
        except Exception as e:
            return f"[Memory recall unavailable: {e}]"

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: Optional[str] = None) -> None:
        """Called after each completed turn. Batch-records every 5 turns with actual content.

        Captures user + assistant content (truncated) so recall() returns searchable signal
        instead of empty label placeholders. Each batch = 5 turns → 1 episode entry.
        """
        if not self._initialized:
            return

        # Increment turn counter; only persist every Nth turn
        self._turn_count = getattr(self, '_turn_count', 0) + 1
        if self._turn_count % 5 != 0:
            return

        try:
            turn_start = self._turn_count - 4
            turn_end = self._turn_count

            # Truncate aggressively — recall() top_k=5 will surface this entry;
            # we want a searchable summary, not a transcript dump.
            u = (user_content or "").strip().replace("\n", " ")[:300]
            a = (assistant_content or "").strip().replace("\n", " ")[:500]

            if not u and not a:
                # No content captured — skip rather than write empty entry
                return

            combined = (
                f"Turn batch {turn_start}-{turn_end} "
                f"(session {session_id or 'unknown'}):\n"
                f"USER: {u}\n"
                f"ASSISTANT: {a}"
            )
            # Fix #2: if assistant content is clean text (no toolCall JSON),
            # store as semantic with higher confidence
            has_tool_noise = '"toolCall"' in a or '"type":"toolCall"' in a
            scope = "episode" if has_tool_noise else "semantic"
            confidence = 0.5 if has_tool_noise else 0.65
            self.store.remember(
                content=combined,
                scope=scope,
                confidence=confidence,
                tags=["conversation-batch", f"turn-{turn_start}-{turn_end}"],
            )
        except Exception:
            pass  # fire-and-forget

    # ── Hook callbacks ─────────────────────────────────────────────────────

    def on_session_start(self, session_id: str, **kwargs) -> Optional[str]:
        """Hook: bootstrap memory on session start. Accepts **kwargs for forward-compat."""
        if not self._initialized:
            return None
        try:
            entries = self.store.bootstrap(max_entries=10)
            if not entries:
                return None
            lines = ["[Boot Context — Recent Memories]"]
            for e in entries:
                lines.append(f"- {e['content'][:200]}")
            return "\n".join(lines)
        except Exception:
            return None

    def pre_llm_call(self, user_message: str, **kwargs) -> Optional[str]:
        """Hook: inject memory context before LLM call."""
        return self.prefetch(user_message)

    def post_tool_call(self, tool_name: str, tool_args: Dict[str, Any],
                       tool_result: Any, **kwargs) -> None:
        """Hook: record significant tool results (deduplicated, size-gated)."""
        if not self._initialized:
            return
        # Only track file-creating mutations with meaningful output
        if tool_name not in ("write_file", "edit"):
            return
        if isinstance(tool_result, dict) and tool_result.get("error"):
            return

        # Extract path from args (common patterns)
        path = tool_args.get("file_path") or tool_args.get("path") or ""
        if not path:
            return

        # Dedup: skip if this path was recorded in the last 5 minutes
        recent = self.store.recall(f"Tool write_file: {path}", top_k=1)
        for r in recent:
            if "write_file" in r.get("content", ""):
                try:
                    from datetime import datetime, timezone, timedelta
                    created = datetime.fromisoformat(r["created_at"].replace("Z", "+00:00"))
                    if datetime.now(timezone.utc) - created < timedelta(minutes=5):
                        return  # already recorded recently
                except Exception:
                    pass

        try:
            summary = f"Tool {tool_name}: {path}"
            self.store.remember(
                content=summary,
                scope="observation",
                confidence=0.4,
                tags=["tool-result", tool_name],
            )
        except Exception:
            pass

    # ── Tool schemas (23 tools) ────────────────────────────────────────────

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        """Return tool definitions for the Hermes tool registry."""
        return [
            # ── Core memory ──
            self._tool("anima_remember", "Store a memory in your cross-platform memory.",
                       {"content": {"type": "string", "description": "The fact or memory to store"},
                        "scope": {"type": "string", "description": "Scope: fact, preference, observation, episode, decision"},
                        "confidence": {"type": "number", "description": "Confidence 0-1"},
                        "tags": {"type": "array", "items": {"type": "string"}}},
                       required=["content"]),
            self._tool("anima_recall", "Search your cross-platform memory.",
                       {"query": {"type": "string", "description": "Search query"},
                        "top_k": {"type": "integer", "description": "Max results"},
                        "scope": {"type": "string", "description": "Filter by scope"}},
                       required=["query"]),
            self._tool("anima_bootstrap", "Load recent context from memory for session start."),
            self._tool("anima_forget", "Delete a memory entry by ID.",
                       {"id": {"type": "string", "description": "Memory entry ID"}},
                       required=["id"]),
            self._tool("anima_update", "Update an existing memory entry.",
                       {"id": {"type": "string"}, "content": {"type": "string"},
                        "confidence": {"type": "number"}, "tags": {"type": "array", "items": {"type": "string"}}},
                       required=["id"]),
            self._tool("anima_invalidate", "Mark a memory as superseded.",
                       {"id": {"type": "string"}, "reason": {"type": "string"}},
                       required=["id"]),
            self._tool("anima_memory_list", "List all memories, optionally filtered by scope.",
                       {"scope": {"type": "string"}, "limit": {"type": "integer"}, "offset": {"type": "integer"}}),

            # ── Stats & diagnostics ──
            self._tool("anima_stats", "Show memory statistics for your agent."),
            self._tool("anima_diagnose", "Run diagnostics on your memory database."),
            self._tool("anima_agent_status", "Show overall agent memory health."),

            # ── Knowledge graph ──
            self._tool("anima_triple_add", "Add a knowledge graph edge between two memories.",
                       {"source_id": {"type": "string"}, "target_id": {"type": "string"},
                        "type": {"type": "string"}, "weight": {"type": "number"}},
                       required=["source_id", "target_id", "type"]),
            self._tool("anima_triple_query", "Query the knowledge graph for a memory.",
                       {"id": {"type": "string", "description": "Neuron/memory ID"}},
                       required=["id"]),

            # ── Scratchpad ──
            self._tool("anima_scratchpad_write", "Write to temporary scratchpad workspace.",
                       {"key": {"type": "string"}, "content": {"type": "string"}}),
            self._tool("anima_scratchpad_read", "Read from scratchpad.",
                       {"key": {"type": "string"}}),
            self._tool("anima_scratchpad_clear", "Clear scratchpad entries.",
                       {"key": {"type": "string", "description": "Optional: clear specific key"}}),

            # ── Import/Export ──
            self._tool("anima_export", "Export all memories as JSON."),
            self._tool("anima_import", "Import memories from JSON array.",
                       {"entries": {"type": "array", "description": "Array of memory entry objects"}}),

            # ── Context engine (stubs — full impl in Phase 5) ──
            self._tool("anima_context_search", "Search conversation history (FTS5 across neurons).",
                       {"query": {"type": "string"}, "limit": {"type": "integer"}}),

            # ── Consolidation ──
            self._tool("anima_sleep", "Run memory consolidation — cross-session summary + cleanup."),
        ]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any]) -> Any:
        """Dispatch a tool call to the store."""
        if tool_name == "anima_remember":
            return self.store.remember(
                content=args["content"],
                scope=args.get("scope", "observation"),
                confidence=args.get("confidence", 0.5),
                tags=args.get("tags", []),
            )
        elif tool_name == "anima_recall":
            return self.store.recall(
                query=args["query"],
                top_k=args.get("top_k", 10),
                scopes=[args["scope"]] if args.get("scope") else None,
            )
        elif tool_name == "anima_bootstrap":
            return self.store.bootstrap(max_entries=args.get("max_entries", 10))
        elif tool_name == "anima_forget":
            self.store.forget(args["id"])
            return {"status": "forgotten"}
        elif tool_name == "anima_update":
            return self.store.update(
                entry_id=args["id"],
                content=args.get("content"),
                confidence=args.get("confidence"),
                tags=args.get("tags"),
            )
        elif tool_name == "anima_invalidate":
            self.store.invalidate(args["id"], args.get("reason", ""))
            return {"status": "invalidated"}
        elif tool_name == "anima_memory_list":
            return self.store.list_all(
                scope=args.get("scope"),
                limit=args.get("limit", 100),
                offset=args.get("offset", 0),
            )
        elif tool_name == "anima_stats":
            return self.store.stats()
        elif tool_name == "anima_diagnose":
            return self.store.diagnose()
        elif tool_name == "anima_agent_status":
            return self.store.agent_status()
        elif tool_name == "anima_triple_add":
            return {"id": self.store.triple_add(
                source_id=args["source_id"],
                target_id=args["target_id"],
                rel_type=args["type"],
                weight=args.get("weight", 1.0),
            )}
        elif tool_name == "anima_triple_query":
            return self.store.triple_query(args["id"])
        elif tool_name == "anima_scratchpad_write":
            self.store.scratchpad_write(args["key"], args["content"])
            return {"status": "written"}
        elif tool_name == "anima_scratchpad_read":
            content = self.store.scratchpad_read(args["key"])
            return {"content": content} if content else {"status": "not_found"}
        elif tool_name == "anima_scratchpad_clear":
            count = self.store.scratchpad_clear(args.get("key"))
            return {"status": "cleared", "count": count}
        elif tool_name == "anima_export":
            return self.store.export_all()
        elif tool_name == "anima_import":
            count = self.store.import_entries(args["entries"])
            return {"status": "imported", "count": count}
        elif tool_name == "anima_sleep":
            # Consolidation: remove low-confidence + duplicate content
            all_entries = self.store.list_all(limit=10000)
            seen = set()
            removed = 0
            for entry in all_entries:
                # Remove entries with confidence < 0.2
                if entry.get("confidence", 0.5) < 0.2:
                    self.store.forget(entry["id"])
                    removed += 1
                    continue
                # Dedup by content prefix hash
                key = hashlib.sha256(entry["content"][:100].encode()).hexdigest()[:12]
                if key in seen:
                    self.store.forget(entry["id"])
                    removed += 1
                else:
                    seen.add(key)
            stats = self.store.stats()
            return {"status": "consolidated", "removed": removed, "stats": stats}
        elif tool_name == "anima_context_search":
            return self.store.recall(
                query=args["query"],
                top_k=args.get("limit", 10),
            )
        else:
            return {"error": f"Unknown tool: {tool_name}"}

    # ── Internal ───────────────────────────────────────────────────────────

    def _tool(self, name: str, description: str,
              properties: Optional[Dict[str, Any]] = None,
              required: Optional[List[str]] = None) -> Dict[str, Any]:
        schema: Dict[str, Any] = {
            "type": "function",
            "function": {
                "name": name,
                "description": description,
            }
        }
        if properties:
            params: Dict[str, Any] = {
                "type": "object",
                "properties": properties,
            }
            if required:
                params["required"] = required
            schema["function"]["parameters"] = params
        return schema


# ── Hermes Plugin Loader ──────────────────────────────────────────────────
# Hermes auto-discovers plugins via the create_provider() entry point.
# This function replaces BuiltinMemoryProvider when configured.

def create_provider(agent_name: Optional[str] = None, **kwargs) -> AnimaMemoryProvider:
    """
    Hermes plugin entry point.

    Called by Hermes MemoryManager when memory.provider = 'anima'.
    Returns a fully initialized AnimaMemoryProvider ready to replace
    BuiltinMemoryProvider as the external memory backend.
    """
    name = agent_name or os.environ.get("HERMES_AGENT_NAME", "hermes-agent")
    provider = AnimaMemoryProvider(name)
    provider.initialize()
    return provider

