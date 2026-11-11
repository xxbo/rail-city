/* MAP47 frozen temporal/continuous oracle. Exact state and insertion order, not approximate totals. */
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const T = require('../rail/temporal-wasm'),
  C = require('../rail/city'),
  F = require('../rail/fleet'),
  Q = require('../rail/ridership'),
  SIM = require('../rail/simulation-wasm'),
  Core = require('../rail/routing-wasm');
const OldC = require('./fixtures/rail-map47-city.cjs'),
  OldF = require('./fixtures/rail-map47-fleet.cjs'),
  OldQ = require('./fixtures/rail-map47-ridership.cjs'),
  OldSIM = require('./fixtures/rail-map47-simulation-wasm.cjs');
const P = require('../rail/passengers'),
  M = require('./helpers/management-compat.cjs'),
  OldP = require('./fixtures/rail-map47-passengers.cjs'),
  OldM = require('./fixtures/rail-map47-management.cjs');
const N = require('../rail/network'),
  X = require('../rail/service-plan'),
  D = require('../rail/demand-model'),
  LS = require('../rail/local-save'),
  {
    create
  } = require('./fixtures/rail-memory-grid.cjs');
const exact = (a, b) => {
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
};
let profiles = 0,
  fleets = 0,
  samples = 0,
  checks = 0;
const mins = [...Array.from({
  length: 1440
}, (_, i) => i), ...[-1440, -1, 0, 300, 360, 420, 540, 600, 720, 840, 960, 1020, 1140, 1260,
  1320, 1440, 1860
].flatMap(m => [m - 1e-9, m - Number.EPSILON * 512, m, m + 1e-9]), NaN, Infinity, -Infinity];
for (const minute of mins) {
  assert.equal(F.peak(minute), OldF.peak(minute));
  for (const p of ['work', 'shopping', 'leisure', 'other'])
    for (const back of [false, true])
      for (const ext of [null, '', 'staff-homebound', 'staff-outbound', 'staff-unknown',
          'local-departure', 'visitor-return', 'visitor-arrival', 'unknown'
        ]) {
        assert.equal(C.profile(p, back, minute, ext), OldC.profile(p, back, minute, ext));
        profiles++;
      }
}
for (const managed of [false, true])
  for (const mode of ['manual', 'auto'])
    for (const weights of [
        [8],
        [1, 1, 1],
        [6, 2],
        [0, 0],
        [2, 4, 6, 8]
      ]) {
      const l = {
        fleetManaged: managed,
        fleet: 16,
        dispatch: {
          mode,
          manual: 10,
          offPeak: 8,
          peak: 16
        },
        patterns: weights.map(fleet => ({
          fleet
        }))
      };
      for (const minute of [419.99999999999994, 419.3, 420, 539.99, 540, 1019.9, 1020, 1139.9,
          1140
        ]) {
        assert.equal(F.planned(l, minute), OldF.planned(l, minute));
        exact(F.allocations(l, minute), OldF.allocations(l, minute));
        fleets++;
      }
      l.dispatch.manual = 20;
      l.dispatch.peak = 24;
      l.patterns[0].fleet += 2;
      exact(F.allocations(l, 420), OldF.allocations(l, 420));
      assert.equal(F.planned(l, 420), OldF.planned(l, 420));
      const copy = F.allocations(l, 420);
      copy[0] = 999;
      exact(F.allocations(l, 420), OldF.allocations(l, 420));
    }
const catalog = Array.from({
  length: 100
}, (_, i) => ({
  daily: i * .013 + 1e-6,
  purpose: ['work', 'shopping', 'leisure'][i % 3],
  back: i % 2 === 0,
  hub: i % 4 === 0,
  externalKind: [null, 'staff-homebound', 'staff-outbound', 'local-departure',
    'visitor-return', 'visitor-arrival'
  ][i % 6],
  lineIds: i % 4 === 0 ? [] : i % 4 === 1 ? ['a', 'missing'] : ['b', 'a']
}));
const s = {
  ridership: {
    model: 22,
    lines: {
      a: {
        satisfaction: .63,
        awareness: .6,
        trust: .9
      },
      b: {
        satisfaction: .82,
        awareness: .4,
        trust: .8
      }
    }
  }
};
for (const model of [22, 1, 0]) {
  if (model === 0) delete s.ridership;
  else {
    s.ridership = {
      model,
      lines: {
        a: {
          satisfaction: .63,
          awareness: .6,
          trust: .9
        },
        b: {
          satisfaction: .82,
          awareness: .4,
          trust: .8
        }
      }
    };
  }
  for (const minute of [419.999, 420, 539.99, 540, 1020, 1140, 1440, 1860])
    for (const dt of [1, 3]) {
      const a = SIM.timedArrivals(catalog, s, minute, dt, .37, 2463534242, true);
      const b = OldSIM.arrivals(catalog, j => OldQ.factor(s, j), j => OldC.profile(j.purpose, j
        .back, minute, j.externalKind) * dt, .37, 2463534242);
      exact(a, b);
      samples++;
      const weighted = SIM.timedArrivals(catalog, s, minute, dt, .37, 2463534242, false);
      const expected = [];
      catalog.forEach((j, i) => {
        const v = j.daily * (OldC.profile(j.purpose, j.back, minute, j.externalKind) * dt);
        if (v >= 1e-12) expected.push(i, v);
      });
      exact(Array.from(weighted.events), expected);
      samples++;
    }
}
// Daily values remain mutable between calls, even when itinerary/group metadata is cached.
catalog[0].daily = 500;
exact(SIM.timedArrivals(catalog, s, 420, 1, 0, 123, true), OldSIM.arrivals(catalog, j => OldQ
  .factor(s, j), j => OldC.profile(j.purpose, j.back, 420, j.externalKind), 0, 123));

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
s.ridership = {
  model: 22,
  lines: {
    missing: {
      satisfaction: .1,
      awareness: .4,
      trust: .6
    }
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
