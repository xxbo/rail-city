/* Versioned Rust-owned model configuration; getters expose a read-only view. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports,api={};
for(const key of ['VERSION','TRACK','STATION','CAR','OPERATING_FACTOR','GRANT_RATE','HUB_CAPTURE_MAX','HUB_MARKET_SCALE'])Object.defineProperty(api,key,{enumerable:true,get:()=>(node?require('./bootstrap-wasm'):root.RailBootstrap).settings().balance[key]});
Object.freeze(api);if(node)module.exports=api;else root.RailBalance=api;
})(typeof globalThis!=='undefined'?globalThis:this);
