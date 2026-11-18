import { describe, expect, test } from "bun:test";
import { collectReviewBranch } from "../../src/review-loop/branch-snapshot";
import { auditReviewEligibility } from "../../src/review-loop/eligibility";

const HEAD = "a".repeat(40), BASE = "b".repeat(40), OTHER = "c".repeat(40);
const REPO = "rfcclub/anima", ROOT = `/repos/${REPO}`, PR = `${ROOT}/pulls/45`;
const clone = <T>(v: T): T => structuredClone(v);
const file = (i: number) => ({ filename: `src/file${i}.ts`, status: "modified" });
const commit = (i: number) => ({ sha: i === 0 ? HEAD : i.toString(16).padStart(40, "0"),
  author: { login: "eli-gotako[bot]" }, committer: { login: "eli-gotako[bot]" },
  commit: { message: `change ${i}\n\nAgent: eli` } });
function fixture(nFiles = 1, nCommits = 1) {
  const metadata = { number:45, state:"open", draft:false, head:{sha:HEAD},
    base:{sha:BASE, ref:"master", repo:{full_name:REPO}}, user:{login:"eli-gotako[bot]"},
    changed_files:nFiles, commits:nCommits };
  const ref = {ref:"refs/heads/master", object:{type:"commit", sha:BASE}};
  const files: any[] = Array.from({length:nFiles}, (_,i) => file(i));
  const commits: any[] = Array.from({length:nCommits}, (_,i) => commit(i));
  const calls: string[] = [], signals: AbortSignal[] = [];
  let prs = 0, refs = 0;
  const overrides = new Map<string, unknown>();
  let lastMetadata: unknown, lastRef: unknown;
  const get = async (path:string, signal:AbortSignal):Promise<unknown> => {
    calls.push(path); signals.push(signal);
    if (overrides.has(path)) return clone(overrides.get(path));
    if (path === PR) return clone(prs++ === 0 || lastMetadata === undefined ? metadata : lastMetadata);
    if (path === `${ROOT}/git/ref/heads/${encodeURIComponent(metadata.base.ref)}`)
      return clone(refs++ === 0 || lastRef === undefined ? ref : lastRef);
    const match = path.match(/\/(files|commits)\?per_page=100&page=(\d+)$/);
    if (!match) throw Error(`Unexpected fixture request: ${path}`);
    return clone((match[1] === "files" ? files : commits).slice((Number(match[2])-1)*100,Number(match[2])*100));
  };
  return {metadata, ref, files, commits, calls, signals, overrides, get,
    endMetadata(v:unknown) {lastMetadata=v;}, endRef(v:unknown) {lastRef=v;} };
}
async function run(f=fixture(), options={}) {return collectReviewBranch(f.get, REPO,45,options);}
async function refused(f:ReturnType<typeof fixture>, collection:string, reason?:string) {
  const r = await run(f);
  expect(r.ok).toBe(false);
  expect(r).not.toHaveProperty("snapshot");
  expect(r).toMatchObject({collection,...(reason ? {reason} : {})});
}

