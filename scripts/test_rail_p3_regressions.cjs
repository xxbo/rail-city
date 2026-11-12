/* Runtime regressions found by the first complete post-migration test run.
 * Assert native state directly; detached JS views never act as simulation input. */
const assert=require('node:assert/strict'),P=require('../rail/passengers'),M=require('../rail/management'),N=require('../rail/network'),B=require('../rail/bootstrap-wasm'),Catalog=require('../rail/forecast-catalog'),LS=require('../rail/local-save'),D=require('../rail/demand-model');
const {create}=require('./fixtures/rail-memory-grid.cjs');
const close=(a,b)=>assert(Math.abs(a-b)<1e-6,`${a} != ${b}`);
function forecast(s){const line=require('../rail/service-plan').expand(s).services[0];return {preparedDefinitions:[{id:0,legs:[{service:line.id,dir:1,from:line.stops[0],to:line.stops.at(-1)}],daily:50000,fare:180,purpose:'shopping',back:false,hub:null,externalKind:null,from:line.stops[0],to:line.stops.at(-1),lineIds:[line.parentLine],byLine:{[line.parentLine]:1}}],flows:[]};}
const legacy=M.init(N.emptyWorld('tokyo'));legacy.routeModel=1;N.addLine(legacy,[{x:600,y:500},{x:640,y:500}]);const legacyRuntime=P.create(legacy,{flows:[]},420,true);M.advance(legacy,legacyRuntime,1);close(legacyRuntime.minute,421);assert.deepEqual(legacy.ridership.lines,{},'weighted legacy lines do not receive modern feedback');assert.doesNotThrow(()=>LS.parse(JSON.stringify(LS.pack(legacy,P.snapshot(legacyRuntime)))),'legacy running worlds remain valid save files');P.dispose(legacyRuntime);
// New routes start cultivation at the requested session clock; existing opening
// dates survive both cold initialization and checkpoint restore.
{const world=M.init(N.emptyWorld('gba'));N.addLine(world,[{x:600,y:500},{x:640,y:500}]);const id=world.services[0].id,rt=P.create(world,{flows:[]},479.9,false);assert.equal(world.ridership.lines[id].opened,479.9);const saved=P.snapshot(rt),copy=structuredClone(world),restored=P.restore(copy,{flows:[]},saved);assert(restored);assert.equal(copy.ridership.lines[id].opened,479.9);P.dispose(rt);P.dispose(restored);}
{const world=M.init(N.emptyWorld('gba'));world.economy.cash=99;world.economy.arrears=500;world.economy.blocked=true;const rt=P.create(world,{flows:[]},480,false);try{assert.equal(M.advance(world,rt,0),false);assert.equal(world.economy.cash,0);assert.equal(world.economy.arrears,401);assert.deepEqual(world.ridership.current.lines,{},'settling old bills creates no operating statistics');assert.equal(rt.minute,480,'blocked settlement does not advance time');}finally{P.dispose(rt);}}
{const world=create(2),rt=P.create(world,{flows:[]},480,false);try{M.advance(world,rt,1e-9);assert.equal(rt.minute,480);M.advance(world,rt,1.1e-9);assert(rt.minute>480);assert(world.economy.operating>0,'sub-microsecond accepted intervals retain their actual operating charge');}finally{P.dispose(rt);}}
const s=create(2),f=forecast(s),input=structuredClone(f),rt=P.create(s,f,480,false);
assert(!rt.defs?.length&&!Object.keys(rt.queues||{}).length&&!rt.transfers?.length,'session creation publishes a compact display, not a full checkpoint');
assert.deepEqual(f,input,'attaching a legacy forecast leaves the caller DTO cloneable and unchanged');
assert.equal(rt.demandStatus.profiles,1,'prepared definitions are retained even without full flows');
for(let i=0;i<4;i++)M.advance(s,rt,10);
assert(rt.completed>0);assert(rt.boarded>0);assert(rt.revenue>0);
assert.equal(s.economy.minute,rt.minute,'world and runtime publish the same canonical minute');const saved=P.snapshot(rt),savedWorld=structuredClone(s),restored=P.restore(savedWorld,f,structuredClone(saved));assert(restored);assert.equal(JSON.stringify(P.snapshot(restored)),JSON.stringify(saved),'immediate native restore preserves the complete ordered checkpoint');
for(const field of ['lineRevenue','lineBoarded','purposeCompleted'])assert.deepEqual(P.snapshot(restored)[field],saved[field],field+' survives restore');
assert(Object.values(saved.lineRevenue).some(n=>n>1000));assert(Object.values(saved.lineBoarded).some(n=>n>0));assert(saved.purposeCompleted.shopping>0);
for(let i=0;i<3;i++){M.advance(s,rt,5);M.advance(savedWorld,restored,5);assert.deepEqual(P.snapshot(rt),P.snapshot(restored),'complete native checkpoint continuation');assert.deepEqual(s,savedWorld,'complete native world continuation');}
close(s.ridership.current.operating,s.economy.operating);
close(Object.values(s.ridership.current.lines).reduce((n,row)=>n+(row.operating||0),0),s.economy.operating);
const authoritative=P.snapshot(rt);rt.minute=-1;rt.generated=-1;rt.trains[0].progress=999;assert.deepEqual(P.snapshot(rt),authoritative,'display mutations cannot alter authoritative state');
const summary=P.summary(rt);close(summary.generated,summary.waiting+summary.onboard+summary.completed+summary.cancelled);
assert(P.station(rt,0).today);assert('transferring' in P.station(rt,0));
{const Runtime=require('../rail/runtime-wasm'),before=P.snapshot(rt);rt.minute=-1;rt.generated=-1;assert.equal(Runtime.rebind(rt,s,f),rt);assert.deepEqual(P.snapshot(rt),before,'rebind consumes an authoritative checkpoint, never display edits');}
{const world=create(2),runtime=P.create(world,{flows:[]},480,false),before=P.snapshot(runtime);try{
 for(const minutes of [-1,NaN,Infinity,1e8+1])assert.throws(()=>require('../rail/runtime-wasm').advance(world,runtime,minutes,{full:true}),/INVALID_RUNTIME_BUDGET/);
 assert.deepEqual(P.snapshot(runtime),before,'invalid full advances preserve the complete arena');
 const batch=M.advanceBudget(world,runtime,0,{budget:0,maxSteps:1});assert.equal(batch.steps,0);assert.equal(batch.consumed,0);assert.equal(batch.reason,'complete');assert.deepEqual(batch.events,[]);
}finally{P.dispose(runtime);}}

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
 {
  const Runtime=require('../rail/runtime-wasm'),world=create(2),f=forecast(world),rt=P.create(world,f,420,false);
  try{
   const file=JSON.stringify(LS.pack(world,null,{speed:6,playing:false}));
   const {token}=await Runtime.previewImport(rt,file);
   const first=await Runtime.prepareImport(rt,token,f);
   assert.equal(first.token,token);
   await assert.rejects(Runtime.importWriteFailed(rt,token+1),/RESTORE_TOKEN_MISMATCH/);
   await Runtime.importWriteFailed(rt,token);
   const second=await Runtime.prepareImport(rt,token,f);
   assert.equal(second.saveKey,first.saveKey);
   await Runtime.commitImport(rt,token);
   await Runtime.commitImport(rt,token);
   await assert.rejects(Runtime.cancelImport(rt,token),/RESTORE_TOKEN_MISMATCH/);
   await assert.rejects(Runtime.forecastBegin(rt),/RESTORE_COMMIT_PENDING/);
  }finally{Runtime.dispose(rt);}
 }

 {const world=create(2),f=forecast(world),rt=P.create(world,f,419.9,false,{arrivalMode:'weighted'});try{assert.equal(rt.arrivalMode,'weighted');await M.advanceBudgetAsync(world,rt,.3,{budget:1e6,maxSteps:10000});assert.equal(rt.arrivalMode,'weighted','cold arrival mode survives internal Worker handoff');}finally{P.dispose(rt);}}
 // The public clock must be the actual native event clock, not start + requested.
 {const world=create(2),f=forecast(world),rt=P.create(world,f,419.9,false);try{
  const before=structuredClone(world.ridership.lines);M.advanceBudget(world,rt,.1,{budget:1e6,maxSteps:10000});
  assert.deepEqual(world.ridership.lines,before,'cold creation does not advance feedback ahead of sampling');
  for(let i=0;i<40;i++){M.advanceBudget(world,rt,.2,{budget:1e6,maxSteps:10000});P.snapshot(rt);assert.equal(rt.minute,rt.nativeView.minute,'save, UI and event clocks agree exactly');}
 }finally{P.dispose(rt);}}
 for(const initial of [{arrivalMode:'invalid'},{arrivalMode:'integer',extra:true}])assert.throws(()=>P.create(create(2),{flows:[]},480,false,initial),/INVALID_RUNTIME_INITIAL_OPTIONS/);
 for(const start of [390,419.9]){
  const world=create(2),f=forecast(world),rt=P.create(world,f,start,false),saved=P.snapshot(rt),cash=world.economy.cash;
  assert.equal(P.restore(structuredClone(world),f,saved),null,'public checkpoints retain the 420-minute lower bound');world.economy.cash=1;
  try{await M.advanceBudgetAsync(world,rt,1,{budget:1e6,maxSteps:10000});assert(rt.minute>=start+1-1e-8);assert(world.economy.cash>1,'handoff uses the native bank, not a modified JS view');assert(world.economy.cash<=cash);}finally{P.dispose(rt);}
 }
 {const world=M.init(N.emptyWorld('gba'));world.economy.cash=99;world.economy.arrears=500;world.economy.blocked=true;const rt=P.create(world,{flows:[]},480,false);try{assert.equal(M.advance(world,rt,0),false);assert.equal(world.economy.cash,0);assert.equal(world.economy.arrears,401);assert.deepEqual(world.ridership.current.lines,{},'settling old bills creates no operating statistics');assert.equal(rt.minute,480,'blocked settlement does not advance time');}finally{P.dispose(rt);}}
{const world=create(2),rt=P.create(world,{flows:[]},480,false);try{M.advance(world,rt,1e-9);assert.equal(rt.minute,480);M.advance(world,rt,1.1e-9);assert(rt.minute>480);assert(world.economy.operating>0,'sub-microsecond accepted intervals retain their actual operating charge');}finally{P.dispose(rt);}}
const s=create(2),f=forecast(s),rt=P.create(s,f,480,false);let restored;
 try{
  await M.advanceBudgetAsync(s,rt,12,{budget:1e6,maxSteps:10000});
  assert(require('../rail/runtime-wasm').usesWorker(rt),'normal handoff actually reaches the Worker');
  const history=await P.historyAsync(rt);assert.deepEqual(history,{current:s.ridership.current,history:s.ridership.history},'history query projects the native ridership fields');history.current.completed=-1;assert.notEqual((await P.historyAsync(rt)).current.completed,-1,'history results are detached');
  const stableSummary=P.summary(rt),world=structuredClone(s),saved=await P.snapshotAsync(rt);assert.deepEqual(P.summary(rt),stableSummary,"full Worker snapshot preserves the live summary");assert.equal(Object.keys(rt.queues).length,0,'saving does not republish native queue cohorts into the live UI');assert.equal(rt.transfers.length,0);assert(rt.trains.every(train=>Object.keys(train.passengers).length===0));for(const train of saved.trains)close(Object.values(train.passengers).reduce((sum,count)=>sum+count,0),train.onboard);restored=P.restore(world,f,structuredClone(saved));assert(restored);
  await M.advanceBudgetAsync(s,rt,3,{budget:1e6,maxSteps:10000});M.advance(world,restored,3);
  assert.deepEqual(await P.snapshotAsync(rt),P.snapshot(restored),'worker and restored local native arenas continue identically');assert.deepEqual(s,world);
  await P.detailsAsync(rt,'station',0);await M.advanceBudgetAsync(s,rt,.7,{budget:1e6,maxSteps:10000});const liveStation=P.station(rt,0),freshStation=await P.detailsAsync(rt,'station',0);assert.equal(liveStation.waiting,freshStation.waiting,'station display cache expires after time advances');assert.equal(liveStation.outside,freshStation.outside);
  const threads=require('node:worker_threads'),Worker=threads.Worker;threads.Worker=class{constructor(){throw Error('worker creation denied');}};
 try{const world=create(2),f=forecast(world),local=P.create(world,f,480,false),referenceWorld=structuredClone(world),reference=P.create(referenceWorld,f,480,false);try{await M.advanceBudgetAsync(world,local,3,{budget:1e6,maxSteps:10000});M.advance(referenceWorld,reference,3);assert(!require('../rail/runtime-wasm').usesWorker(local));assert.deepEqual(P.snapshot(local),P.snapshot(reference));assert.deepEqual(world,referenceWorld);}finally{P.dispose(local);P.dispose(reference);}}finally{threads.Worker=Worker;}
 console.log('P3 Worker regression passed: session handoff, full checkpoint and deterministic native continuation.');
 }finally{P.dispose(rt);if(restored)P.dispose(restored);}
})().catch(error=>{console.error(error);process.exitCode=1;});
