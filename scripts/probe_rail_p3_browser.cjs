/* Optional real-browser verification; Playwright is a development host dependency. */
const {chromium}=require('playwright'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
// Exercise pointer hit testing with the inspector open. These scenarios use the
// real editor and its transaction, including the distinction between stops and bends.
async function buildFromMap(page, region, screenshotDirectory) {
 const mobile = region === 'gba';
 const map = page.locator('#map');
 const bounds = await map.boundingBox();
 const viewport = page.viewportSize();
 assert.equal(bounds.width, viewport.width);
 assert.equal(bounds.height, viewport.height);
 await page.locator('#add-line').click();
 await page.locator('#edit-bar').waitFor();
 const heading = page.locator('#edit-bar .panel-header');
 assert(await heading.evaluate(el => getComputedStyle(el).backgroundColor === getComputedStyle(document.querySelector('#console-nav')).backgroundColor),
  'The white inspector title needs the dark toolbar background');
 if (mobile) {
  const allVisible=await page.locator('#console-nav button').evaluateAll(buttons => buttons.every(button => {
   const rect=button.getBoundingClientRect();
   return rect.width>=32 && rect.left>=0 && rect.right<=innerWidth && rect.bottom<=innerHeight;
  }));
  assert(allVisible,'All phone toolbar actions must fit on screen');
 }
 // Zoom from inside the construction workspace, then place stops at street scale.
 for (let i=0; i<(mobile?3:1); i++) {
  const before=await map.getAttribute('viewBox');
  await page.locator('#zoom-in').click();
  await page.waitForFunction(box => document.querySelector('#map').getAttribute('viewBox')!==box, before);
 }
 const points = await map.evaluate(svg => {
  const rect = svg.getBoundingClientRect();
  const step = Math.min(55, svg.getScreenCTM().a * 19);
  const x = rect.left + rect.width * .45, y = rect.top + rect.height * .54;
  return [[x-step, y], [x, y-step*.45], [x+step, y]];
 });
 const press = async ([x,y], bend=false) => {
  assert(await page.evaluate(([x,y]) => !!document.elementFromPoint(x,y)?.closest('#map'), [x,y]));
  if (mobile && !bend) await page.touchscreen.tap(x,y);
  else await page.mouse.click(x,y,{button:bend?'right':'left'});
 };
 await press(points[0]);
 await page.waitForFunction(() => document.querySelectorAll('.build-stop').length === 1);
 await press(points[1], true);
 await page.waitForFunction(() => document.querySelectorAll('#map [data-draft-label]').length === 2);
 assert.equal(await page.locator('.build-stop').count(), 1);
 await page.locator('#undo-draft').click();
 await page.waitForFunction(() => document.querySelectorAll('#map [data-draft-label]').length === 1);
 await press(points[1], true);
 await press(points[2]);
 await page.waitForFunction(() => document.querySelectorAll('.build-stop').length === 2);
 if (screenshotDirectory) await page.screenshot({path:path.join(screenshotDirectory,region+'-construction.png')});
 await page.locator('#confirm-add').click();
 await page.locator('#line-panel').waitFor();
 assert.equal(await map.locator('.route').count(),1);
 await page.locator('#line-tab-stations').click();
 const stops = page.locator('#line-view-stations .stop-name');
 assert.equal(await stops.count(),2);
 if (screenshotDirectory) await page.screenshot({path:path.join(screenshotDirectory,region+'-line.png')});
 await stops.first().click();
 await page.locator('#back-to-line').click();
 await page.locator('#line-panel').waitFor();
 await page.locator('#close-panel').click();
 await page.locator('#line-panel').waitFor({state:'hidden'});
}
(async()=>{
 const server=http.createServer((req,res)=>{let p;try{p=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://local').pathname));}catch{res.writeHead(400).end();return;}
  if(!p.startsWith(root+path.sep)){res.writeHead(403).end();return;}if(fs.existsSync(p)&&fs.statSync(p).isDirectory())p=path.join(p,'index.html');
  if(!fs.existsSync(p)){res.writeHead(404).end();return;}const ext=path.extname(p);res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.json':'application/json','.wasm':'application/wasm','.css':'text/css'})[ext]||'application/octet-stream');fs.createReadStream(p).pipe(res);
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
 let browser;try{browser=await chromium.launch({headless:true,executablePath:process.env.RAIL_CHROMIUM,args:['--no-sandbox']});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url+'/scripts/fixtures/rail-p3-browser.html');const probe=await page.evaluate(()=>window.result);assert.equal(errors.length,0,errors.join('\n'));assert(Object.values(probe).filter(v=>typeof v==='boolean').every(Boolean));
  const games=[];for(const region of ['tokyo','gba']){const mobile=region==='gba';const app=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1440,height:900},hasTouch:mobile,isMobile:mobile,reducedMotion:'reduce'});const faults=[];app.on('pageerror',e=>faults.push(e.message));await app.route('**/*',route=>{
    const request=route.request(),target=new URL(request.url());
    const tiles=request.resourceType()==='image' && ['server.arcgisonline.com','cyberjapandata.gsi.go.jp','tile.openstreetmap.org'].includes(target.hostname);
    return target.origin===url || (process.argv[2] && tiles)?route.continue():route.abort();
   });await app.goto(url+'/rail/?map='+region,{waitUntil:'domcontentloaded'});
   await app.waitForFunction(()=>!document.querySelector('#game-loading'),{timeout:45000});
   if(await app.locator('#play').getAttribute('aria-label')==='暂停运行')await app.locator('#play').click();
   await app.waitForFunction(()=>document.querySelector('#play')?.getAttribute('aria-label')==='开始运行');
   await app.locator('#play').click();await app.waitForFunction(()=>document.querySelector('#play')?.getAttribute('aria-label')==='暂停运行');
   await app.locator('#play').click();await app.waitForFunction(()=>document.querySelector('#play')?.getAttribute('aria-label')==='开始运行');
   if(await app.locator('#dismiss-guide').isVisible())await app.locator('#dismiss-guide').click();
   // A rejected durable write must leave the current game and its stored bytes available.
   await app.locator('#speed').selectOption('12');
   await app.evaluate(()=>{
    window.realReplacementWrite=RailSaveStore.writeReplacement;
    RailSaveStore.writeReplacement=async([{base}])=>{window.resetPreimage=base.expected;throw Error('COMMIT_ABORTED');};
   });
   await app.locator('#manage-toggle').click();await app.locator('#new-game').click();await app.locator('#confirm-newgame').click();
   await app.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('新游戏未写入'));
   const [before,kept]=await app.evaluate(async region=>{
    RailSaveStore.writeReplacement=window.realReplacementWrite;
    return [window.resetPreimage,(await RailSaveStore.replacementBase(RailRegions.get(region).saveKey)).expected];
   },region);
   assert.equal(JSON.parse(before).speed,12);
   assert.equal(kept,before);
   assert.equal(await app.locator('#speed').inputValue(),'12');
   await app.locator('#manage-toggle').click();await app.locator('#new-game').click();await app.locator('#confirm-newgame').click();
   await app.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('新游戏已开始'));
   const saved=await app.evaluate(async region=>{
    const base=await RailSaveStore.replacementBase(RailRegions.get(region).saveKey);
    return RailLocalSave.parse(base.expected).state.region;
   },region);
   assert.equal(saved,region);
   if(await app.locator('#dismiss-guide').isVisible())await app.locator('#dismiss-guide').click();
   await buildFromMap(app,region,process.argv[2] && path.dirname(path.resolve(process.argv[2])));
   assert.equal(faults.length,0,faults.join('\n'));games.push({region,startPause:true,newGame:true,mapConstruction:true,stationInspection:true,pageErrors:faults});await app.close();
  }
  const result={scope:'P3-1 Rust initialization and compatibility session/browser acceptance',browser:browser.version(),probe,games};
  if(process.argv[2])fs.writeFileSync(path.resolve(process.argv[2]),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
