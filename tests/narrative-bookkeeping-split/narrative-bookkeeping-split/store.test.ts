import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedNarrativeStore } from "../../../src/narrative/shared-store";

const dirs: string[] = [];
const dbPath = () => { const dir=mkdtempSync(join(tmpdir(),"anima-marks-")); dirs.push(dir); return join(dir,"test.db"); };
afterEach(() => { for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true}); });
const keys = ["pulse-anima-slot-fired:2026-10-29-a", "pulse-anima-library-active", "pulse-anima-restore-due", "visit-dedup:eli:bruno", "eli:digest", "eli:last-digest", "encounter:eli:bruno", "encounter-line:eli", "eli:last-action", "eli:last-agora-post", "room-scene-gen-count", "expedition:eli"];

// This regression needs no new API: it observes the real old bootstrap leak.
test("BK-1 regression: every bookkeeping family is absent even if legacy flags are inserted after opening", () => {
 const store=new SharedNarrativeStore(dbPath());
 for(const key of keys)store.setFlag(key,"machine-state","eli");
 store.setFlag("story:door","open","bruno");
 store.incrementCounter("visits","eli");
 store.recordThread({id:"t",fromAgent:"bruno",toAgent:"eli",label:"a story",value:"v"});
 const text=store.buildBootstrap("eli");
 for(const key of keys)expect(text).not.toContain(key);
 expect(text).toContain("story:door");expect(text).toContain("Narrative counters:");expect(text).toContain("a story");
});

test("BK-2 mark API preserves metadata, exact prefixes, stable newest-first order and empty enumeration", () => {
 const path=dbPath(),store=new SharedNarrativeStore(path),db=new Database(path);
 store.setMark("x%_first","one","eli"); store.setMark("xysecond","two","bruno"); store.setMark("x%_third","three","milo");
 db.run("UPDATE automation_marks SET set_at='2026-10-29T00:00:00Z'");
 expect(store.listMarks("").map(x=>x.key)).toEqual(["x%_third","xysecond","x%_first"]);
 expect(store.listMarks("x%_").map(x=>x.key)).toEqual(["x%_third","x%_first"]);
 expect(store.getMark("x%_first")).toEqual({key:"x%_first",value:"one",setBy:"eli",setAt:"2026-10-29T00:00:00Z",expiresAt:null});
 store.setMark("utc","v","eli"); expect(store.getMark("utc")!.setAt).toMatch(/Z$/);db.close();
});

test("BK-2/BK-4 expiry is set on write, absent at its boundary, pruned; nonexpiring marks remain", () => {
 const path=dbPath(),store=new SharedNarrativeStore(path),db=new Database(path),before=Date.now();
 store.setMark("visit-dedup:eli:bruno","now","eli",12*3600_000);
 const mark=store.getMark("visit-dedup:eli:bruno")!;
 expect(mark.expiresAt).toBeGreaterThanOrEqual(before+12*3600_000);expect(mark.expiresAt).toBeLessThanOrEqual(Date.now()+12*3600_000);
 for(const key of ["expired-read","expired-list"])store.setMark(key,"v","eli",100);
 db.run("UPDATE automation_marks SET expires_at=? WHERE key LIKE 'expired-%'",[Date.now()]);
 expect(store.getMark("expired-read")).toBeNull();expect(store.listMarks("").some(x=>x.key.startsWith("expired-"))).toBe(false);
 expect(db.query("SELECT count(*) AS n FROM automation_marks WHERE key LIKE 'expired-%'").get()).toEqual({n:0});
 store.setMark("permanent","v","bruno");expect(store.getMark("permanent")!.expiresAt).toBeNull();db.close();
});

test("BK-5 migration preserves every field and story fact, applies UTC TTL, and is idempotent", () => {
 const path=dbPath(),legacy=new SharedNarrativeStore(path),db=new Database(path);
 const at=new Date(Date.now()-1000).toISOString().replace("T"," ").replace(/\.\d{3}Z$/,""), epoch=Date.parse(at.replace(" ","T")+"Z");
 for(const key of keys)legacy.setFlag(key,"v:"+key,"actor:"+key);
 legacy.setFlag("story:digestive","a story","bruno"); db.run("UPDATE shared_flags SET set_at=?",[at]);
 const store=new SharedNarrativeStore(path);
 const marks=store.listMarks("");expect(marks).toHaveLength(keys.length);
 for(const key of keys){
  const ttl=key.startsWith("pulse-anima-slot-fired:")?7*86400_000:key.startsWith("visit-dedup:")?12*3600_000:key.startsWith("encounter:")?2*86400_000:null;
  expect(store.getMark(key)).toEqual({key,value:"v:"+key,setBy:"actor:"+key,setAt:at,expiresAt:ttl===null?null:epoch+ttl});
 }
 expect(store.getAllFlags().map(x=>x.key)).toEqual(["story:digestive"]);
 expect(new SharedNarrativeStore(path).listMarks("")).toEqual(marks);db.close();
});

test("BK-5 a failed migration rolls back every move rather than losing either colliding state", () => {
 const path=dbPath(),legacy=new SharedNarrativeStore(path),db=new Database(path);
 legacy.setFlag("eli:digest","old","eli"); legacy.setFlag("bruno:digest","other","bruno");
 // A distinct new-table value must not be silently replaced by an old writer.
 db.run("CREATE TABLE IF NOT EXISTS automation_marks (key TEXT PRIMARY KEY,value TEXT NOT NULL,set_by TEXT NOT NULL,set_at TEXT NOT NULL,expires_at INTEGER)");
 db.run("INSERT INTO automation_marks VALUES ('bruno:digest','new','bruno',?,NULL)",[new Date().toISOString()]);
 expect(()=>new SharedNarrativeStore(path)).toThrow();
 expect(db.query("SELECT count(*) AS n FROM shared_flags").get()).toEqual({n:2});
 expect(db.query("SELECT count(*) AS n FROM automation_marks").get()).toEqual({n:1});
 expect((db.query("SELECT value FROM automation_marks").get() as {value:string}).value).toBe("new");db.close();
});

