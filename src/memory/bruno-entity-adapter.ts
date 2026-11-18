// ---------------------------------------------------------------------------
// BrunoEntityAdapter — agent-memory-contract adapter for Bruno's neural graph
// ---------------------------------------------------------------------------
// Bruno's memory is the bruno-entity neural graph at ~/work/bruno-entity/.
//
//   recall()    →  node ~/work/bruno-entity/scripts/recall.mjs --query Q --topK N
//   remember()  →  python3 ~/substrate/5_ENGINE/inbox_writer.py --type OBSERVATION ...
//   bootstrap() →  recall with a broad "recent context" query
//
// The adapter shells out to these external scripts. The exec function is
// injectable for testability.
// ---------------------------------------------------------------------------

import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentMemoryEntry,
  AgentMemoryStore,
  MemoryScope,
  RecallOptions,
  BootstrapOptions,
} from "./contract";
import { MemoryWriteError } from "./errors";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Pluggable command executor. Defaults to Bun-based execution.
 * Tests can inject a mock.
 */
export type ExecFn = (
  cmd: string[],
  opts?: { env?: Record<string, string> },
) => Promise<ExecResult>;

export interface BrunoEntityAdapterOptions {
  /** Path to the recall.mjs script. */
  recallScript?: string;
  /** Path to the inbox_writer.py script. */
  inboxWriterScript?: string;
  /** Pluggable exec function (default: Bun.spawn based). */
  execFn?: ExecFn;
  /** Agent name used as source. Default: "bruno". */
  agentName?: string;
}

// ── Default exec — Bun.spawn ─────────────────────────────────────────────────

const defaultExecFn: ExecFn = async (
  cmd: string[],
  opts?: { env?: Record<string, string> },
): Promise<ExecResult> => {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(opts?.env ?? {}) },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
};

// ── Default paths ────────────────────────────────────────────────────────────

const DEFAULT_RECALL_SCRIPT = join(
  homedir(),
  "work",
  "bruno-entity",
  "scripts",
  "recall.mjs",
);

const DEFAULT_INBOX_WRITER = join(
  homedir(),
  "substrate",
  "5_ENGINE",
  "inbox_writer.py",
);

// ── Recall output shape ──────────────────────────────────────────────────────

interface RecallNeuron {
  id: string;
  content: string;
  type: string;
  activation: number;
  metadata?: Record<string, unknown>;
}

interface RecallOutput {
  query: string;
  confidence: string;
  neurons: RecallNeuron[];
  recalledIds: string[];
  paths?: Array<{ source: string; target: string; weight: number }>;
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/**
 * BrunoEntityAdapter — AgentMemoryStore bridge to Bruno's neural graph.
 *
 * Shells out to the bruno-entity recall.mjs script for querying the neural
 * graph and to inbox_writer.py for persisting observations. The exec
 * function is injectable for testability. Implements argument injection
 * protection by rejecting tag values starting with '-'.
 */
export class BrunoEntityAdapter implements AgentMemoryStore {
  private readonly recallScript: string;
  private readonly inboxWriterScript: string;
  private readonly execFn: ExecFn;
  private readonly agentName: string;

  constructor(options?: BrunoEntityAdapterOptions) {
    this.recallScript = options?.recallScript ?? DEFAULT_RECALL_SCRIPT;
    this.inboxWriterScript = options?.inboxWriterScript ?? DEFAULT_INBOX_WRITER;
    this.execFn = options?.execFn ?? defaultExecFn;
    this.agentName = options?.agentName ?? "bruno";
  }

  // ── AgentMemoryStore implementation ────────────────────────────────────────

  /**
   * Recall from Bruno's neural graph via recall.mjs.
   * Shells out to `node <recallScript> --query "<query>" --topK <topK>`
   * and parses the JSON output.
   */
  async recall(
    query: string,
    options?: RecallOptions,
  ): Promise<AgentMemoryEntry[]> {
    if (!query || query.trim().length === 0) return [];

    const topK = options?.topK ?? 10;

    const args = [
      "node",
      this.recallScript,
      "--query",
      query,
      "--topK",
      String(topK),
    ];

    try {
      const { stdout, stderr, exitCode } = await this.execFn(args);

      if (exitCode !== 0) {
        console.error(
          `[BrunoEntityAdapter] recall.mjs exited ${exitCode}: ${stderr}`,
        );
        return [];
      }

      const parsed: RecallOutput = JSON.parse(stdout);

      if (!parsed.neurons || !Array.isArray(parsed.neurons)) {
        return [];
      }

      const minConfidence = options?.minConfidence;

      let results = parsed.neurons.map((n) =>
        this.neuronToEntry(n, parsed.confidence),
      );

      if (minConfidence !== undefined) {
        results = results.filter((e) => e.confidence >= minConfidence);
      }

      // Filter by scope if specified
      if (options?.scopes && options.scopes.length > 0) {
        results = results.filter((e) =>
          options.scopes!.includes(e.scope as MemoryScope),
        );
      }

      return results.slice(0, topK);
    } catch (err) {
      console.error(`[BrunoEntityAdapter] recall error: ${err}`);
      return [];
    }
  }

  /**
   * Store an observation by writing an inbox file via inbox_writer.py.
   * Shells out to `python3 <inboxWriterScript> --type OBSERVATION ...`
   */
  async remember(
    entry: Omit<AgentMemoryEntry, "id" | "createdAt">,
  ): Promise<AgentMemoryEntry> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const createdAt = now;

    const confidence = entry.confidence ?? 0.8;
    const scope = entry.scope ?? ("observation" as MemoryScope);

    // Map scope to inbox type
    const inboxType = this.scopeToInboxType(scope);

    const args = [
      "python3",
      this.inboxWriterScript,
      "--type",
      inboxType,
      "--content",
      entry.content,
      "--confidence",
      String(confidence),
    ];

