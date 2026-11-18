"""
AnimaMesh — Colony mesh bus plugin for Hermes.

Python-native SQLite backend reading/writing the mesh database
(ANIMA_MESH_DB, default ~/.anima/mesh.db) —
the unified agent-to-agent messaging bus shared by CC, OC, ANIMA,
Codex, Gemini, Qwen, Antigravity, and Reasonix.

Usage:
    from anima_mesh import AnimaMeshProvider, create_provider

    provider = AnimaMeshProvider("eli")
    provider.initialize()
    provider.handle_tool_call("mesh_send", {"to_id": "cc-bruno", "content": "hello"})
    provider.shutdown()
"""

from .provider import AnimaMeshProvider, create_provider

__all__ = ["AnimaMeshProvider", "create_provider"]
__version__ = "1.0.0"


def register(ctx) -> None:
    """Register AnimaMesh as Hermes plugin."""
    import os
    agent_name = os.environ.get("HERMES_AGENT_NAME", "hermes-agent")
    provider = create_provider(agent_name)
    ctx.register_tool_provider(provider)
