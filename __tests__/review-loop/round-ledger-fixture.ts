import { Database } from 'bun:sqlite';
import { ReviewRoundLedger, RoundLedgerError } from '../../src/review-loop/round-ledger';
const [file, raw, mode] = process.argv.slice(2);
if (!file || !raw) throw Error('fixture input');
const db = new Database(file);
try {
  const ledger = new ReviewRoundLedger(db, { clock: () => 10_000 });
  console.log('READY');
  await Bun.stdin.text();
  try { console.log(JSON.stringify({ ok: true, value: ledger.startRound(JSON.parse(raw)) })); }
  catch (e) { console.log(JSON.stringify({ ok: false, code: e instanceof RoundLedgerError ? e.code : 'unexpected' })); }
  if (mode === 'hold') await Bun.sleep(60_000);
} finally { db.close(); }
