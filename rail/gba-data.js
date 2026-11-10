/* Raw GBA observations/polygons and derived geography are owned by Rust. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports,B=()=>node?require('./bootstrap-wasm'):root.RailBootstrap;
const api={create:()=>B().readonly(B().view('city','gba')),get hubs(){return B().view('hubs','gba');},land:(lon,lat)=>B().run('land',{lon,lat})};
for(const key of ['cities','estuary','islandPolys','populationSource'])Object.defineProperty(api,key,{enumerable:true,get:()=>B().view('gbaSource','gba')[key]});
if(node)module.exports=api;else root.RailGBA=api;
})(typeof globalThis!=='undefined'?globalThis:this);
