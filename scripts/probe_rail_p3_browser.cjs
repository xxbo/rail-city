/* Optional real-browser verification; Playwright is a development host dependency. */
const {chromium}=require('playwright'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
(async()=>{
 const server=http.createServer((req,res)=>{let p;try{p=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://local').pathname));}catch{res.writeHead(400).end();return;}
  if(!p.startsWith(root+path.sep)){res.writeHead(403).end();return;}if(fs.existsSync(p)&&fs.statSync(p).isDirectory())p=path.join(p,'index.html');
  if(!fs.existsSync(p)){res.writeHead(404).end();return;}const ext=path.extname(p);res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.json':'application/json','.wasm':'application/wasm','.css':'text/css'})[ext]||'application/octet-stream');fs.createReadStream(p).pipe(res);
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
 let browser;try{browser=await chromium.launch({headless:true,executablePath:process.env.RAIL_CHROMIUM,args:['--no-sandbox']});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url+'/scripts/fixtures/rail-p3-browser.html');const probe=await page.evaluate(()=>window.result);assert.equal(errors.length,0,errors.join('\n'));assert(Object.values(probe).filter(v=>typeof v==='boolean').every(Boolean));
  const games=[];for(const region of ['tokyo','gba']){const app=await browser.newPage();const faults=[];app.on('pageerror',e=>faults.push(e.message));await app.route('**/*',route=>route.request().url().startsWith(url)?route.continue():route.abort());await app.goto(url+'/rail/?map='+region);
   await app.waitForFunction(()=>!document.querySelector('#game-loading'),{timeout:45000});
   if(await app.locator('#play').getAttribute('aria-label')==='暂停运行')await app.locator('#play').click();
   await app.waitForFunction(()=>document.querySelector('#play')?.getAttribute('aria-label')==='开始运行');
   await app.locator('#play').click();await app.waitForFunction(()=>document.querySelector('#play')?.getAttribute('aria-label')==='暂停运行');
   await app.locator('#play').click();await app.waitForFunction(()=>document.querySelector('#play')?.getAttribute('aria-label')==='开始运行');
   if(await app.locator('#dismiss-guide').isVisible())await app.locator('#dismiss-guide').click();
   await app.locator('#manage-toggle').click();await app.locator('#new-game').click();await app.locator('#confirm-newgame').click();
   await app.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('新游戏已开始'));
   assert.equal(faults.length,0,faults.join('\n'));games.push({region,startPause:true,newGame:true,pageErrors:faults});await app.close();
  }
  const result={scope:'P3-1 Rust initialization and compatibility session/browser acceptance',browser:browser.version(),probe,games};
  if(process.argv[2])fs.writeFileSync(path.resolve(process.argv[2]),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
