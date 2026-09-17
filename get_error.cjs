const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
  await page.goto('http://127.0.0.1:3000');
  await new Promise(r => setTimeout(r, 2000));
  const html = await page.evaluate(() => document.body.innerHTML);
  console.log('HTML CONTENT LENGTH:', html.length);
  if (html.length < 500) console.log(html);
  await browser.close();
})();
