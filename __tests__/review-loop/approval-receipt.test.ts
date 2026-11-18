import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewJournal } from "../../src/review-loop/review-journal";
import { produceApprovalReceipt, reconcileApprovalAttempt, approvalAttemptMarker } from "../../src/review-loop/approval-receipt";
const snapshot={repo:"rfcclub/anima",number:45,headSha:"a".repeat(40),baseSha:"b".repeat(40),baseBranch:"master",authorLogin:"author[bot]"};
const reviewer={agent:"reviewer",appLogin:"reviewer[bot]"};
const anchor={...snapshot,state:"OPEN",draft:false,liveBaseSha:snapshot.baseSha};
const review={id:123,state:"APPROVED",commit_id:snapshot.headSha,user:{login:reviewer.appLogin,type:"Bot"}};
function fixture() {
 const db=new Database(":memory:"), journal=new ReviewJournal(db), calls:any[]=[];let reads=0;
 const ports={readAnchor:async (_signal:AbortSignal)=>{reads++;return anchor;},submitApproval:async(request:any,_signal:AbortSignal)=>{calls.push(request);return {status:200,review};}};
 const run=(options:any={})=>produceApprovalReceipt(journal,snapshot,reviewer,"Reviewed code.",ports,options);
 return {db,journal,calls,ports,run,reads:()=>reads};
}
async function scoped(fn:(f:ReturnType<typeof fixture>)=>Promise<void>){const f=fixture();try{await fn(f);}finally{f.db.close();}}
test("BR-2/3 one exact-head POST, trusted marker and response receipt",()=>scoped(async f=>{
 const r=await f.run();expect(r.ok).toBe(true);if(!r.ok)throw Error("not created");expect(f.calls).toHaveLength(1);expect(f.reads()).toBe(2);
 expect(f.calls[0]).toEqual({repo:snapshot.repo,number:45,event:"APPROVE",commit_id:snapshot.headSha,body:`Reviewed code.\n\nReviewer: reviewer\n${approvalAttemptMarker(r.attemptId)}`});
 expect(r.binding).toEqual({reviewId:123,headSha:snapshot.headSha,baseSha:snapshot.baseSha,appLogin:reviewer.appLogin});expect(f.journal.bindings()).toEqual([r.binding]);
}));
test("duplicate bound subject and dismissal do not create another approval",()=>scoped(async f=>{
 expect((await f.run()).ok).toBe(true);const r=await f.run();expect(r).toMatchObject({ok:false,reason:"same_subject_bound"});expect(f.calls).toHaveLength(1);
}));
for(const [field,value] of [["headSha","c".repeat(40)],["baseSha","c".repeat(40)],["liveBaseSha","c".repeat(40)],["baseBranch","other"],["authorLogin","foreign[bot]"],["repo","rfcclub/other"],["number",46],["state","CLOSED"],["draft",true]] as const) {
 test(`BR-2 initial anchor ${field} mismatch: zero reservation/send`,()=>scoped(async f=>{
  f.ports.readAnchor=async()=>({...anchor,[field]:value});expect(await f.run()).toMatchObject({ok:false,reason:"anchor_moved"});expect(f.calls).toEqual([]);expect(f.journal.find({...snapshot,appLogin:reviewer.appLogin})).toBeNull();
 }));
 test(`BR-3 final anchor ${field} mismatch: created stays unbound`,()=>scoped(async f=>{
  let n=0;f.ports.readAnchor=async()=>++n===1?anchor:({...anchor,[field]:value});const r=await f.run();expect(r).toMatchObject({ok:false,reason:"anchor_moved"});expect(f.calls).toHaveLength(1);expect(f.journal.bindings()).toEqual([]);expect(f.journal.get(r.attemptId!)?.state).toBe("unbound");
 }));
}
for(const [field,value] of [["id",0],["id",Number.MAX_SAFE_INTEGER+1],["state","COMMENTED"],["commit_id","c".repeat(40)],["user",{login:"wrong[bot]",type:"Bot"}],["user",{login:reviewer.appLogin,type:"User"}],["user",null]] as const) test(`BR-3 untrusted response ${field} ${JSON.stringify(value)}`,()=>scoped(async f=>{
 f.ports.submitApproval=async(request)=>{f.calls.push(request);return {status:200,review:{...review,[field]:value}} as any;};const r=await f.run();expect(r).toMatchObject({ok:false,reason:"response_unproven"});expect(f.journal.get(r.attemptId!)?.state).toBe("uncertain");expect(f.journal.bindings()).toEqual([]);await f.run();expect(f.calls).toHaveLength(1);
}));
for(const status of [400,401,403,404,422,429]) test(`BR-4 definitive ${status} rejection is terminal, never retried`,()=>scoped(async f=>{
 f.ports.submitApproval=async request=>{f.calls.push(request);return {status,review};};const r=await f.run();expect(r).toMatchObject({ok:false,reason:"rejected"});expect(f.journal.get(r.attemptId!)?.state).toBe("rejected");expect(f.journal.bindings()).toEqual([]);await f.run();expect(f.calls).toHaveLength(1);
}));
for(const status of [100,199,300,302,307,308,408,500,502,503,0]) test(`BR-4 ambiguous ${status} cannot bind`,()=>scoped(async f=>{
 f.ports.submitApproval=async request=>{f.calls.push(request);return {status,review};};const r=await f.run();expect(r).toMatchObject({ok:false,reason:"response_unproven"});expect(f.journal.get(r.attemptId!)?.state).toBe("uncertain");expect(f.journal.bindings()).toEqual([]);
}));
test("BR-4 lost connection is content-free and never retried",()=>scoped(async f=>{
 f.ports.submitApproval=async request=>{f.calls.push(request);throw Error("secret-token response Location");};const r=await f.run();expect(r).toMatchObject({ok:false,reason:"port_failed"});expect(JSON.stringify(r)).not.toContain("secret");expect(f.journal.get(r.attemptId!)?.state).toBe("uncertain");await f.run();expect(f.calls).toHaveLength(1);
}));
test("BR-6 hostile POST ignoring abort has bounded uncertain refusal",()=>scoped(async f=>{
 f.ports.submitApproval=async request=>{f.calls.push(request);return await new Promise(()=>{});};const start=Date.now(),r=await f.run({timeoutMs:20});expect(Date.now()-start).toBeLessThan(1000);expect(r).toMatchObject({ok:false,reason:"aborted"});expect(f.journal.get(r.attemptId!)?.state).toBe("uncertain");expect(f.calls).toHaveLength(1);
}));
test("BR-6 hostile initial read times out without reservation or POST",()=>scoped(async f=>{
 f.ports.readAnchor=async()=>await new Promise(()=>{});const r=await f.run({timeoutMs:20});expect(r).toMatchObject({ok:false,reason:"aborted"});expect(f.calls).toEqual([]);expect(f.journal.find({...snapshot,appLogin:reviewer.appLogin})).toBeNull();
}));
test("BR-6 caller abort after sending is uncertain and forwarded",()=>scoped(async f=>{
 const c=new AbortController();let seen:AbortSignal|undefined;f.ports.submitApproval=async(request,signal)=>{f.calls.push(request);seen=signal;c.abort();return await new Promise(()=>{});};
 const r=await f.run({signal:c.signal});expect(r).toMatchObject({ok:false,reason:"aborted"});expect(seen?.aborted).toBe(true);expect(f.journal.get(r.attemptId!)?.state).toBe("uncertain");
}));
test("BR-6 already aborted does no work",()=>scoped(async f=>{
 const c=new AbortController();c.abort();expect(await f.run({signal:c.signal})).toMatchObject({ok:false,reason:"aborted"});expect(f.calls).toEqual([]);expect(f.reads()).toBe(0);
}));
for(const field of ["headSha","baseSha","baseBranch","repo","number","authorLogin"] as const)test(`BR-2 malformed trusted snapshot ${field} refuses`,()=>scoped(async f=>{
 const r=await produceApprovalReceipt(f.journal,{...snapshot,[field]:null},reviewer,"body",f.ports);expect(r).toMatchObject({ok:false,reason:"invalid_input"});expect(f.calls).toEqual([]);
}));
for(const body of ["Reviewer: forged","text\nReviewer: forged","<!-- anima-review-attempt:forged -->","x".repeat(65536)])test("BR-2 reserved marker/tag or oversized prose refuses",()=>scoped(async f=>{
 expect(await produceApprovalReceipt(f.journal,snapshot,reviewer,body,f.ports)).toMatchObject({ok:false,reason:"invalid_input"});expect(f.calls).toEqual([]);
}));
test("BR-2 own author identity cannot review itself",()=>scoped(async f=>{
 expect(await produceApprovalReceipt(f.journal,snapshot,{...reviewer,appLogin:snapshot.authorLogin},"body",f.ports)).toMatchObject({ok:false,reason:"invalid_input"});expect(f.calls).toEqual([]);
}));
test("BR-2 subject mutation during await cannot retarget the POST",()=>scoped(async f=>{
 const input={...snapshot},who={...reviewer};f.ports.readAnchor=async()=>{input.headSha="c".repeat(40);who.appLogin="wrong[bot]";return anchor;};
 const r=await produceApprovalReceipt(f.journal,input,who,"body",f.ports);expect(r.ok).toBe(true);expect(f.calls[0].commit_id).toBe(snapshot.headSha);
}));
test("BR-1 reserved crash/incomplete state never sends or auto-reclaims",()=>scoped(async f=>{
 const a=f.journal.reserve({...snapshot,appLogin:reviewer.appLogin})!;expect(await f.run()).toMatchObject({ok:false,reason:"same_subject_reserved",attemptId:a.id});expect(f.calls).toEqual([]);
}));
test("BR-5 complete collector reconciliation finds only exact-marker App/head reviews, never binds",()=>scoped(async f=>{
 const a=f.journal.reserve({...snapshot,appLogin:reviewer.appLogin})!;f.journal.append(a.id,"sending");f.journal.append(a.id,"uncertain");
 const item={id:123,appLogin:reviewer.appLogin,headSha:snapshot.headSha,state:"APPROVED",body:approvalAttemptMarker(a.id),submittedAt:1};
 const result={ok:true,snapshot:{...snapshot,reviews:{complete:true,items:[item,{...item,id:124,body:"no marker"},{...item,id:125,appLogin:"wrong[bot]"},{...item,id:126,headSha:"c".repeat(40)}]},comments:{complete:true,items:[]},threads:{complete:true,items:[]},rate:{observedCost:1,remaining:4999,resetAt:"2026-10-30T01:00:00Z"}}};
 expect(reconcileApprovalAttempt(f.journal,a.id,result as any)).toEqual({ok:true,reviewIds:[123],bound:false});expect(f.journal.bindings()).toEqual([]);expect(f.journal.get(a.id)?.state).toBe("uncertain");expect(f.calls).toEqual([]);
 for(const bad of [{ok:false},{...result,snapshot:{...result.snapshot,baseSha:"c".repeat(40)}},{...result,snapshot:{...result.snapshot,reviews:{complete:false,items:[item]}}}])expect(reconcileApprovalAttempt(f.journal,a.id,bad as any).ok).toBe(false);
}));

