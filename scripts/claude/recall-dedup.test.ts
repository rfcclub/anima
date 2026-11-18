import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, statSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook, type HookDeps } from "./identity-client";
import { createGuard } from "./sensitive-terms";
import { recallGuardPath } from "./recall-guard";

const dirs: string[] = [];
function fixture(extra: any = {}) {
  const directory = mkdtempSync(join(tmpdir(), "anima-recall-dedup-")); dirs.push(directory);
  const options = { directory, ...extra };
  const deps: HookDeps & { dedup: any } = { recall: async () => [{ source: "fixture", content: "remember compiler boundaries" }], noteGate: { shouldNote: () => false, markNoted() {} }, guard: createGuard({ phrases: ["secret-topic"], words: [] }), dedup: options };
  return { directory, options, deps };
}
const input = { prompt: "please inspect the compiler boundaries", session_id: "fixture-session" };
const text = (out: string | undefined) => out ? JSON.parse(out).hookSpecificOutput.additionalContext as string : "";
const hook = (deps: HookDeps, over: any = {}) => runHook({ ...input, ...over } as any, deps);
const statePath = (dir: string) => join(dir, "fixture-session.json");
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("RD-1 regression: separate hook runs suppress exact repeats within one session only", async () => {
  const { deps } = fixture(); expect(text(await hook(deps))).toContain("compiler boundaries");
  expect(text(await hook(deps))).toBe("");
  expect(text(await hook(deps, { session_id: "other-session" }))).toContain("compiler boundaries");
});

test("RD-2: changing retrieval metadata leaves the body hash stable, meaningful numbers survive", async () => {
  const { deps } = fixture(); let n=1;
  deps.recall = async () => [{source:"fixture", content:`## fact ${n}\nscore: 0.${n}\ntimestamp: 2026-01-0${n}\nretrieval_id: ${n}\nKeep compiler version 42 on 2026-02-03.`}];
  await hook(deps); n++; expect(text(await hook(deps))).toBe("");
  deps.recall=async()=>[{source:"fixture",content:"Keep compiler version 43 on 2026-02-03."}];
  expect(text(await hook(deps))).toContain("version 43");
});

test("RD-3: one decision batch drops a paraphrase and keeps a different candidate", async () => {
  const { deps, options } = fixture(); await hook(deps); const calls: any[]=[];
  options.decision=async (candidates: string[], recent: string[]) => { calls.push({candidates,recent});return [true,false]; };
  deps.recall=async()=>[{source:"fixture",content:"## A\nretain the compiler boundary\n## B\nnew database transaction decision"}];
  const out=text(await hook(deps));expect(out).not.toContain("retain the compiler");expect(out).toContain("new database");
  expect(calls).toHaveLength(1);expect(calls[0].recent).toEqual(["remember compiler boundaries"]);
});

for (const failure of ["throw", "timeout", "malformed", "budget"]) {
  test(`RD-4: ${failure} keeps exact-only output under a bounded deadline`, async () => {
    const { deps, options }=fixture({deadlineMs:15});await hook(deps);
    deps.recall=async()=>[{source:"fixture",content:"unseen candidate"}];
    options.decision=async()=> { if(failure==="throw")throw Error("failure");if(failure==="timeout")return new Promise(()=>{});return failure==="malformed"?[]:[true]; };
    if(failure==="budget")options.maxDecisionCandidates=0;
    const start=Date.now();expect(text(await hook(deps))).toContain("unseen candidate");expect(Date.now()-start).toBeLessThan(400);
  });
}

test("RD-5: sensitive full text, including clipped tail, never reaches decision or disk",async()=>{
  const {deps,options,directory}=fixture();await hook(deps);const calls:any[]=[];
  options.decision=async(c:string[],r:string[])=>{calls.push({c,r});return c.map(()=>false)};
  deps.recall=async()=>[{source:"fixture",content:"## private\n"+"x".repeat(650)+" secret-topic PRIVATE SENTINEL"},{source:"fixture",content:"secret-topic SHORT PRIVATE SENTINEL"},{source:"fixture",content:"safe new item"}];
  await hook(deps);const serialized=readFileSync(statePath(directory),"utf8");expect(serialized).not.toContain("PRIVATE SENTINEL");expect(serialized).not.toContain("secret-topic");expect(serialized).not.toContain("xxx");
  expect(JSON.stringify(calls)).not.toContain("secret-topic");expect(JSON.stringify(calls)).not.toContain("xxx");
  expect(text(await hook(deps))).toBe("");
});

