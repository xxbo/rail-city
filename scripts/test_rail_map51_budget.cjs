const assert=require('node:assert/strict');
const P=require('../rail/passengers'),M=require('./helpers/management-compat.cjs'),D=require('../rail/demand-model'),N=require('../rail/network');
const OldP=require('./fixtures/rail-map50-passengers.cjs'),OldM=require('./fixtures/rail-map50-management.cjs');
const Perf=require('../rail/performance'),OldPerf=require('./fixtures/rail-map50-performance.cjs');
const U=require('../rail/urban-growth'),RV=require('../rail/operations-review');
const {create}=require('./fixtures/rail-memory-grid.cjs');
let checks=0,multiStepBatches=0,executedSteps=0;const nativeAdvance=M.advanceBudget;
M.advanceBudget=(...args)=>{const batch=nativeAdvance(...args);executedSteps+=batch.steps;if(batch.steps>1)multiStepBatches++;return batch;};
function forecast(s) {
  const cells = s.nodes.map((n, i) => ({
    id: 'c' + i,
    x: n.x,
    y: n.y,
    w: 8,
    h: 8,
    area: .13,
    people: 18000 + i * 500,
    jobs: 12000 + i * 200,
    shops: 5000,
    industry: 500,
    leisure: 1000
  }));
  return D.evaluate(s, {
    cells,
    totals: Object.fromEntries(['people', 'jobs', 'shops', 'industry', 'leisure'].map(k => [k,
      cells.reduce((v, c) => v + c[k], 0)
    ])),
    metadata: {
      effectiveConnections: true,
      demandZoneUnits: 40
    }
  });
}

const Oracle=require('./helpers/native-oracle.cjs'),Runtime=require('../rail/runtime-wasm');
function pair(start=480,weighted=false,debt=false,cash){
 const a=create(3);a.economy.minute=start;if(cash!==undefined)a.economy.cash=cash;
 if(debt){a.economy.nextLoan=2;a.economy.loans=[{id:1,initial:1e8,principal:1e8,interest:20,installment:1e8/30,nextDue:start+.135}];}
 U.init(a);a.urban.lastMinute=Math.max(420,start-360+.2);RV.init(a,{minute:start});
 const b=structuredClone(a),f=forecast(a),ra=Oracle.create(P,a,f,start,weighted),rb=OldP.create(b,f,start,false);if(weighted)rb.arrivalMode='weighted';return {a,b,f,ra,rb};
}
function compare(p){Oracle.world(p.a,p.b);Oracle.checkpoint(P.snapshot(p.ra),OldP.snapshot(p.rb),p.rb.defs,p.a);}
function close(p){P.dispose(p.ra);OldP.dispose?.(p.rb);}
function clockResult(actual,expected,blockedFinalQuantum=false){const {busy,epoch,...common}=actual;assert.equal(busy,false);assert(Number.isSafeInteger(epoch)&&epoch>=0);if(blockedFinalQuantum){assert.equal(common.steps,expected.steps+1,'native reports the final executed blocked quantum');delete common.steps;const {steps,...rest}=expected;Oracle.equal(common,rest,'blocked clock result');}else Oracle.equal(common,expected,'clock result');}


for(const weighted of [false,true]) for(const start of [539.83,1859.85]) for(const debt of [false,true]) {
 const p=pair(start,weighted,debt),clock=Perf.createClock(),oldClock=OldPerf.createClock();
 for(let i=0;i<24;i++) {
  if(i===6||i===12) {
   const dispatch={mode:'auto',manual:8,offPeak:i===6?0:4,peak:8};
   for(const line of [...p.a.services]){const result=Runtime.commandSync(p.ra,{kind:'network',op:'configure',args:{id:line.id,values:{dispatch}}}).result;assert(!result.error,result.error);const mark=RV.prepare(p.b,p.rb);assert(!OldM.change(p.b,state=>N.configure(state,line.id,{dispatch})).error);OldP.reconcile(p.rb,p.b);RV.record(p.b,p.rb,mark);}OldP.reconcile(p.rb,p.b);
  }
  const elapsed=[0,.016,.04,.12,.3,-.1,.001][i%7];
  const a=clock.runBudget(elapsed,24,1e6,(dt,options)=>M.advanceBudget(p.a,p.ra,dt,{...options,nativeLoop:true}),()=>0);
  const b=oldClock.run(elapsed,24,1e6,dt=>OldM.advance(p.b,p.rb,dt),()=>0);
  clockResult(a,b);compare(p);checks++;
 }
 close(p);clock.close();
}
// Native wall budget rejection and step-count yields retain the complete arena.
for(const mode of ['time','steps']){
 const p=pair(),before=P.snapshot(p.ra),count=mode==='time'?0:2;
 const result=M.advanceBudget(p.a,p.ra,10,mode==='time'?{budget:0,maxSteps:10000}:{budget:1e6,maxSteps:2});
 assert.equal(result.steps,count);assert.equal(result.reason,mode==='time'?'time':'steps');
 if(!count)assert.deepEqual(P.snapshot(p.ra),before,'zero budget is an atomic refusal');
 for(let i=0;i<count;i++)OldM.advance(p.b,p.rb,.1);compare(p);
 const next=M.advanceBudget(p.a,p.ra,result.remaining,{budget:1e6,maxSteps:10000});
 let pending=result.remaining;while(pending>1e-8){const dt=Math.min(.1,pending);OldM.advance(p.b,p.rb,dt);pending-=dt;}
 Oracle.equal(next.remaining,pending);compare(p);checks+=2;close(p);
}
// Cancellation clears the native presentation backlog; no callback crosses WASM.
{const clock=Perf.createClock(),old=OldPerf.createClock();clock.runBudget(0,24,5,()=>assert.fail('zero elapsed'),()=>0);old.run(0,24,5,()=>assert.fail('zero elapsed'),()=>0);clock.reset();old.reset();assert.equal(clock.pending,old.pending);assert.equal(clock.pending,0);clock.close();checks++;}
// A blocked account stops both clocks and clears accumulated presentation time identically.
{
 const p=pair(480,false,false,.01);
 const a=Perf.createClock().runBudget(.12,24,5,(dt,o)=>M.advanceBudget(p.a,p.ra,dt,o),()=>0);
 const b=OldPerf.createClock().run(.12,24,5,dt=>OldM.advance(p.b,p.rb,dt),()=>0);
 clockResult(a,b,true);compare(p);checks++;close(p);
}
{
 const p=pair(),r=M.advanceBudget(p.a,p.ra,2000,{budget:1e6,maxSteps:1,now:()=>0});
 assert.equal(r.steps,1);assert.equal(r.remaining,1999.9);OldM.advance(p.b,p.rb,.1);
 compare(p);checks++;close(p);
}
assert(multiStepBatches>0&&executedSteps>multiStepBatches,'owned Rust RPC must execute actual multiple-step batches');
console.log(`MAP51 budget: ${checks} complete frozen MAP50 clock/state checks; frame remainders, minute/peak/debt/day/city/review boundaries, edits, pause/step/cancel yields and cash-stop continuity.`);
