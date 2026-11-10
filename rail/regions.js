/* Region configuration and geographic model transforms are owned by Rust. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports,B=()=>node?require('./bootstrap-wasm'):root.RailBootstrap;
const api={get all(){return B().settings().regions;},get:(id='tokyo')=>B().settings().regions[id]||B().settings().regions.tokyo,project:(lat,lon,id='tokyo')=>B().run('project',{lat,lon,region:id}),latLon:(p,id='tokyo')=>B().run('latLon',{...p,region:id})};
if(node)module.exports=api;else root.RailRegions=api;
})(typeof globalThis!=='undefined'?globalThis:this);