for(const options of [{timeoutMs:0},{timeoutMs:30001},{timeoutMs:NaN},{signal:{}},null])test("BR-6 invalid limits/caller signal refuse before ports",()=>scoped(async f=>{
 expect(await f.run(options)).toMatchObject({ok:false,reason:"invalid_input"});expect(f.calls).toEqual([]);expect(f.reads()).toBe(0);
}));
test("BR-3 response Bot login case is preserved in the receipt and matched case-insensitively",()=>scoped(async f=>{
 f.ports.submitApproval=async request=>{f.calls.push(request);return {status:201,review:{...review,user:{login:"REVIEWER[bot]",type:"Bot"}}};};
 const r=await f.run();expect(r.ok).toBe(true);if(r.ok)expect(r.binding.appLogin).toBe("REVIEWER[bot]");
}));
test("BR-4 final read failure persists created-unbound, no raw thrown text",()=>scoped(async f=>{
 let n=0;f.ports.readAnchor=async()=>{if(++n>1)throw Error("sensitive caller exception");return anchor;};
 const r=await f.run();expect(r).toMatchObject({ok:false,reason:"port_failed"});expect(JSON.stringify(r)).not.toContain("sensitive");expect(f.journal.get(r.attemptId!)?.state).toBe("unbound");expect(f.journal.bindings()).toEqual([]);
}));
test("BR-6 prose and raw port error never enter journal rows",()=>scoped(async f=>{
 f.ports.submitApproval=async()=>{throw Error("raw-secret-error");};
 await produceApprovalReceipt(f.journal,snapshot,reviewer,"synthetic-private-prose",f.ports);
 const rows=JSON.stringify(f.db.query("SELECT * FROM review_events").all())+JSON.stringify(f.db.query("SELECT * FROM review_subjects").all());
 expect(rows).not.toContain("raw-secret-error");expect(rows).not.toContain("synthetic-private-prose");expect(rows).not.toContain("Reviewer:");
}));

