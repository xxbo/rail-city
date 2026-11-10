/* Real-browser source for P3-9. Scenario results name only actions actually
   exercised; remaining release scenarios require separate source-bound evidence. */
const {chromium}=require('playwright'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
(async()=>{
 const server=http.createServer((req,res)=>{let file;try{file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://local').pathname));}catch{res.writeHead(400).end();return;}
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
  if(!fs.existsSync(file)){res.writeHead(404).end();return;}
  res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.json':'application/json','.wasm':'application/wasm','.css':'text/css'})[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 let browser;const scenarios=[],measurements=[],failures=[];
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.RAIL_CHROMIUM,args:['--no-sandbox']});
  const context=await browser.newContext({acceptDownloads:true});
  for(const region of ['tokyo','gba']){
   const page=await context.newPage(),faults=[];page.on('pageerror',error=>faults.push(error.message));
   await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
   await page.addInitScript(()=>{window.railProbe={longTasks:[],frames:[]};try{new PerformanceObserver(list=>{for(const entry of list.getEntries())window.railProbe.longTasks.push(entry.duration);}).observe({type:'longtask',buffered:true});}catch{}let last;const frame=at=>{if(last!==undefined&&window.railProbe.frames.length<600)window.railProbe.frames.push(at-last);last=at;requestAnimationFrame(frame);};requestAnimationFrame(frame);});
   const open=async()=>{await page.goto(base+'/rail/?map='+region);await page.waitForFunction(()=>!document.querySelector('#game-loading'),null,{timeout:60000});if(await page.locator('#dismiss-guide').isVisible())await page.locator('#dismiss-guide').click();};
   await open();scenarios.push({id:region+'-start',status:'passed'});
   if(await page.locator('#play').getAttribute('aria-label')==='暂停运行')await page.locator('#play').click();
   for(const speed of ['1','3','6','12','24']){await page.locator('#speed').selectOption(speed);assert.equal(await page.locator('#speed').inputValue(),speed);}
   await page.locator('#play').click();await page.waitForFunction(()=>document.querySelector('#play').getAttribute('aria-label')==='暂停运行');
   await page.locator('#play').click();await page.waitForFunction(()=>document.querySelector('#play').getAttribute('aria-label')==='开始运行');
   // Trigger the existing UI action, avoiding hidden legacy navigation controls.
   await page.evaluate(()=>document.getElementById('saves-toggle').click());
   await page.locator('#save-local-now').click();await page.waitForFunction(()=>document.querySelector('.save-status')?.textContent.includes('已保存到本地数据库'));
   const event=page.waitForEvent('download');await page.locator('#export-local-save').click();const download=await event,file=await download.path();assert(file);
   await page.locator('#local-save-file').setInputFiles(file);await page.locator('#confirm-local-import').waitFor();await page.locator('#confirm-local-import').click();
   await page.waitForFunction(()=>!document.querySelector('#game-loading')&&new URL(location.href).searchParams.get('v'),null,{timeout:60000});
   assert.equal(await page.locator('#play').getAttribute('aria-label'),'开始运行');
   await page.reload();await page.waitForFunction(()=>!document.querySelector('#game-loading'),null,{timeout:60000});
   const metrics=await page.evaluate(()=>({longTasks:window.railProbe.longTasks,frameIntervals:window.railProbe.frames,jsHeap:performance.memory?.usedJSHeapSize??null}));measurements.push({region,...metrics});
   assert.equal(faults.length,0,faults.join('\n'));await page.close();
  }
  scenarios.push({id:'start-pause-speed',status:'passed'},{id:'import-export-reload',status:'passed'});
 }catch(error){failures.push(error.stack||error.message);throw error;}
 finally{
  const result={schemaVersion:1,source:process.env.RAIL_ACCEPTANCE_SOURCE||null,scope:'two-map startup, controls, file round trip and refresh; empty-network scenario',status:failures.length?'failed':'passed',scenarios,measurements,failures};
  const target=process.env.RAIL_BROWSER_EVIDENCE||process.argv[2];if(target)fs.writeFileSync(path.resolve(target),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));await browser?.close();await new Promise(resolve=>server.close(resolve));
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
