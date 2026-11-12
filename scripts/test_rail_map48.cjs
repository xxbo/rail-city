/* MAP47 frozen temporal/continuous oracle. Exact state and insertion order, not approximate totals. */
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const SIM = require('../rail/simulation-wasm'),
  Core = require('../rail/routing-wasm');
const OldC = require('./fixtures/rail-map47-city.cjs'),
  OldF = require('./fixtures/rail-map47-fleet.cjs'),
  OldQ = require('./fixtures/rail-map47-ridership.cjs'),
  OldSIM = require('./fixtures/rail-map47-simulation-wasm.cjs');
const P = require('../rail/passengers'),
  OldP = require('./fixtures/rail-map47-passengers.cjs'),
  OldM = require('./fixtures/rail-map47-management.cjs');
const N = require('../rail/network'),
  D = require('../rail/demand-model'),
  LS = require('../rail/local-save'),
  {
    create
  } = require('./fixtures/rail-memory-grid.cjs');
const {checkTemporalParity, exact} = require('./helpers/temporal-parity.cjs');
const {catalog, profiles, fleets, samples} = checkTemporalParity({city: OldC, fleet: OldF, ridership: OldQ, simulation: OldSIM});
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

const H=require('./helpers/session-oracle.cjs');
function pair(start=480,weighted=false,prepare=()=>{}){return H.pair(()=>create(3),forecast,OldP,start,weighted,prepare);}
function check(p,dt,managed=true){H.advance(p,OldM,dt);checks++;}
function dispatch(p,values){for(const line of [...p.a.services])H.edit(p,OldM,{kind:'network',op:'configure',args:{id:line.id,values:{dispatch:values}}});}
for(const weighted of [false,true]){
 const p=pair(419.9,weighted);for(let i=0;i<40;i++)check(p,.2,i%2===0);
 dispatch(p,{mode:'auto',manual:8,offPeak:4,peak:8});for(let i=0;i<30;i++)check(p,.3);
 H.fixture(p,state=>{delete state.ridership.model;for(const row of Object.values(state.ridership.lines)){row.awareness=.43;row.trust=.7;}});check(p,70);
 const loaded=LS.parse(JSON.stringify(LS.pack(p.a,P.snapshot(p.ra)))),restored=P.restore(loaded.state,p.f,loaded.runtime);assert(restored);P.dispose(restored);H.close(p);
}
for(const start of [539.9,1019.9,1139.9,1379.9,1439.9,1859.9]){const p=pair(start);dispatch(p,{mode:'auto',manual:8,offPeak:4,peak:8});for(let i=0;i<15;i++)check(p,.1);H.close(p);}
for(const start of [419.9,1139.9]){const p=pair(start,false,state=>{for(const line of state.services)assert(!N.configure(state,line.id,{dispatch:{mode:'auto',manual:8,offPeak:0,peak:8}}).error);});for(let i=0;i<20;i++)check(p,.2);H.close(p);}
// A previously absent line can become available without rebuilding group metadata.
const s = {
  ridership: {
    model: 22,
    lines: {missing: {satisfaction: .1, awareness: .4, trust: .6}}
  }
};
exact(SIM.timedArrivals(catalog, s, 1020, 1, .2, 99, true), OldSIM.arrivals(catalog, j => OldQ
  .factor(s, j), j => OldC.profile(j.purpose, j.back, 1020, j.externalKind), .2, 99));
const bytes = fs.readFileSync(path.join(__dirname, '../rail/wasm/rail-core-v33.wasm'));
H.closeAll();Core.create(bytes, {
  recycleBytes: 0
});
const recovery = pair();
for (let i = 0; i < 10; i++) check(recovery, .2);
H.closeAll();Core.create(bytes, {
  recycleBytes: 64 * 1024 * 1024
});
assert.equal(Core.status().temporalAbi, 1);
const source = fs.readFileSync(path.join(__dirname, '../rail/passengers.js'), 'utf8');
assert(!source.includes('C.profile('));
assert(!source.includes('Q.factor('));
assert(!source.includes('F.allocations('));

// Enforce a real host-buffer budget independently of the native arena and catalog objects.
const probe = require('node:child_process').spawnSync(process.execPath,
  ['--expose-gc', path.join(__dirname, 'fixtures/rail-temporal-memory.cjs')], {
    encoding: 'utf8',
    timeout: 30000
  });
assert.equal(probe.status, 0, probe.stderr);
const memory = JSON.parse(probe.stdout);
assert(memory.arrayBufferGrowth <= memory.profiles * 20 + 65536,
  '151056-profile transport retained redundant full-size buffers');
console.log(
  `MAP48 passed: ${profiles} exact profile comparisons, ${fleets} fleet phases, ${samples} fused samplers, ${checks} complete frozen MAP47 checkpoints; auto/manual shifts, legacy factors, weighted/integer flows, mutable daily demand, save restore and native recovery.`
);

H.closeAll();
