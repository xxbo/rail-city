/* Gazetteer and naming decisions execute in Rust. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports,B=()=>node?require('./bootstrap-wasm'):root.RailBootstrap,E=()=>node?require('./editor-wasm'):root.RailEditor;
const api={places:region=>B().view('places',region),suggest:(s,p,seed=B().run('random'),except=null)=>E().query(s,'suggestName',{point:p,seed,except}),migrate:s=>E().mutate(s,'migrateNames')};
if(node)module.exports=api;else root.RailPlaceNames=api;
})(typeof globalThis!=='undefined'?globalThis:this);
