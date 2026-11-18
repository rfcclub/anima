import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ReviewJournal } from "../../src/review-loop/review-journal";
import { produceApprovalReceipt, reconcileApprovalAttempt } from "../../src/review-loop/approval-receipt";
const snapshot={repo:"rfcclub/anima",number:45,headSha:"a".repeat(40),baseSha:"b".repeat(40),baseBranch:"master",authorLogin:"author[bot]"};
const reviewer={agent:"reviewer",appLogin:"reviewer[bot]"};
for(const phase of ["reserved","posted"] as const)test(`BR-1/4 real SIGKILL ${phase}: reopen refuses resend and orphan never binds`,async()=>{
 const root=mkdtempSync(join(tmpdir(),"anima-review-crash-")),path=join(root,"journal.sqlite");
 const proc=Bun.spawn([process.execPath,join(import.meta.dir,"fixtures/approval-crash.ts"),path,phase],{
  cwd:root,env:{HOME:root,TMPDIR:root,PATH:dirname(process.execPath),ANIMA_REVIEW_CRASH_FIXTURE:"1"},stdin:"ignore",stdout:"pipe",stderr:"pipe"});
 let db:Database|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const errors=new Response(proc.stderr).text();
 try {
  const reader=proc.stdout.getReader();const bytes=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("child readiness timeout")),10000);})]);
  if(timer)clearTimeout(timer);expect(new TextDecoder().decode(bytes.value)).toContain(`READY:${phase}`);
  proc.kill("SIGKILL");expect(await proc.exited).not.toBe(0);expect(await errors).toBe("");
  db=new Database(path);const journal=new ReviewJournal(db),attempt=journal.find({...snapshot,appLogin:reviewer.appLogin})!;
  expect(attempt).not.toBeNull();expect(attempt.state).toBe(phase==="reserved"?"reserved":"sending");expect(journal.bindings()).toEqual([]);
  let sends=0;const result=await produceApprovalReceipt(journal,snapshot,reviewer,"later review",{readAnchor:async()=>{throw Error("must not read");},submitApproval:async()=>{sends++;throw Error("must not send");}});
  expect(result).toMatchObject({ok:false,reason:`same_subject_${attempt.state}`});expect(sends).toBe(0);
  if(phase==="posted"){
   const sent=JSON.parse(readFileSync(join(root,"sent.json"),"utf8"));expect(sent.commit_id).toBe(snapshot.headSha);
   const observed={ok:true,snapshot:{...snapshot,reviews:{complete:true,items:[{id:123,appLogin:reviewer.appLogin,headSha:snapshot.headSha,body:sent.body,state:"APPROVED",submittedAt:1}]},threads:{complete:true,items:[]},comments:{complete:true,items:[]},rate:{observedCost:1,remaining:4999,resetAt:"2026-10-30T01:00:00Z"}}};
   expect(reconcileApprovalAttempt(journal,attempt.id,observed as any)).toEqual({ok:true,reviewIds:[123],bound:false});expect(journal.bindings()).toEqual([]);expect(journal.get(attempt.id)?.state).toBe("sending");
  }
 } finally {if(timer)clearTimeout(timer);proc.kill("SIGKILL");await proc.exited;db?.close();rmSync(root,{recursive:true,force:true});}
},20000);
