import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

type Subject = {repo:string;number:number};
type Reference = {version:1;reference:string};
type Round = {roundNo:number;headSha:string;baseSha:string;reviewer:string;startedAt:number};
type LocalHistory = Subject & {reference:Reference;rounds:Round[];historyProven:false;automaticReview:false};
type Start = Subject & {headSha:string;baseSha:string;reviewer:string;now:number;cooldownMs:number};
export class RoundLedgerError extends Error {
 constructor(public readonly code:string){super(code);this.name='RoundLedgerError';}
}
const refuse=(code:string):never=>{throw new RoundLedgerError(code);};
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const agent=(v:unknown):v is string=>typeof v==='string'&&/^[a-z0-9][a-z0-9_-]{0,127}$/.test(v);
function subject(input:unknown):Subject {
 if(!object(input))return refuse('invalid_input');
 const repo=input.repo,number=input.number;
 if(typeof repo!=='string'||!/^rfcclub\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(repo)||repo.includes('..')||!integer(number)||number===0)return refuse('invalid_input');
 return {repo:repo.toLowerCase(),number};
}
function capture<T>(fn:()=>T):T{try{return fn();}catch(e){if(e instanceof RoundLedgerError)throw e;return refuse('invalid_input');}}
function digest(s:Subject,r:Round,previous:string){return createHash('sha256').update(JSON.stringify([s.repo,s.number,r.roundNo,r.headSha,r.baseSha,r.reviewer,r.startedAt,previous])).digest('hex');}
/** Local spending only. The caller supplies DB and clock; neither local history nor a reference proves admission/custody. */
export class ReviewRoundLedger {
 private readonly clock:()=>number;
 constructor(private readonly db:Database,options:{clock:()=>number}){
  let clock:unknown;try{clock=options?.clock;}catch{throw new RoundLedgerError('config_invalid');}
  if(!(db instanceof Database)||typeof clock!=='function')throw new RoundLedgerError('config_invalid');
  this.clock=clock as ()=>number;
  this.storage(()=>{
   db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000');
   db.exec(`CREATE TABLE IF NOT EXISTS review_round_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
    INSERT OR IGNORE INTO review_round_meta VALUES(1,1);`);
   this.version();
   db.exec(`CREATE TABLE IF NOT EXISTS review_round_subjects(repo TEXT NOT NULL,pr INTEGER NOT NULL,ref_version INTEGER NOT NULL,reference TEXT NOT NULL,PRIMARY KEY(repo,pr));
    CREATE TABLE IF NOT EXISTS review_round_rows(repo TEXT NOT NULL,pr INTEGER NOT NULL,round_no INTEGER NOT NULL,head TEXT NOT NULL,base TEXT NOT NULL,reviewer TEXT NOT NULL,started_at INTEGER NOT NULL,previous_hash TEXT NOT NULL,hash TEXT NOT NULL,
     UNIQUE(repo,pr,round_no), UNIQUE(repo,pr,head,base), FOREIGN KEY(repo,pr) REFERENCES review_round_subjects(repo,pr));
    CREATE TRIGGER IF NOT EXISTS review_round_rows_update BEFORE UPDATE ON review_round_rows BEGIN SELECT RAISE(ABORT,'round_append_only'); END;
    CREATE TRIGGER IF NOT EXISTS review_round_rows_delete BEFORE DELETE ON review_round_rows BEGIN SELECT RAISE(ABORT,'round_append_only'); END;
    CREATE TRIGGER IF NOT EXISTS review_round_subjects_update BEFORE UPDATE ON review_round_subjects BEGIN SELECT RAISE(ABORT,'round_append_only'); END;
    CREATE TRIGGER IF NOT EXISTS review_round_subjects_delete BEFORE DELETE ON review_round_subjects BEGIN SELECT RAISE(ABORT,'round_append_only'); END;`);
  });
 }
 private storage<T>(fn:()=>T):T{try{return fn();}catch(e){if(e instanceof RoundLedgerError)throw e;return refuse('storage_failed');}}
 private version(){const rows=this.db.query('SELECT id,version FROM review_round_meta').all() as {id:number;version:number}[];if(rows.length!==1||rows[0]?.id!==1||rows[0]?.version!==1)refuse('schema_invalid');}
 private history(s:Subject):LocalHistory{
  this.version();
  const row=this.db.query('SELECT ref_version,reference FROM review_round_subjects WHERE repo=? AND pr=?').get(s.repo,s.number) as {ref_version:unknown;reference:unknown}|null;
  if(!row)return refuse('history_unproven');
  if(row.ref_version!==1||typeof row.reference!=='string'||!/^[\x20-\x7e]{1,256}$/.test(row.reference)||row.reference.length>256)return refuse('history_invalid');
  const rows=this.db.query('SELECT round_no,head,base,reviewer,started_at,previous_hash,hash FROM review_round_rows WHERE repo=? AND pr=? ORDER BY round_no LIMIT 4').all(s.repo,s.number) as Record<string,unknown>[];
  if(rows.length>3)return refuse('history_invalid');
  let previous='',time=0;const seen=new Set<string>(),rounds:Round[]=[];
  for(const [i,r] of rows.entries()){
   if(r.round_no!==i+1||!sha(r.head)||!sha(r.base)||!agent(r.reviewer)||!integer(r.started_at)||r.started_at<time||r.previous_hash!==previous)return refuse('history_invalid');
   const value:Round={roundNo:i+1,headSha:r.head,baseSha:r.base,reviewer:r.reviewer,startedAt:r.started_at};
   const key=r.head+':'+r.base;if(seen.has(key)||r.hash!==digest(s,value,previous))return refuse('history_invalid');
   seen.add(key);rounds.push(value);previous=r.hash as string;time=r.started_at;
  }
  return {...s,reference:{version:1,reference:row.reference},rounds,historyProven:false,automaticReview:false};
 }
 recordLocalSubject(input:unknown,reference:unknown):LocalHistory{
  const {s,ref}=capture(()=>{
   const s=subject(input);if(!object(reference))return refuse('invalid_input');
   const version=reference.version,text=reference.reference;
   if(version!==1||typeof text!=='string'||!/^[\x20-\x7e]{1,256}$/.test(text))return refuse('invalid_input');
   return {s,ref:{version:1 as const,reference:text}};
  });
  return this.storage(()=>this.db.transaction(()=>{
   this.version();
   const row=this.db.query('SELECT reference,ref_version FROM review_round_subjects WHERE repo=? AND pr=?').get(s.repo,s.number) as {reference:unknown;ref_version:unknown}|null;
   if(row){if(row.reference!==ref.reference||row.ref_version!==ref.version)refuse('subject_conflict');}
   else this.db.query('INSERT INTO review_round_subjects VALUES(?,?,?,?)').run(s.repo,s.number,ref.version,ref.reference);
   return this.history(s);
  }).immediate());
 }
 inspect(input:unknown):LocalHistory{const s=capture(()=>subject(input));return this.storage(()=>this.db.transaction(()=>this.history(s))());}
 startRound(input:unknown):Round & {historyProven:false;automaticReview:false}{
  const v:Start=capture(()=>{
   const s=subject(input);const x=input as Record<string,unknown>;
   const headSha=x.headSha,baseSha=x.baseSha,reviewer=x.reviewer,now=x.now,cooldownMs=x.cooldownMs;
   if(!sha(headSha)||!sha(baseSha)||!agent(reviewer)||!integer(now)||!integer(cooldownMs))return refuse('invalid_input');
   return {...s,headSha,baseSha,reviewer,now,cooldownMs};
  });
  return this.storage(()=>this.db.transaction(()=>{
   const history=this.history(v);let clock:unknown;try{clock=this.clock();}catch{return refuse('clock_invalid');}
   const last=history.rounds.at(-1);
   if(!integer(clock)||v.now>clock||(last&&v.now<last.startedAt))return refuse('clock_invalid');
   if(history.rounds.some(r=>r.headSha===v.headSha&&r.baseSha===v.baseSha))return refuse('round_spent_unconfirmed');
   if(history.rounds.length>=3)return refuse('round_limit');
   if(last&&v.now-last.startedAt<v.cooldownMs)return refuse('cooldown');
   const value:Round={roundNo:history.rounds.length+1,headSha:v.headSha,baseSha:v.baseSha,reviewer:v.reviewer,startedAt:v.now};
   const previous=last?(this.db.query('SELECT hash FROM review_round_rows WHERE repo=? AND pr=? AND round_no=?').get(v.repo,v.number,last.roundNo) as {hash:string}).hash:'';
   this.db.query('INSERT INTO review_round_rows VALUES(?,?,?,?,?,?,?,?,?)').run(v.repo,v.number,value.roundNo,value.headSha,value.baseSha,value.reviewer,value.startedAt,previous,digest(v,value,previous));
   return {...value,historyProven:false as const,automaticReview:false as const};
  }).immediate());
 }
}
