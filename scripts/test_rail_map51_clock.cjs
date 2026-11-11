/* Async presentation debt survives worker roundtrips; pause/reset never revives old debt. */
const assert=require('node:assert/strict');
const Perf=require('../rail/performance');
const Core=require('../rail/routing-wasm');
const Client=require('../rail/simulation-client');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  const clock=Perf.createClock();let finish,calls=0;
  const advance=(minutes)=>{calls++;return new Promise(resolve=>{finish=()=>resolve({remaining:minutes-.2,steps:2,running:true});});};
  clock.runAsync(.1,6,6,advance,()=>0);await turn();
  for(let i=0;i<5;i++)clock.runAsync(.02,6,6,advance,()=>0);
  assert.equal(calls,1);const debt=clock.pending;
  finish();await turn();assert.equal(clock.pending,debt-.2);
  clock.runAsync(0,6,6,advance,()=>0);await turn();
  clock.reset();finish();await turn();assert.equal(clock.pending,0);
  const blocked=Perf.createClock();
  blocked.runAsync(.1,6,6,async()=>({remaining:.5,steps:0,running:false}),()=>0);
  await turn();assert.equal(blocked.runAsync(0,6,6,advance,()=>0).ok,false);assert.equal(blocked.pending,0);
  const invalid=Perf.createClock();
  invalid.runAsync(.1,6,6,async()=>({remaining:100,steps:1,running:true}),()=>0);
  await turn();assert.throws(()=>invalid.runAsync(0,6,6,advance,()=>0));
  // Same Rust kernel in environments without Worker. No alternative simulation algorithm.
  const P=require('../rail/passengers'),M=require('./helpers/management-compat.cjs'),{create}=require('./fixtures/rail-memory-grid.cjs');
  const state=create(2),rt=P.create(state,{preparedDefinitions:[]},480,false);
  const referenceWorld=structuredClone(state),reference=P.create(referenceWorld,{preparedDefinitions:[]},480,false),threads=require('node:worker_threads'),Worker=threads.Worker;
  threads.Worker=class{constructor(){throw Error('unavailable');}};
  try{const result=await M.advanceBudgetAsync(state,rt,.1,{budget:1e6,maxSteps:10000});M.advance(referenceWorld,reference,.1);assert(result.running);assert.equal(result.steps,1);assert.equal(result.remaining,0);assert(!require('../rail/runtime-wasm').usesWorker(rt));assert.deepEqual(P.snapshot(rt),P.snapshot(reference));assert.deepEqual(state,referenceWorld);}finally{threads.Worker=Worker;P.dispose(rt);P.dispose(reference);}
  Core.recycleSimulation();
  const worker=Client.create();
  try {
    await assert.rejects(worker.run(function*(){yield {name:'forbidden',input:new Float64Array()};}),/Unknown simulation worker operation/);
    await assert.rejects(worker.run(function*(){yield {name:'forbidden',input:new Float64Array()};}),/Unknown simulation worker operation/);
  }finally{worker.close();}
  console.log('MAP51 async clock: serialized in-flight batches, retained debt, pause/reset, blocked/fault validation, same-kernel local mode and worker rejection cleanup.');
})().catch(error=>{console.error(error);process.exitCode=1;});
