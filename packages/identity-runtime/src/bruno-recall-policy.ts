import { homedir } from "node:os";
import { join } from "node:path";
import { BrunoEntityAdapter } from "../../../src/memory/bruno-entity-adapter.ts";
import type { ProviderMessage } from "../../../src/providers/interface.ts";
import { ModeRouter } from "../../../src/providers/router.ts";
import { decideQueryChoices } from "./jev-choice.ts";

export type RecallSource = "hive" | "bruno_entity" | "rag";

export interface RecallResult {
  source: RecallSource;
  content: string;
}

export interface QueryClassifier {
  classify(query: string): Promise<RecallSource[]>;
}

const KNOWN_SOURCES: RecallSource[] = ["hive", "bruno_entity", "rag"];
const CLASSIFY_SYSTEM_PROMPT = [
  "You classify a query into zero or more dispatch targets.",
  "",
  "Targets:",
  "- hive: the query is about a colony concept, another agent, or shared colony/team knowledge.",
  "- bruno_entity: the query is about Bruno's own past sessions, decisions, identity, or history.",
  "- rag: the query asks to search wiki or project documentation broadly.",
  "",
  "Respond with ONLY a comma-separated list of matching target names from {hive, bruno_entity, rag} -- nothing else, no explanation. If none match, respond with none.",
].join("\n");

function messageText(message: ProviderMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

interface ClassifyAttempt {
  resolved: boolean;
  sources: RecallSource[];
}

export class LLMQueryClassifier implements QueryClassifier {
  constructor(
    private readonly router: Pick<ModeRouter, "query">,
    private readonly attempts = 3,
  ) {}

  async classify(query: string): Promise<RecallSource[]> {
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      const result = await this.classifyOnce(query);
      if (result.resolved) return result.sources;
    }
    return [];
  }

  private async classifyOnce(query: string): Promise<ClassifyAttempt> {
    try {
      const response = await this.router.query({
        agent: "bruno",
        mode: "plan",
        effort: "fast",
        system: CLASSIFY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: query }],
      }, "chatting");
      const text = messageText(response.message).trim().toLowerCase();
      if (!text) return { resolved: false, sources: [] };
      if (text === "none") return { resolved: true, sources: [] };
      const sources = KNOWN_SOURCES.filter((source) => text.includes(source));
      return sources.length > 0
        ? { resolved: true, sources }
        : { resolved: false, sources: [] };
    } catch {
      return { resolved: false, sources: [] };
    }
  }
}

const OTHER_AGENT_NAMES = [
  "eli", "abel", "finn", "cleo", "rhea", "ivan", "milo", "hana",
  "gus", "sam", "lena", "pia", "nora", "dana", "kai",
];

function heuristicClassify(query: string): RecallSource[] | null {
  const text = query.toLowerCase();
  const matched = new Set<RecallSource>();
  if (
    text.includes("hive")
    || text.includes("colony")
    || OTHER_AGENT_NAMES.some((name) => text.includes(name))
  ) {
    matched.add("hive");
  }
  // "t\u00e0i li\u1ec7u" is the Vietnamese word for "documentation" (written as \u escapes).
  if (text.includes("wiki") || text.includes("documentation") || text.includes("t\u00e0i li\u1ec7u")) {
    matched.add("rag");
  }
  return matched.size === 1 ? [...matched] : null;
}

export class HeuristicQueryClassifier implements QueryClassifier {
  constructor(private readonly fallback: QueryClassifier) {}

  async classify(query: string): Promise<RecallSource[]> {
    const heuristic = heuristicClassify(query);
    if (heuristic) return heuristic;
    return this.fallback.classify(query);
  }
}

const JEV_QUESTIONS: Record<
  string,
  { type: "choice"; instructions: string; criteria: Record<"yes" | "no", string> }
> = {
  hive: {
    type: "choice",
    instructions: "Is the query about a colony concept, another agent, or shared colony/team knowledge?",
    criteria: { yes: "clearly about colony/agents/shared knowledge", no: "not about that" },
  },
  bruno_entity: {
    type: "choice",
    instructions: "Is the query about Bruno's own past sessions, decisions, identity, or history?",
    criteria: { yes: "clearly self-referential to Bruno", no: "not about that" },
  },
  rag: {
    type: "choice",
    instructions: "Does the query ask to search wiki or project documentation broadly?",
    criteria: { yes: "clearly a doc/wiki search request", no: "not about that" },
  },
};

