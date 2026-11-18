import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewRoundLedger, RoundLedgerError } from '../../src/review-loop/round-ledger';
const subject = { repo: 'rfcclub/anima', number: 45 };
const ref = { version: 1 as const, reference: 'local-reference-not-authority' };
const H = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40);
const start = { ...subject, headSha: H, baseSha: B, reviewer: 'bruno', now: 100, cooldownMs: 0 };
const dbs: Database[] = [], dirs: string[] = [];
function memory() { const db = new Database(':memory:'); dbs.push(db); return db; }
function fixture() { const db = memory(); return { db, ledger: new ReviewRoundLedger(db, { clock: () => 10_000 }) }; }
function known() { const f = fixture(); f.ledger.recordLocalSubject(subject, ref); return f; }
function code(fn: () => unknown, expected: string) {
  try { fn(); throw Error('did not refuse'); } catch(e) { expect(e).toBeInstanceOf(RoundLedgerError); expect((e as RoundLedgerError).code).toBe(expected); }
}
afterEach(() => { for (const db of dbs.splice(0)) try { db.close(); } catch {} for(const d of dirs.splice(0)) rmSync(d,{recursive:true,force:true}); });

test('RL-1 unknown inspect/start never enrolls implicitly', () => {
 const {db,ledger}=fixture(); code(()=>ledger.inspect(subject),'history_unproven'); code(()=>ledger.startRound(start),'history_unproven');
 expect(db.query('SELECT count(*) AS n FROM review_round_subjects').get()).toEqual({n:0});
});
test('RL-2 opaque local reference remains unproven and idempotent, conflict refuses',()=>{
 const {ledger}=known(); expect(ledger.inspect(subject)).toMatchObject({reference:ref,historyProven:false,automaticReview:false,rounds:[]});
 ledger.recordLocalSubject(subject,ref); code(()=>ledger.recordLocalSubject(subject,{...ref,reference:'other'}),'subject_conflict');
 expect(ledger.inspect(subject).reference).toEqual(ref);
});
test('RL-3 three-round lifetime cap survives head/base changes and reopen',()=>{
 const dir=mkdtempSync(join(tmpdir(),'round-ledger-'));dirs.push(dir);const file=join(dir,'test.db');
 const db=new Database(file), l=new ReviewRoundLedger(db,{clock:()=>10_000});l.recordLocalSubject(subject,ref);
 expect(l.startRound(start).roundNo).toBe(1);
 expect(l.startRound({...start,baseSha:C,now:101}).roundNo).toBe(2);
 expect(l.startRound({...start,headSha:D,baseSha:C,now:102}).roundNo).toBe(3);db.close();
 const db2=new Database(file);dbs.push(db2);const reopened=new ReviewRoundLedger(db2,{clock:()=>10_000});
 code(()=>reopened.startRound({...start,headSha:C,now:103}),'round_limit');expect(reopened.inspect(subject).rounds).toHaveLength(3);
});
test('RL-4 same head/base remains spent with no renewed timestamp or reviewer',()=>{
 const {ledger}=known();ledger.startRound(start);const before=ledger.inspect(subject);
 code(()=>ledger.startRound({...start,now:200,reviewer:'eli'}),'round_spent_unconfirmed');expect(ledger.inspect(subject)).toEqual(before);
});
for (const [now,allowed] of [[109,false],[110,true],[111,true]] as const) test(`RL-5 cooldown boundary ${now}`,()=>{
 const {ledger}=known();ledger.startRound(start); const next={...start,headSha:C,now,cooldownMs:10};
 if(allowed) expect(ledger.startRound(next).roundNo).toBe(2);else code(()=>ledger.startRound(next),'cooldown');
});
for(const now of [99,10001]) test(`RL-5 invalid clock ${now} refuses without spending`,()=>{
 const {ledger}=known();ledger.startRound(start);code(()=>ledger.startRound({...start,headSha:C,now}),'clock_invalid');expect(ledger.inspect(subject).rounds).toHaveLength(1);
});
test('RL-5 injected clock failures and invalid values have fixed refusal',()=>{
 for(const clock of [()=>{throw Error('private');},()=>NaN,()=>-1,()=>1.5]) {
 const db=memory(),ledger=new ReviewRoundLedger(db,{clock});ledger.recordLocalSubject(subject,ref);code(()=>ledger.startRound(start),'clock_invalid');expect(ledger.inspect(subject).rounds).toHaveLength(0);
 }
});
test('RL-6 independent connections see the same spent pair',()=>{
 const dir=mkdtempSync(join(tmpdir(),'round-ledger-'));dirs.push(dir); const path=join(dir,'test.db');
 const a=new Database(path),b=new Database(path);dbs.push(a,b);const x=new ReviewRoundLedger(a,{clock:()=>1000}),y=new ReviewRoundLedger(b,{clock:()=>1000});
 x.recordLocalSubject(subject,ref);x.startRound(start);code(()=>y.startRound(start),'round_spent_unconfirmed');expect(y.inspect(subject).rounds).toHaveLength(1);
});
for(const which of ['number','pair']) test(`RL-6c UNIQUE ${which} is enforced independently of transaction ordering`,()=>{
 const {db,ledger}=known();ledger.startRound(start);
 // Fixture-only direct duplicate insertion into a disposable in-memory database, never an operator DB.
 expect(()=>db.query(`INSERT INTO review_round_rows(repo,pr,round_no,head,base,reviewer,started_at,previous_hash,hash)
 VALUES(?,?,?,?,?,?,?,?,?)`).run(subject.repo,subject.number,which==='number'?1:2,which==='number'?C:H,B,'bruno',101,'','x')).toThrow('UNIQUE');
 expect(ledger.inspect(subject).rounds).toHaveLength(1);
});
test('RL-7 storage corruption with legal sequence is refused',()=>{
 const {db,ledger}=known();ledger.startRound(start);
 // Fixture-only schema tamper in disposable memory DB; custody is not claimed.
 db.exec('DROP TRIGGER review_round_rows_update');db.query('UPDATE review_round_rows SET hash=?').run('0'.repeat(64));
 code(()=>ledger.inspect(subject),'history_invalid');
});
test('RL-7 ordinary row updates/deletions refuse and rows stay unchanged',()=>{
 const {db,ledger}=known();ledger.startRound(start);const before=ledger.inspect(subject);
 // Fixture-only statements against this test's disposable memory DB. Operator execution forbidden; expected trigger refusal.
 expect(()=>db.exec('UPDATE review_round_rows SET started_at=0')).toThrow('round_append_only');
 // Disposable refusal fixture; operator execution forbidden; requires review.
 expect(()=>db.exec('DELETE FROM review_round_rows')).toThrow('round_append_only');
 expect(ledger.inspect(subject)).toEqual(before);
});
test('RL-7 constructor forces FULL and foreign keys on weak connection',()=>{
 const db=memory();db.exec('PRAGMA synchronous=OFF; PRAGMA foreign_keys=OFF');new ReviewRoundLedger(db,{clock:()=>0});
 expect(db.query('PRAGMA synchronous').get()).toEqual({synchronous:2});expect(db.query('PRAGMA foreign_keys').get()).toEqual({foreign_keys:1});
});
test('RL-7 unrecognized schema version refuses',()=>{
 const db=memory();db.exec('CREATE TABLE review_round_meta(id INTEGER PRIMARY KEY,version INTEGER); INSERT INTO review_round_meta VALUES(1,2)');
 code(()=>new ReviewRoundLedger(db,{clock:()=>0}),'schema_invalid');
});
test('RL-7 repo and PR isolation',()=>{
 const {ledger}=known();ledger.startRound(start);for(const s of [{...subject,number:46},{...subject,repo:'rfcclub/colony-mesh'}]){ledger.recordLocalSubject(s,ref);expect(ledger.inspect(s).rounds).toEqual([]);expect(ledger.startRound({...start,...s}).roundNo).toBe(1);}
});
const invalidSubjects=[null,{}, {...subject,repo:'other/anima'},{...subject,repo:'rfcclub/../x'},{...subject,number:0},{...subject,number:1.5}];
invalidSubjects.forEach((s,i)=>test(`RL-7 malformed subject ${i}`,()=>{const {ledger}=fixture();code(()=>ledger.inspect(s),'invalid_input');code(()=>ledger.recordLocalSubject(s,ref),'invalid_input');}));
const invalidRefs=[null,{}, {version:2,reference:'x'},{version:1,reference:''},{version:1,reference:'x'.repeat(257)},{version:1,reference:'x\n'}];
invalidRefs.forEach((r,i)=>test(`RL-7 invalid local reference ${i}`,()=>{const {ledger}=fixture();code(()=>ledger.recordLocalSubject(subject,r),'invalid_input');code(()=>ledger.inspect(subject),'history_unproven');}));
const invalidStarts=[null,{}, {...start,headSha:'A'.repeat(40)},{...start,baseSha:'bad'},{...start,reviewer:'BRUNO'},{...start,reviewer:''},{...start,now:NaN},{...start,now:-1},{...start,now:1.5},{...start,cooldownMs:-1},{...start,cooldownMs:Infinity},{...start,cooldownMs:0.1}];
invalidStarts.forEach((s,i)=>test(`RL-7 invalid start ${i}`,()=>{const {ledger}=known();code(()=>ledger.startRound(s),'invalid_input');expect(ledger.inspect(subject).rounds).toHaveLength(0);}));
test('RL-7 throwing input getters refuse with no disclosed text',()=>{
 const {ledger}=known();code(()=>ledger.startRound({get repo(){throw Error('private');}}),'invalid_input');
});
test('RL-8 local receipts do not carry complete, ready, candidate or loop authority',()=>{
 const {ledger}=known();const receipt=ledger.startRound(start);expect(receipt).toMatchObject({historyProven:false,automaticReview:false});
 for(const key of ['complete','ready','candidate','loop','automaticMerge'])expect(receipt).not.toHaveProperty(key);
 const source=readFileSync(new URL('../../src/review-loop/round-ledger.ts',import.meta.url),'utf8');expect(source).not.toMatch(/process\.env|Date\.now|fetch\(|homedir\(|readFile/);
});
async function child(file:string,input:unknown,hold=false) {
 const p=Bun.spawn([process.execPath,new URL('./round-ledger-fixture.ts',import.meta.url).pathname,file,JSON.stringify(input),hold?'hold':'exit'],
  {stdin:'pipe',stdout:'pipe',stderr:'pipe',env:{PATH:'/usr/bin:/bin'}});
 const reader=p.stdout.getReader(); let text='';
 async function line(){for(;;){const n=text.indexOf('\n');if(n>=0){const s=text.slice(0,n);text=text.slice(n+1);return s;}const r=await reader.read();if(r.done)throw Error('fixture closed: '+await new Response(p.stderr).text());text+=new TextDecoder().decode(r.value);}}
 expect(await line()).toBe('READY');
 return {p,line,reader};
}
async function race(lastSlot:boolean){
 const dir=mkdtempSync(join(tmpdir(),'round-ledger-'));dirs.push(dir);const file=join(dir,'test.db');const db=new Database(file);dbs.push(db);
 const l=new ReviewRoundLedger(db,{clock:()=>10000});l.recordLocalSubject(subject,ref);
 if(lastSlot){l.startRound(start);l.startRound({...start,headSha:C});}
 const a=await child(file,{...start,headSha:D}),b=await child(file,{...start,headSha:lastSlot?B:D});
 try {a.p.stdin.write('go');a.p.stdin.end();b.p.stdin.write('go');b.p.stdin.end();const results=await Promise.all([a.line(),b.line()]);
 const receipts=results.map(s=>JSON.parse(s));expect(receipts.map(r=>r.ok).sort()).toEqual([false,true]);
 expect(receipts.find(r=>!r.ok)?.code).toBe(lastSlot?'round_limit':'round_spent_unconfirmed');expect(await a.p.exited).toBe(0);expect(await b.p.exited).toBe(0);
 expect(l.inspect(subject).rounds).toHaveLength(lastSlot?3:1);
 } finally {a.reader.releaseLock();b.reader.releaseLock();a.p.kill();b.p.kill();await Promise.all([a.p.exited,b.p.exited]);}
}
test('RL-6a real processes race same subject pair once',()=>race(false),10000);
test('RL-6b real processes race the final third slot once',()=>race(true),10000);
test('RL-4 SIGKILL after committed spending cannot refund or start same pair again',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'round-ledger-'));dirs.push(dir);const file=join(dir,'test.db');const db=new Database(file);dbs.push(db);
 const l=new ReviewRoundLedger(db,{clock:()=>10000});l.recordLocalSubject(subject,ref);const c=await child(file,start,true);
 try {c.p.stdin.write('go');c.p.stdin.end();expect(JSON.parse(await c.line()).ok).toBe(true);c.p.kill('SIGKILL');await c.p.exited;
 code(()=>l.startRound({...start,now:200}),'round_spent_unconfirmed');expect(l.inspect(subject).rounds).toHaveLength(1);
 } finally {c.reader.releaseLock();c.p.kill();await c.p.exited;}
},10000);
test('RL-7-case repository case aliases cannot enroll a fresh budget',()=>{
 const {ledger}=known();ledger.startRound(start);const alias={...subject,repo:'rfcclub/ANIMA'};
 expect(ledger.inspect(alias)).toEqual(ledger.inspect(subject));ledger.recordLocalSubject(alias,ref);
 code(()=>ledger.startRound({...start,...alias}),'round_spent_unconfirmed');
});
test('RL-7 constructor captures clock callback once',()=>{
 const db=memory();let reads=0;const ledger=new ReviewRoundLedger(db,{get clock(){reads++;if(reads>1)throw Error('private');return ()=>1000;}});
 ledger.recordLocalSubject(subject,ref);expect(ledger.startRound(start).roundNo).toBe(1);expect(reads).toBe(1);
});
test('RL-7 input scalars stay captured when clock mutates caller objects',()=>{
 const db=memory(),input={...start};const ledger=new ReviewRoundLedger(db,{clock:()=>{input.headSha=C;input.baseSha=D;input.reviewer='eli';input.now=999;return 1000;}});
 ledger.recordLocalSubject(subject,ref);expect(ledger.startRound(input)).toMatchObject({headSha:H,baseSha:B,reviewer:'bruno',startedAt:100});
});
test('RL-7 closed storage yields only fixed storage_failed',()=>{
 const {db,ledger}=known();db.close();code(()=>ledger.inspect(subject),'storage_failed');
});

