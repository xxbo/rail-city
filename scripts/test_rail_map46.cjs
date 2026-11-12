/* Exact MAP45 oracle: native operating statistics with sparse projections and external updates. */
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const P = require('../rail/passengers'),
  Q = require('../rail/ridership'),
  M = require('./helpers/management-compat.cjs'),
  D = require('../rail/demand-model'),
  X = require('../rail/service-plan'),
  Core = require('../rail/routing-wasm');
const OldP = require('./fixtures/rail-map45-passengers.cjs'),
  OldQ = require('./fixtures/rail-map45-ridership.cjs'),
  OldM = require('./fixtures/rail-map45-management.cjs');
const {
  create
} = require('./fixtures/rail-memory-grid.cjs');
let checks = 0,
  direct = 0;

function exact(a, b) {
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b),
    'serialized property order must remain stable');
}
// Standalone public statistics API remains Rust-backed, including unusual but supported event shapes.
{
  const a = create(2),
    b = structuredClone(a),
    ra = {
      minute: 420,
      plan: X.expand(a)
    },
    rb = {
      minute: 420,
      plan: X.expand(b)
    };
  const ids = a.services.map(l => l.id),
    trip = {
      lineIds: [ids[0], 'retired', ids[0]],
      fare: 123.4,
      byLine: {
        [ids[0]]: .37,
        [ids[1]]: .63
      }
    };
  for (const minute of [419.99999999, 420, 479.999, 480, 1379.9, 1859.99999999, 1860, 1921, 3300]) {
    ra.minute = rb.minute = minute;
    for (const kind of ['attempt', 'enter', 'board', 'alight', 'reject', 'complete', 'unknown'])
      for (const count of [.0001, 3, .2, -.01]) {
        Q.event(a, ra, trip, kind, count, 2.7, ids[0], 1);
        OldQ.event(b, rb, trip, kind, count, 2.7, ids[0], 1);
        exact(a.ridership, b.ridership);
        direct++;
      }
    const t = {
      service: ids[0],
      parentLine: ids[0],
      onboard: 3.2
    };
    Q.travel(a, ra, t, .003, {
      cars: 8
    });
    OldQ.travel(b, rb, t, .003, {
      cars: 8
    });
    exact(a.ridership, b.ridership);
    direct++;
  }
}

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

const H=require('./helpers/session-oracle.cjs'),Runtime=require('../rail/runtime-wasm');
function pair(start=480,weighted=false){return H.pair(()=>create(3),forecast,OldP,start,weighted);}
function check(p,dt,managed=false){H.advance(p,OldM,dt);checks++;}
for (const weighted of [false, true]) {
  const p = pair(480, weighted);
  for (let i = 0; i < 100; i++) check(p, .2, i % 2 === 0);
  // External events and fare edits invalidate only the relevant native statistic inputs.
  H.fixture(p,(state,saved,index)=>{const lib=index?OldQ:Q;lib.event(state,{...saved,plan:X.expand(state)},saved.urbanDefs[0],'reject',.1);});
  for (let i = 0; i < 30; i++) check(p, .2, true);
  H.edit(p,OldM,{kind:'network',op:'configure',args:{id:p.a.services[0].id,values:{fareBands:[400,500,600,700,800,900]}}});H.demand(p,forecast);
  for (let i = 0; i < 30; i++) check(p, .2, true);
  // Hour trimming, records and bucket transitions use the same operation order.
  check(p, 70, true);
}
for (const start of [419.9, 479.9, 1379.9, 1439.9, 1859.9]) {
  const p = pair(start);
  for (let i = 0; i < 12; i++) check(p, .1, true);
}
const batchOnly = pair();
const standalone=Core.status().statisticsCalls;M.advance(batchOnly.a,batchOnly.ra,60);assert.equal(Core.status().statisticsCalls,standalone,'owned hot advance makes no host statistics calls');OldM.advance(batchOnly.b,batchOnly.rb,60);H.compare(batchOnly);checks++;
// A busy line removal must use one statistics batch rather than one native call per rejected cohort.
const removed = pair(480, true);
check(removed, 4);
assert(P.summary(removed.ra).waiting > 0);
for(const line of [...removed.a.services])H.edit(removed,OldM,{kind:'network',op:'removeLine',args:{id:line.id}});
assert.equal(Runtime.querySync(removed.ra,'storage').hostCommandValues,0,'owned rejection accounting stays inside Rust');H.compare(removed);
check(removed, 5);
const bytes = fs.readFileSync(path.join(__dirname, '../rail/wasm/rail-core-v33.wasm'));
H.closeAll();Core.create(bytes, {
  recycleBytes: 0
});
const recovery = pair();
for (let i = 0; i < 12; i++) check(recovery, .2, true);
H.closeAll();Core.create(bytes, {
  recycleBytes: 64 * 1024 * 1024
});
const source = fs.readFileSync(path.join(__dirname, '../rail/queue-runtime.js'), 'utf8');
assert(!source.includes('Q.event('));
assert(!source.includes('Q.travel('));
const qSource = fs.readFileSync(path.join(__dirname, '../rail/ridership.js'), 'utf8');
assert(!qSource.includes('d.attempted += count'));
assert(!qSource.includes('const revenue = count * (j.fare'));
assert.equal(Core.status().statisticsAbi, 1);
console.log(
  `MAP46 passed: ${direct} exact standalone event/travel comparisons and ${checks} complete MAP45 checkpoints; property order, fractional cohorts, hours/days/bins, finance interleaving, external edits, rebase and forced native recovery. Hot queue events make no per-event JS statistics calls.`
);

H.closeAll();