test("BK-4 migrated expired rows are pruned and encounter-line is permanent", () => {
 const path=dbPath(),legacy=new SharedNarrativeStore(path),db=new Database(path);
 for(const key of keys)legacy.setFlag(key,"v","eli");db.run("UPDATE shared_flags SET set_at='2000-01-01 00:00:00'");
 const store=new SharedNarrativeStore(path);
 expect(db.query("SELECT count(*) AS n FROM automation_marks").get()).toEqual({n:keys.length-3});
 for(const key of keys)expect(store.getMark(key)!==null).toBe(!/^(pulse-anima-slot-fired:|visit-dedup:|encounter:)/.test(key));
 expect(store.getMark("encounter-line:eli")!.expiresAt).toBeNull();db.close();
});

test("BK-6 story flags are at most 40 rows, ordered newest first with a 4000-character section bound", () => {
 const path=dbPath(),store=new SharedNarrativeStore(path),db=new Database(path);
 for(let i=0;i<45;i++)store.setFlag(`story-${i}`,"v","eli");
 db.run("UPDATE shared_flags SET set_at='2020-01-01 00:00:00'");
 db.run("UPDATE shared_flags SET set_at='2026-01-01T00:00:00Z' WHERE key='story-0'");
 let text=store.buildBootstrap("eli");expect(text.split("\n").filter(x=>x.startsWith("- "))).toHaveLength(40);
 expect(text.indexOf("story-0:")).toBeLessThan(text.indexOf("story-44:"));
 store.setFlag("latest-long","x".repeat(9000),"bruno");text=store.buildBootstrap("eli");expect(text.length).toBeLessThanOrEqual(4000);expect(text).toContain("latest-long");db.close();
});

test("BK-6 no flags omits their section while counters and incoming threads remain", () => {
 const store=new SharedNarrativeStore(dbPath());expect(store.buildBootstrap("eli")).toBe("");
 store.incrementCounter("visits","bruno");store.recordThread({id:"t",fromAgent:"bruno",toAgent:"eli",label:"hello",value:"v"});
 const text=store.buildBootstrap("eli");expect(text).not.toContain("shared facts");expect(text).toContain("visits: 1");expect(text).toContain("hello");
});

test("BK-3 every production bookkeeping module uses marks, including expedition's former direct SQL", () => {
 for(const path of ["src/continuity/digest.ts","src/continuity/encounter.ts","src/continuity/reflection-engine.ts","src/continuity/pulse-anima-dispatcher.ts","src/continuity/room-scene-dispatcher.ts"]){
  const source=readFileSync(path,"utf8");expect(source).not.toMatch(/\.(setFlag|getFlag|getAllFlags)\(/);
 }
 const source=readFileSync("src/narrative/shared-store.ts","utf8").split("claimExpedition(")[1]!.split("startExpedition(")[0]!;
 expect(source).not.toContain("shared_flags");
});

test("BK-2 list independently prunes expired marks and sorts mixed historical/ISO timestamps by UTC instant", () => {
 const path=dbPath(),store=new SharedNarrativeStore(path),db=new Database(path);
 store.setMark("old-iso","v","eli");store.setMark("new-sqlite","v","bruno");
 db.run("UPDATE automation_marks SET set_at='2026-10-29T00:00:00Z' WHERE key='old-iso'");
 db.run("UPDATE automation_marks SET set_at='2026-10-29 23:00:00' WHERE key='new-sqlite'");
 store.setMark("expired-list-only","v","eli",100);
 db.run("UPDATE automation_marks SET expires_at=? WHERE key='expired-list-only'",[Date.now()-1]);
 expect(store.listMarks("").map(x=>x.key)).toEqual(["new-sqlite","old-iso"]);
 expect(db.query("SELECT key FROM automation_marks WHERE key='expired-list-only'").get()).toBeNull();db.close();
});

test("BK-4 write defaults apply each TTL family and refuse unusable TTLs without overwriting state", () => {
 const store=new SharedNarrativeStore(dbPath());
 for(const [key,ttl] of [["pulse-anima-slot-fired:now",7*86400_000],["visit-dedup:a:b",12*3600_000],["encounter:a|b",2*86400_000]] as const){
  store.setMark(key,"v","eli");const mark=store.getMark(key)!;expect(mark.expiresAt!-Date.parse(mark.setAt)).toBe(ttl);
 }
 store.setMark("keep","original","bruno");
 for(const ttl of [0,-1,NaN,Infinity])expect(()=>store.setMark("keep","replacement","eli",ttl)).toThrow();
 expect(store.getMark("keep")!.value).toBe("original");
});

test("BK-5 invalid migrated expiry timestamps abort the complete transaction", () => {
 const path=dbPath(),legacy=new SharedNarrativeStore(path),db=new Database(path);
 legacy.setFlag("eli:digest","keep","eli");legacy.setFlag("visit-dedup:a:b","v","eli");
 db.run("UPDATE shared_flags SET set_at='not a date' WHERE key='visit-dedup:a:b'");
 expect(()=>new SharedNarrativeStore(path)).toThrow("Invalid automation mark timestamp");
 expect(db.query("SELECT count(*) AS n FROM shared_flags").get()).toEqual({n:2});
 expect(db.query("SELECT count(*) AS n FROM automation_marks").get()).toEqual({n:0});db.close();
});
