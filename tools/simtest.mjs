// Usage: node tools/simtest.mjs "p=leaker&v=1"
import { chromium } from 'playwright';
const q = process.argv[2] ?? '';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('console', (m) => console.log(m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message, e.stack));
await page.goto('http://localhost:8765/simtest.html?' + q);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 600000 });
await browser.close();
