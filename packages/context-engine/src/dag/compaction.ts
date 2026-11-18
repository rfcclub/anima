// CompactionEngine — DAG-based conversation compaction.
// Clean-room implementation based on lossless-claw's algorithm.
// Uses our store interfaces + SummaryProvider instead of OpenClaw runtime.llm.

import type { ConversationStore } from '../store/conversation-store.js';
import type { SummaryStore } from '../store/summary-store.js';
import type { SummaryProvider, CompactionConfig, MessageRecord, ContextItem } from '../types.js';
import { DEFAULT_COMPACTION_CONFIG } from '../types.js';
import { estimateTokens, truncateTextToEstimatedTokens } from './estimate-tokens.js';

export interface CompactionResult {
  actionTaken: boolean;
  tokensBefore: number;
  tokensAfter: number;
  summariesCreated: number;
  level: 'normal' | 'aggressive' | 'fallback';
  authFailure?: boolean;
}

export class CompactionEngine {
  constructor(
    private convStore: ConversationStore,
    private summaryStore: SummaryStore,
    private provider: SummaryProvider,
    private config: CompactionConfig = DEFAULT_COMPACTION_CONFIG,
  ) {}

  /**
   * Main entry point: evaluate whether compaction is needed and run if so.
   */
  async compact(
    conversationId: string,
    targetTokens: number,
    currentTokens?: number,
  ): Promise<CompactionResult> {
    const tokensBefore = currentTokens ?? this.summaryStore.getContextTokenCount(conversationId);
    const threshold = targetTokens * 0.75; // compact at 75% of budget

    if (tokensBefore <= threshold) {
      return {
        actionTaken: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        summariesCreated: 0,
        level: 'normal',
      };
    }

    let summariesCreated = 0;
    let tokensAfter = tokensBefore;

    try {
      // Multi-round convergence: sweep until under budget or limits exhausted
      const maxRounds = this.config.maxRounds;
      const overallDeadline = Date.now() + this.config.compactUntilUnderDeadlineMs;

      for (let round = 0; round < maxRounds && Date.now() < overallDeadline; round++) {
        const beforeRound = this.summaryStore.getContextTokenCount(conversationId);
        if (beforeRound <= threshold) break;

        // Full sweep: leaf pass + condensed pass
        const leafResult = await this.leafPass(conversationId, targetTokens);
        summariesCreated += leafResult.summariesCreated;

        const condensedResult = await this.condensedPass(conversationId, targetTokens);
        summariesCreated += condensedResult.summariesCreated;

        const afterRound = this.summaryStore.getContextTokenCount(conversationId);
        if (afterRound >= beforeRound) break; // no progress, stop

        tokensAfter = afterRound;
      }

      tokensAfter = this.summaryStore.getContextTokenCount(conversationId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('auth') || msg.toLowerCase().includes('unauthorized') || msg.toLowerCase().includes('key')) {
        return {
          actionTaken: false,
          tokensBefore,
          tokensAfter: tokensBefore,
          summariesCreated,
          level: 'normal',
          authFailure: true,
        };
      }
      throw err;
    }

    return {
      actionTaken: summariesCreated > 0,
      tokensBefore,
      tokensAfter,
      summariesCreated,
      level: 'normal',
    };
  }

  /**
   * Phase 1: Find the oldest raw messages outside the fresh tail and compact them
   * into leaf summaries. Runs repeatedly until fresh tail is reached.
   */
  private async leafPass(
    conversationId: string,
    targetTokens: number,
  ): Promise<{ summariesCreated: number }> {
    let summariesCreated = 0;
    const maxIter = this.config.maxSweepIterations;
    const deadline = Date.now() + this.config.sweepDeadlineMs;
    const freshTailCount = this.config.freshTailCount;

    for (let iter = 0; iter < maxIter && Date.now() < deadline; iter++) {
      // Get current context items
      const items = this.convStore.getContextItems(conversationId);

      // Find fresh tail: the last N message-type items by ordinal position
      const freshTailIds = this.resolveFreshTail(items, freshTailCount);

      // Select oldest chunk of raw messages outside fresh tail
      const chunk = this.selectOldestLeafChunk(items, freshTailIds);
      if (!chunk || chunk.messageIds.length === 0) break;

      // Fetch the actual messages
      const messages: MessageRecord[] = [];
      for (const msgId of chunk.messageIds) {
        const msg = this.convStore.getMessage(msgId);
        if (msg) messages.push(msg);
      }
      if (messages.length === 0) break;

      // Generate leaf summary
      const summary = await this.summarizeChunk(messages, 'leaf', 0);
      const summaryId = `sum_${conversationId}_L${chunk.startOrdinal}`;

      this.summaryStore.createSummary({
        summaryId,
        conversationId,
        kind: 'leaf',
        depth: 0,
        content: summary.content,
        tokenCount: estimateTokens(summary.content),
        sourceMessageIds: chunk.messageIds,
        descendantCount: messages.length,
        descendantTokenCount: messages.reduce((s, m) => s + (m.token_count ?? 0), 0),
        model: summary.model,
      });

      // Replace the message range with the summary in context_items
      this.summaryStore.replaceContextRangeWithSummary(
        conversationId,
        chunk.startOrdinal,
        chunk.endOrdinal,
        summaryId,
      );

      summariesCreated++;

      // Stop if we're under target
      const currentTokens = this.summaryStore.getContextTokenCount(conversationId);
      if (currentTokens <= targetTokens * 0.75) break;
    }

    return { summariesCreated };
  }

