/* Native statistics lifetime and minute-window projections against frozen MAP55. */
const assert=require('node:assert/strict');
const P=require('../rail/passengers'),M=require('./helpers/management-compat.cjs'),Q=require('../rail/ridership'),D=require('../rail/demand-model');
const OldP=require('./fixtures/rail-map55-passengers.cjs'),OldM=require('./fixtures/rail-map55-management.cjs'),OldQ=require('./fixtures/rail-map55-ridership.cjs');
const {create}=require('./fixtures/rail-memory-grid.cjs');
const Oracle=require('./helpers/native-oracle.cjs'),Runtime=require('../rail/runtime-wasm');
const options={budget:1e6,maxSteps:10000,now:()=>0};
const exact=(a,b)=>{assert.deepEqual(a,b);assert.equal(JSON.stringify(a),JSON.stringify(b));};
function forecast(s,populated){
 const cells=s.nodes.map((n,i)=>({id:'c'+i,x:n.x,y:n.y,w:8,h:8,area:.13,people:populated?3000+i*200:0,jobs:populated?1500+i*100:0,shops:populated?500:0,industry:0,leisure:0}));
 return D.evaluate(s,{cells,totals:Object.fromEntries(['people','jobs','shops','industry','leisure'].map(k=>[k,cells.reduce((n,c)=>n+c[k],0)])),metadata:{effectiveConnections:true,demandZoneUnits:40}});
}
(async()=>{
 let checks=0,maxFull=0;
 for(const start of [479.85,1859.85])for(const populated of [false,true])for(const weighted of [false,true]){
  const s=create(3),f=forecast(s,populated);
  s.ridership.hour=[{minute:start-60.001,count:2},{minute:start-60,count:3},{minute:start-59.99,count:4},{minute:start-10,count:5},{minute:start-80,count:6}];
  s.economy.minute=start;const old=structuredClone(s);let rt=Oracle.create(P,s,f,start,weighted),before=OldP.create(old,f,start,false);
  s.economy.minute=old.economy.minute=start;
  if(weighted)before.arrivalMode='weighted';
  P.nativeViews(rt);OldP.nativeViews(before);
  try{
   for(const dt of [.3,15,45,30,30]){
    const a=await M.advanceBudgetAsync(s,rt,dt,options),b=await OldM.advanceBudgetAsync(old,before,dt,options);
    Oracle.batch(a,b);Oracle.world(s,old);Oracle.checkpoint(await P.snapshotAsync(rt),await OldP.snapshotAsync(before),before.defs,s);checks++;
   }
   const stable=await Runtime.query(rt,'storage');maxFull=Math.max(maxFull,stable.statisticsFullFrames);
   assert(stable.statisticsFullFrames<=3,JSON.stringify(stable));
   // A detached historical statistics fixture is accepted through an explicit
   // checkpoint restore; writes to a live JS display never feed the native arena.
   const nativeSaved=await P.snapshotAsync(rt),saved=await OldP.snapshotAsync(before);P.dispose(rt);OldP.dispose(before);
   s.ridership.current.completed+=.25;old.ridership.current.completed+=.25;
   const trip={lineIds:[],fare:0,byLine:{}};
   for(const state of [s,old])OldQ.event(state,{minute:nativeSaved.minute,plan:state},trip,'enter',.25);
   rt=P.restore(s,f,nativeSaved);before=OldP.restore(old,f,saved);assert(rt&&before);before.demandStatus.updatedAt=saved.demandStatus.updatedAt;
   await M.advanceBudgetAsync(s,rt,.4,options);await OldM.advanceBudgetAsync(old,before,.4,options);
   Oracle.world(s,old);Oracle.checkpoint(await P.snapshotAsync(rt),await OldP.snapshotAsync(before),before.defs,s);checks++;
   assert.equal((await Runtime.query(rt,'storage')).statisticsFullFrames,1,'new owner loads a single full statistics frame');
  }finally{P.dispose(rt);OldP.dispose(before);}
 }
 console.log(`MAP56 statistics: ${checks} complete business worlds/saves; integer/weighted, empty/populated, unsorted expired buckets, exact 60-minute cutoff, quiet expiry, 07:00 archive and explicit historical restore; at most ${maxFull} full frames across 120 game minutes.`);
})().catch(e=>{console.error(e);process.exitCode=1;});
