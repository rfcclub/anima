import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("RD-11 host: two real hook processes share only configured tenant seen-state",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"anima-hook-process-"));const tenant=join(dir,"tenant");mkdirSync(tenant,{mode:0o700});const terms=join(dir,"terms.json");writeFileSync(terms,JSON.stringify({phrases:["synthetic-private"],words:[]}));let joins=0,recalls=0;
 const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req){
  const path=new URL(req.url).pathname;
  if(path==="/identity-runtime/eli/join"){joins++;return Response.json({leaseId:"fixture-lease",sessionToken:"fixture-token",stateHash:"fixture-hash",expiresAt:Date.now()+3600000})}
  if(path==="/identity-runtime/continuity/direct-recall"){recalls++;return Response.json([{source:"process-fixture",content:"synthetic compiler rule for this hook"}])}
  return new Response("unexpected route",{status:404});
 }});
 async function run(session_id?:string){
  const child=Bun.spawn([process.execPath,join(import.meta.dir,"identity-client.ts"),"hook"],{stdin:"pipe",stdout:"pipe",stderr:"pipe",timeout:5000,env:{PATH:process.env.PATH!,TMPDIR:process.env.TMPDIR??"/tmp",TZ:"UTC",NODE_ENV:"test",IDENTITY_TENANT:"eli",IDENTITY_SESSION_PATH:join(tenant,"session.json"),IDENTITY_RUNTIME_URL:`http://127.0.0.1:${server.port}`,IDENTITY_HOOK_HINDSIGHT:"0",IDENTITY_HOOK_JEV:"0",ANIMA_SENSITIVE_TERMS_FILE:terms}});
  child.stdin.write(JSON.stringify({prompt:"please inspect this synthetic compiler rule",cwd:dir,session_id}));child.stdin.end();
  const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect({exit,stderr}).toEqual({exit:0,stderr:""});return stdout.trim();
 }
 try{
  const first=await run("process-session"),second=await run("process-session");expect(first).toContain("synthetic compiler rule");expect(second).toBe("");
  expect(await run("different-session")).toContain("synthetic compiler rule");
  expect(await run()).toContain("synthetic compiler rule");expect(await run("../escape")).toContain("synthetic compiler rule");
  expect(joins).toBe(1);expect(recalls).toBe(5);expect(readdirSync(join(tenant,"recall-seen")).sort()).toEqual([".recall-guard-1b.sqlite",".recall-guard-26.sqlite","different-session.json","process-session.json"]);
  expect(readFileSync(join(tenant,"recall-seen/process-session.json"),"utf8")).not.toContain("fixture-token");
 }finally{server.stop(true);rmSync(dir,{recursive:true,force:true})}
},20000);