  /**
   * Phase 2: Condense same-depth summaries into higher-depth nodes.
   */
  private async condensedPass(
    conversationId: string,
    targetTokens: number,
  ): Promise<{ summariesCreated: number }> {
    let summariesCreated = 0;
    const maxIter = this.config.maxSweepIterations;
    const deadline = Date.now() + this.config.sweepDeadlineMs;
    const minFanout = this.config.condensedMinFanout;

    for (let iter = 0; iter < maxIter && Date.now() < deadline; iter++) {
      // Find the shallowest depth with enough same-depth summaries
      const candidate = this.selectCondensationCandidate(conversationId, minFanout);
      if (!candidate) break;

      // Generate condensed summary from parent summaries
      const parentContents = candidate.summaries.map(s => s.content).join('\n\n');
      const summary = await this.summarizeChunk(
        [{ id: '', seq: 0, role: 'system', content: parentContents, created_at: '' }],
        'condensed',
        candidate.depth + 1,
      );

      const summaryId = `sum_${conversationId}_C${candidate.startOrdinal}`;
      const parentIds = candidate.summaries.map(s => s.summary_id);

      this.summaryStore.createSummary({
        summaryId,
        conversationId,
        kind: 'condensed',
        depth: candidate.depth + 1,
        content: summary.content,
        tokenCount: estimateTokens(summary.content),
        parentSummaryIds: parentIds,
        descendantCount: candidate.summaries.reduce((s, sm) => s + (sm.descendant_count ?? 1), 0),
        descendantTokenCount: candidate.summaries.reduce((s, sm) => s + (sm.descendant_token_count ?? 0), 0),
        model: summary.model,
      });

      // Replace parent summary range with condensed summary
      this.summaryStore.replaceContextRangeWithSummary(
        conversationId,
        candidate.startOrdinal,
        candidate.endOrdinal,
        summaryId,
      );

      summariesCreated++;

      const currentTokens = this.summaryStore.getContextTokenCount(conversationId);
      if (currentTokens <= targetTokens * 0.75) break;
    }

    return { summariesCreated };
  }

  /**
   * Resolve the set of message IDs that belong to the fresh tail
   * (the last N message-type items in the context_items array).
   */
  private resolveFreshTail(items: ContextItem[], count: number): Set<string> {
    const messageItems = items.filter(i => i.item_type === 'message');
    const tailMessages = messageItems.slice(Math.max(0, messageItems.length - count));
    return new Set(tailMessages.map(i => i.message_id!).filter(Boolean));
  }

  /**
   * Select the oldest contiguous chunk of raw messages outside the fresh tail.
   */
  private selectOldestLeafChunk(
    items: ContextItem[],
    freshTailIds: Set<string>,
  ): { startOrdinal: number; endOrdinal: number; messageIds: string[] } | null {
    const messageItems = items.filter(i => i.item_type === 'message');
    if (messageItems.length === 0) return null;

    // Find eligible messages outside fresh tail
    const eligible = messageItems.filter(i => !freshTailIds.has(i.message_id ?? ''));
    if (eligible.length === 0) return null;

    // Take up to leafChunkTokens worth of oldest messages
    let tokenTotal = 0;
    const chunkMessages: typeof eligible = [];
    for (const item of eligible) {
      const msg = this.convStore.getMessage(item.message_id!);
      const tokens = msg?.token_count ?? estimateTokens(msg?.content ?? '');
      if (tokenTotal + tokens > this.config.leafChunkTokens && chunkMessages.length > 0) break;
      tokenTotal += tokens;
      chunkMessages.push(item);
    }

    if (chunkMessages.length === 0) return null;

    return {
      startOrdinal: chunkMessages[0].ordinal,
      endOrdinal: chunkMessages[chunkMessages.length - 1].ordinal,
      messageIds: chunkMessages.map(i => i.message_id!).filter(Boolean),
    };
  }

