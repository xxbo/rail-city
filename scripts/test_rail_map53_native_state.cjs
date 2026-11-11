/* Owned Worker state, queried against the historical business contract. */
const assert=require('node:assert/strict'),P=require('../rail/passengers'),M=require('../rail/management'),N=require('../rail/network'),Runtime=require('../rail/runtime-wasm'),Oracle=require('./helpers/native-oracle.cjs');
const OldP=require('./fixtures/rail-map52-passengers.cjs'),OldM=require('./fixtures/rail-map52-management.cjs'),{create}=require('./fixtures/rail-memory-grid.cjs');
const opts={budget:1e6,maxSteps:10000};
(async()=>{
 let checks=0;
 for(const weighted of [false,true]){
  const s=create(3);s.economy.minute=530;require('../rail/urban-growth').init(s);const old=structuredClone(s),l=s.services[0];
  const catalog=Array.from({length:30},(_,id)=>({id,legs:[{service:l.id,dir:1,from:l.stops[0],to:l.stops.at(-1)}],daily:300000+id*1000,fare:180+id,purpose:['work','shopping','leisure'][id%3],back:!!(id%2),hub:null,externalKind:null,from:l.stops[0],to:l.stops.at(-1),lineIds:[l.id],byLine:{[l.id]:1}}));
  const f={preparedDefinitions:catalog,flows:[]},legacyForecast=structuredClone(f);let rt=Oracle.create(P,s,f,530,weighted),expected=OldP.create(old,legacyForecast,530,false);if(weighted)expected.arrivalMode='weighted';
  // Use the physical admission limits in both kernels; high demand still forces crowding.
  try{
   for(const dt of [1,2.3,6.7,.1,15.2,4.3]){
    await M.advanceBudgetAsync(s,rt,dt,opts);OldM.advanceBudget(old,expected,dt,opts);
    Oracle.world(s,old,'world at '+rt.minute);const snap=await P.snapshotAsync(rt);
    Oracle.checkpoint(snap,OldP.snapshot(expected),expected.defs,s);Oracle.equal(P.summary(rt),OldP.summary(expected));
    assert.equal(Object.keys(rt.queues).length,0);assert.equal(rt.transfers.length,0);assert(rt.trains.every(t=>Object.keys(t.passengers).length===0));
    for(const id of l.stops)Oracle.equal(await P.detailsAsync(rt,'station',id),OldP.station(expected,id),'station query');
    for(const t of rt.trains.slice(0,2)){const detail=await P.detailsAsync(rt,'train',t.id);assert.deepEqual(detail.passengers,snap.trains.find(x=>x.id===t.id).passengers);const destinations={};for(const [token,count]of Object.entries(detail.passengers)){const j=snap.urbanDefs[+token.split(':')[0]];destinations[j.to]=(destinations[j.to]||0)+count;}assert.deepEqual(detail.destinations,destinations);}
    assert.throws(()=>P.snapshot(rt),/异步快照/);checks++;
   }
   assert(rt.rejected>0,'physical gates actually reject excess demand');
   const index=3,previous=expected.demandCatalog[index].daily,value=previous/2;
   await P.setDaily(rt,index,value);expected.demandCatalog[index].daily=value;legacyForecast.preparedDefinitions[index].daily=value;expected.demandStatus.daily+=value-previous;expected.demandStatus.updatedAt=expected.minute;
   await M.advanceBudgetAsync(s,rt,2.2,opts);OldM.advanceBudget(old,expected,2.2,opts);Oracle.world(s,old);Oracle.checkpoint(await P.snapshotAsync(rt),OldP.snapshot(expected),expected.defs,s);checks++;
   const archive=await P.snapshotAsync(rt);while(archive.urbanDefs.length<56001)archive.urbanDefs.push({...archive.urbanDefs[0],id:archive.urbanDefs.length,daily:0});
   const enlarged=P.restore(s,f,archive);assert(enlarged);P.dispose(rt);rt=enlarged;
   while(expected.defs.length<56001)expected.defs.push({...expected.defs[0],id:expected.defs.length,daily:0});
   await M.replaceDemandAsync(rt,f);OldP.rebase(expected,old,structuredClone(legacyForecast));await P.materializeAsync(rt);assert(rt.defs.length<100);Oracle.checkpoint(await P.snapshotAsync(rt),OldP.snapshot(expected),expected.defs,s);checks++;
   const dispatch={mode:'auto',manual:8,offPeak:4,peak:8},changed=await M.changeAsync(s,rt,{kind:'network',op:'configure',args:{id:l.id,values:{dispatch}}});assert(!changed.error,changed.error);
   assert(!OldM.change(old,state=>N.configure(state,l.id,{dispatch})).error);OldP.reconcile(expected,old);Oracle.checkpoint(await P.snapshotAsync(rt),OldP.snapshot(expected),expected.defs,s);
   await M.advanceBudgetAsync(s,rt,3,opts);OldM.advanceBudget(old,expected,3,opts);Oracle.checkpoint(await P.snapshotAsync(rt),OldP.snapshot(expected),expected.defs,s);Oracle.world(s,old);checks++;
   const saved=await P.snapshotAsync(rt),restored=P.restore(s,f,saved);assert(restored);P.dispose(rt);rt=restored;
   const oldSaved=OldP.snapshot(expected);OldP.dispose?.(expected);expected=OldP.restore(old,structuredClone(legacyForecast),oldSaved);assert(expected);expected.demandStatus.updatedAt=oldSaved.demandStatus.updatedAt;
   await M.advanceBudgetAsync(s,rt,3,opts);OldM.advanceBudget(old,expected,3,opts);Oracle.checkpoint(await P.snapshotAsync(rt),OldP.snapshot(expected),expected.defs,s);Oracle.world(s,old);checks++;
  }finally{P.dispose(rt);OldP.dispose?.(expected);}
 }
 const threads=require('node:worker_threads'),Worker=threads.Worker;threads.Worker=class{constructor(){throw Error('worker unavailable in this test');}};
 try{
  const s=create(2);s.economy.minute=480;const old=structuredClone(s),l=s.services[0],f={preparedDefinitions:[{id:0,legs:[{service:l.id,dir:1,from:l.stops[0],to:l.stops.at(-1)}],daily:20000,fare:180,purpose:'work',back:false,hub:null,externalKind:null,from:l.stops[0],to:l.stops.at(-1),lineIds:[l.id],byLine:{[l.id]:1}}]};
  const rt=P.create(s,f,480,false),expected=OldP.create(old,structuredClone(f),480,false);try{await M.advanceBudgetAsync(s,rt,4.2,opts);OldM.advanceBudget(old,expected,4.2,opts);Oracle.world(s,old);Oracle.checkpoint(P.snapshot(rt),OldP.snapshot(expected),expected.defs,s);assert(!Runtime.usesWorker(rt));checks++;}finally{P.dispose(rt);OldP.dispose?.(expected);}
 }finally{threads.Worker=Worker;}
 console.log('MAP53 native state:',checks,'Worker/local business checkpoints, physical crowding, explicit demand edits, archive compaction, native commands and restore.');
})().catch(error=>{console.error(error);process.exitCode=1;});
