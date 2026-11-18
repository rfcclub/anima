#!/usr/bin/env node
// verify-anima-fts.mjs — regression check for the FTS5 multi-word recall bug.
// Usage: ./tools/verify-anima-fts.mjs [--agent abel]

import { AnimaMemoryStore } from '/Users/user/.openclaw/plugins/@anima/openclaw-adapter/dist/memory-store.js';

const agent = process.argv.includes('--agent')
  ? process.argv[process.argv.indexOf('--agent') + 1]
  : 'abel';

const dbPath = `${process.env.HOME}/.anima/agents/${agent}/memory.db`;
const store = new AnimaMemoryStore(dbPath);

await store.initialize();

const andResult = store.ftsSearch('memory compaction', 10);
const orTokenResult = store.ftsSearch('compaction engine strategy', 10);

console.log(`[verify-anima-fts:${agent}] database: ${dbPath}`);
console.log(`  "memory compaction" (OR-joined): ${andResult.length}`);
console.log(`  "compaction engine strategy" (OR-joined): ${orTokenResult.length}`);

if (andResult.length === 0 && store.ftsSearch('compaction', 10).length > 0) {
  console.error('FAIL: multi-word query returns empty while single token returns results — FTS5 AND bug still present.');
  process.exit(1);
}

console.log('PASS: multi-word FTS recall is working.');
