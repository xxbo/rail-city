/* Native forecast statistics; retain the public line/Map views. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports,native=()=>node?require('./diagnostics-wasm'):root.RailDiagnostics;
const all=(s,f)=>new Map(Object.entries(native().run(s,'stats',{}, {},f)));
const line=(s,f,id)=>all(s,f).get(id)||null;
const api={line,all};if(node)module.exports=api;else root.RailNetworkStats=api;
})(typeof globalThis!=='undefined'?globalThis:this);
