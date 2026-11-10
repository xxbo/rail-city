/* Source bytes/attribution are embedded as versioned Rust data assets. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports;const read=()=>{const B=node?require('./bootstrap-wasm'):root.RailBootstrap,d=B.view('tokyoSource');d.raw=Uint8Array.from(d.raw);return d;};
if(node)module.exports=read();else root.RailDataReady=root.RailRoutingReady.then(()=>{root.RailCityData=read();});
})(typeof globalThis!=='undefined'?globalThis:this);
