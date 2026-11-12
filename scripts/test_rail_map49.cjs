/* Exact frozen temporal kernels plus versioned native-session business checkpoints. */
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const SIM = require('../rail/simulation-wasm'),
  Core = require('../rail/routing-wasm');
const OldC = require('./fixtures/rail-map48-city.cjs'),
  OldF = require('./fixtures/rail-map48-fleet.cjs'),
  OldQ = require('./fixtures/rail-map48-ridership.cjs'),
  OldSIM = require('./fixtures/rail-map48-simulation-wasm.cjs');
const P = require('../rail/passengers'),
  M = require('./helpers/management-compat.cjs'),
  OldP = require('./fixtures/rail-map48-passengers.cjs'),
  OldM = require('./fixtures/rail-map48-management.cjs');
const N = require('../rail/network'),
  D = require('../rail/demand-model'),
  LS = require('../rail/local-save'),
  {
    create
  } = require('./fixtures/rail-memory-grid.cjs');
const {checkTemporalParity, exact} = require('./helpers/temporal-parity.cjs');
const {catalog} = checkTemporalParity({city: OldC, fleet: OldF, ridership: OldQ, simulation: OldSIM});
let checks = 0;

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

const Oracle=require('./helpers/native-oracle.cjs'),Runtime=require('../rail/runtime-wasm'),B=require('../rail/bootstrap-wasm');
const pairs=new Set();
function pair(start=480,weighted=false,prepare=()=>{}){
 const a=create(3);a.economy.minute=start;prepare(a);const b=structuredClone(a),f=forecast(a),ra=Oracle.create(P,a,f,start,weighted),rb=OldP.create(b,f,start,false);if(weighted)rb.arrivalMode='weighted';
 const p={a,b,f,ra,rb};pairs.add(p);return p;
}
function closePairs(){for(const p of pairs){if(p.ra)P.dispose(p.ra);if(p.rb)OldP.dispose?.(p.rb);}pairs.clear();}
async function compare(p){Oracle.world(p.a,p.b);Oracle.checkpoint(await P.snapshotAsync(p.ra),OldP.snapshot(p.rb),p.rb.defs,p.a);}
async function check(p,dt){const actual=M.advanceBudget(p.a,p.ra,dt,{budget:1e6,maxSteps:10000});const expected=Oracle.advanceLegacy(OldM,p.b,p.rb,dt,{budget:1e6,maxSteps:10000,now:()=>0});Oracle.batch(actual,expected);await compare(p);checks++;}
async function dispatch(p,values){for(const line of [...p.a.services]){const result=Runtime.commandSync(p.ra,{kind:'network',op:'configure',args:{id:line.id,values:{dispatch:values}}}).result;assert(!result.error,result.error);assert(!OldM.change(p.b,state=>N.configure(state,line.id,{dispatch:values})).error);}OldP.reconcile(p.rb,p.b);}
async function restoreFixture(p,edit){
 const a=await P.snapshotAsync(p.ra),b=OldP.snapshot(p.rb);P.dispose(p.ra);OldP.dispose?.(p.rb);edit(p.a,a);edit(p.b,b);
 p.ra=P.restore(p.a,p.f,a);p.rb=OldP.restore(p.b,p.f,b);assert(p.ra&&p.rb,'explicit edited fixture restores');p.rb.demandStatus.updatedAt=b.demandStatus.updatedAt;
}
(async()=>{try{
for(const weighted of [false,true]){
 const p=pair(419.9,weighted);for(let i=0;i<40;i++)await check(p,.2);
 await dispatch(p,{mode:'auto',manual:8,offPeak:4,peak:8});for(let i=0;i<30;i++)await check(p,.3);
 await restoreFixture(p,state=>{delete state.ridership.model;for(const row of Object.values(state.ridership.lines)){row.awareness=.43;row.trust=.7;}});await check(p,70);
 const loaded=LS.parse(JSON.stringify(LS.pack(p.a,await P.snapshotAsync(p.ra)))),restored=P.restore(loaded.state,p.f,loaded.runtime);assert(restored);P.dispose(restored);
}
for(const start of [539.9,1019.9,1139.9,1379.9,1439.9,1859.9]){
 const p=pair(start);await dispatch(p,{mode:'auto',manual:8,offPeak:4,peak:8});for(let i=0;i<15;i++)await check(p,.1);
}
for(const start of [419.9,1139.9]){const p=pair(start,false,state=>{for(const line of state.services)assert(!N.configure(state,line.id,{dispatch:{mode:'auto',manual:8,offPeak:0,peak:8}}).error);});for(let i=0;i<20;i++)await check(p,.2);}
// Standalone sampling keeps its independent exact temporal oracle.
const s={ridership:{model:22,lines:{missing:{satisfaction:.1,awareness:.4,trust:.6}}}};
exact(SIM.timedArrivals(catalog,s,1020,1,.2,99,true),OldSIM.arrivals(catalog,j=>OldQ.factor(s,j),j=>OldC.profile(j.purpose,j.back,1020,j.externalKind),.2,99));
const bytes=fs.readFileSync(path.join(__dirname,'../rail/wasm/rail-core-v33.wasm'));closePairs();Core.create(bytes,{recycleBytes:0});
const recovery=pair();for(let i=0;i<10;i++)await check(recovery,.2);closePairs();Core.create(bytes,{recycleBytes:64*1024*1024});
// Hot stepping has one stateful native request and no host accounting RPC.
{
 const p=pair();await check(p,.1);const runtime=B.runtime,kernel=Core.kernel,Worker=require('node:worker_threads').Worker,post=Worker.prototype.postMessage;let advances=0,accounts=0;
 Worker.prototype.postMessage=function(data,...args){if(data.kind==='session'&&data.action==='advance')advances++;return post.call(this,data,...args);};B.runtime=(action,...args)=>{if(action==='advance')advances++;return runtime(action,...args);};Core.kernel=(name,input,...args)=>{if(name==='operations_run'&&[2,3].includes(input[1]))accounts++;return kernel(name,input,...args);};
 try{for(let i=0;i<40;i++){const result=await M.advanceBudgetAsync(p.a,p.ra,.1,{worker:false,budget:1e6,maxSteps:10000});assert.equal(result.steps,1);}}finally{B.runtime=runtime;Core.kernel=kernel;Worker.prototype.postMessage=post;}
 // Count stateful requests in either transport; no host accounting RPC is added.
 assert.equal(accounts,0);assert.equal(advances,40);for(let i=0;i<40;i++)OldM.advance(p.b,p.rb,.1);await compare(p);
 await restoreFixture(p,state=>{state.economy.cash+=12345;});await check(p,.1);
 Oracle.equal(await M.borrowAsync(p.a,p.ra,1e8),OldM.borrow(p.b,1e8));await check(p,.2);
 Oracle.equal(await M.repayAsync(p.a,p.ra,p.a.economy.loans[0].id),OldM.repay(p.b,p.b.economy.loans[0].id));await check(p,.2);
 await restoreFixture(p,(state,saved)=>OldQ.finance(state,{minute:saved.minute,plan:state},123,57));await check(p,.2);
}
for(const cash of [5e9,.01]){
 const p=pair(1859.85,false,state=>{state.economy.cash=cash;state.economy.nextLoan=3;state.economy.loans=[1860,1860.035].map((nextDue,i)=>({id:i+1,initial:1e8,principal:1e8,interest:10,installment:1e8/30,nextDue}));});
 const actual=[],expected=[];for(let i=0;i<25;i++)actual.push(M.advanceBudget(p.a,p.ra,.1,{budget:1e6,maxSteps:10000}).running);for(let i=0;i<25;i++)expected.push(OldM.advance(p.b,p.rb,.1));exact(actual,expected);await compare(p);checks++;
}
// Native-owned daily values transmit only deltas, preserving arbitrary direct edits.
{
  const n = 151056,
    large = Array.from({
      length: n
    }, (_, i) => ({
      daily: 1e-8,
      purpose: 'work',
      back: !!(i % 2),
      hub: false,
      lineIds: ['a'],
      externalKind: null
    }));
  const original = Core.kernel,
    frames = [];
  Core.kernel = function(name, input, ...args) {
    if (name === 'simulation_run' && input[0] === 9) frames.push({
      bytes: input.byteLength,
      load: input[2]
    });
    return original(name, input, ...args);
  };
  try {
    const first = SIM.timedArrivals(large, {}, 480, 1, 0, 123, true);
    const second = SIM.timedArrivals(large, {}, 480, 1, 0, 123, true);
    exact(first, second);
    assert(frames.at(-1).bytes < 256);
    assert.equal(frames.at(-1).load, 0);
    large[123].daily = 500;
    large[n - 1].daily = 700;
    const actual = SIM.timedArrivals(large, {}, 480, 1, 0, 123, true);
    assert.equal(frames.at(-1).bytes, frames.at(-2).bytes + 32);
    exact(actual, OldSIM.timedArrivals(large, {}, 480, 1, 0, 123, true));
  } finally {
    Core.kernel = original;
  }
}
console.log(
  `MAP49 passed: ${checks} complete frozen MAP48 checkpoints; queue/finance transaction, next-clock reuse, mutable economy, credit, external statistics, sparse 151056-profile daily updates and forced recycling.`
);

}finally{closePairs();}})().catch(error=>{console.error(error);process.exitCode=1;});
