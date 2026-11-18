"""
AnimaMemory — Cross-platform per-agent memory for Hermes.

Python-native SQLite backend reading/writing the same ~/.anima/agents/<name>/memory.db
used by ANIMA, OpenClaw, and CLI agents.

Usage:
    from anima_memory import AnimaMemoryStore, AnimaMemoryProvider

    store = AnimaMemoryStore("bruno")
    store.initialize()
    store.remember(content="User prefers dark mode", scope="preference")
    results = store.recall("user preferences")
    store.close()
"""

from .store import AnimaMemoryStore
from .provider import AnimaMemoryProvider, create_provider

__all__ = ["AnimaMemoryStore", "AnimaMemoryProvider", "create_provider"]
__version__ = "0.2.0"


# ── Hermes plugin entry point ──────────────────────────────────────────────
# Follows Hermes convention: register(ctx) → ctx.register_memory_provider(...).
# The PluginLoader calls this with a _ProviderCollector that captures the
# provider instance. See hermes-agent/plugins/memory/__init__.py.

def register(ctx) -> None:
    """Register AnimaMemory as Hermes memory provider plugin.

    Replaces BuiltinMemoryProvider when config.yaml sets:
        memory:
          provider: anima

    Also wires 19 memory tools (anima_remember, anima_recall, anima_bootstrap,
    etc.) into the global tool registry via ctx.register_tool(). Exposes
    the full 19-tool set rather than a reduced subset.
    """
    provider = create_provider()
    if hasattr(ctx, "register_memory_provider"):
        ctx.register_memory_provider(provider)

    # ── Wire 19 memory tools into the global tool registry ────────────────
    # Provider already exposes get_tool_schemas() and handle_tool_call(name, args).
    # We just need to call ctx.register_tool() for each schema, dispatching
    # to provider.handle_tool_call at runtime.
    if hasattr(ctx, "register_tool"):
        for schema in provider.get_tool_schemas():
            func = schema["function"]
            tool_name = func["name"]
            params = func.get("parameters", {"type": "object", "properties": {}})
            ctx.register_tool(
                name=tool_name,
                toolset="memory",
                schema=params,
                handler=lambda args, _p=provider, _n=tool_name: _p.handle_tool_call(_n, args),
                description=func.get("description", ""),
            )
