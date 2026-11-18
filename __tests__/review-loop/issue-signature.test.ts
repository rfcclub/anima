import {describe,test,expect} from 'bun:test';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {inspectSignedIssueReceipt} from '../../src/review-loop/issue-signature';

const pair=generateKeyPairSync('ed25519');
const publicKey=(pair.publicKey.export({type:'spki',format:'der'}) as Buffer).subarray(-32).toString('base64');
const other=generateKeyPairSync('ed25519');
const otherKey=(other.publicKey.export({type:'spki',format:'der'}) as Buffer).subarray(-32).toString('base64');
const digest=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const fields=['repoId','issueId','repo','number','bodySha256','issueType','decision','issuerId','keyId','policyEpoch'] as const;
function subject(){return {repoId:'123',issueId:'456',repo:'rfcclub/anima',number:45,bodySha256:'a'.repeat(64),issueType:'enhancement',decision:'approve-enhancement',issuerId:'operator-1',keyId:'key-1',policyEpoch:1};}
function payload():unknown[]{return ['anima-issue-authority/v1',...Object.values(subject()),'receipt-1',1000,2000];}
function encoded(p:unknown[]=payload()){return JSON.stringify([p,sign(null,Buffer.from(JSON.stringify(p)),pair.privateKey).toString('base64')]);}
const good=encoded();
function inspect(...args:unknown[]){return inspectSignedIssueReceipt(args.length>0?args[0]:good,args.length>1?args[1]:subject(),args.length>2?args[2]:publicKey);}
function refused(v:ReturnType<typeof inspect>,reason?:string){expect(v.kind).toBe('refused');expect(v.authority).toBe('unproven');expect(v.automaticMerge).toBe(false);if(reason)expect((v as {reason:string}).reason).toBe(reason);}
function matching(v:ReturnType<typeof inspect>){expect(v.kind).toBe('signature_matches');expect(v.authority).toBe('unproven');expect(v.automaticMerge).toBe(false);}

describe('IS-1 bounded canonical representation',()=>{
 test('a signed canonical envelope matches exact bytes but grants no authority',()=>{
  const v=inspect();matching(v);if(v.kind!=='signature_matches')throw Error('fixture refused');
  expect(v.envelopeSha256).toBe(digest(good));expect(v.payloadSha256).toBe(digest(JSON.stringify(payload())));expect(v.publicKeySha256).toBe(digest(Buffer.from(publicKey,'base64')));
  expect(Object.keys(v).sort()).toEqual(['kind','authority','automaticMerge','envelopeSha256','payloadSha256','publicKeySha256','unproven'].sort());
  expect(v.unproven).toEqual(['issuer','custody','classification','clock','lifetime','revocation','subject']);
 });
 for(const [name,e] of Object.entries({undefined:undefined,null:null,object:{},array:[],number:5,empty:'',json:'{',primitive:'true',objectJSON:'{}',short:'[]',long:'[[],"x",0]',pretty:JSON.stringify(JSON.parse(good),null,2),leading:' '+good,newline:good+'\n',escaped:good.replace('anima-','\\u0061nima-'),unicode:good.replace('receipt-1','r\u00e9ceipt-1')}))test(`refuses malformed envelope ${name}`,()=>refused(inspect(e),'format'));
 test('8193 bytes refuse before JSON interpretation',()=>refused(inspect('x'.repeat(8193)),'limit'));
 test('8192-byte invalid input is bounded format refusal',()=>refused(inspect('x'.repeat(8192)),'format'));
 test('extra payload element refuses',()=>refused(inspect(encoded([...payload(),1])),'format'));
 test('missing payload element refuses',()=>refused(inspect(encoded(payload().slice(0,-1))),'format'));
 test('wrong domain cannot replay Orca outcome signature',()=>{const p=payload();p[0]='orca-outcome-review/v1';refused(inspect(encoded(p)),'format');});
 test('alternate numeric spelling refuses canonicality',()=>refused(inspect(good.replace(',45,',',4.5e1,')),'format'));
});