test('RL-7 first round with legal hash but wrong sequence refuses',()=>{
 const {db,ledger}=known();
 // Deliberate fixture forgery in a disposable database: legal hash does not repair a sequence gap.
 const hash=createHash('sha256').update(JSON.stringify([subject.repo,subject.number,2,H,B,'bruno',100,''])).digest('hex');
 db.query('INSERT INTO review_round_rows VALUES(?,?,?,?,?,?,?,?,?)').run(subject.repo,subject.number,2,H,B,'bruno',100,'',hash);
 code(()=>ledger.inspect(subject),'history_invalid');
});
test('RL-7 actual orphan round insert refuses foreign key and leaves zero rows',()=>{
 const {db}=fixture();
 expect(()=>db.query('INSERT INTO review_round_rows VALUES(?,?,?,?,?,?,?,?,?)').run(subject.repo,subject.number,1,H,B,'bruno',100,'','fake')).toThrow('FOREIGN KEY');
 expect(db.query('SELECT count(*) AS n FROM review_round_rows').get()).toEqual({n:0});
});
test('RL-7 invalid stored local reference refuses',()=>{
 const {db,ledger}=fixture();db.query('INSERT INTO review_round_subjects VALUES(?,?,?,?)').run(subject.repo,subject.number,2,'not-version-one');
 code(()=>ledger.inspect(subject),'history_invalid');
});
test('RL-7 row counter and canonical hash counter cannot disagree',()=>{
 const {db,ledger}=known();
 // Disposable fixture: hash claims counter1 while the stored counter is2. Neither representation may overwrite the other.
 const hash=createHash('sha256').update(JSON.stringify([subject.repo,subject.number,1,H,B,'bruno',100,''])).digest('hex');
 db.query('INSERT INTO review_round_rows VALUES(?,?,?,?,?,?,?,?,?)').run(subject.repo,subject.number,2,H,B,'bruno',100,'',hash);
 code(()=>ledger.inspect(subject),'history_invalid');
});

