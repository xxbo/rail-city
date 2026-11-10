/* Native alert thresholds and ordering, with display-only messages. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports;
function evaluate(s,rt){return (node?require('./diagnostics-wasm'):root.RailDiagnostics).run(s,'alerts',{},rt).map(v=>{const {messageCode,capacity,...row}=v;const messages={outside:()=>`站内 ${Math.round(v.inside)} / ${capacity} 人，站外 ${Math.round(v.outside)} 人等候`,station:()=>`候车占用 ${Math.round(v.ratio*100)}%，接近站台容量`,idle:()=> '有候车客流但未投放列车',line:()=>`最高满载 ${Math.round(v.ratio*100)}%，候车 ${Math.round(v.waiting)} 人`,clearance:()=>`最高满载 ${Math.round(v.ratio*100)}%，候车 ${Math.round(v.waiting)} 人，理论疏散约 ${Math.ceil(v.clearance)} 分钟`};return Object.fromEntries([...Object.entries(row).slice(0,5),['message',messages[messageCode]()],...Object.entries(row).slice(5)]);});}
const api={evaluate};if(node)module.exports=api;else root.RailAlerts=api;
})(typeof globalThis!=='undefined'?globalThis:this);
