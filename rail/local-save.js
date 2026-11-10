/* File format compatibility transport; all JSON and save policy live in Rust. */
(function(root){'use strict';const node=typeof module!=='undefined'&&module.exports;
const run=(action,args)=>(node?require('./bootstrap-wasm'):root.RailBootstrap).persistence(action,args);
function errorMessage(error){const code=error?.message||String(error);
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
  pack:(state,runtime,settings={})=>run('pack',{state,runtime,settings:{...settings,exportedAt:new Date().toISOString()}}),
  parse:text=>run('parse',{text}),records:value=>run('records',{value}).value};
if(node)module.exports=api;else root.RailLocalSave=api;
})(typeof globalThis!=='undefined'?globalThis:this);