test("RD-5: no terms means hash-only; reclassified recent text is not sent",async()=>{
  const {deps,options,directory}=fixture();await hook(deps);let calls=0;
  deps.guard=createGuard({phrases:["compiler"],words:[]});options.decision=async(c:string[])=>{calls++;return c.map(()=>false)};
  deps.recall=async()=>[{source:"fixture",content:"other candidate"}];await hook(deps);expect(calls).toBe(0);
  deps.guard=createGuard(null);deps.recall=async()=>[{source:"fixture",content:"unclassifiable MEMORY SENTINEL"}];await hook(deps);
  expect(readFileSync(statePath(directory),"utf8")).not.toContain("MEMORY SENTINEL");
});

test("RD-6/7: runtime sections, Hindsight lines and local fallback share emission dedup",async()=>{
  const {deps}=fixture();deps.recall=async()=>[{source:"fixture",content:"## A\nfirst body\n## B\nsecond body"}];deps.hindsight={label:"fixture",recall:async()=>"- hindsight body"};
  await hook(deps);deps.recall=async()=>[{source:"fixture",content:"## A\nfirst body\n## C\nthird body"}];
  const out=text(await hook(deps));expect(out).not.toContain("first body");expect(out).not.toContain("hindsight body");expect(out).toContain("third body");
  deps.recall=async()=>{throw Error("offline")};deps.localRecall=async()=>"- [fact#1] local body";expect(text(await hook(deps))).toContain("local body");deps.localRecall=async()=>"- [fact#2] local body";expect(text(await hook(deps))).toBe("");
});

test("RD-8: a relevance rejection remains eligible on a later turn",async()=>{
  const {deps}=fixture();deps.recall=async()=>[];deps.hindsight={label:"fixture",recall:async()=>"- useful later"};deps.relevance=async()=>[false];expect(text(await hook(deps))).toBe("");deps.relevance=async()=>[true];expect(text(await hook(deps))).toContain("useful later");expect(text(await hook(deps))).toBe("");
});

for (const mode of ["corrupt","unwritable","symlink","lock"]) {
 test(`RD-9: ${mode} state preserves legacy output`,async()=>{
  const {deps,directory}=fixture();const path=statePath(directory);
  if(mode==="corrupt")writeFileSync(path,"{broken");
  if(mode==="unwritable"){rmSync(directory,{recursive:true});writeFileSync(directory,"not a directory");}
  if(mode==="symlink"){writeFileSync(join(directory,"target"),"untouched");symlinkSync(join(directory,"target"),path);}
  if(mode==="lock")writeFileSync(path+".lock","busy");
  const legacy=await runHook(input as any,{...deps,dedup:undefined} as any);expect(await hook(deps)).toBe(legacy);
  if(mode==="symlink")expect(readFileSync(join(directory,"target"),"utf8")).toBe("untouched");
 });
}

test("RD-10: oldest hashes evicted at500; recent5, secure modes and two-day cleanup",async()=>{
 const {deps,options,directory}=fixture();let now=Date.now();options.now=()=>now;
 for(let i=0;i<503;i++){deps.recall=async()=>[{source:"fixture",content:`unique body ${i}`}];await hook(deps);}
 const s=JSON.parse(readFileSync(statePath(directory),"utf8"));expect(s.hashes).toHaveLength(500);expect(s.recent).toHaveLength(5);expect(statSync(statePath(directory)).mode&0o777).toBe(0o600);expect(statSync(directory).mode&0o777).toBe(0o700);
 deps.recall=async()=>[{source:"fixture",content:"unique body 0"}];expect(text(await hook(deps))).toContain("unique body 0");
 const old=join(directory,"old-session.json");writeFileSync(old,JSON.stringify({...s,updatedAt:now-3*86400000}));utimesSync(old,new Date(now-3*86400000),new Date(now-3*86400000));
 now+=3*86400000;expect(text(await hook(deps))).toContain("unique body 0");expect(readdirSync(directory)).not.toContain("old-session.json");
});

test("RD-8/11: entirely capped sections stay eligible; partly clipped sections count as seen",async()=>{
 const {deps}=fixture();const bodies=[0,1,2,3].map(i=>`body-${i} `+String(i).repeat(700));deps.recall=async()=>bodies.map(content=>({source:"fixture",content}));
 const first=text(await hook(deps));expect(first).not.toContain("body-3");const second=text(await hook(deps));expect(second).not.toContain("body-0");expect(second).not.toContain("body-2");expect(second).toContain("body-3");
});

