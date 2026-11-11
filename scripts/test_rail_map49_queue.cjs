/* Frozen MAP44 oracle for native queue ownership and ordered event continuation. */
const assert = require('node:assert/strict'),
  fs = require('node:fs');
const P = require('../rail/passengers'),
  Old = require('./fixtures/rail-map48-passengers.cjs');
const M = require('./helpers/management-compat.cjs'),
  OldM = require('./fixtures/rail-map48-management.cjs');
const N = require('../rail/network'),
  D = require('../rail/demand-model'),
  Core = require('../rail/routing-wasm');
const {
  create
} = require('./fixtures/rail-memory-grid.cjs');
const H=require('./helpers/session-oracle.cjs'),Oracle=require('./helpers/native-oracle.cjs');
let checkpoints = 0,
  resumes = 0;
const kernel = Core.kernel;
Core.kernel = function(name, input, ...rest) {
  if (name === 'engine_step' && input[4] === 1) resumes++;
  return kernel(name, input, ...rest);
};

function forecast(s) {
  const cells = s.nodes.map((n, i) => ({
    id: 'c' + i,
    x: n.x,
    y: n.y,
    w: 8,
    h: 8,
    area: .13,
    people: 3000000,
    jobs: 2000000,
    shops: 1000000,
    industry: 500,
    leisure: 10000
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

function pair(weighted=false){return H.pair(()=>create(3),forecast,Old,480,weighted);}
function step(p,dt){H.advance(p,OldM,dt);const v=P.summary(p.ra);assert(Math.abs(v.generated-v.completed-v.cancelled-v.waiting-v.onboard)<1e-5);checkpoints++;}

for (const weighted of [false, true]) {
  const p = pair(weighted);
  for (let i = 0; i < 90; i++) step(p, .5);
  assert(p.ra.rejected > 0);
  assert(p.ra.completed > 0);
  // Editing a populated network retains incumbent fares and retires old train geometry.
  H.edit(p,OldM,{kind:'network',op:'removeStation',args:{id:p.a.services[0].id,nodeId:p.a.services[0].stops[1]}});
  for (let i = 0; i < 50; i++) step(p, .5);
  H.edit(p,OldM,{kind:'network',op:'removeLine',args:{id:p.a.services[2].id}});
  for (let i = 0; i < 40; i++) step(p, .5);
  // Full archive replacement triggers a native reload without resetting queues or counters.
  H.demand(p,forecast);
  for (let i = 0; i < 20; i++) step(p, .5);H.close(p);
}
const bytes = fs.readFileSync(require('node:path').join(__dirname,
  '../rail/wasm/rail-core-v33.wasm'));
H.closeAll();Core.create(bytes, {
  recycleBytes: 0
});
const recovery = pair();
for (let i = 0; i < 20; i++) step(recovery, .5);
H.edit(recovery,OldM,{kind:'network',op:'removeLine',args:{id:recovery.a.services[0].id}});
for (let i = 0; i < 30; i++) step(recovery, .5);
H.closeAll();Core.create(bytes, {
  recycleBytes: 64 * 1024 * 1024
});
assert(H.metrics.nativeReroutes>0,'owned Rust queue must execute actual reroutes');
console.log(
  `MAP49 queue integration: ${checkpoints} complete states, ${H.metrics.nativeReroutes} native reroutes, edits/rebase/weighted arrivals and forced native recovery.`
  );

H.closeAll();