describe("review branch collection (BS-1..9)", () => {
  test("BS-1 BS-3 BS-5 complete page2 files and commits preserve a protected rename and foreign author", async () => {
    const f=fixture(101,101);
    f.files[100]={filename:"src/new.ts",previous_filename:"scripts/ANIMA.ENV",status:"renamed"};
    f.commits[100].author.login="foreign-user";
    const r=await run(f);
    expect(r.ok).toBe(true);
    if (!r.ok) throw Error("expected branch snapshot");
    expect(r.snapshot.paths).toEqual({complete:true,items:f.files.map(x=>({path:x.filename,...(x.previous_filename ? {previousPath:x.previous_filename} : {})}))});
    expect(r.snapshot.commits.items[100]!.authorLogin).toBe("foreign-user");
    expect(r.snapshot.baseSha).toBe(BASE);
    expect(f.calls).toEqual([PR,`${ROOT}/git/ref/heads/master`,`${PR}/files?per_page=100&page=1`,`${PR}/files?per_page=100&page=2`,`${PR}/commits?per_page=100&page=1`,`${PR}/commits?per_page=100&page=2`,PR,`${ROOT}/git/ref/heads/master`]);
    expect(new Set(f.signals).size).toBe(1);
  });
  test("largest admitted REST snapshot completes in37 calls",async()=>{
    const f=fixture(2999,249);const r=await run(f);expect(r.ok).toBe(true);
    if(!r.ok)throw Error("expected snapshot");
    expect(r.snapshot.paths.items.length).toBe(2999);expect(r.snapshot.commits.items.length).toBe(249);expect(f.calls.length).toBe(37);
  });
  test.each(["src/safe.ts","docs/notes.md"])("BS-9 partial facts for %s cannot become a complete eligibility snapshot",async path=>{
    const f=fixture(); f.files[0].filename=path; const r=await run(f); expect(r.ok).toBe(true); if(!r.ok)throw Error("expected snapshot");
    const audit=auditReviewEligibility(r.snapshot,{apps:{eli:"eli-gotako[bot]"},bindings:[],now:100,cooldownMs:0});
    expect(audit).toEqual({automaticMerge:false,reasons:["atomic_base_guard_unproven","malformed_snapshot"]});
    for (const absent of ["reviews","threads","ci","issue","loop","ownerAgents"]) expect(r.snapshot).not.toHaveProperty(absent);
  });
  test("exact100 items require the empty next page",async()=>{
    const f=fixture(100,100); const r=await run(f); expect(r.ok).toBe(true);
    expect(f.calls).toContain(`${PR}/files?per_page=100&page=2`);
    expect(f.calls).toContain(`${PR}/commits?per_page=100&page=2`);
  });
  test.each(["https://github.com/rfcclub/anima","rfcclub/../anima","rfcclub/anima?x=y","evil/anima","rfcclub/anima/",""])("refuse noncanonical repo %s",async repo=>{
    const f=fixture(); expect(await collectReviewBranch(f.get,repo,45)).toMatchObject({ok:false,collection:"subject"}); expect(f.calls).toEqual([]);
  });
  test("regression: coercible non-string repository refuses before reads",async()=>{
    const f=fixture(); const repo={toString:()=>REPO};
    expect(await collectReviewBranch(f.get,repo as never,45)).toMatchObject({ok:false,collection:"subject",reason:"malformed"});
    expect(f.calls).toEqual([]);
  });
  test.each([null,0,"options",{signal:{}},{signal:null}])("regression: malformed options refuse before reads: %j",async options=>{
    const f=fixture();expect(await collectReviewBranch(f.get,REPO,45,options as never)).toMatchObject({ok:false,collection:"subject",reason:"malformed"});expect(f.calls).toEqual([]);
  });
  test.each([0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])("refuse invalid PR %s",async n=>{
    const f=fixture(); expect(await collectReviewBranch(f.get,REPO,n)).toMatchObject({ok:false,collection:"subject"}); expect(f.calls).toEqual([]);
  });
  test.each([0,-1,Infinity,30_001,1.5])("refuse invalid deadline %s before I/O",async timeoutMs=>{
    const f=fixture(); expect(await run(f,{timeoutMs})).toMatchObject({ok:false,collection:"subject"}); expect(f.calls).toEqual([]);
  });
  test.each(["closed","unknown"])("non-open state %s refuses",async state=>{const f=fixture();f.metadata.state=state;await refused(f,"metadata");});
  test("draft refuses",async()=>{const f=fixture();f.metadata.draft=true;await refused(f,"metadata");});
  test.each(["changed_files","commits"])("zero %s refuses",async key=>{const f=fixture();(f.metadata as any)[key]=0;await refused(f,"metadata");});
  test.each(["number","user","base","head","changed_files","commits","state","draft"])("missing metadata %s refuses",async key=>{const f=fixture();delete (f.metadata as any)[key];await refused(f,"metadata");});
  test.each(["a".repeat(39),"A".repeat(40),"oops"])("malformed head %s refuses",async sha=>{const f=fixture();f.metadata.head.sha=sha;await refused(f,"metadata");});
  test("wrong subject number refuses",async()=>{const f=fixture();f.metadata.number=46;await refused(f,"metadata");});
  test("wrong base repository refuses",async()=>{const f=fixture();f.metadata.base.repo.full_name="rfcclub/other";await refused(f,"metadata");});
  test.each(["", "../master", "x?ref=y", "a..b", "a//b", "a.lock", "a@{b", "a b", "a\\b"])("invalid branch %s refuses",async ref=>{const f=fixture();f.metadata.base.ref=ref;await refused(f,"metadata");});
  test("slash branch uses encoded deterministic ref path",async()=>{const f=fixture();f.metadata.base.ref="release/topic";f.ref.ref="refs/heads/release/topic";expect((await run(f)).ok).toBe(true);expect(f.calls).toContain(`${ROOT}/git/ref/heads/release%2Ftopic`);});
  test.each(["ref","object"])("missing live ref %s refuses",async key=>{const f=fixture();delete (f.ref as any)[key];await refused(f,"base");});
  test("wrong live ref identity refuses",async()=>{const f=fixture();f.ref.ref="refs/heads/other";await refused(f,"base");});
  test("noncommit live ref refuses",async()=>{const f=fixture();f.ref.object.type="tag";await refused(f,"base");});
  test("BS-7 stable PR base metadata cannot hide a moved live tip",async()=>{const f=fixture();f.ref.object.sha=OTHER;await refused(f,"base","base_metadata_stale");});
  test("BS-8 ancestor-preserving live base movement refuses",async()=>{const f=fixture();const ref=clone(f.ref);ref.object.sha=OTHER;f.endRef(ref);await refused(f,"base","snapshot_changed");});
  test.each(["head","base","state","draft","user","changed_files","commits"])("final %s drift refuses",async key=>{
    const f=fixture();const m:any=clone(f.metadata);
    const changed:any={head:{sha:OTHER},base:{...m.base,ref:"other"},state:"closed",draft:true,user:{login:"other"},changed_files:2,commits:2};
    m[key]=changed[key];f.endMetadata(m);await refused(f,"metadata");
  });
  test("BS-4 metadata file ceiling is refused before enumeration",async()=>{const f=fixture();f.metadata.changed_files=3000;await refused(f,"files","rest_limit");expect(f.calls).toEqual([PR]);});
  test("metadata commit ceiling is refused before enumeration",async()=>{const f=fixture();f.metadata.commits=250;await refused(f,"commits","rest_limit");expect(f.calls).toEqual([PR]);});
  test.each(["files","commits"])("short %s page with a false count refuses",async key=>{const f=fixture();if(key==="files")f.metadata.changed_files=2;else f.metadata.commits=2;await refused(f,key,"count_mismatch");});
  test.each(["files","commits"])("duplicate %s identity refuses",async key=>{const f=fixture(2,2);(f as any)[key][1]=clone((f as any)[key][0]);await refused(f,key,"duplicate");});
  test.each(["files","commits"])("overlong %s page refuses",async key=>{const f=fixture();f.overrides.set(`${PR}/${key}?per_page=100&page=1`,Array.from({length:101},(_,i)=>key==="files"?file(i):commit(i)));await refused(f,key);});
  test.each(["files","commits"])("non-array %s page refuses",async key=>{const f=fixture();f.overrides.set(`${PR}/${key}?per_page=100&page=1`,{items:[]});await refused(f,key);});
  test.each(["../secret","src//a.ts","src/./a.ts","/src/a.ts","src/a\\b.ts","src/\u0000.ts"])("malformed new path %s refuses",async path=>{const f=fixture();f.files[0].filename=path;await refused(f,"files");});
  test.each(["../secret","src//old.ts",""])("malformed rename source %s refuses",async path=>{const f=fixture();f.files[0]={filename:"src/new.ts",previous_filename:path,status:"renamed"};await refused(f,"files");});
  test("rename without old name refuses",async()=>{const f=fixture();f.files[0].status="renamed";await refused(f,"files");});
  test("unknown file status refuses",async()=>{const f=fixture();f.files[0].status="invented";await refused(f,"files");});
  test("commit head must be present",async()=>{const f=fixture();f.commits[0].sha=OTHER;await refused(f,"commits","head_missing");});
  test.each(["sha","author","committer","commit"])("BS-6 missing commit %s refuses",async key=>{const f=fixture();delete f.commits[0][key];await refused(f,"commits");});
  test.each(["author","committer"])("unlinked commit %s is not inferred from email",async key=>{const f=fixture();f.commits[0][key]=null;await refused(f,"commits","malformed");});
  test("oversized commit text refuses",async()=>{const f=fixture();f.commits[0].commit.message="x".repeat(65537);await refused(f,"commits");});
  test("unauthorized/read errors are content-free and never partial success",async()=>{
    const f=fixture();const r=await collectReviewBranch(async(path,signal)=>{if(path.includes("/commits?"))throw Error("401 token=TOP_SECRET");return f.get(path,signal);},REPO,45);
    expect(r).toEqual({ok:false,collection:"commits",reason:"read_failed"});expect(JSON.stringify(r)).not.toContain("TOP_SECRET");
  });
  test("pre-aborted request performs no reads",async()=>{const f=fixture();const c=new AbortController();c.abort();expect(await run(f,{signal:c.signal})).toMatchObject({ok:false,reason:"aborted"});expect(f.calls).toEqual([]);});
  test("BS-2 hung port is bounded and receives an aborted signal",async()=>{let received:AbortSignal|undefined;const t=Date.now();const r=await collectReviewBranch(async(_path,signal)=>{received=signal;return new Promise(()=>{});},REPO,45,{timeoutMs:10});expect(r).toEqual({ok:false,collection:"metadata",reason:"aborted"});expect(received!.aborted).toBe(true);expect(Date.now()-t).toBeLessThan(1000);});
  test("aborting between reads refuses without another port call",async()=>{const f=fixture();const c=new AbortController();const r=await collectReviewBranch(async(path,signal)=>{const v=await f.get(path,signal);if(path.includes("/files?"))c.abort();return v;},REPO,45,{signal:c.signal});expect(r).toMatchObject({ok:false,reason:"aborted"});expect(f.calls.filter(x=>x.includes("/commits?")).length).toBe(0);});
});