describe('IS-2 signed-field shapes',()=>{
 const bad:[string,number,unknown][]=[
  ['zero repo id',1,'0'],['leading issue zero',2,'0456'],['numeric database id',1,123],['large database id',2,'1'.repeat(21)],['foreign owner',3,'other/anima'],['repo slash',3,'rfcclub/a/b'],['dot repo',3,'rfcclub/.'],['long repo',3,'rfcclub/'+'a'.repeat(101)],
  ['zero issue',4,0],['unsafe issue',4,Number.MAX_SAFE_INTEGER+1],['fraction issue',4,1.5],['string issue',4,'45'],['upper digest',5,'A'.repeat(64)],['short digest',5,'a'.repeat(63)],['unknown type',6,'feature'],['unknown decision',7,'approve'],['mismatched pair',7,'classify-bug'],
  ['empty issuer',8,''],['issuer whitespace',8,'operator x'],['issuer uppercase',8,'Operator'],['issuer dot',8,'a.b'],['long issuer',8,'a'.repeat(129)],['bad key id',9,'-a'],['zero epoch',10,0],['unsafe epoch',10,Number.MAX_SAFE_INTEGER+1],['bad receipt',11,'../x'],['long receipt',11,'a'.repeat(129)],
  ['negative issued',12,-1],['string issued',12,'1000'],['fraction expiry',13,2000.5],['unsafe expiry',13,Number.MAX_SAFE_INTEGER+1],['equal expiry',13,1000],['earlier expiry',13,999],['null time',13,null],
 ];
 for(const [name,i,value] of bad)test(`forbidden receipt shape: ${name}`,()=>{const p=payload();p[i]=value;refused(inspect(encoded(p)),'format');});
 test('bug/classify-bug is representable but not a trusted exemption',()=>{const p=payload();p[6]='bug';p[7]='classify-bug';matching(inspect(encoded(p),{...subject(),issueType:'bug',decision:'classify-bug'}));});
 test('maximum public identifiers and integers remain exact',()=>{const p=payload();p[1]='9'.repeat(20);p[2]='8'.repeat(20);p[3]='rfcclub/'+'a'.repeat(100);p[4]=Number.MAX_SAFE_INTEGER;p[8]='a'.repeat(128);p[9]='b'.repeat(128);p[10]=Number.MAX_SAFE_INTEGER;p[11]='c'.repeat(128);p[12]=0;p[13]=Number.MAX_SAFE_INTEGER;matching(inspect(encoded(p),Object.fromEntries(fields.map((k,i)=>[k,p[i+1]]))));});
});

describe('IS-3 exact subject and capture',()=>{
 const values:Record<string,unknown>={repoId:'124',issueId:'457',repo:'rfcclub/colony-mesh',number:46,bodySha256:'b'.repeat(64),issuerId:'operator-2',keyId:'key-2',policyEpoch:2};
 for(const [key,value] of Object.entries(values))test(`subject mismatch isolates ${key}`,()=>refused(inspect(good,{...subject(),[key]:value}),'subject_mismatch'));
 test('signed type and decision cannot cross exempt path',()=>refused(inspect(good,{...subject(),issueType:'bug',decision:'classify-bug'}),'subject_mismatch'));
 for(const key of fields)test(`missing subject ${key} refuses`,()=>{const s:Record<string,unknown>={...subject()};delete s[key];refused(inspect(good,s),'subject_invalid');});
 test('extra subject property refuses',()=>refused(inspect(good,{...subject(),approved:true}),'subject_invalid'));
 test('symbol subject property refuses',()=>refused(inspect(good,{...subject(),[Symbol('x')]:1}),'subject_invalid'));
 test('inherited fields do not establish subject',()=>refused(inspect(good,Object.create(subject())),'subject_invalid'));
 test('custom prototype with otherwise complete own fields refuses',()=>refused(inspect(good,Object.assign(Object.create({marker:1}),subject())),'subject_invalid'));
 test('descriptor snapshot never reads a proxy live property',()=>{let reads=0;const s=new Proxy(subject(),{get(target,key,receiver){reads++;return key==='issuerId'?'other':Reflect.get(target,key,receiver);}});matching(inspect(good,s));expect(reads).toBe(0);});
 test('null-prototype data subject is valid',()=>matching(inspect(good,Object.assign(Object.create(null),subject()))));
 test('getter is not called and cannot impersonate configured issuer',()=>{let calls=0;const s={...subject()};Object.defineProperty(s,'issuerId',{enumerable:true,get(){calls++;return 'operator-1';}});refused(inspect(good,s),'subject_invalid');expect(calls).toBe(0);});
 test('hostile descriptors return fixed code without thrown text',()=>{const s=new Proxy({}, {ownKeys(){throw Error('SECRET-CONFIG');}});const v=inspect(good,s);refused(v,'subject_invalid');expect(JSON.stringify(v)).not.toContain('SECRET');});
 test('object toString cannot impersonate expected login',()=>{let called=0;refused(inspect(good,{...subject(),issuerId:{toString(){called++;return 'operator-1';}}}),'subject_invalid');expect(called).toBe(0);});
});