    if (entry.tags && entry.tags.length > 0) {
      // Security: reject tag values that start with '-' to prevent argument injection
      for (const tag of entry.tags) {
        if (tag.startsWith("-")) {
          throw new Error(
            `Tag value rejected (starts with '-'): "${tag}"`,
          );
        }
      }
      // Plain `--tags t1 t2`. The old form put an end-of-options `--` BEFORE
      // the flag, which made argparse treat "--tags" itself as a positional:
      // inbox_writer.py exited 2 ("unrecognized arguments") for every remember
      // that carried tags — silently, because the failure used to be swallowed
      // below (fixed: a non-zero exit now throws MemoryWriteError).
      // A `--` here would also be unnecessary: tags starting with '-' are
      // rejected outright a few lines above.
      args.push("--tags", ...entry.tags);
    }

    try {
      const { stderr, exitCode } = await this.execFn(args);

      if (exitCode !== 0) {
        throw new MemoryWriteError(
          `inbox_writer.py exited ${exitCode}: ${stderr}`,
        );
      }
    } catch (err) {
      if (err instanceof MemoryWriteError) throw err;
      throw new MemoryWriteError(`inbox write error: ${err}`, { cause: err });
    }

    return {
      id,
      content: entry.content,
      scope,
      tags: entry.tags,
      confidence,
      source: entry.source || this.agentName,
      createdAt,
    };
  }

  /**
   * Bootstrap — runs recall with a broad query to gather recent context.
   * This retrieves the most recently activated/accessed neurons for session boot.
   */
  /**
   * Forget / remove a neuron by ID from the neural graph.
   *
   * Best-effort: writes a FORGET inbox entry so the entity daemon can
   * process it during the next memory cycle. The actual deletion from
   * the neural graph is handled asynchronously by the daemon.
   */
  async forget(id: string): Promise<void> {
    const args = [
      "python3",
      this.inboxWriterScript,
      "--type",
      "FORGET",
      "--content",
      `Request to forget neuron: ${id}`,
      "--confidence",
      "1.0",
    ];

    try {
      const { exitCode, stderr } = await this.execFn(args);
      if (exitCode !== 0) {
        console.error(
          `[BrunoEntityAdapter] forget inbox write exited ${exitCode}: ${stderr}`,
        );
      }
    } catch (err) {
      console.error(`[BrunoEntityAdapter] forget inbox error: ${err}`);
    }
  }

  async bootstrap(options?: BootstrapOptions): Promise<AgentMemoryEntry[]> {
    const maxEntries = options?.maxEntries ?? 5;

    // Use a broad query to pull recent/salient context
    const query =
      options?.currentPrompt && options.currentPrompt.trim().length > 0
        ? options.currentPrompt
        : "recent context session work";

    try {
      const args = [
        "node",
        this.recallScript,
        "--query",
        query,
        "--topK",
        String(maxEntries * 2),
      ];

      const { stdout, stderr, exitCode } = await this.execFn(args);

      if (exitCode !== 0) {
        console.error(
          `[BrunoEntityAdapter] bootstrap recall.mjs exited ${exitCode}: ${stderr}`,
        );
        return [];
      }

      const parsed: RecallOutput = JSON.parse(stdout);

      if (!parsed.neurons || !Array.isArray(parsed.neurons)) {
        return [];
      }

      return parsed.neurons
        .slice(0, maxEntries)
        .map((n) => this.neuronToEntry(n, parsed.confidence));
    } catch (err) {
      console.error(`[BrunoEntityAdapter] bootstrap error: ${err}`);
      return [];
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Convert a RecallNeuron from the neural graph to an AgentMemoryEntry.
   */
  private neuronToEntry(
    neuron: RecallNeuron,
    confidenceLabel: string,
  ): AgentMemoryEntry {
    // Q1: recall.mjs's `confidence` is one label for the whole response, so
    // every neuron in a batch used to get the same score regardless of how
    // relevant it individually was. `neuron.activation` is a genuine per-neuron
    // score already present in the data — use it, falling back to the coarse
    // label only if a neuron is ever missing one.
    const labelConfidence = confidenceLabel === "high" ? 0.9 : confidenceLabel === "medium" ? 0.6 : 0.3;
    const confidence = Number.isFinite(neuron.activation) ? neuron.activation : labelConfidence;

    return {
      id: neuron.id,
      content: neuron.content,
      scope: this.mapNeuronType(neuron.type),
      tags: [],
      confidence,
      source: this.agentName,
      createdAt: new Date().toISOString(),
      metadata: {
        activation: neuron.activation,
        confidenceLabel,
        ...(neuron.metadata ?? {}),
      },
    };
  }

  /**
   * Map neuron type string to MemoryScope.
   */
  private mapNeuronType(type: string): MemoryScope {
    const validScopes: MemoryScope[] = [
      "episode",
      "observation",
      "fact",
      "scent",
      "preference",
      "private",
      "decision",
      "growth_ring",
    ];
    if (validScopes.includes(type as MemoryScope)) {
      return type as MemoryScope;
    }
    return "observation";
  }

  /**
   * Map MemoryScope to inbox writer type.
   */
  private scopeToInboxType(scope: MemoryScope): string {
    switch (scope) {
      case "observation":
        return "OBSERVATION";
      case "episode":
        return "INSIGHT";
      case "fact":
        return "SIGNAL";
      case "decision":
        return "HYPOTHESIS";
      default:
        return "OBSERVATION";
    }
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create an BrunoEntityAdapter with default paths.
 */
export function createBrunoEntityAdapter(
  options?: BrunoEntityAdapterOptions,
): BrunoEntityAdapter {
  return new BrunoEntityAdapter(options);
}
