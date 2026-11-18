import { expect, test } from "bun:test";
import { jevDuplicates } from "./duplicate-filter";

const answers=(flags: Array<[string, number]>)=>Response.json({answers:Object.fromEntries(flags.map(([choice,p],i)=>[`candidate_${i}`,{type:"choice",choice,probabilities:{duplicate:p,different:1-p}}]))});
test("RD-3 adapter: one bounded batch uses named questions, latest alias and both text sets",async()=>{
 const calls:any[]=[];const filter=jevDuplicates({apiKey:"synthetic",fetcher:async(url,init)=>{calls.push({url,init,body:JSON.parse(String(init?.body))});return answers([["duplicate",0.99],["different",0.1]])}});
 expect(await filter(["paraphrase","different topic"],["original fact"])).toEqual([true,false]);expect(calls).toHaveLength(1);expect(calls[0].url).toBe("https://openrouter.ai/api/alpha/decisions");expect(calls[0].body.model).toBe("~typesafe/jev-latest");expect(calls[0].body.state).toEqual({candidates:["paraphrase","different topic"],recent:["original fact"]});expect(Object.keys(calls[0].body.questions)).toEqual(["candidate_0","candidate_1"]);expect(calls[0].body.questions.candidate_1.instructions).toContain("candidates[1]");expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
});
test("RD-3 adapter: uncertain, contradictory, missing or malformed choices keep candidates",async()=>{
 for(const response of [()=>answers([["duplicate",0.79],["different",0.99]]),()=>Response.json({answers:{candidate_0:{choice:"duplicate",probabilities:{duplicate:2}}}}),()=>Response.json({answers:{candidate_0:{choice:"duplicate",probabilities:{duplicate:"0.99"}}}}),()=>Response.json({answers:{candidate_0:{choice:"duplicate",probabilities:{duplicate:0.99,different:0.01}}}}),()=>Response.json({answers:{}})]){
  const filter=jevDuplicates({apiKey:"synthetic",fetcher:async()=>response()});expect(await filter(["one","two"],["prior"])).toEqual([false,false]);
 }
});
test("RD-4 adapter: no key, recent, candidates or budget means no request",async()=>{
 let calls=0;const fetcher=async()=>{calls++;return answers([["duplicate",1]])};
 for(const [key,c,r] of [[undefined,["new"],["old"]],["k",[],["old"]],["k",["new"],[]],["k",Array(33).fill("new"),["old"]],["k",["x".repeat(601)],["old"]],["k",["new"],Array(6).fill("old")]] as const){
  expect(await jevDuplicates({apiKey:key,fetcher})([...c],[...r])).toEqual(c.map(()=>false));
 }expect(calls).toBe(0);
});
for(const kind of ["throw","http","malformed","timeout"]){test(`RD-4 adapter: ${kind} is exact-only and never retries`,async()=>{
 let calls=0;const filter=jevDuplicates({apiKey:"synthetic",timeoutMs:10,fetcher:async(_url,init)=>{calls++;if(kind==="throw")throw Error("offline");if(kind==="http")return new Response("failure",{status:503});if(kind==="malformed")return new Response("bad json");return new Promise((_resolve,reject)=>init?.signal?.addEventListener("abort",()=>reject(Error("aborted")),{once:true}));}});
 expect(await filter(["new"],["old"])).toEqual([false]);expect(calls).toBe(1);
});}
