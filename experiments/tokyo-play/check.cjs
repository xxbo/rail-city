const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const {chromium} = require('playwright');

(async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage({viewport: {width:1200,height:780}});
    const faults = [];
    page.on('pageerror', error => faults.push(error.message));
    await page.goto(pathToFileURL(path.resolve(process.argv[2])).href);
    const station = name => page.getByRole('button', {name, exact:true});
    await station('上野').click();
    await station('秋叶原').click();
    await station('东京').click();
    await page.locator('#undo').click();
    await station('东京').click();
    await page.locator('#go').click();
    await page.locator('#speed').click();
    await page.waitForFunction(() => /已到站 [1-9]/.test(document.querySelector('#detail').textContent));
    await station('秋叶原').click();
    assert.match(await page.locator('#selection').innerText(), /秋叶原.*候车/);
    await page.locator('#go').click();
    await page.getByRole('button',{name:'继续运营'}).waitFor();
    await page.waitForTimeout(300);
    const clock = await page.locator('#time').innerText();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#time').innerText(), clock);
    await page.setViewportSize({width:390,height:760});
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#replay').click();
    await station('浅草').click();
    await station('押上').click();
    await page.waitForFunction(() => !document.querySelector('#go').disabled);
    assert.equal(await page.locator('#time').innerText(), '08:00');
    assert.deepEqual(faults, []);
    console.log('Offline Tokyo scenario passed construction, boarding, arrival, station selection, pause and mobile restart.');
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
