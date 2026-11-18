import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { guardAgentId } from "../utils/path-guard";

export const TRUST_DOMAINS = [
  "code_review",
  "memory_write",
  "external_action",
  "architecture",
  "communication",
  "private_mode",
] as const;

export type TrustDomain = typeof TRUST_DOMAINS[number];

export interface TrustDomainScore {
  score: number;
  samples: number;
  lastUpdated: string;
}

export interface TrustFile {
  version: 1;
  domains: Record<TrustDomain, TrustDomainScore>;
}

export interface TrustSystemOptions {
  rootDir?: string;
  roomsDir?: string;
  now?: () => Date;
}

export interface DomainClassificationInput {
  actionType?: string;
  path?: string;
  paths?: string[];
}

const INITIAL_SCORE = 0.5;
const FLOOR = 0.1;
const CEILING = 1;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export class TrustSystem {
  private readonly roomsDir: string;
  private readonly now: () => Date;

  constructor(options: TrustSystemOptions = {}) {
    this.roomsDir = resolve(options.roomsDir ?? join(options.rootDir ?? process.cwd(), "rooms"));
    this.now = options.now ?? (() => new Date());
  }

  async initialize(agentId: string): Promise<TrustFile> {
    const file = await this.read(agentId);
    await this.write(agentId, file);
    return file;
  }

  async read(agentId: string): Promise<TrustFile> {
    const now = this.now().toISOString();
    const parsed = await this.readRaw(agentId);
    const file: TrustFile = {
      version: 1,
      domains: {} as Record<TrustDomain, TrustDomainScore>,
    };

    for (const domain of TRUST_DOMAINS) {
      const existing = parsed?.domains?.[domain];
      file.domains[domain] = {
        score: this.clamp(Number(existing?.score ?? INITIAL_SCORE)),
        samples: Number.isFinite(existing?.samples) ? Math.max(0, Math.floor(existing!.samples)) : 0,
        lastUpdated: typeof existing?.lastUpdated === "string" ? existing.lastUpdated : now,
      };
      file.domains[domain] = this.applyDecay(file.domains[domain]);
    }

    await this.write(agentId, file);
    return file;
  }

  async get(agentId: string, domain: TrustDomain): Promise<TrustDomainScore> {
    const file = await this.read(agentId);
    return file.domains[domain];
  }

  async getScores(agentId: string): Promise<Record<TrustDomain, TrustDomainScore>> {
    const file = await this.read(agentId);
    return { ...file.domains };
  }

  async confirm(agentId: string, domain: TrustDomain): Promise<TrustDomainScore> {
    const file = await this.read(agentId);
    const current = file.domains[domain];
    file.domains[domain] = {
      score: this.clamp(current.score + 0.02 * (1 - current.score)),
      samples: current.samples + 1,
      lastUpdated: this.now().toISOString(),
    };
    await this.write(agentId, file);
    return file.domains[domain];
  }

  async penalize(agentId: string, domain: TrustDomain): Promise<TrustDomainScore> {
    const file = await this.read(agentId);
    const current = file.domains[domain];
    file.domains[domain] = {
      score: this.clamp(current.score - 0.15),
      samples: current.samples + 1,
      lastUpdated: this.now().toISOString(),
    };
    await this.write(agentId, file);
    return file.domains[domain];
  }

  classifyDomain(input: DomainClassificationInput): TrustDomain {
    const action = (input.actionType ?? "").toLowerCase();
    const paths = [input.path, ...(input.paths ?? [])].filter((path): path is string => typeof path === "string");

    if (action.includes("private_mode")) return "private_mode";
    if (action.includes("telegram") || action.includes("message") || action.includes("send")) return "communication";
    if (action.includes("external") || action.includes("api") || action.includes("http")) return "external_action";
    if (action.includes("spawn") || action.includes("architect") || action.includes("design")) return "architecture";
    if (action.includes("memory") || paths.some((path) => this.isMemoryPath(path))) return "memory_write";
    if (action.includes("code") || action.includes("file") || paths.some((path) => this.isCodePath(path))) return "code_review";

    return "communication";
  }

  private async readRaw(agentId: string): Promise<Partial<TrustFile> | null> {
    const path = this.path(agentId);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(await readFile(path, "utf-8")) as Partial<TrustFile>;
    } catch {
      return null; // corrupt file — fall back to defaults
    }
  }

  private async write(agentId: string, file: TrustFile): Promise<void> {
    const path = this.path(agentId);
    await mkdir(join(this.roomsDir, agentId), { recursive: true });
    await writeFile(path, JSON.stringify(file, null, 2) + "\n", "utf-8");
  }

  private path(agentId: string): string {
    guardAgentId(agentId);
    return join(this.roomsDir, agentId, "trust.json");
  }

  private applyDecay(score: TrustDomainScore): TrustDomainScore {
    const updatedAt = Date.parse(score.lastUpdated);
    if (!Number.isFinite(updatedAt)) {
      return { ...score, lastUpdated: this.now().toISOString() };
    }

    const elapsedWeeks = Math.floor((this.now().getTime() - updatedAt) / WEEK_MS);
    if (elapsedWeeks <= 0) return score;

    return {
      ...score,
      score: this.clamp(score.score * Math.pow(0.99, elapsedWeeks)),
      lastUpdated: this.now().toISOString(),
    };
  }

  private clamp(value: number): number {
    if (!Number.isFinite(value)) return INITIAL_SCORE;
    return Math.min(CEILING, Math.max(FLOOR, value));
  }

  private isMemoryPath(path: string): boolean {
    return path.includes("/substrate/") || path.startsWith("substrate/") || path.includes("/0_SOUL/");
  }

  private isCodePath(path: string): boolean {
    return /\.(ts|tsx|js|jsx|json|yaml|yml|md|css|html)$/.test(path) && !this.isMemoryPath(path);
  }
}
