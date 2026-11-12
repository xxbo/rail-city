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
const OldP = require('./fixtures/rail-map46-passengers.cjs'),
  OldQ = require('./fixtures/rail-map46-ridership.cjs'),
  OldM = require('./fixtures/rail-map46-management.cjs');
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

const H=require('./helpers/session-oracle.cjs'),Oracle=require('./helpers/native-oracle.cjs'),Runtime=require('../rail/runtime-wasm');
function pair(start=480,weighted=false,prepare=()=>{}){return H.pair(()=>create(3),forecast,OldP,start,weighted,prepare);}
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

// Satisfaction: pure query, zero-duration refresh, disconnected/through lines, crowded trains and legacy decay.
for (const model of [undefined, 22]) {
  const p = pair(480,false,s=>{
    if (model === undefined) delete s.ridership.model;
    else s.ridership.model = model;
    delete s.urban;require('../rail/urban-growth').init(s);s.urban.lastMinute=480;
    Object.assign(s.urban,{
      facilities: [{
        kind: 'school',
        level: 1,
        x: s.nodes[0].x,
        y: s.nodes[0].y
      }, {
        kind: 'hospital',
        level: 2,
        x: s.nodes.at(-1).x,
        y: s.nodes.at(-1).y
      }]
    });
  });
  for (let i = 0; i < 10; i++) {
    check(p, .3);
    for (let j = 0; j < p.a.services.length; j++) exact(Q.feedback(p.a, p.ra, p.a.services[j]), OldQ
      .feedback(p.b, p.rb, p.b.services[j]));
    H.fixture(p,(state,saved,index)=>(index?OldQ:Q).updateSatisfaction(state,{...saved,plan:X.expand(state)},i===0?0:5));
    Oracle.world(p.a,p.b);
  }
}
// Finance boundaries: fractional due times, overdue bills, zero cash, arrears, multi-day loans and save restore.
for (const scenario of ['due', 'overdue', 'arrears', 'exhaust', 'all-paid', 'multi']) {
  const p = pair(1859.95,false,s=>{
    s.economy.minute = 1859.95;
    s.economy.loans = [{
      id: 1,
      initial: 1e8,
      principal: 1e8,
      interest: 111.5,
      installment: 1e8 / 30,
      nextDue: scenario === 'overdue' ? 420 : 1860
    }];
    if (scenario === 'all-paid') {
      s.economy.loans[0].principal = .0009;
      s.economy.cash = 0;
    }
    if (scenario === 'arrears') {
      s.economy.arrears = 1e7;
      s.economy.cash = 99;
      s.economy.blocked = true;
    }
    if (scenario === 'exhaust') s.economy.cash = .01;
    if (scenario === 'multi') s.economy.loans.push({
      id: 2,
      initial: 2e8,
      principal: 1e8,
      interest: 20,
      installment: 2e8 / 30,
      nextDue: 1860.035
    });
  });
  for (let i = 0; i < 12; i++) check(p, .1, true);
  const running=[];H.fixture(p,(state,saved,index)=>running[index]=(index?OldM:M).settle(state));assert.equal(...running);
  Oracle.world(p.a,p.b);

}
for (const minutes of [0, 1e-10, 1e-9, 1.1e-9, .0999999999999, .1, .1000000000001, 1.234567]) check(
  pair(), minutes, true);

// Public credit actions use the same native debt rules as automatic repayment.
{
  const a = create(2),
    b = structuredClone(a);
  for (const amount of [NaN, Infinity, '100000000', [1e8], null, -1, 0, 99999999, 1e8, 2e8, 1e9, 1e9]) {
    exact(M.borrow(a, amount), OldM.borrow(b, amount));
    exact(a, b);
    assert.equal(M.available(a), OldM.available(b));
    exact(a, b);
  }
  for (const id of [999, 2, 1, 3]) {
    exact(M.repay(a, id), OldM.repay(b, id));
    exact(a, b);
  }
  for (const x of [a, b]) {
    x.economy.cash = 0;
    x.economy.arrears = 500;
  }
  exact(M.borrow(a, 1e8), OldM.borrow(b, 1e8));
  exact(a, b);
  exact(M.repay(a, a.economy.loans[0].id), OldM.repay(b, b.economy.loans[0].id));
  exact(a, b);
}
assert.equal(Core.status().operationsAbi, 1);
console.log(
  `MAP47 passed: ${direct} event comparisons, ${checks} complete checkpoints, pure feedback/smoothing/coverage, shared fractional clock, debt/credit/arrears/stop boundaries and forced module recovery.`
  );

H.closeAll();
