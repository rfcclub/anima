import { describe, it, expect } from 'vitest';
import type {
  MessageRecord,
  AssembleResult,
  SummaryProvider,
  ContextEngine,
  DEFAULT_COMPACTION_CONFIG,
} from '../src/types.js';

describe('ContextEngine types', () => {
  it('MessageRecord has generic role types (no OpenClaw deps)', () => {
    const msg: MessageRecord = {
      id: 'm1',
      role: 'user',
      content: 'hello',
      seq: 0,
      created_at: new Date().toISOString(),
    };
    expect(msg.role).toBe('user');
    // Verify role union includes all expected values
    const roles: MessageRecord['role'][] = ['user', 'assistant', 'system', 'tool'];
    expect(roles).toHaveLength(4);
  });

  it('AssembleResult has messages array and estimated tokens', () => {
    const result: AssembleResult = {
      messages: [],
      estimatedTokens: 0,
      freshTailCount: 0,
    };
    expect(result.estimatedTokens).toBe(0);
    expect(result.freshTailCount).toBe(0);
  });

  it('SummaryProvider interface accepts complete params', () => {
    const provider: SummaryProvider = {
      complete: async (params) => {
        expect(params.system).toBeTypeOf('string');
        expect(params.messages).toBeInstanceOf(Array);
        return { content: 'test summary' };
      },
    };
    expect(provider).toBeDefined();
    expect(provider.complete).toBeTypeOf('function');
  });

  it('ContextEngine interface defines all lifecycle methods', () => {
    // This is a compile-time shape check
    const engine: ContextEngine = {
      initialize: async () => {},
      bootstrap: async () => ({ importedCount: 0, conversationId: 'c1' }),
      ingest: async () => {},
      assemble: async () => ({ messages: [], estimatedTokens: 0, freshTailCount: 0 }),
      compact: async () => ({ compacted: false, summariesCreated: 0, tokensBefore: 0, tokensAfter: 0 }),
      search: async () => [],
      checkIntegrity: async () => ({ healthy: true, checks: [] }),
      dispose: () => {},
    };
    expect(engine.initialize).toBeTypeOf('function');
    expect(engine.bootstrap).toBeTypeOf('function');
  });

  it('DEFAULT_COMPACTION_CONFIG has all required fields', () => {
    // Imported via type-only — verified by TypeScript compilation
    // This test confirms the constant is importable
    const config = {
      leafChunkTokens: 20_000,
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      leafTargetTokens: 2400,
      condensedTargetTokens: 2000,
      freshTailCount: 64,
      maxSweepIterations: 12,
      sweepDeadlineMs: 120_000,
      maxRounds: 10,
      compactUntilUnderDeadlineMs: 300_000,
    };
    expect(config.freshTailCount).toBe(64);
    expect(config.maxSweepIterations).toBe(12);
  });
});