  /**
   * Find the shallowest depth where enough same-depth summaries exist for condensation.
   */
  private selectCondensationCandidate(
    conversationId: string,
    minFanout: number,
  ): { startOrdinal: number; endOrdinal: number; depth: number; summaries: Array<{ summary_id: string; content: string; descendant_count?: number; descendant_token_count?: number }> } | null {
    const items = this.convStore.getContextItems(conversationId);
    const summaryItems = items.filter(i => i.item_type === 'summary');

    // Group summaries by depth
    const byDepth = new Map<number, ContextItem[]>();
    for (const item of summaryItems) {
      const s = this.summaryStore.getSummary(item.summary_id!);
      if (!s) continue;
      const depth = s.depth;
      if (!byDepth.has(depth)) byDepth.set(depth, []);
      byDepth.get(depth)!.push(item);
    }

    // Find the shallowest depth with enough candidates
    for (const [depth, candidates] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
      if (candidates.length < minFanout) continue;

      // Take contiguous candidates at this depth
      const contiguous: ContextItem[] = [];
      for (const item of candidates) {
        if (contiguous.length === 0 || item.ordinal === contiguous[contiguous.length - 1].ordinal + 1) {
          contiguous.push(item);
        } else {
          if (contiguous.length >= minFanout) break;
          contiguous.length = 0;
          contiguous.push(item);
        }
      }

      if (contiguous.length >= minFanout) {
        const summaries = contiguous.map(c => {
          const s = this.summaryStore.getSummary(c.summary_id!)!;
          return { summary_id: s.summary_id, content: s.content, descendant_count: s.descendant_count, descendant_token_count: s.descendant_token_count };
        });

        return {
          startOrdinal: contiguous[0].ordinal,
          endOrdinal: contiguous[contiguous.length - 1].ordinal,
          depth,
          summaries,
        };
      }
    }

    return null;
  }

  /**
   * Summarize a chunk of messages using the provider.
   * Falls back: normal → aggressive → deterministic truncation.
   */
  private async summarizeChunk(
    messages: MessageRecord[],
    kind: 'leaf' | 'condensed',
    depth: number,
  ): Promise<{ content: string; model?: string }> {
    const targetTokens = kind === 'leaf'
      ? this.config.leafTargetTokens
      : this.config.condensedTargetTokens;

    const formatted = messages.map(m =>
      `[${m.role}]: ${(m.content ?? '').slice(0, 2000)}`,
    ).join('\n\n');

    const isAuthError = (err: unknown): boolean => {
      const msg = err instanceof Error ? err.message : String(err);
      const lower = msg.toLowerCase();
      return lower.includes('auth') || lower.includes('unauthorized') || lower.includes('key')
        || lower.includes('401') || lower.includes('403');
    };

    // Level 1: Normal summarization
    try {
      const result = await this.provider.complete({
        system: kind === 'leaf'
          ? 'Summarize the conversation segment below. Preserve key facts, decisions, and context. Be concise.'
          : 'Condense the following summaries into a higher-level memory node. Preserve durable context, discard transient details.',
        messages: [{ role: 'user', content: formatted }],
        maxTokens: targetTokens,
        temperature: 0.3,
      });

      if (result.content && estimateTokens(result.content) < estimateTokens(formatted) * 0.8) {
        return { content: result.content, model: result.model };
      }
    } catch (err) {
      if (isAuthError(err)) throw err;
      // Fall through to aggressive
    }

    // Level 2: Aggressive — lower target
    try {
      const result = await this.provider.complete({
        system: 'Compress the following to its essential facts. Be extremely concise.',
        messages: [{ role: 'user', content: formatted }],
        maxTokens: Math.floor(targetTokens * 0.5),
        temperature: 0.1,
      });

      if (result.content && estimateTokens(result.content) < estimateTokens(formatted)) {
        return { content: result.content, model: result.model };
      }
    } catch (err) {
      if (isAuthError(err)) throw err;
      // Fall through to deterministic
    }

    // Level 3: Deterministic truncation fallback
    const truncated = truncateTextToEstimatedTokens(formatted, targetTokens);
    return { content: `[Truncated]\n${truncated}` };
  }
}