type JevAnswers = Record<string, { choice: string }>;

async function defaultJevDecide(state: string): Promise<JevAnswers | null> {
  return decideQueryChoices(state, JEV_QUESTIONS);
}

export class JevQueryClassifier implements QueryClassifier {
  constructor(
    private readonly decide: (state: string) => Promise<JevAnswers | null> = defaultJevDecide,
  ) {}

  async classify(query: string): Promise<RecallSource[]> {
    try {
      const answers = await this.decide(query);
      if (!answers) return [];
      return KNOWN_SOURCES.filter((source) => answers[source]?.choice === "yes");
    } catch {
      return [];
    }
  }
}

export async function defaultClassifier(): Promise<QueryClassifier> {
  return new HeuristicQueryClassifier(new JevQueryClassifier());
}

const HIVE_BIN = join(homedir(), "agora", "hive", "bin", "hive");

async function dispatchHive(query: string): Promise<RecallResult> {
  if (query.startsWith("-")) {
    return { source: "hive", content: "" };
  }
  const process = Bun.spawn([HIVE_BIN, "search", "--", query], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout] = await Promise.all([new Response(process.stdout).text(), process.exited]);
  return { source: "hive", content: stdout };
}

// Below this, recall.mjs's own "low" bucket lives (low activation)
// — clear noise, not a borderline match. Anything at or
// above "medium" (~0.3+) still gets through; this only cuts the obvious misses
// that used to ride along equally with strong matches under the old
// whole-response confidence label.
const BRUNO_ENTITY_MIN_CONFIDENCE = 0.2;

async function dispatchBrunoEntity(
  query: string,
  adapter: Pick<BrunoEntityAdapter, "recall"> = new BrunoEntityAdapter(),
): Promise<RecallResult> {
  const entries = await adapter.recall(query, { topK: 5, minConfidence: BRUNO_ENTITY_MIN_CONFIDENCE });
  return {
    source: "bruno_entity",
    content: entries.map((entry) => entry.content).join("\n\n"),
  };
}

function dispatchRag(): RecallResult {
  return { source: "rag", content: "RAG over wiki/project sources is not yet implemented." };
}

export interface RecallDeps {
  classifier?: QueryClassifier;
  /** Asked whatever the classifier says (deduplicated; the classifier's own picks keep their order). */
  alwaysSources?: readonly RecallSource[];
  /** Replaces a source's dispatch; used by tests, never by production wiring. */
  dispatchers?: Partial<Record<RecallSource, (query: string) => RecallResult | Promise<RecallResult>>>;
  /** Test seam for the bruno_entity dispatch's relevance cut; production always uses a real BrunoEntityAdapter. */
  brunoEntityAdapter?: Pick<BrunoEntityAdapter, "recall">;
}

export async function recall(query: string, deps: RecallDeps = {}): Promise<RecallResult[]> {
  const classifier = deps.classifier ?? (await defaultClassifier());
  const picked = await classifier.classify(query);
  const sources = [...picked, ...(deps.alwaysSources ?? []).filter((source) => !picked.includes(source))];
  const dispatch = {
    hive: dispatchHive,
    bruno_entity: (q: string) => dispatchBrunoEntity(q, deps.brunoEntityAdapter),
    rag: dispatchRag,
    ...deps.dispatchers,
  };
  const results: RecallResult[] = [];
  for (const source of sources) results.push(await dispatch[source](query));
  return results;
}

/**
 * identity-runtime's own direct-recall policy. Unlike `recall`, it always asks
 * bruno_entity: an HTTP-only host (Windows) has no local bruno-entity to fall back
 * to, and the classifier sends repo/engineering queries nowhere. The `rag` source
 * is not implemented, so its placeholder is never surfaced as memory.
 */
export function createDirectRecallPolicy(deps: RecallDeps = {}): { recall(query: string): Promise<RecallResult[]> } {
  return {
    recall: async (query) => {
      const results = await recall(query, {
        ...deps,
        alwaysSources: [...(deps.alwaysSources ?? []), "bruno_entity"],
      });
      return results.filter((result) => result.source !== "rag");
    },
  };
}
