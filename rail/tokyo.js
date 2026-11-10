/* Rust-owned Tokyo seed world; API kept for historical callers. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports,B=()=>node?require('./bootstrap-wasm'):root.RailBootstrap;
const api={create:()=>B().run('tokyoSeed'),project:(lon,lat)=>B().run('tokyoProject',{lon,lat}),get world(){return B().view('tokyoWorld');}};
if(node)module.exports=api;else root.TokyoRegion=api;
})(typeof globalThis!=='undefined'?globalThis:this);
