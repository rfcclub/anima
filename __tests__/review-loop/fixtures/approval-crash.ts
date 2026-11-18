import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ReviewJournal, type ReviewSubject, type ReviewJournalState, type ReviewEvidence } from "../../../src/review-loop/review-journal";
import { produceApprovalReceipt } from "../../../src/review-loop/approval-receipt";
const [path,phase]=process.argv.slice(2);
if(process.env.ANIMA_REVIEW_CRASH_FIXTURE!=="1" || !path || !process.env.HOME || dirname(resolve(path))!==resolve(process.env.HOME) || !["reserved","posted"].includes(phase!))throw Error("fixture_scope");
function pause(){writeFileSync(1,`READY:${phase}\n`);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);throw Error("unreachable");}
class CrashJournal extends ReviewJournal {
 override reserve(subject:ReviewSubject){const result=super.reserve(subject);if(phase==="reserved")pause();return result;}
 override append(id:string,state:Exclude<ReviewJournalState,"reserved">,review?:ReviewEvidence){if(phase==="posted"&&state==="created")pause();super.append(id,state,review);}
}
const db=new Database(path),journal=new CrashJournal(db);
const snapshot={repo:"rfcclub/anima",number:45,headSha:"a".repeat(40),baseSha:"b".repeat(40),baseBranch:"master",authorLogin:"author[bot]"};
await produceApprovalReceipt(journal,snapshot,{agent:"reviewer",appLogin:"reviewer[bot]"},"Synthetic code review only",{
 readAnchor:async()=>({...snapshot,state:"OPEN",draft:false,liveBaseSha:snapshot.baseSha}),
 submitApproval:async(request)=>{writeFileSync(join(dirname(path),"sent.json"),JSON.stringify(request));return {status:200,review:{id:123,state:"APPROVED",commit_id:snapshot.headSha,user:{login:"reviewer[bot]",type:"Bot"}}};},
});
throw Error("fixture_failed_to_pause");
