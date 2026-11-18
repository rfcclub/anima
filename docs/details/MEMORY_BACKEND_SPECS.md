# MEMORY_BACKEND_SPECS

Technical specifications for the three memory backends that implement the `AgentMemoryStore` contract.

## BrunoEntityAdapter

**Neural graph memory** for Bruno. Shells out to external scripts.

**recall.mjs interface**:
```
node <entity-root>/scripts/recall.mjs --query Q --topK N
```
Outputs JSON:
```json
{
  "query": "Q",
  "confidence": "high" | "medium" | "low",
  "neurons": [
    { "id": "uuid", "content": "...", "type": "observation",
      "activation": 0.85, "metadata": {} }
  ],
  "recalledIds": ["uuid", ...]
}
```

**Confidence mapping**: `"high" -> 0.9`, `"medium" -> 0.6`, `"low" -> 0.3`.

**inbox_writer.py args**:
```
python3 inbox_writer.py --type OBSERVATION --content "..." --confidence 0.8 -- --tags tag1 tag2
```
Security: tag values starting with `-` are rejected. `--` separator prevents argument injection.

## AbelMemAdapter

**HTTP service** for 2B. Wraps `AbelMemService` at `http://127.0.0.1:3579`.

**Auth flow**: Bearer token from `BEARER_2B_TOKEN` env var or auto-generated UUID. Token rotation via `rotateBearerToken()`.

**Endpoints**:
| Method | Path | Timeout |
|--------|------|---------|
| GET | /health | 5s |
| POST | /api/memory | 10s |
| GET | /api/memory?q=&topK= | 10s |
| POST | /api/bootstrap | 10s |
| POST | /api/dream | 30s |

**Error handling**: On any failure (non-ok status, timeout, network error), `engineAvailable` is set to `false`. All subsequent calls return empty/error stubs until next restart.

## AnimaEntityStore

**Local SQLite** with hybrid search. Used by the colony as a shared or per-agent store.

**Schema**: `neurons` (id, type, content, scope, tags, source, confidence, access_count, timestamps), `synapses` (source_id, target_id, type, weight), `neurons_fts` (FTS5 virtual table on content), `embeddings` (neuron_id, embedding BLOB).

**WAL mode**: `PRAGMA journal_mode=WAL` for concurrent read/write. FTS sync triggers on insert/update/delete.

**Full-text search**: FTS5 with `MATCH ?`. Query characters `["'*+^:~()-]` are stripped. Results are ranked by FTS rank.

**Hybrid RRF search**: FTS + optional Gemini Embedding 2 semantic search combined via Reciprocal Rank Fusion (`RRF_K=60`). Graceful fallback to FTS-only when embeddings are unavailable.

**Scope filtering**: results are post-filtered by `options.scopes` array if provided. Confidence threshold is applied after scoping.