test("BR-1 two producers with independent connections and simultaneous anchors reserve once and POST once",async()=>{
 const root=mkdtempSync(join(tmpdir(),"anima-review-race-")),path=join(root,"journal.sqlite");
 const a=new Database(path),b=new Database(path);
 try {
  const journals=[new ReviewJournal(a),new ReviewJournal(b)];let release!:()=>void,reads=0,sends=0;
  const ready=new Promise<void>(resolve=>{release=resolve;});
  const ports={readAnchor:async()=>{if(++reads<=2){if(reads===2)release();await ready;}return anchor;},
   submitApproval:async()=>{sends++;return {status:200,review};}};
  const results=await Promise.all(journals.map(j=>produceApprovalReceipt(j,snapshot,reviewer,"review",ports)));
  expect(results.filter(r=>r.ok)).toHaveLength(1);expect(results.filter(r=>!r.ok)).toEqual([{ok:false,reason:"subject_reserved"}]);
  expect(reads).toBe(3);expect(sends).toBe(1);expect(journals[0].bindings()).toHaveLength(1);
  expect(a.query("SELECT COUNT(*) AS n FROM review_subjects").get()).toEqual({n:1});
 } finally {a.close();b.close();rmSync(root,{recursive:true,force:true});}
});

test("BR-5 regression: mixed User and App collector reviews preserve only the exact-marker App diagnostic",()=>scoped(async f=>{
 const a=f.journal.reserve({...snapshot,appLogin:reviewer.appLogin})!;f.journal.append(a.id,"sending");f.journal.append(a.id,"uncertain");
 const item={id:123,appLogin:reviewer.appLogin,headSha:snapshot.headSha,state:"APPROVED",body:approvalAttemptMarker(a.id),submittedAt:1};
 const result={ok:true,snapshot:{...snapshot,reviews:{complete:true,items:[item,{...item,id:124,appLogin:"rfcclub"},{...item,id:125,appLogin:"reviewer"}]},
  comments:{complete:true,items:[]},threads:{complete:true,items:[]},rate:{observedCost:1,remaining:4999,resetAt:"2026-10-30T01:00:00Z"}}};
 expect(reconcileApprovalAttempt(f.journal,a.id,result as any)).toEqual({ok:true,reviewIds:[123],bound:false});
 expect(f.journal.get(a.id)?.state).toBe("uncertain");expect(f.journal.bindings()).toEqual([]);expect(f.calls).toEqual([]);
}));

