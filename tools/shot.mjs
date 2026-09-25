// Usage: node tools/shot.mjs "<url or path+query>" <out.png> [width] [height] [waitMs]
// Example: node tools/shot.mjs "/viewer.html?model=ship&az=40&el=15" shots/ship.png
// Requires the dev server running on http://localhost:8765 (npm run dev).
import { chromium } from 'playwright';
const [, , urlArg, out = 'shots/out.png', w = '1600', h = '900', waitMs = '0'] = process.argv;
const url = urlArg.startsWith('http') ? urlArg : 'http://localhost:8765' + (urlArg.startsWith('/') ? '' : '/') + urlArg;
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'load' });
let pageErr = null;
page.on('pageerror', (e) => { pageErr = e; });
try {
  await Promise.race([
    page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 }),
    new Promise((_, rej) => { const iv = setInterval(() => { if (pageErr) { clearInterval(iv); rej(pageErr); } }, 200); }),
  ]);
} catch {
  logs.push('[shot] timed out waiting for window.__ready');
}
if (+waitMs > 0) await page.waitForTimeout(+waitMs);
const { mkdirSync } = await import('fs');
const { dirname } = await import('path');
mkdirSync(dirname(out), { recursive: true });
await page.screenshot({ path: out });
const errs = logs.filter((l) => /error|warn/i.test(l));
if (errs.length) console.log(errs.slice(0, 30).join('\n'));
console.log('saved', out);
await browser.close();
process.exit(0);
