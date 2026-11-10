/* Native network and forecast aggregates, projected for the UI. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports;
const api={summary:(s,f)=>(node?require('./diagnostics-wasm'):root.RailDiagnostics).run(s,'metrics',{}, {},f)};
if(node)module.exports=api;else root.RailMetrics=api;
})(typeof globalThis!=='undefined'?globalThis:this);
