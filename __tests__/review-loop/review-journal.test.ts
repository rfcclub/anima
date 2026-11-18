import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewJournal, type ReviewJournalState, type ReviewSubject } from "../../src/review-loop/review-journal";
const subject: ReviewSubject = { repo: "rfcclub/anima", number: 45, headSha: "a".repeat(40), baseSha: "b".repeat(40), appLogin: "reviewer[bot]" };
const review = { reviewId: 123, headSha: subject.headSha, appLogin: subject.appLogin };
function fixture(run: (j: ReviewJournal, db: Database, path: string) => void) {
 const root=mkdtempSync(join(tmpdir(),"anima-review-journal-")), path=join(root,"journal.sqlite"), db=new Database(path);
 try {run(new ReviewJournal(db),db,path);} finally {db.close();rmSync(root,{recursive:true,force:true});}
}
describe("approval journal BR-1",()=>{
 test("two independent connections reserve an exact subject once",()=>fixture((j,_db,path)=>{
  const a=j.reserve(subject);expect(a).not.toBeNull(); const db2=new Database(path);
  try {const other=new ReviewJournal(db2);expect(other.reserve(subject)).toBeNull();expect(other.get(a!.id)?.state).toBe("reserved");} finally {db2.close();}
 }));
 test("case variants of App and repository cannot reserve twice",()=>fixture(j=>{
  expect(j.reserve(subject)).not.toBeNull();expect(j.reserve({...subject,repo:"rfcclub/ANIMA",appLogin:"REVIEWER[bot]"})).toBeNull();
 }));
 test("every subject identity axis has its own reservation",()=>fixture(j=>{
  expect(j.reserve(subject)).not.toBeNull();
  for(const value of [{repo:"rfcclub/other"},{number:46},{headSha:"c".repeat(40)},{baseSha:"c".repeat(40)},{appLogin:"another[bot]"}]) expect(j.reserve({...subject,...value})).not.toBeNull();
 }));
 test("FULL durability and reopen preserve reserved and sending uncertainty",()=>fixture((j,db,path)=>{
  expect(db.query("PRAGMA synchronous").get()).toEqual({synchronous:2});const a=j.reserve(subject)!;j.append(a.id,"sending");
  const db2=new Database(path);try {const other=new ReviewJournal(db2);expect(other.get(a.id)?.state).toBe("sending");expect(other.reserve(subject)).toBeNull();expect(other.bindings()).toEqual([]);}finally{db2.close();}
 }));
 test("only bound state exposes the exact receipt, never created or orphan",()=>fixture(j=>{
  const a=j.reserve(subject)!;j.append(a.id,"sending");j.append(a.id,"created",review);expect(j.bindings()).toEqual([]);j.append(a.id,"bound");
  expect(j.bindings()).toEqual([{reviewId:123,headSha:subject.headSha,baseSha:subject.baseSha,appLogin:subject.appLogin}]);
 }));
 for(const terminal of ["rejected","uncertain"] as const) test(`${terminal} is terminal and not automatically retried`,()=>fixture(j=>{
  const a=j.reserve(subject)!;j.append(a.id,"sending");j.append(a.id,terminal);expect(j.reserve(subject)).toBeNull();expect(()=>j.append(a.id,"sending")).toThrow("journal_transition");expect(j.bindings()).toEqual([]);
 }));
 test("created then unbound remains unbound and cannot be promoted",()=>fixture(j=>{
  const a=j.reserve(subject)!;j.append(a.id,"sending");j.append(a.id,"created",review);j.append(a.id,"unbound");
  expect(()=>j.append(a.id,"bound")).toThrow("journal_transition");expect(j.bindings()).toEqual([]);
 }));
 test("invalid transitions do not add events",()=>fixture(j=>{
  const a=j.reserve(subject)!;expect(()=>j.append(a.id,"bound")).toThrow("journal_transition");expect(()=>j.append(a.id,"created",review)).toThrow("journal_transition");expect(j.get(a.id)?.state).toBe("reserved");
 }));
 test("actual review id cannot bind two different subjects",()=>fixture(j=>{
  const a=j.reserve(subject)!,b=j.reserve({...subject,baseSha:"c".repeat(40)})!;
  for(const x of [a,b])j.append(x.id,"sending");j.append(a.id,"created",review);j.append(a.id,"bound");
  expect(()=>j.append(b.id,"created",review)).toThrow();expect(j.bindings()).toHaveLength(1);expect(j.get(b.id)?.state).toBe("sending");
 }));
 for(const field of ["reviewId","headSha","appLogin"] as const) test(`created ${field} is validated against actual subject`,()=>fixture(j=>{
  const a=j.reserve(subject)!;j.append(a.id,"sending");const invalid={...review,[field]:field==="reviewId"?0:"wrong"};expect(()=>j.append(a.id,"created",invalid)).toThrow("journal_review");expect(j.get(a.id)?.state).toBe("sending");
 }));
 for(const table of ["review_subjects","review_events"])for(const mutation of ["UPDATE","DELETE"]) test(`${table} refuses ${mutation}`,()=>fixture((j,db)=>{
  j.reserve(subject);const before=db.query(`SELECT COUNT(*) AS n FROM ${table}`).get();
  // Disposable per-test temp DB only; operator execution forbidden; requires review; expected trigger refusal.
  const sql=mutation==="DELETE"?`DELETE FROM ${table}`:`UPDATE ${table} SET ${table==="review_subjects"?"id=id":"state=state"}`;
  expect(()=>db.exec(sql)).toThrow("journal_immutable");expect(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual(before);expect(j.reserve(subject)).toBeNull();
 }));
 test("unknown attempt and malformed subject refuse with fixed errors",()=>fixture(j=>{
  expect(j.get("missing")).toBeNull();expect(()=>j.append("missing","sending")).toThrow("journal_transition");
  for(const bad of [{...subject,number:0},{...subject,headSha:"bad"},{...subject,repo:"evil/anima"},{...subject,appLogin:"user"}])expect(()=>j.reserve(bad)).toThrow("journal_subject");
 }));
 test("inserted invalid event sequence is detected by every binding reader",()=>fixture((j,db)=>{
  const a=j.reserve(subject)!;db.query("INSERT INTO review_events(attempt_id,seq,state) VALUES(?,3,'bound')").run(a.id);
  expect(()=>j.get(a.id)).toThrow("journal_invalid");expect(()=>j.bindings()).toThrow("journal_invalid");
 }));
 test("inserted evidence not matching subject never appears as a binding",()=>fixture((j,db)=>{
  const a=j.reserve(subject)!;j.append(a.id,"sending");
  db.query("INSERT INTO review_events(attempt_id,seq,state,payload,review_id) VALUES(?,3,'created',?,123)").run(a.id,JSON.stringify({...review,headSha:"c".repeat(40)}));
  expect(()=>j.get(a.id)).toThrow("journal_invalid");expect(()=>j.bindings()).toThrow("journal_invalid");
 }));
 test("transaction rollback preserves reservation when initial event cannot be inserted",()=>fixture((j,db)=>{
  db.exec("CREATE TRIGGER fixture_fail BEFORE INSERT ON review_events BEGIN SELECT RAISE(ABORT,'fixture'); END;");
  expect(()=>j.reserve(subject)).toThrow("fixture");expect(j.find(subject)).toBeNull();db.exec("DROP TRIGGER fixture_fail");expect(j.reserve(subject)).not.toBeNull();
 }));

 test("sequence gap with an otherwise legal transition refuses readback",()=>fixture((j,db)=>{
  const a=j.reserve(subject)!;db.query("INSERT INTO review_events(attempt_id,seq,state) VALUES(?,3,'sending')").run(a.id);
  expect(()=>j.get(a.id)).toThrow("journal_invalid");expect(()=>j.bindings()).toThrow("journal_invalid");
 }));

});

// This matrix pins the public transition contract, including every terminal -> created attempt.
const transitions: Record<ReviewJournalState, readonly ReviewJournalState[]> = {
 reserved:["sending"],sending:["created","rejected","uncertain"],created:["bound","unbound"],
 rejected:[],uncertain:[],bound:[],unbound:[],
};
function atState(j:ReviewJournal,state:ReviewJournalState) {
 const a=j.reserve(subject)!;
 if(state!=="reserved")j.append(a.id,"sending");
 if(["created","bound","unbound"].includes(state))j.append(a.id,"created",review);
 if(["rejected","uncertain","bound","unbound"].includes(state))j.append(a.id,state as "rejected"|"uncertain"|"bound"|"unbound");
 return a.id;
}
for(const from of Object.keys(transitions) as ReviewJournalState[])for(const to of ["sending","created","rejected","uncertain","bound","unbound"] as const)
 test(`BR-1 transition ${from} -> ${to}: ${transitions[from].includes(to)?"allowed":"refused"}`,()=>fixture((j,db)=>{
  const id=atState(j,from),before=db.query("SELECT * FROM review_events ORDER BY seq").all();
  if(transitions[from].includes(to)){j.append(id,to,to==="created"?review:undefined);expect(j.get(id)?.state).toBe(to);}
  else {expect(()=>j.append(id,to,to==="created"?review:undefined)).toThrow("journal_transition");expect(j.get(id)?.state).toBe(from);expect(db.query("SELECT * FROM review_events ORDER BY seq").all()).toEqual(before);}
  expect(j.bindings()).toHaveLength((transitions[from].includes(to)?to:from)==="bound"?1:0);
 }));
for(const shape of ["wrong first state","illegal transition with contiguous sequence","review id column mismatch","payload on plain event","key versus subject payload","subject with no events"])
 test(`BR-1 forged history refuses: ${shape}`,()=>fixture((j,db)=>{
  const id="fixture-forged-attempt",key=JSON.stringify([subject.repo,subject.number,subject.headSha,subject.baseSha,subject.appLogin]);
  db.query("INSERT INTO review_subjects(key,id,payload) VALUES(?,?,?)").run(key,id,JSON.stringify(shape==="key versus subject payload"?{...subject,number:46}:subject));
  const add=(seq:number,state:string,payload:string|null=null,column:number|null=null)=>db.query("INSERT INTO review_events(attempt_id,seq,state,payload,review_id) VALUES(?,?,?,?,?)").run(id,seq,state,payload,column);
  if(shape!=="subject with no events")add(1,shape==="wrong first state"?"sending":"reserved",shape==="payload on plain event"?"{}":null);
  if(shape==="illegal transition with contiguous sequence")add(2,"bound");
  if(shape==="review id column mismatch"){add(2,"sending");add(3,"created",JSON.stringify(review),124);}
  expect(()=>j.get(id)).toThrow("journal_invalid");expect(()=>j.bindings()).toThrow("journal_invalid");
 }));
test("BR-1 FULL is forced on an explicitly weakened connection",()=>fixture((_j,db)=>{
 db.exec("PRAGMA synchronous=OFF");expect(db.query("PRAGMA synchronous").get()).toEqual({synchronous:0});new ReviewJournal(db);expect(db.query("PRAGMA synchronous").get()).toEqual({synchronous:2});
}));
test("BR-1 foreign key prevents events without a subject",()=>fixture((_j,db)=>{
 expect(()=>db.query("INSERT INTO review_events(attempt_id,seq,state) VALUES('missing',1,'reserved')").run()).toThrow("FOREIGN KEY");expect(db.query("SELECT COUNT(*) AS n FROM review_events").get()).toEqual({n:0});
}));
for(const bad of [{...subject,baseSha:"bad"},{...subject,appLogin:"bad login[bot]"}])test("BR-1 malformed base/App refuses at the journal boundary",()=>fixture(j=>{
 expect(()=>j.reserve(bad)).toThrow("journal_subject");expect(j.bindings()).toEqual([]);
}));
test("BR-1 custody limitation: INSERT OR REPLACE can reconstruct a legal history",()=>fixture((j,db)=>{
 const id=atState(j,"uncertain");expect(db.query("PRAGMA recursive_triggers").get()).toEqual({recursive_triggers:0});
 // Disposable fixture only; demonstrates an UNPROTECTED same-UID SQL boundary, never operator recovery.
 db.query("INSERT OR REPLACE INTO review_events(attempt_id,seq,state,payload,review_id) VALUES(?,3,'created',?,?)").run(id,JSON.stringify(review),review.reviewId);
 j.append(id,"bound");expect(j.bindings()).toEqual([{...review,baseSha:subject.baseSha}]);
}));
