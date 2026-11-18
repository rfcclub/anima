// ContextAssembler — build model context from DAG.
// Based on lossless-claw's assembler.ts algorithm, adapted for our types.

import type { ConversationStore } from '../store/conversation-store.js';
import type { SummaryStore } from '../store/summary-store.js';
import type { MessageRecord, ContextItem } from '../types.js';
import { estimateTokens } from './estimate-tokens.js';

export interface AssemblyResult {
  messages: MessageRecord[];
  estimatedTokens: number;
  freshTailCount: number;
  systemPromptAddition?: string;
}

export class ContextAssembler {
  constructor(
    private convStore: ConversationStore,
    private summaryStore: SummaryStore,
    private freshTailCount: number = 64,
  ) {}

  /**
   * Assemble context for a prompt.
   * 1. Fetch all context items
   * 2. Resolve messages and summaries
   * 3. Apply budget-aware selection
   * 4. Return assembled messages
   */
  assemble(
    conversationId: string,
    prompt?: string,
    tokenBudget?: number,
  ): AssemblyResult {
    const items = this.convStore.getContextItems(conversationId);
    if (items.length === 0) {
      return { messages: [], estimatedTokens: 0, freshTailCount: 0 };
    }

    // Split into evictable and fresh tail
    const messageItems = items.filter(i => i.item_type === 'message');
    const freshTailStart = Math.max(0, messageItems.length - this.freshTailCount);

    const resolved: ResolvedItem[] = [];
    let freshTailIds: Set<string> = new Set();

    // Determine which messages are in fresh tail
    const freshTailMessages = messageItems.slice(freshTailStart);
    for (const msg of freshTailMessages) {
      freshTailIds.add(msg.message_id!);
    }

    // Resolve all items
    for (const item of items) {
      const ri = this.resolveItem(item);
      if (ri) {
        resolved.push({
          item,
          message: ri.message,
          content: ri.content,
          tokens: ri.tokens,
          isFreshTail: freshTailIds.has(item.message_id ?? ''),
        });
      }
    }

    // Budget-aware selection
    let selected = resolved;
    let estimatedTokens = resolved.reduce((s, r) => s + r.tokens, 0);

    if (tokenBudget && estimatedTokens > tokenBudget) {
      selected = this.budgetSelect(resolved, tokenBudget, prompt);
      estimatedTokens = selected.reduce((s, r) => s + r.tokens, 0);
    }

    return {
      messages: selected.map(r => r.message),
      estimatedTokens,
      freshTailCount: selected.filter(r => r.isFreshTail).length,
    };
  }

  private resolveItem(item: ContextItem): Pick<ResolvedItem, "message" | "content" | "tokens"> | null {
    if (item.item_type === 'message' && item.message_id) {
      const msg = this.convStore.getMessage(item.message_id);
      if (!msg) return null;
      const tokens = msg.token_count ?? estimateTokens(msg.content);
      return { message: msg, content: msg.content ?? '', tokens };
    }

    if (item.item_type === 'summary' && item.summary_id) {
      const summary = this.summaryStore.getSummary(item.summary_id);
      if (!summary) return null;
      const content = formatSummaryContent(summary.content, summary.kind, summary.depth, summary.descendant_count ?? 0);
      const tokens = summary.token_count ?? estimateTokens(content);
      // Wrap summary as a system message
      const msg: MessageRecord = {
        id: `synth_${summary.summary_id}`,
        conversation_id: item.conversation_id,
        seq: -1,
        role: 'system',
        content,
        token_count: tokens,
        created_at: summary.created_at,
      };
      return { message: msg, content, tokens };
    }

    return null;
  }

  /**
   * Budget-aware eviction using BM25-lite relevance scoring.
   * Fresh tail items are never evicted. Remaining items are scored
   * by relevance to the prompt, and the highest-scoring items
   * are kept up to the budget.
   */
  private budgetSelect(
    items: ResolvedItem[],
    budget: number,
    prompt?: string,
  ): ResolvedItem[] {
    // Split fresh tail
    const freshTail = items.filter(r => r.isFreshTail);
    const evictable = items.filter(r => !r.isFreshTail);

    const freshTailTokens = freshTail.reduce((s, r) => s + r.tokens, 0);
    const remainingBudget = budget - freshTailTokens;
    if (remainingBudget <= 0) return freshTail;

    // BM25-lite score each evictable item against prompt
    const scored = evictable.map(r => ({
      ...r,
      score: prompt ? bm25LiteScore(r.content, prompt) : r.item.ordinal, // fallback: chronological
    }));

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Greedy fill budget
    const selected = new Set(freshTail.map(r => r.item.ordinal));
    let used = 0;
    for (const item of scored) {
      if (used + item.tokens <= remainingBudget) {
        selected.add(item.item.ordinal);
        used += item.tokens;
      }
    }

    // Return items in original chronological order (not score order)
    return items.filter(r => selected.has(r.item.ordinal));
  }
}

interface ResolvedItem {
  item: ContextItem;
  message: MessageRecord;
  content: string;
  tokens: number;
  isFreshTail: boolean;
}

function formatSummaryContent(content: string, kind: string, depth: number, descendantCount: number): string {
  return `<summary id="${kind}" depth="${depth}" descendants="${descendantCount}">\n${content}\n</summary>`;
}

/**
 * BM25-lite: term-frequency overlap between query and document.
 */
function bm25LiteScore(document: string, query: string): number {
  const docTerms = tokenize(document);
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return 0;

  let score = 0;
  for (const qt of queryTerms) {
    const tf = docTerms.filter(t => t === qt).length;
    if (tf > 0) {
      score += tf / (tf + 1.5); // simplified BM25 saturation
    }
  }
  return score / queryTerms.length;
}

function tokenize(text: string): string[] {
  return text.toLowerCase()
    // \u4e00-\u9fff is the CJK Unified Ideographs range, kept in the token class.
    .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0);
}
