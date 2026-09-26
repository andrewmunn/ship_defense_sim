// Scriptable game screenshot harness.
// Usage: node tools/gshot.mjs <script.json | inline-json> [width] [height]
// Script: { "url": "/?scenario=coastalraid", "steps": [ {"eval": "game.advance(60)"}, {"wait": 500}, {"shot": "shots/x.png"}, {"log": "game.fps"} ] }
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
const [, , arg, w = '1600', h = '900'] = process.argv;
const script = JSON.parse(arg.trim().startsWith('{') ? arg : readFileSync(arg, 'utf8'));
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
const url = script.url.startsWith('http') ? script.url : (process.env.GS_BASE ?? 'http://localhost:8765') + script.url;
await page.goto(url, { waitUntil: 'load' });
try {
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
} catch {
  console.log('[gshot] timed out waiting for __ready');
}
const COMMON = readFileSync(new URL('./scenes/common.js', import.meta.url), 'utf8');
await page.evaluate(COMMON);
// Vite may hot-reload the page mid-script (other edits); re-arm helpers if that happened.
async function ensure() {
  for (let i = 0; i < 3; i++) {
    try {
      const ok = await page.evaluate(() => !!window.game && !!window.T && window.__ready === true);
      if (ok) return;
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
      await page.evaluate(COMMON);
      console.log('[gshot] page reloaded; helpers re-injected (scene state was reset)');
      return;
    } catch {
      await page.waitForTimeout(1000);
    }
  }
}
for (const s of script.steps ?? []) {
  if (s.eval) {
    await ensure();
    let r;
    try {
      r = await page.evaluate(s.eval);
    } catch (e) {
      console.log('[gshot] eval failed, retrying after reload check:', String(e).slice(0, 120));
      await page.waitForTimeout(1500);
      await ensure();
      r = await page.evaluate(s.eval);
    }
    if (r !== undefined && r !== null) console.log('eval:', typeof r === 'string' ? r : JSON.stringify(r));
  }
  if (s.wait) await page.waitForTimeout(s.wait);
  if (s.log) { await ensure(); console.log('log:', JSON.stringify(await page.evaluate(s.log))); }
  if (s.shot) {
    mkdirSync(dirname(s.shot), { recursive: true });
    await page.screenshot({ path: s.shot });
    console.log('saved', s.shot);
  }
}
const errs = logs.filter((l) => /error|warn/i.test(l));
if (errs.length) console.log(errs.slice(0, 30).join('\n'));
await browser.close();
process.exit(0);