describe('IS-4 actual signature verification',()=>{
 test('different valid Ed25519 public key refuses',()=>refused(inspect(good,subject(),otherKey),'signature_invalid'));
 test('another signature on the same payload refuses',()=>{const v=JSON.parse(good);v[1]=sign(null,Buffer.from(JSON.stringify(v[0])),other.privateKey).toString('base64');refused(inspect(JSON.stringify(v)),'signature_invalid');});
 for(let i=1;i<14;i++)if(i!==6&&i!==7)test(`tampering signed field ${i} with matching subject still fails crypto`,()=>{
  const v=JSON.parse(good),p=v[0];p[i]=typeof p[i]==='number'?p[i]+1:(i===5?'b'.repeat(64):p[i]+'x');
  if(i===1||i===2)p[i]='999';if(i===3)p[i]='rfcclub/other';
  const s=Object.fromEntries(fields.map((k,n)=>[k,p[n+1]]));refused(inspect(JSON.stringify(v),s),'signature_invalid');
 });
 test('tampering both type and decision still fails crypto after subject match',()=>{const v=JSON.parse(good);v[0][6]='bug';v[0][7]='classify-bug';refused(inspect(JSON.stringify(v),{...subject(),issueType:'bug',decision:'classify-bug'}),'signature_invalid');});
 for(const [name,key] of Object.entries({undefined:undefined,object:{},short:'AA==',long:'A'.repeat(88),whitespace:publicKey+'\n',url:'_'.repeat(43)+'=',noncanonical:publicKey.slice(0,-2)+'B=',private:'-----BEGIN '+'PRIVATE KEY-----'}))test(`invalid public key ${name}`,()=>refused(inspect(good,subject(),key),'key_invalid'));
 for(const [name,sig] of Object.entries({null:null,short:'AA==',long:'A'.repeat(92),whitespace:JSON.parse(good)[1]+'\n',noncanonical:JSON.parse(good)[1].slice(0,-3)+'B==',url:'_'.repeat(86)+'=='}))test(`invalid signature encoding ${name}`,()=>{const v=JSON.parse(good);v[1]=sig;refused(inspect(JSON.stringify(v)),'signature_invalid');});
});

describe('IS-5 authority and compatibility',()=>{
 test('mathematically valid past/future receipts do not prove time authority',()=>{for(const [a,b] of [[0,1],[8e12,8e12+1]]){const p=payload();p[12]=a;p[13]=b;const v=inspect(encoded(p));matching(v);if(v.kind==='signature_matches')expect(v.unproven).toContain('clock');}});
 test('result list mutation cannot change a later diagnostic',()=>{const a=inspect();if(a.kind!=='signature_matches')throw Error('fixture');a.unproven.pop();const b=inspect();if(b.kind!=='signature_matches')throw Error('fixture');expect(b.unproven).toContain('subject');});
 test('input objects cannot be coerced to encoded receipts or keys',()=>{let calls=0;const hostile={toString(){calls++;return good;}};refused(inspect(hostile),'format');refused(inspect(good,subject(),hostile),'key_invalid');expect(calls).toBe(0);});
 test('refusals expose only fixed non-authority properties',()=>{const v=inspect('SECRET-TEXT');refused(v,'format');expect(Object.keys(v).sort()).toEqual(['kind','reason','authority','automaticMerge'].sort());expect(JSON.stringify(v)).not.toContain('SECRET-TEXT');});
});

// Ed25519 8-torsion y coordinates and p/p+1 aliases; both sign bits are refused.
// Reference: libsodium 1.0.18 ed25519_ref10.c ge25519_has_small_order (not X25519).
describe('IS-6 small-order pin refusal',()=>{
 const ys=['00'.repeat(32),'01'+'00'.repeat(31),
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ec'+'ff'.repeat(30)+'7f','ed'+'ff'.repeat(30)+'7f','ee'+'ff'.repeat(30)+'7f'];
 for(const [i,y] of ys.entries())for(const signBit of [0,128])test(`regression: forbidden torsion/alias key ${i} sign ${signBit}`,()=>{
  const key=Buffer.from(y,'hex');key[31]!|=signBit;
  refused(inspect(good,subject(),key.toString('base64')),'key_invalid');
 });
 for(const [name,signature] of [
  ['identity R and zero S',Buffer.concat([Buffer.from('01'+'00'.repeat(31),'hex'),Buffer.alloc(32)])],
  ['basepoint R and unit S',Buffer.concat([Buffer.from('58'+'66'.repeat(31),'hex'),Buffer.from('01'+'00'.repeat(31),'hex')])],
 ] as const)test(`regression: forged ${name} cannot match with identity key`,()=>{
  const envelope=JSON.stringify([payload(),signature.toString('base64')]);
  refused(inspect(envelope,subject(),Buffer.from('01'+'00'.repeat(31),'hex').toString('base64')),'key_invalid');
 });
});
