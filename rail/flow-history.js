/* Bounded, actual passenger counts per operating day. Missing history stays missing. */
(function(root) {
  'use strict';
  const History = typeof module !== 'undefined' && module.exports ? require('./history-wasm') : root.RailHistory;
  const FIELDS = ['entered', 'boarded', 'completed'];

  function view(d, field = 'entered', interval = 15) {
    if (!FIELDS.includes(field)) field = 'entered';
    if (![15, 30, 60].includes(interval)) interval = 15;
    return History.view(d, field, interval);
  }
  const api = { FIELDS, view };
  if (typeof module !== 'undefined' && module.exports) {
    // Historical statistics fixtures still mutate day records synchronously.
    module.exports = { ...require('../scripts/fixtures/rail-map56-flow-history.cjs'), ...api };
  } else root.RailFlowHistory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
