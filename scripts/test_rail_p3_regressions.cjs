/* Runtime regressions found by the first complete post-migration test run.
 * Assert native state directly; detached JS views never act as simulation input. */
const assert=require('node:assert/strict'),P=require('../rail/passengers'),M=require('../rail/management'),N=require('../rail/network'),B=require('../rail/bootstrap-wasm'),Catalog=require('../rail/forecast-catalog'),LS=require('../rail/local-save'),D=require('../rail/demand-model');
const {create}=require('./fixtures/rail-memory-grid.cjs');
const close=(a,b)=>assert(Math.abs(a-b)<1e-6,`${a} != ${b}`);
function forecast(s){const line=require('../rail/service-plan').expand(s).services[0];return {preparedDefinitions:[{id:0,legs:[{service:line.id,dir:1,from:line.stops[0],to:line.stops.at(-1)}],daily:50000,fare:180,purpose:'shopping',back:false,hub:null,externalKind:null,from:line.stops[0],to:line.stops.at(-1),lineIds:[line.parentLine],byLine:{[line.parentLine]:1}}],flows:[]};}
const s=create(2),f=forecast(s),input=structuredClone(f),rt=P.create(s,f,480,false);
assert.deepEqual(f,input,'attaching a legacy forecast leaves the caller DTO cloneable and unchanged');
assert.equal(rt.demandStatus.profiles,1,'prepared definitions are retained even without full flows');
for(let i=0;i<4;i++)M.advance(s,rt,10);
assert(rt.completed>0);assert(rt.boarded>0);assert(rt.revenue>0);
assert.equal(s.economy.minute,rt.minute,'world and runtime publish the same canonical minute');const saved=P.snapshot(rt),savedWorld=structuredClone(s),restored=P.restore(savedWorld,f,structuredClone(saved));assert(restored);
for(const field of ['lineRevenue','lineBoarded','purposeCompleted'])assert.deepEqual(P.snapshot(restored)[field],saved[field],field+' survives restore');
assert(Object.values(saved.lineRevenue).some(n=>n>1000));assert(Object.values(saved.lineBoarded).some(n=>n>0));assert(saved.purposeCompleted.shopping>0);
for(let i=0;i<3;i++){M.advance(s,rt,5);M.advance(savedWorld,restored,5);assert.deepEqual(P.snapshot(rt),P.snapshot(restored),'complete native checkpoint continuation');assert.deepEqual(s,savedWorld,'complete native world continuation');}
close(s.ridership.current.operating,s.economy.operating);
close(Object.values(s.ridership.current.lines).reduce((n,row)=>n+(row.operating||0),0),s.economy.operating);
const authoritative=P.snapshot(rt);rt.minute=-1;rt.generated=-1;rt.trains[0].progress=999;assert.deepEqual(P.snapshot(rt),authoritative,'display mutations cannot alter authoritative state');
const summary=P.summary(rt);close(summary.generated,summary.waiting+summary.onboard+summary.completed+summary.cancelled);
assert(P.station(rt,0).today);assert('transferring' in P.station(rt,0));
// Invalid service references reject cleanly and leave the WASM instance usable.
assert.throws(()=>P.create(create(2),{flows:[{from:0,to:1,trips:1,path:{edges:[{service:'missing',to:1}],fare:1,km:1}}]},480,false),/INVALID_LEGACY_FORECAST/);
assert.deepEqual(P.snapshot(rt),authoritative);
// A compiled pattern service is resolved against the expanded operating plan.
const patterned=M.init(N.emptyWorld('gba'));N.addLine(patterned,[{x:600,y:500},{x:625,y:500},{x:650,y:500},{x:675,y:500}]);const line=patterned.services[0];assert(!N.configure(patterned,line.id,{fleet:12,patterns:[{kind:'local',from:0,to:3,fleet:2,headway:20},{kind:'direct',from:0,to:3,fleet:2,headway:20}]}).error);
const plan=require('../rail/service-plan').expand(patterned),run=plan.services.find(l=>l.id!==line.id&&l.parentLine===line.id),track=patterned.tracks.find(t=>t.id===run.trackIds[0]);
const pr=P.create(patterned,{flows:[{from:run.stops[0],to:run.stops[1],trips:1000,demandTrips:1000,path:{edges:[{service:run.id,track:track.id,dir:1,to:run.stops[1],km:track.km}],fare:180,km:track.km}}]},480,false);M.advance(patterned,pr,1);assert(Number.isFinite(pr.generated));
// Large forecast projections already own numeric tables; runtime creation reuses them.
const fields=['people','jobs','shops','industry','leisure'],cells=patterned.nodes.map((n,i)=>({id:'c'+i,x:n.x,y:n.y,w:8,h:8,area:.13,people:3000,jobs:1500,shops:500,industry:50,leisure:200}));
const evaluated=D.evaluate(patterned,{cells,totals:Object.fromEntries(fields.map(k=>[k,cells.reduce((n,c)=>n+c[k],0)])),metadata:{effectiveConnections:true,demandZoneUnits:40}});
assert(Catalog.source(evaluated));assert.doesNotThrow(()=>structuredClone(evaluated));const evaluatedRuntime=P.create(patterned,evaluated,480,false);assert(evaluatedRuntime.demandStatus.profiles>0);
assert.deepEqual(B.persistence('mergeRecords',{values:[{bestDay:12}]}),{bestDay:12,bestHour:0,totalCompleted:0});
const file=LS.pack(s,P.snapshot(rt),{personalRecords:{bestDay:12}});assert.equal(LS.parse(JSON.stringify(file)).playing,false);
for(const value of [rt,restored,pr,evaluatedRuntime])P.dispose(value);
console.log('P3 regressions passed: queue wire ordering, prepared catalogs, immutable DTOs, native restore/continuation, cumulative costs, authoritative views, compiled services, invalid-input recovery and save compatibility.');
(async()=>{
 const s=create(2),f=forecast(s),rt=P.create(s,f,480,false);let restored;
 try{
  await M.advanceBudgetAsync(s,rt,12,{budget:1e6,maxSteps:10000});
  const world=structuredClone(s),saved=await P.snapshotAsync(rt);restored=P.restore(world,f,structuredClone(saved));assert(restored);
  await M.advanceBudgetAsync(s,rt,3,{budget:1e6,maxSteps:10000});M.advance(world,restored,3);
  assert.deepEqual(await P.snapshotAsync(rt),P.snapshot(restored),'worker and restored local native arenas continue identically');assert.deepEqual(s,world);
  console.log('P3 Worker regression passed: session handoff, full checkpoint and deterministic native continuation.');
 }finally{P.dispose(rt);if(restored)P.dispose(restored);}
})().catch(error=>{console.error(error);process.exitCode=1;});
