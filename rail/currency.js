/* Fixed game denomination, not a live foreign-exchange rate. Old saves keep their purchasing power. */
(function(root) {
  'use strict';
  const SCALE = .05;
  const model=(kind,value)=>(typeof module!=='undefined'&&module.exports?require('./bootstrap-wasm'):root.RailBootstrap).viewModel(kind,{value});
  const toCNY = n => model('currencyTo',n),fromCNY = n => model('currencyFrom',n);

  function format(n) {
    const v = toCNY(n),
      a = Math.abs(v);
    return (v < 0 ? '−' : '') + '¥' + (a >= 1e8 ? (a / 1e8).toFixed(2) + ' 亿' : a >= 1e4 ? (a / 1e4)
      .toFixed(1) + ' 万' : a.toLocaleString('zh-CN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }));
  }
  const api = {
    SCALE,
    toCNY,
    fromCNY,
    format
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RailCurrency = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
