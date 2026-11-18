/**
 * One-way sync: a Hindsight bank -> neurons in an agent's memory.db.
 *
 * memory.db stays the store of record; Hindsight is only a source of neurons.
 * Generalizes ~/.hermes/scripts/hindsight-to-memorydb-sync.py (ivan only).
 */

export const MAX_ENTITY_GROUP = 12;
const PAGE_SIZE = 100;
const GENERIC_ENTITIES = new Set(["user", "assistant", "agent", "ai", "human", "the user"]);

export class HindsightSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HindsightSyncError";
  }
}

export interface NewNeuron {
  type: string;
  scope: string;
  content: string;
  tags: string[];
  source: string;
  confidence: number;
  metadata: Record<string, unknown>;
  createdAt?: string;
}

export interface SyncSink {
  /** hindsight id -> neuron id for neurons that already exist */
  existing(): Map<string, string>;
  addNeuron(n: NewNeuron): string;
  addSynapse(sourceId: string, targetId: string, type: string, weight: number, metadata: Record<string, unknown>): void;
  /** Run the whole write phase atomically; a throw must roll back every neuron and synapse written inside. */
  transaction?<T>(fn: () => T): T;
  /** Settle background work (embeddings) started by addNeuron; awaited before the caller closes the store. */
  flush?(): Promise<void>;
}

export interface SyncOptions {
  bank: string;
  agent: string;
  apiUrl: string;
  apiToken?: string;
  sink: SyncSink;
  apply: boolean;
  factType?: string;
  fetchFn?: typeof fetch;
}

export interface SyncReport {
  scanned: number;
  created: number;
  skipped: number;
  synapses: number;
  applied: boolean;
}

export interface EntityPair {
  a: string;
  b: string;
  entity: string;
}

/** Normalize and split the entity field (comma string or list). */
export function parseEntities(raw: unknown): string[] {
  const parts: string[] = [];
  if (Array.isArray(raw)) {
    for (const e of raw) {
      if (typeof e === "string") parts.push(e);
      else if (e && typeof e === "object") parts.push(String((e as { name?: unknown; id?: unknown }).name ?? (e as { id?: unknown }).id ?? ""));
    }
  } else if (typeof raw === "string") {
    parts.push(...raw.split(","));
  }
  return [...new Set(parts.map((p) => p.trim().toLowerCase()).filter((p) => p && !GENERIC_ENTITIES.has(p)))];
}

/**
 * Pairs of keys that share a non-generic entity held by at most MAX_ENTITY_GROUP keys.
 * One pair per two keys, labelled with the first shared entity (alphabetical).
 */
export function entityPairs(items: Array<{ key: string; entities: string[] }>): EntityPair[] {
  const groups = new Map<string, string[]>();
  for (const it of items) {
    for (const e of parseEntities(it.entities)) {
      const g = groups.get(e) ?? [];
      g.push(it.key);
      groups.set(e, g);
    }
  }
  const seen = new Map<string, EntityPair>();
  for (const [entity, keys] of [...groups.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    if (keys.length < 2 || keys.length > MAX_ENTITY_GROUP) continue;
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const [a, b] = keys[i]! < keys[j]! ? [keys[i]!, keys[j]!] : [keys[j]!, keys[i]!];
        const id = `${a}\u0000${b}`;
        if (!seen.has(id)) seen.set(id, { a, b, entity });
      }
    }
  }
  return [...seen.values()];
}

interface HindsightItem {
  id?: unknown;
  text?: unknown;
  content?: unknown;
  entities?: unknown;
  mentioned_at?: unknown;
  occurred_start?: unknown;
  date?: unknown;
}

