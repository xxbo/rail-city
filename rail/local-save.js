/* Browser-local JSON interchange. Format acceptance and model rules execute in Rust. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports;
const native=()=>node?require('./save-wasm'):root.RailSave,FORMAT='rail-local-save',VERSION=1,MAX_BYTES=64*1024*1024;
const records=(v={})=>native().run('records',{value:v});
function pack(state,runtime,settings={}){return {format:FORMAT,formatVersion:VERSION,appVersion:65,exportedAt:new Date().toISOString(),region:state.region,gameVersion:7,state,runtime,signature:(node?require('./management'):root.RailManagement).signature(state),speed:[1,3,6,12,24].includes(settings.speed)?settings.speed:6,playing:!!settings.playing,personalRecords:records(settings.personalRecords),runtimeVersion:1};}
const errors=[null,'存档结构过大或嵌套过深。','存档包含无效数值。','不是有效的游戏存档。','不支持此存档格式或版本。','仅支持第7代游戏存档。','地图标识无效或不一致。','存档中的线网、城市、财务或满意度数据校验失败，当前进度未改变。','存档运行数据与线网版本不匹配，当前进度未改变。','存档中的运行数据或乘客关联校验失败，当前进度未改变。'];
function parse(text){if(typeof text!=='string'||text.length>MAX_BYTES)throw Error('请选择64MB以内的JSON存档。');let v;try{v=JSON.parse(text,(k,v)=>{if(['__proto__','prototype','constructor'].includes(k))throw Error('不支持的字段');return v;});}catch{throw Error('无法解析JSON，请选择游戏导出的完整存档文件。');}
const code=native().run('accept',{value:v});if(code)throw Error(errors[code]);return {gameVersion:7,region:v.state.region,state:v.state,runtime:v.runtime||null,signature:v.signature,speed:[1,3,6,12,24].includes(v.speed)?v.speed:6,playing:false,personalRecords:records(v.personalRecords),exportedAt:typeof v.exportedAt==='string'?v.exportedAt:null};}
const api={FORMAT,VERSION,MAX_BYTES,pack,parse,records};if(node)module.exports=api;else root.RailLocalSave=api;
})(typeof globalThis!=='undefined'?globalThis:this);