test('RL-5 cooldown is measured from the latest of two prior rounds',()=>{
 const {ledger}=known();ledger.startRound(start);ledger.startRound({...start,headSha:C,now:200});
 code(()=>ledger.startRound({...start,headSha:D,now:209,cooldownMs:10}),'cooldown');
 expect(ledger.inspect(subject).rounds).toHaveLength(2);
 expect(ledger.startRound({...start,headSha:D,now:210,cooldownMs:10}).roundNo).toBe(3);
});
for(const op of ['update','remove'])test(`RL-7 subject ${op} trigger refuses and preserves all history`,()=>{
 const {db,ledger}=known();ledger.startRound(start);const before=ledger.inspect(subject);
 // Disposable refusal fixture; operator execution forbidden; requires review.
 const sql=op==='remove'?'DELETE FROM review_round_subjects':"UPDATE review_round_subjects SET reference='changed'";
 expect(()=>db.exec(sql)).toThrow('round_append_only');expect(ledger.inspect(subject)).toEqual(before);
 expect(db.query('SELECT count(*) AS n FROM review_round_subjects').get()).toEqual({n:1});
 expect(db.query('SELECT count(*) AS n FROM review_round_rows').get()).toEqual({n:1});
});
test('RL-6 immediate write reservation exists before the clock callback',()=>{
 const dir=mkdtempSync(join(tmpdir(),'round-ledger-'));dirs.push(dir);const path=join(dir,'test.db');
 const db=new Database(path),observer=new Database(path);dbs.push(db,observer);observer.exec('PRAGMA busy_timeout=0');let blocked=false;
 const ledger=new ReviewRoundLedger(db,{clock:()=>{
  try{observer.exec('BEGIN IMMEDIATE');observer.exec('ROLLBACK');}
  catch(e){expect(String(e)).toMatch(/locked|busy/i);blocked=true;}
  return 1000;
 }});
 ledger.recordLocalSubject(subject,ref);expect(ledger.startRound(start).roundNo).toBe(1);expect(blocked).toBe(true);
});
const hashFields=[['repo','rfcclub/other'],['pr',46],['round_no',2],['head',C],['base',D],['reviewer','eli'],['started_at',101],['previous_hash','0'.repeat(64)],['hash','f'.repeat(64)]] as const;
for(const [field,value] of hashFields)test(`RL-7 stored ${field} tamper cannot retain the old digest`,()=>{
 const {db,ledger}=known();ledger.startRound(start);const moved={repo:field==='repo'?String(value):subject.repo,number:field==='pr'?Number(value):subject.number};
 if(field==='repo'||field==='pr')ledger.recordLocalSubject(moved,ref);
 // Disposable memory-only forgery; operator execution forbidden; requires review.
 db.exec('DROP TRIGGER review_round_rows_update');db.query(`UPDATE review_round_rows SET ${field}=?`).run(value);
 code(()=>ledger.inspect(moved),'history_invalid');
 expect(db.query('SELECT count(*) AS n FROM review_round_rows').get()).toEqual({n:1});
});
