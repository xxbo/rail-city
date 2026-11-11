/* File format compatibility transport; all JSON and save policy live in Rust. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports;
const run=(action,args)=>(node?require('./bootstrap-wasm'):root.RailBootstrap).persistence(action,args);
function errorMessage(error){const code=error?.message||String(error);
  if(code==='PARSE_NONFINITE')return 'JSON存档包含无效数值，请检查文件。';
  if(code==='PARSE_STRUCTURE')return '存档数据过大或嵌套过深，请选择游戏导出的完整文件。';
  if(code==='PARSE_SIZE')return '请选择64MB以内的JSON存档。';
  if(code.startsWith('PARSE_'))return 'JSON存档解析失败，请选择游戏导出的完整文件。';
  if(code.includes('VERSION')||code==='VALIDATE_SAVE_4'||code==='VALIDATE_SAVE_5')return '此存档版本尚未受支持，原存档已保留。';
  if(code==='RESTORE_STALE_PREVIEW'||code==='RESTORE_TOKEN_MISMATCH')return '预览后的游戏进度已有变化，请重新选择存档文件。';
  if(code==='COMMIT_CONFLICT')return '其他标签页已更新存档，请刷新后重新导入。';
  if(code.startsWith('COMMIT_'))return '存档写入失败，请检查站点存储权限或磁盘空间后重试。';
  if(code.startsWith('READ_'))return '本地存档读取失败，请检查站点存储权限后重试。';
  if(code.startsWith('VALIDATE_')||code.startsWith('RESTORE_'))return '线网、财务或乘客运行数据校验失败，请检查文件。';
  return code;
}
const api={errorMessage,FORMAT:'rail-local-save',VERSION:1,MAX_BYTES:64*1024*1024,
  pack:(state,runtime,settings={})=>run('packView',{state,runtime,settings:{...settings,exportedAt:new Date().toISOString()}}),
  parse:text=>{try{return run('parseView',{text});}catch(error){const code=error.message,labels={'VALIDATE_SAVE_4':'不支持此存档格式或版本。','VALIDATE_SAVE_5':'仅支持第7代游戏存档。','VALIDATE_FORMAT_VERSION':'不支持此存档格式或版本。','VALIDATE_GAME_VERSION':'仅支持第7代游戏存档。','VALIDATE_SAVE_6':'地图标识无效或不一致。','VALIDATE_SAVE_7':'存档中的线网、城市、财务或满意度数据校验失败，当前进度未改变。','VALIDATE_SAVE_8':'存档运行数据与线网版本不匹配，当前进度未改变。','VALIDATE_SAVE_9':'存档中的运行数据或乘客关联校验失败，当前进度未改变。'};const display=Error(labels[code]||errorMessage(error));display.code=code;throw display;}},records:value=>run('records',{value}).value};
if(node)module.exports=api;else root.RailLocalSave=api;
})(typeof globalThis!=='undefined'?globalThis:this);
