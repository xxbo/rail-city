/* Native operational choices; titles, rounding and Chinese text are presentation only. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports,native=()=>node?require('./diagnostics-wasm'):root.RailDiagnostics;
const message={
 add:a=>['建议增加投放',`最忙断面高峰需求约 ${Math.round(a[0])} 人/小时；按80%负荷及高峰8分钟、平峰12分钟服务目标，高峰 ${a[1]}→${a[2]} 列、平峰 ${a[3]}→${a[4]} 列。`],
 reduce:a=>['可收回富余配车',`预测最忙断面高峰 ${Math.round(a[0])}%、平峰 ${Math.round(a[1])}%；建议平峰 ${a[2]}→${a[3]} 列，高峰 ${a[4]}→${a[5]} 列。`],
 crowd:a=>['实时满载并积压',`在线最高满载 ${Math.round(a[0])}%，本线站台候车 ${Math.round(a[1])} 人；优先检查积压区段与交路分配。`],
 station:a=>['共站站外排队',`本线所经车站合计有 ${Math.round(a[0])} 人在站外等候，可能涉及其他线路；请检查具体车站及换乘瓶颈。`],
 stock:a=>['兼容库存不足',`${a[0]} 最多可配属 ${a[1]} 列，建议高峰 ${a[2]} 列，缺口 ${a[3]} 列；可先收回其他线路闲置配属。`],
 duplicate:a=>['可合并重复交路',`第 ${a[0]} 个交路与第 ${a[1]} 个停站、端点完全相同，可合并以简化调度。`],
 'low-pattern':a=>['复核低使用交路',`第 ${a[0]} 个交路仅占本线交路使用量 ${a[1].toFixed(1)}%；保留全程普通车，先评估合并。`],
 short:a=>['考虑增加小交路',`「${a[0]}—${a[1]}」集中主要断面需求，外段较弱；小交路可把车辆集中到繁忙区间。`],
 express:a=>['考虑快速交路',`约 ${Math.round(a[0])}% 本线出行跨越六成以上里程；快速车草案保留两端及主要客流站，全程普通车继续覆盖其余车站。`],
 observe:()=>['等待需求形成','当前预测中没有可分配到本线的OD路径，暂不据此减车；检查投放、目的地接驳和线路连通性。'],
 quality:a=>['服务满意度偏低',`满意度 ${Math.round(a[0])} 分；查看候车、票价、覆盖和拥挤分项，避免只靠加车处理全部问题。`]
};
function project(s,rows){return rows.map(r=>{const suggestions=r.suggestions.map(v=>{const [title,reason]=message[v.type](v.args),{args,...extra}=v;return {key:v.key,type:v.type,title,reason,priority:v.priority,...Object.fromEntries(Object.entries(extra).filter(([k])=>!['key','type','priority'].includes(k)))};});return {id:r.id,l:s.services.find(l=>l.id===r.id),stats:r.stats,suggestions,...Object.fromEntries(Object.entries(r).filter(([k])=>!['id','l','stats','suggestions'].includes(k)))};});}
function analyze(s,f,rt){return project(s,native().run(s,'analyze',{},rt,f));}
function bundle(s,f,rt){const out=native().run(s,'diagnose',{},rt,f);return {rows:project(s,out.rows),metrics:out.metrics};}
const signature=l=>native().run({},'signature',{line:l}),resize=(patterns,total)=>native().run({},'resize',{patterns,total}),dispatchValues=(line,offPeak,peak)=>native().run({},'dispatch',{line,offPeak,peak}),capacity=(s,line,minute,prepared)=>new Map(native().run(s,'capacity',{line,minute,prepared})),peakRatio=(d,c,share)=>native().run({},'ratio',{demand:[...d],capacity:[...c],share}),preview=(s,row)=>native().run(s,'preview',{row});
const api={project,analyze,bundle,preview,signature,dispatchValues,resize,capacity,peakRatio,PEAK:.18,OFF:.06,TARGET:.8};if(node)module.exports=api;else root.RailOperationsCenter=api;
})(typeof globalThis!=='undefined'?globalThis:this);
