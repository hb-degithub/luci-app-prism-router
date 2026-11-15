const puppeteer = require('puppeteer');
const BASE = process.env.LUCI_BASE || 'https://192.168.100.1';
const PASS = process.env.LUCI_PASS || '';
(async () => {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox','--disable-setuid-sandbox','--ignore-certificate-errors'],
    ignoreHTTPSErrors: true,
  });
  const page = await browser.newPage();
  await page.setBypassCSP(true);
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0,180)); });
  page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0,180)));
  await page.goto(BASE + '/cgi-bin/luci/', { waitUntil: 'networkidle2', timeout: 30000 });
  if (await page.$('input[type=password]')) {
    await page.type('input[type=password]', PASS);
    await Promise.all([
      page.waitForNavigation({ waitUntil:'networkidle2', timeout:20000 }).catch(()=>{}),
      page.click('button[type=submit], input[type=submit], [type=submit]').catch(()=>page.keyboard.press('Enter')),
    ]);
  }
  console.log('LOGIN:', (await page.$('input[type=password]')) ? 'FAIL' : 'OK');
  const pages = ['overview','devices','apps','nodes','settings'];
  const expect = { overview:['流量','代理','直连'], devices:['设备'], apps:['应用'], nodes:['节点'], settings:['飞书'] };
  let bad = 0;
  for (const p of pages) {
    errors.length = 0;
    try {
      await page.goto(BASE + '/cgi-bin/luci/admin/services/traffic-stats/' + p, { waitUntil:'networkidle2', timeout:25000 });
    } catch(e) { console.log(`${p}: NAV_FAIL ${e.message.slice(0,60)}`); bad++; continue; }
    await new Promise(r => setTimeout(r, 2500));
    const body = await page.evaluate(() => document.body.innerText || '');
    const hasView = await page.evaluate(() => !!document.querySelector('#maincontent, .cbi-map, .cbi-section, .cbi-page-actions'));
    const hits = (expect[p]||[]).filter(k => body.includes(k));
    const errs = errors.filter(e => !/favicon|net::ERR/i.test(e));
    const ok = hasView && hits.length >= 1 && errs.length === 0;
    if (!ok) bad++;
    console.log(`${p}: ${ok?'OK':'FAIL'} view=${hasView} hits=[${hits}] len=${body.length} err=${errs.length}`);
    if (errs.length) errs.slice(0,2).forEach(e => console.log('   ! '+e));
    if (body.length < 60) console.log('   body=' + body.slice(0,100).replace(/\s+/g,' '));
  }
  await browser.close();
  process.exit(bad===0?0:1);
})();
