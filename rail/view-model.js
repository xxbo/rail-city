/* Detached read-only panel projections. Only labels and text formatting live here. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports;
const query=(kind,args={})=>(node?require('./bootstrap-wasm'):root.RailBootstrap).viewModel(kind,args);
const labels=Object.freeze({crowding:'拥挤舒适度',waiting:'候车与频率',speed:'速度与绕行',coverage:'目的地覆盖',fare:'票价合理性',reliability:'服务可靠性',hours:'运营时段'});
const api={query,labels};if(node)module.exports=api;else root.RailViewModel=api;
})(typeof globalThis!=='undefined'?globalThis:this);