function observationFor(id:string) {
 const item={id:123,appLogin:reviewer.appLogin,headSha:snapshot.headSha,state:"APPROVED",body:approvalAttemptMarker(id),submittedAt:1};
 return {ok:true,snapshot:{...snapshot,reviews:{complete:true,items:[item]},comments:{complete:true,items:[]},threads:{complete:true,items:[]},rate:{observedCost:1,remaining:4999,resetAt:"2026-10-30T01:00:00Z"}}};
}
for(const [field,value] of [["repo","rfcclub/other"],["number",46],["headSha","c".repeat(40)]] as const)test(`BR-5 reconciliation refuses foreign ${field}`,()=>scoped(async f=>{
 const a=f.journal.reserve({...snapshot,appLogin:reviewer.appLogin})!,data=observationFor(a.id);Object.assign(data.snapshot,{[field]:value});
 expect(reconcileApprovalAttempt(f.journal,a.id,data as any)).toEqual({ok:false,reason:"reconciliation_unproven"});expect(f.journal.bindings()).toEqual([]);
}));
test("BR-5 another attempt's marker is never attributed or promoted",()=>scoped(async f=>{
 const a=f.journal.reserve({...snapshot,appLogin:reviewer.appLogin})!,b=f.journal.reserve({...snapshot,number:46,appLogin:reviewer.appLogin})!,data=observationFor(b.id);
 expect(reconcileApprovalAttempt(f.journal,a.id,data as any)).toEqual({ok:true,reviewIds:[],bound:false});expect(f.journal.get(a.id)?.state).toBe("reserved");expect(f.journal.bindings()).toEqual([]);
}));
test("BR-5 duplicate review ids refuse the whole reconciliation",()=>scoped(async f=>{
 const a=f.journal.reserve({...snapshot,appLogin:reviewer.appLogin})!,data=observationFor(a.id);data.snapshot.reviews.items.push({...data.snapshot.reviews.items[0]});
 expect(reconcileApprovalAttempt(f.journal,a.id,data as any)).toEqual({ok:false,reason:"reconciliation_unproven"});expect(f.journal.bindings()).toEqual([]);
}));
for(const bad of ["x","00000000-0000-0000-0000-00000000000g","00000000-0000-0000-0000-000000000000\n"])test("BR-5 malformed attempt marker refuses",()=>{
 expect(()=>approvalAttemptMarker(bad)).toThrow("attempt_id");
});
test("BR-2 structural journal impersonation refuses before any port or journal calls",()=>scoped(async f=>{
 let touched=0;const impostor={find:()=>{touched++;return null;},reserve:f.journal.reserve.bind(f.journal),append:f.journal.append.bind(f.journal),get:f.journal.get.bind(f.journal)};
 expect(await produceApprovalReceipt(impostor as any,snapshot,reviewer,"body",f.ports)).toEqual({ok:false,reason:"invalid_input"});expect(touched).toBe(0);expect(f.calls).toEqual([]);expect(f.reads()).toBe(0);
}));
test("BR-4 journal failure during uncertainty is explicit and content-free",()=>scoped(async f=>{
 f.db.exec("CREATE TRIGGER fixture_fail_uncertain BEFORE INSERT ON review_events WHEN NEW.state='uncertain' BEGIN SELECT RAISE(ABORT,'fixture-secret'); END;");
 f.ports.submitApproval=async()=>{throw Error("sensitive transport");};const r=await f.run();expect(r).toMatchObject({ok:false,reason:"journal_failed"});expect(JSON.stringify(r)).not.toContain("secret");expect(f.journal.get(r.attemptId!)?.state).toBe("sending");expect(f.journal.bindings()).toEqual([]);
}));
test("BR-6 final success aborts both completed port signals",()=>scoped(async f=>{
 const signals:AbortSignal[]=[];f.ports.readAnchor=async signal=>{signals.push(signal);return anchor;};f.ports.submitApproval=async(_request,signal)=>{signals.push(signal);return {status:200,review};};
 expect((await f.run()).ok).toBe(true);expect(signals).toHaveLength(3);expect(signals.every(signal=>signal.aborted)).toBe(true);
}));

test("BR-2 plain User PR author is outside the App-authored slice",()=>scoped(async f=>{
 const input={...snapshot,authorLogin:"ordinary-user"};f.ports.readAnchor=async()=>({...anchor,authorLogin:input.authorLogin});
 expect(await produceApprovalReceipt(f.journal,input,reviewer,"body",f.ports)).toEqual({ok:false,reason:"invalid_input"});expect(f.reads()).toBe(0);expect(f.calls).toEqual([]);expect(f.journal.bindings()).toEqual([]);
}));
