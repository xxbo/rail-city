const $ = id => document.getElementById(id);
const callbacks = new Map();
let worker, sourceURL, serial=0, route=[], ready=false, building=false, live=null;
let selected=null, paused=false, speed=1, framePending=false, lastFrame=0, quoteRevision=0, quoted=false;
const cashText = value => (value/10000).toLocaleString('zh-CN',{maximumFractionDigits:0})+' 万元';
function status(title,detail){$('message').textContent=title;$('detail').textContent=detail;}
function rpc(action,args={}) {
  const id=++serial;
  return new Promise((resolve,reject)=>{callbacks.set(id,{resolve,reject});worker.postMessage({id,action,...args});});
}
function syncUI() {
  $('undo').hidden=!!live;$('undo').disabled=!route.length||building;
  $('go').disabled=!ready||building||(!live&&!quoted);
  $('go').textContent=live?(paused?'继续运营':'暂停运营'):'开通线路';
  $('replay').hidden=!live;$('speed').hidden=!live;$('speed').textContent='速度 ×'+speed;
  $('phase').textContent=live?'列车运营':'线路规划';
  for(const button of $('stations').children){const chosen=route.includes(button.dataset.key);button.classList.toggle('chosen',chosen);button.setAttribute('aria-pressed',String(chosen));button.disabled=!ready||building;}
  if(live){$('cash').textContent=cashText(live.cash);const m=Math.floor(live.minute);$('time').textContent=[Math.floor(m/60)%24,m%60].map(x=>String(x).padStart(2,'0')).join(':');
    status(paused?'运营已暂停':route.map(key=>stationByKey.get(key).name).filter((_,i)=>i===0||i===route.length-1).join(' ↔ '),
      '累计上车 '+live.boarded+' 人　·　已到站 '+live.completed+' 人　·　在线 '+live.trains.length+' 列');
    if(selected){$('selection').hidden=false;$('selection').textContent=stationByKey.get(selected).name+'　'+(route.includes(selected)?'候车 '+(live.stations[selected]||0)+' 人':'尚未接入线路');}
  }
  renderMap(route,live);
}
async function updateDraft(){
  const ticket=++quoteRevision;quoted=false;
  const names=route.map(key=>stationByKey.get(key).name);
  status(names.length?names.join(' → '):'铺设第一条线',names.length<2?'依次选两个或更多站点。':'正在核算线路与列车费用…');syncUI();
  if(names.length<2)return;
  try{const {cost}=await rpc('quote',{route});if(ticket!==quoteRevision)return;quoted=true;
    status(names.join(' → '),'全线 '+names.length+' 站　·　建设及 4 列 6B 合计 '+cashText(cost));}
  catch(e){if(ticket===quoteRevision)status('这条线路暂时无法开通',e.message);}
  if(ticket===quoteRevision)syncUI();
}
places.forEach(p=>{const b=document.createElement('button');b.className='station';b.dataset.key=p.key;b.style.left=p.u*100+'%';b.style.top=p.v*100+'%';b.setAttribute('aria-label',p.name);b.append(document.createElement('i'),document.createElement('span'));b.lastChild.textContent=p.name;
  b.onclick=()=>{if(!ready||building)return;if(live){selected=p.key;syncUI();return;}if(!route.includes(p.key)){route.push(p.key);updateDraft();}};
  $('stations').append(b);
});
function undo(){if(!building&&!live&&route.length){route.pop();updateDraft();}}
$('undo').onclick=undo;
$('go').onclick=async()=>{
  if(live){paused=!paused;syncUI();return;}
  if(!quoted||building)return;
  building=true;status('正在开通线路…','列车正在进入运行图。');syncUI();
  try{live=await rpc('build',{route});lastFrame=0;}catch(e){status('开通失败',e.message);}
  building=false;syncUI();
};
$('speed').onclick=()=>{speed=speed===1?3:1;syncUI();};
$('replay').onclick=()=>{if(confirm('结束这次试运营，重新选择站点？'))start();};
window.addEventListener('keydown',e=>{if(e.target.closest('button')&&e.code==='Space')return;
  if(e.code==='Space'&&live){e.preventDefault();paused=!paused;syncUI();}
  if(e.code==='Backspace'&&!live){e.preventDefault();undo();}
});
async function start(){
  ++quoteRevision;ready=false;building=false;live=null;selected=null;paused=false;speed=1;route=[];quoted=false;framePending=false;
  if(worker)worker.terminate();for(const cb of callbacks.values())cb.reject(Error('本次试运营已结束'));callbacks.clear();
  if(!sourceURL)sourceURL=URL.createObjectURL(new Blob([$('worker-source').textContent],{type:'text/javascript'}));
  worker=new Worker(sourceURL);const owner=worker;
  worker.onmessage=({data})=>{const cb=callbacks.get(data.id);if(!cb)return;callbacks.delete(data.id);if(data.error)cb.reject(Error(data.error));else cb.resolve(data.result);};
  worker.onerror=e=>{ready=false;paused=true;for(const cb of callbacks.values())cb.reject(Error(e.message||'运行线程中断'));callbacks.clear();status('运行线程中断',e.message||'请重新打开本场景。');};
  $('selection').hidden=true;$('time').textContent='08:00';status('正在载入城市…','准备东京东部的线路与客流。');syncUI();
  try{const v=await rpc('open',{places});if(owner!==worker)return;ready=true;$('cash').textContent=cashText(v.cash);await updateDraft();}
  catch(e){if(owner===worker)status('载入失败',e.message);}
}
async function updateClock(at) {
  const owner=worker;framePending=true;
  try{const next=await rpc('pulse',{at,playing:!paused,visible:!document.hidden,speed:6*speed});
    if(owner===worker){live=next;if(!next.running)paused=true;syncUI();}}
  catch(e){if(owner===worker){ready=false;paused=true;syncUI();status('运营已停止',e.message);}}
  finally{if(owner===worker)framePending=false;}
}
function frame(at){if(live&&ready&&!framePending&&at-lastFrame>=100){lastFrame=at;updateClock(at);}requestAnimationFrame(frame);}
new ResizeObserver(()=>{cityArt();renderMap(route,live);}).observe(board);
cityArt();start();requestAnimationFrame(frame);