test("RD-11 security: absent and forbidden session filenames preserve legacy behavior and create no state",async()=>{
 const {deps,directory}=fixture();for(const session_id of [undefined,"../escape","bad/id", ""]){const one=await hook(deps,{session_id});expect(await hook(deps,{session_id})).toBe(one);}expect(readdirSync(directory)).toEqual([]);
});

test("RD-9: a commit failure restores all legacy items, including known hashes",async()=>{
 const {deps,options,directory}=fixture();await hook(deps);const path=statePath(directory);
 deps.recall=async()=>[{source:"fixture",content:"remember compiler boundaries"},{source:"fixture",content:"a new item"}];
 const legacy=await runHook(input as any,{...deps,dedup:undefined} as any);
 options.decision=async(c:string[])=>{rmSync(path);mkdirSync(path);return c.map(()=>false)};
 expect(await hook(deps)).toBe(legacy);expect(readdirSync(directory).some(n=>n.endsWith(".tmp")||n.endsWith(".lock"))).toBe(false);
});

test("RD-9: another concurrent hook fails open without deleting the active guard",async()=>{
 const {deps,options,directory}=fixture();await hook(deps);let release:()=>void=()=>{},started:()=>void=()=>{};const entered=new Promise<void>(r=>started=r);
 deps.recall=async()=>[{source:"fixture",content:"new concurrent candidate"}];options.decision=async(c:string[])=>{started();await new Promise<void>(r=>release=r);return c.map(()=>false)};
 const pending=hook(deps);await entered;const lock=recallGuardPath(directory,"fixture-session");const ino=statSync(lock).ino;
 const legacy=await runHook(input as any,{...deps,dedup:undefined} as any);expect(await hook(deps)).toBe(legacy);expect(statSync(lock).isFile()).toBe(true);expect(statSync(lock).ino).toBe(ino);release();await pending;expect(statSync(lock).ino).toBe(ino);expect(statSync(lock).size).toBe(0);expect(readdirSync(directory).some(n=>n.endsWith(".lock"))).toBe(false);
});


test("RD-3/5: long bodies use complete hashes only; clipped semantic prefixes cannot erase changed tails",async()=>{
 const {deps,options,directory}=fixture();const prefix="safe common prefix "+"x".repeat(650);deps.recall=async()=>[{source:"fixture",content:prefix+" old decision"}];await hook(deps);let calls=0;
 options.decision=async(c:string[])=>{calls++;return c.map(()=>true)};deps.recall=async()=>[{source:"fixture",content:prefix+" changed decision"}];expect(text(await hook(deps))).toContain("safe common prefix");expect(calls).toBe(0);expect(JSON.parse(readFileSync(statePath(directory),"utf8")).recent).toEqual([]);
});

test("RD-9/10: oversized state fails open before decoding even valid padded JSON",async()=>{
 const {deps,directory}=fixture();await hook(deps);const path=statePath(directory);writeFileSync(path,readFileSync(path,"utf8")+" ".repeat(131073));
 const legacy=await runHook(input as any,{...deps,dedup:undefined} as any);expect(await hook(deps)).toBe(legacy);
});

test("RD-5 security: original-only sensitive headings and stripped metadata are forbidden from decision and recent text",async()=>{
 const {deps,options,directory}=fixture();await hook(deps);let calls=0;
 options.decision=async(c:string[])=>{calls++;return c.map(()=>false)};
 deps.recall=async()=>[
  {source:"secret-topic source",content:"public-looking source body"},
  {source:"fixture",content:"## secret-topic heading\npublic-looking section body"},
  {source:"fixture",content:"timestamp: secret-topic metadata\npublic-looking metadata body"},
 ];
 const out=text(await hook(deps));expect(out).toContain("public-looking");expect(calls).toBe(0);
 const state=readFileSync(statePath(directory),"utf8");expect(state).not.toContain("public-looking");expect(state).not.toContain("secret-topic");expect(text(await hook(deps))).toBe("");
});

for(const answer of [[true],[true,false,true]]){
 test(`RD-4: non-empty ${answer.length===1?"short":"long"} decision batch keeps every exact-only candidate`,async()=>{
  const {deps,options}=fixture();await hook(deps);options.decision=async()=>answer;
  deps.recall=async()=>[{source:"fixture",content:"## One\nnew first fact\n## Two\nnew second fact"}];
  const out=text(await hook(deps));expect(out).toContain("new first fact");expect(out).toContain("new second fact");
 });
}
