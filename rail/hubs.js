/* Observations are static Rust data; model splits/conversions execute in Rust. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports,B=()=>node?require('./bootstrap-wasm'):root.RailBootstrap;
const api={forRegion:(region='tokyo')=>B().view('hubs',region),get list(){return B().view('hubs','tokyo');},daily:h=>B().run('hubDaily',{hub:h}),envelope:h=>B().run('hubEnvelope',{hub:h}),access:h=>B().run('hubAccess',{hub:h}),project:(lat,lon)=>B().run('project',{lat,lon,region:'tokyo'}),share:(h,args,kind)=>(node?require('./demand-kernels'):root.RailDemandKernels).hubShare(api.access(h).railReference,args,kind)};
if(node)module.exports=api;else root.RailHubs=api;
})(typeof globalThis!=='undefined'?globalThis:this);