async function fetchAll(opts: SyncOptions, factType: string): Promise<HindsightItem[]> {
  const f = opts.fetchFn ?? fetch;
  const base = opts.apiUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.apiToken) headers.Authorization = `Bearer ${opts.apiToken}`;
  const out: HindsightItem[] = [];
  for (let offset = 0; ; offset = out.length) {
    const url = `${base}/v1/default/banks/${encodeURIComponent(opts.bank)}/memories/list?type=${encodeURIComponent(factType)}&limit=${PAGE_SIZE}&offset=${offset}`;
    let res: Response;
    try {
      res = await f(url, { headers });
    } catch (err) {
      throw new HindsightSyncError(`hindsight request failed: ${err instanceof Error ? err.name : "error"}`);
    }
    if (!res.ok) throw new HindsightSyncError(`hindsight returned status ${res.status}`);
    let body: { items?: HindsightItem[]; total?: unknown };
    try {
      body = (await res.json()) as { items?: HindsightItem[]; total?: unknown };
    } catch {
      throw new HindsightSyncError("hindsight returned invalid JSON");
    }
    const items = Array.isArray(body.items) ? body.items : [];
    out.push(...items);
    // The server may cap a page below PAGE_SIZE, so trust `total` when it is given.
    if (items.length === 0 || (typeof body.total === "number" ? out.length >= body.total : items.length < PAGE_SIZE)) break;
  }
  return out;
}

export async function syncHindsightBank(opts: SyncOptions): Promise<SyncReport> {
  const factType = opts.factType ?? "experience";
  // Fetch everything before writing anything: a failed page leaves memory.db untouched.
  const items = await fetchAll(opts, factType);
  const existing = opts.sink.existing();

  let skipped = 0;
  const fresh: Array<{ hid: string; text: string; entitiesRaw: string; entities: string[]; occurred: string }> = [];
  const known: Array<{ hid: string; entities: string[] }> = [];
  for (const it of items) {
    const hid = typeof it.id === "string" ? it.id : typeof it.id === "number" && Number.isFinite(it.id) ? String(it.id) : "";
    const text = String(it.text ?? it.content ?? "").trim();
    if (!hid || !text) {
      skipped++;
      continue;
    }
    const entitiesRaw = Array.isArray(it.entities) ? parseEntities(it.entities).join(", ") : String(it.entities ?? "");
    const entities = parseEntities(it.entities);
    if (existing.has(hid)) {
      known.push({ hid, entities });
      continue;
    }
    const occurred = String(it.occurred_start ?? it.mentioned_at ?? it.date ?? new Date().toISOString());
    fresh.push({ hid, text, entitiesRaw, entities, occurred });
  }

  const freshIds = new Set(fresh.map((f) => f.hid));
  const pairs = entityPairs([...known, ...fresh].map((x) => ({ key: x.hid, entities: x.entities }))).filter(
    (p) => freshIds.has(p.a) || freshIds.has(p.b),
  );

  if (opts.apply) {
    const write = () => {
      const idByHid = new Map(existing);
      for (const f of fresh) {
        const id = opts.sink.addNeuron({
          type: "hindsight-sync",
          scope: opts.agent,
          content: f.text,
          tags: ["hindsight", factType, "episodic", "migrated"],
          source: `hindsight:${f.hid}`,
          confidence: 0.95,
          metadata: { hindsight_id: f.hid, entities: f.entitiesRaw, fact_type: factType, occurred_at: f.occurred },
        });
        idByHid.set(f.hid, id);
      }
      for (const p of pairs) {
        const a = idByHid.get(p.a);
        const b = idByHid.get(p.b);
        if (a && b) opts.sink.addSynapse(a, b, "co_entity", 0.5, { entity: p.entity });
      }
    };
    // Neurons and their synapses land together or not at all: a rerun only links pairs that include a NEW neuron,
    // so a half-written run would lose its synapses for good.
    if (opts.sink.transaction) opts.sink.transaction(write);
    else write();
    await opts.sink.flush?.();
  }

  return { scanned: items.length, created: fresh.length, skipped, synapses: pairs.length, applied: opts.apply };
}
