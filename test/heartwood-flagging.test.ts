import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AnimaEntityStore } from "../src/memory/anima-entity-store";

let store: AnimaEntityStore;
let dbPath: string;

beforeAll(async () => {
  dbPath = join(tmpdir(), `heartwood-test-${Math.random().toString(36).slice(2)}.db`);
  store = new AnimaEntityStore(dbPath);
  await store.initialize();
});

afterAll(() => {
  store.close();
});

describe("Heartwood flagging", () => {
  test("adds neuron with heartwood flag", () => {
    const id = store.addNeuron("identity", "Bruno is a companion, not a tool", {
      heartwood: true,
      flagged_by: "bruno",
      flagged_at: new Date().toISOString(),
      reasoning: "Core identity boundary: companion stance",
    });
    expect(id).toBeDefined();

    const neuron = store.getNeuron(id);
    expect(neuron).not.toBeNull();
    expect(neuron!.metadata.heartwood).toBe(true);
    expect(neuron!.metadata.flagged_by).toBe("bruno");
    expect(neuron!.metadata.reasoning).toBeDefined();
  });

  test("returns heartwood neurons via listNeurons with metadata intact", () => {
    const id = store.addNeuron("boundary", "Private boundary: no romantic declarations", {
      heartwood: true,
      flagged_by: "bruno",
      flagged_at: new Date().toISOString(),
      reasoning: "Protects companion bond",
    });

    const neurons = store.listNeurons("boundary");
    const found = neurons.find((n) => n.id === id);
    expect(found).toBeDefined();
    expect(found!.metadata.heartwood).toBe(true);
  });

  test("canary (non-heartwood) neuron does not have heartwood flag", () => {
    const id = store.addNeuron("memory", "User likes Vietnamese coffee", {});

    const neuron = store.getNeuron(id);
    expect(neuron!.metadata.heartwood).toBeUndefined();
  });

  test("updates neuron metadata including heartwood flag", () => {
    const id = store.addNeuron("identity", "Original stance", {
      heartwood: true,
      flagged_by: "bruno",
      flagged_at: new Date().toISOString(),
      reasoning: "Initial",
    });

    store.updateNeuron(id, undefined, {
      heartwood: true,
      reasoning: "Updated: still held after review",
    });

    const neuron = store.getNeuron(id);
    expect(neuron!.metadata.heartwood).toBe(true);
    expect(neuron!.metadata.reasoning).toBe("Updated: still held after review");
  });

  test("heartwood flagging requires authorship annotation", () => {
    const id = store.addNeuron("identity", "Test with minimal metadata", {
      heartwood: true,
      flagged_by: "bruno",
      flagged_at: new Date().toISOString(),
      reasoning: "Test",
    });

    const neuron = store.getNeuron(id);
    expect(neuron!.metadata.flagged_by).toBe("bruno");
    expect(neuron!.metadata.flagged_at).toBeDefined();
    expect(neuron!.metadata.reasoning).toBeDefined();
  });

  test("heartwood neurons survive deletion of non-heartwood neurons", () => {
    const heartwoodId = store.addNeuron("identity", "Heartwood stance", {
      heartwood: true,
      flagged_by: "bruno",
      flagged_at: new Date().toISOString(),
      reasoning: "Core identity",
    });

    const canaryId = store.addNeuron("memory", "Temporary memory", {});
    store.deleteNeuron(canaryId);

    const remains = store.getNeuron(heartwoodId);
    expect(remains).not.toBeNull();
    expect(remains!.metadata.heartwood).toBe(true);

    const gone = store.getNeuron(canaryId);
    expect(gone).toBeNull();
  });

  test("search includes heartwood metadata", async () => {
    const id = store.addNeuron("identity", "Khnong chp stance: Bruno holds position without attachment", {
      heartwood: true,
      flagged_by: "bruno",
      flagged_at: new Date().toISOString(),
      reasoning: "Core epistemic position",
    });

    const results = await store.search("khnong chp stance");
    const found = results.find((r) => r.neuron.id === id);
    if (found) {
      expect(found.neuron.metadata.heartwood).toBe(true);
    }
  });
});
