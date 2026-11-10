/* Demand needs network/city inputs, not checkpoint histories or operating ledgers. */
(function(root) {
  'use strict';

  function capture(state) {
    return (typeof module!=='undefined'&&module.exports?require('./bootstrap-wasm'):root.RailBootstrap).forecast('snapshot',{state});
  }
  const api = {
    capture
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RailDemandSnapshot = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
