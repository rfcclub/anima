import { homedir } from 'node:os';
import type { MemoryAdapter, MemoryEntry, RecallOptions, RecallMode } from './adapter';

export interface CustomMemoryAdapterOptions {
  entityScript: string;
  substrateDir?: string;
  defaultMode?: RecallMode;
  fallback?: boolean;
}

interface RecallEnvelope {
  neurons?: Array<{ id: string; content: string; type: string; activation: number }>;
  confidence?: string;
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? homedir() + p.slice(1) : p;
}

function mapNeuronType(type: string): MemoryEntry['type'] {
  if (type === 'episode') return 'episode';
  if (type === 'observation') return 'observation';
  if (type === 'message') return 'message';
  return 'fact';
}

export class CustomMemoryAdapter implements MemoryAdapter {
  private readonly entityScript: string;
  private readonly substrateDir: string | undefined;
  private readonly defaultMode: RecallMode;
  private readonly fallback: boolean;

  constructor(options: CustomMemoryAdapterOptions) {
    this.entityScript = expandHome(options.entityScript);
    this.substrateDir = options.substrateDir ? expandHome(options.substrateDir) : undefined;
    this.defaultMode = options.defaultMode ?? 'normal';
    this.fallback = options.fallback ?? true;
  }

  async store(_entry: MemoryEntry): Promise<void> {
    return;
  }

  async recall(query: string, opts?: RecallOptions): Promise<MemoryEntry[]> {
    const mode = opts?.mode ?? this.defaultMode;

    if (mode === 'normal') {
      return this.normalRecall(query, opts);
    }

    if (mode === 'semantic' || mode === 'neural') {
      try {
        const results = await this.neuralRecall(query, opts);
        if (results.length > 0 || !this.fallback) return results;
        return this.normalRecall(query, opts);
      } catch {
        if (this.fallback) return this.normalRecall(query, opts);
        return [];
      }
    }

    return [];
  }

  private normalRecall(query: string, opts?: RecallOptions): MemoryEntry[] {
    // sessionStore is typed as unknown in RecallOptions to avoid circular deps
    const sessionStore = opts?.sessionStore as { getTurns: (id: string) => Array<{ id: number; role: string; content: string; ts: string }> } | undefined;
    if (!sessionStore || !opts?.sessionId) return [];

    const turns = sessionStore.getTurns(opts.sessionId);
    const keywords = query.toLowerCase().split(/\s+/).filter((k) => k.length > 1);
    const recentDays = opts?.recentDays ?? 7;
    const cutoffMs = Date.now() - recentDays * 24 * 60 * 60 * 1000;
    const matches = turns
      .filter((t) => Date.parse(t.ts) >= cutoffMs)
      .filter((t) => keywords.some((kw) => t.content.toLowerCase().includes(kw)))
      .slice(0, opts?.topK ?? 5);

    return matches.map((t) => ({
      id: String(t.id),
      namespace: opts?.namespace ?? 'all',
      content: t.content,
      type: 'message' as const,
      timestamp: t.ts,
      metadata: { sessionId: opts.sessionId, role: t.role },
    }));
  }

  private async neuralRecall(query: string, opts?: RecallOptions): Promise<MemoryEntry[]> {
    const topK = opts?.topK ?? 5;
    const modeFlag = opts?.mode === 'neural' ? '--neural' : '';
    const args = ['node', this.entityScript, '--query', query, '--topK', topK.toString()];
    if (modeFlag) args.push(modeFlag);

    try {
      const proc = Bun.spawn(args, {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          SUBSTRATE_SUBSTRATE: this.substrateDir ?? process.env.SUBSTRATE_SUBSTRATE ?? '',
        },
      });

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      await proc.exited;

      if (proc.exitCode !== 0) {
        console.error(`CustomMemoryAdapter recall failed (exit ${proc.exitCode}): ${stderr}`);
        return [];
      }

      const parsed = JSON.parse(stdout) as RecallEnvelope | MemoryEntry[];

      if (!Array.isArray(parsed) && parsed.neurons) {
        const now = new Date().toISOString();
        return parsed.neurons.map((n) => ({
          id: n.id,
          namespace: 'bruno',
          content: n.content,
          type: mapNeuronType(n.type),
          timestamp: now,
          metadata: { activation: n.activation, confidence: parsed.confidence },
        }));
      }

      return parsed as MemoryEntry[];
    } catch (error) {
      console.error(`CustomMemoryAdapter recall error: ${error}`);
      return [];
    }
  }
}
