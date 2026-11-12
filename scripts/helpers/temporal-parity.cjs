/* Compare each frozen migration baseline with the current temporal and arrival APIs. */
const assert = require('node:assert/strict');
const City = require('../../rail/city');
const Fleet = require('../../rail/fleet');
const Simulation = require('../../rail/simulation-wasm');

const exact = (a, b) => {
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
};

function checkTemporalParity({city, fleet, ridership, simulation}) {
  let profiles = 0,
    fleets = 0,
    samples = 0;
  const mins = [...Array.from({
    length: 1440
  }, (_, i) => i), ...[-1440, -1, 0, 300, 360, 420, 540, 600, 720, 840, 960, 1020, 1140, 1260,
    1320, 1440, 1860
  ].flatMap(m => [m - 1e-9, m - Number.EPSILON * 512, m, m + 1e-9]), NaN, Infinity, -Infinity];
  for (const minute of mins) {
    assert.equal(Fleet.peak(minute), fleet.peak(minute));
    for (const p of ['work', 'shopping', 'leisure', 'other'])
      for (const back of [false, true])
        for (const ext of [null, '', 'staff-homebound', 'staff-outbound', 'staff-unknown',
            'local-departure', 'visitor-return', 'visitor-arrival', 'unknown'
          ]) {
          assert.equal(City.profile(p, back, minute, ext), city.profile(p, back, minute, ext));
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
          assert.equal(Fleet.planned(l, minute), fleet.planned(l, minute));
          exact(Fleet.allocations(l, minute), fleet.allocations(l, minute));
          fleets++;
        }
        l.dispatch.manual = 20;
        l.dispatch.peak = 24;
        l.patterns[0].fleet += 2;
        exact(Fleet.allocations(l, 420), fleet.allocations(l, 420));
        assert.equal(Fleet.planned(l, 420), fleet.planned(l, 420));
        const copy = Fleet.allocations(l, 420);
        copy[0] = 999;
        exact(Fleet.allocations(l, 420), fleet.allocations(l, 420));
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
  const s = {};
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
        const a = Simulation.timedArrivals(catalog, s, minute, dt, .37, 2463534242, true);
        const b = simulation.arrivals(catalog, j => ridership.factor(s, j), j => city.profile(j.purpose, j
          .back, minute, j.externalKind) * dt, .37, 2463534242);
        exact(a, b);
        samples++;
        const weighted = Simulation.timedArrivals(catalog, s, minute, dt, .37, 2463534242, false);
        const expected = [];
        catalog.forEach((j, i) => {
          const v = j.daily * (city.profile(j.purpose, j.back, minute, j.externalKind) * dt);
          if (v >= 1e-12) expected.push(i, v);
        });
        exact(Array.from(weighted.events), expected);
        samples++;
      }
  }
  // Daily values remain mutable between calls, even when itinerary/group metadata is cached.
  catalog[0].daily = 500;
  exact(Simulation.timedArrivals(catalog, s, 420, 1, 0, 123, true), simulation.arrivals(catalog, j => ridership
    .factor(s, j), j => city.profile(j.purpose, j.back, 420, j.externalKind), 0, 123));
  return {catalog, profiles, fleets, samples};
}

module.exports = {checkTemporalParity, exact};
