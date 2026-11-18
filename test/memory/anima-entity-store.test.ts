import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  AnimaEntityStore,
  type Neuron,
  type Synapse,
  type SearchResult,
} from "../../src/memory/anima-entity-store";

let store: AnimaEntityStore;
let testDir: string;
let dbPath: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `anima-entity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  dbPath = join(testDir, "entity.db");
  store = new AnimaEntityStore(dbPath);
  await store.initialize();
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // Already closed or not initialized
  }
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/*  Neuron CRUD                                                        */
/* ------------------------------------------------------------------ */

describe("neuron CRUD", () => {
  test("addNeuron returns a UUID and stores the neuron", () => {
    const id = store.addNeuron("fact", "The sky is blue");

    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");

    const neuron = store.getNeuron(id);
    expect(neuron).not.toBeNull();
    expect(neuron!.type).toBe("fact");
    expect(neuron!.content).toBe("The sky is blue");
    expect(neuron!.accessCount).toBe(0);
    expect(neuron!.metadata).toEqual({});
    expect(neuron!.createdAt).toBeTruthy();
    expect(neuron!.updatedAt).toBeTruthy();
  });

  test("addNeuron with metadata", () => {
    const id = store.addNeuron("experience", "Visited Paris", {
      source: "travel-log",
      confidence: 0.9,
    });

    const neuron = store.getNeuron(id);
    expect(neuron!.metadata).toEqual({ source: "travel-log", confidence: 0.9 });
  });

  test("getNeuron returns null for nonexistent id", () => {
    const neuron = store.getNeuron("nonexistent-id");
    expect(neuron).toBeNull();
  });

  test("updateNeuron updates content", () => {
    const id = store.addNeuron("fact", "Earth is flat");

    store.updateNeuron(id, "Earth is round");

    const neuron = store.getNeuron(id);
    expect(neuron!.content).toBe("Earth is round");
  });

  test("updateNeuron merges metadata", () => {
    const id = store.addNeuron("fact", "Test", { a: 1, b: 2 });

    store.updateNeuron(id, undefined, { b: 3, c: 4 });

    const neuron = store.getNeuron(id);
    expect(neuron!.metadata).toEqual({ a: 1, b: 3, c: 4 });
  });

  test("updateNeuron does nothing for nonexistent id", () => {
    expect(() => store.updateNeuron("nonexistent", "x")).not.toThrow();
  });

  test("deleteNeuron removes a neuron", () => {
    const id = store.addNeuron("fact", "Temporary fact");
    expect(store.getNeuron(id)).not.toBeNull();

    store.deleteNeuron(id);
    expect(store.getNeuron(id)).toBeNull();
  });

  test("listNeurons returns all neurons", () => {
    store.addNeuron("fact", "First");
    store.addNeuron("fact", "Second");
    store.addNeuron("experience", "Third");

    const all = store.listNeurons();
    expect(all).toHaveLength(3);
  });

  test("listNeurons filters by type", () => {
    store.addNeuron("fact", "F1");
    store.addNeuron("fact", "F2");
    store.addNeuron("experience", "E1");

    const facts = store.listNeurons("fact");
    expect(facts).toHaveLength(2);
    expect(facts.every((n) => n.type === "fact")).toBe(true);
  });

  test("listNeurons respects limit and offset", () => {
    for (let i = 0; i < 5; i++) {
      store.addNeuron("fact", `Fact ${i}`);
    }

    const page = store.listNeurons(undefined, 2, 1);
    expect(page).toHaveLength(2);
  });

  test("incrementAccess increases access count", () => {
    const id = store.addNeuron("fact", "Important fact");

    store.incrementAccess(id);
    store.incrementAccess(id);
    store.incrementAccess(id);

    const neuron = store.getNeuron(id);
    expect(neuron!.accessCount).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/*  Synapse CRUD                                                       */
/* ------------------------------------------------------------------ */

describe("synapse CRUD", () => {
  test("addSynapse creates a link between neurons", () => {
    const a = store.addNeuron("fact", "Cause");
    const b = store.addNeuron("fact", "Effect");

    const sid = store.addSynapse(a, b, "caused_by");

    expect(sid).toBeTruthy();
  });

  test("getSynapses returns synapses in both directions", () => {
    const a = store.addNeuron("fact", "A");
    const b = store.addNeuron("fact", "B");
    const c = store.addNeuron("fact", "C");

    store.addSynapse(a, b, "related_to");
    store.addSynapse(c, a, "part_of");

    const synsA = store.getSynapses(a);
    expect(synsA).toHaveLength(2);

    const synsB = store.getSynapses(b);
    expect(synsB).toHaveLength(1);
    expect(synsB[0].type).toBe("related_to");

    const synsC = store.getSynapses(c);
    expect(synsC).toHaveLength(1);
  });

  test("synapse has correct fields", () => {
    const a = store.addNeuron("fact", "Source");
    const b = store.addNeuron("fact", "Target");

    const sid = store.addSynapse(a, b, "leads_to", 2.5, { reason: "test" });

    const syns = store.getSynapses(a);
    expect(syns).toHaveLength(1);

    const syn = syns[0];
    expect(syn.id).toBe(sid);
    expect(syn.sourceId).toBe(a);
    expect(syn.targetId).toBe(b);
    expect(syn.type).toBe("leads_to");
    expect(syn.weight).toBe(2.5);
    expect(syn.metadata).toEqual({ reason: "test" });
  });

  test("deleteSynapse removes a synapse", () => {
    const a = store.addNeuron("fact", "A");
    const b = store.addNeuron("fact", "B");
    const sid = store.addSynapse(a, b, "related_to");

    store.deleteSynapse(sid);

    const syns = store.getSynapses(a);
    expect(syns).toHaveLength(0);
  });

  test("deleting a neuron cascades to synapses", () => {
    const a = store.addNeuron("fact", "A");
    const b = store.addNeuron("fact", "B");

    store.addSynapse(a, b, "related_to");
    store.deleteNeuron(a);

    const synsB = store.getSynapses(b);
    expect(synsB).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  FTS5 text search                                                   */
/* ------------------------------------------------------------------ */

describe("FTS5 text search", () => {
  test("search finds neurons by content keywords", async () => {
    store.addNeuron("fact", "The mitochondria is the powerhouse of the cell");
    store.addNeuron("fact", "Photosynthesis converts sunlight to energy");
    store.addNeuron("fact", "DNA contains genetic information");

    const results = await store.search("mitochondria", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].neuron.content).toContain("mitochondria");
    expect(results[0].score).toBeGreaterThan(0);
  });

  test("search returns empty for no matches", async () => {
    store.addNeuron("fact", "Hello world");

    const results = await store.search("xyznonexistent", 5);
    expect(results).toHaveLength(0);
  });

  test("search respects topK limit", async () => {
    for (let i = 0; i < 10; i++) {
      store.addNeuron("fact", `Fact about machine learning part ${i}`);
    }

    const results = await store.search("machine learning", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  test("search handles special characters gracefully", async () => {
    store.addNeuron("fact", "Testing special chars");

    const results = await store.search("test+special*chars", 5);
    // Should not throw, returns results or empty
    expect(Array.isArray(results)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  Session Bootstrap                                                  */
/* ------------------------------------------------------------------ */

describe("session bootstrap", () => {
  test("bootstrap returns top accessed, recent, and relevant neurons", async () => {
    // Create neurons with different access counts
    const id1 = store.addNeuron("fact", "Most important fact about ANIMA");
    const id2 = store.addNeuron("fact", "Second important fact");
    const id3 = store.addNeuron("fact", "Recent fact about machine learning");

    // Increment access for the first two
    for (let i = 0; i < 10; i++) store.incrementAccess(id1);
    for (let i = 0; i < 5; i++) store.incrementAccess(id2);

    const results = await store.bootstrap({ currentPrompt: "machine learning", maxEntries: 5 });

    // Should return all three neurons (deduplicated)
    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results.some((n) => n.id === id1)).toBe(true);
    expect(results.some((n) => n.id === id3)).toBe(true);
  });

  test("bootstrap returns empty when no neurons exist", async () => {
    const results = await store.bootstrap({ currentPrompt: "hello", maxEntries: 5 });
    expect(results).toHaveLength(0);
  });

  test("bootstrap deduplicates neurons across categories", async () => {
    const id = store.addNeuron("fact", "Important and recent fact");
    // Make it both top-accessed AND recent
    store.incrementAccess(id);
    store.incrementAccess(id);

    const results = await store.bootstrap({ currentPrompt: "important fact", maxEntries: 5 });
    const idCount = results.filter((n) => n.id === id).length;
    expect(idCount).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/*  Embedding storage and retrieval                                    */
/* ------------------------------------------------------------------ */

describe("embedding storage", () => {
  test("getEmbedding returns null when no embedding stored", () => {
    const id = store.addNeuron("fact", "No embedding yet");
    const embedding = store.getEmbedding(id);
    expect(embedding).toBeNull();
  });

  test("isEmbeddingAvailable reflects API key presence", () => {
    // In test environment, GEMINI_API_KEY may or may not be set
    expect(typeof store.isEmbeddingAvailable).toBe("boolean");
  });

  test("embedding round-trip via direct DB write", () => {
    const id = store.addNeuron("fact", "Test embedding storage");

    // Manually write an embedding to the DB
    const fakeEmbedding = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
    const buf = Buffer.from(fakeEmbedding.buffer, fakeEmbedding.byteOffset, fakeEmbedding.byteLength);

    // Direct DB access for test
    const db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
    db.prepare(
      "INSERT OR REPLACE INTO embeddings (neuron_id, embedding, model) VALUES (?, ?, ?)",
    ).run(id, buf, "models/gemini-embedding-2");

    const retrieved = store.getEmbedding(id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.length).toBe(5);
    expect(Math.abs(retrieved![0] - 0.1)).toBeLessThan(0.001);
  });
});

/* ------------------------------------------------------------------ */
/*  Graceful fallback when no embeddings                               */
/* ------------------------------------------------------------------ */

describe("graceful embedding fallback", () => {
  test("search works with FTS-only when embeddings unavailable", async () => {
    store.addNeuron("fact", "Bun is a fast JavaScript runtime");
    store.addNeuron("fact", "Node.js is also a runtime");

    const results = await store.search("JavaScript runtime", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].neuron.content).toContain("JavaScript");
  });

  test("generateEmbedding throws without API key", async () => {
    // Store without API key (clear the internal client)
    const noKeyStore = new AnimaEntityStore(join(testDir, "nokey.db"));
    // Temporarily remove env key
    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    await noKeyStore.initialize();

    try {
      await noKeyStore.generateEmbedding("test");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("Gemini API key");
    } finally {
      if (originalKey) process.env.GEMINI_API_KEY = originalKey;
      noKeyStore.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Edge cases                                                         */
/* ------------------------------------------------------------------ */

describe("edge cases", () => {
  test("initialize creates parent directories", async () => {
    const nestedPath = join(testDir, "deep", "nested", "entity.db");
    const nestedStore = new AnimaEntityStore(nestedPath);
    await nestedStore.initialize();

    const id = nestedStore.addNeuron("fact", "Nested path works");
    expect(nestedStore.getNeuron(id)).not.toBeNull();

    nestedStore.close();
  });

  test("addNeuron with all neuron types", () => {
    const types = ["concept", "fact", "experience", "beam", "wound", "episode"];
    const ids: string[] = [];

    for (const t of types) {
      ids.push(store.addNeuron(t, `Content for ${t}`));
    }

    for (const id of ids) {
      const neuron = store.getNeuron(id);
      expect(neuron).not.toBeNull();
    }

    const all = store.listNeurons();
    expect(all).toHaveLength(6);
  });

  test("empty metadata defaults to {}", () => {
    const id = store.addNeuron("fact", "No metadata");
    const neuron = store.getNeuron(id);
    expect(neuron!.metadata).toEqual({});
  });

  test("close and re-open preserves data", async () => {
    const id = store.addNeuron("fact", "Persistent fact");
    store.close();

    const store2 = new AnimaEntityStore(dbPath);
    await store2.initialize();

    const neuron = store2.getNeuron(id);
    expect(neuron).not.toBeNull();
    expect(neuron!.content).toBe("Persistent fact");

    store2.close();
  });
});
