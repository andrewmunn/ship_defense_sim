// Hitch profiler: plays a scenario in real time (director + auto time, like a user would) and logs
// every long frame with what changed (new shader programs, textures, geometries) and what the sim
// was doing. Usage: node tools/hitch.mjs [scenario] [seconds] [threshold_ms]
import { chromium } from 'playwright';
const [, , scenario = 'mixedraid', secs = '120', thr = '60'] = process.argv;
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-precise-memory-info', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.text().startsWith('[hitch]')) console.log(m.text()); });
const base = process.env.GS_BASE ?? 'http://localhost:8765';
const t0 = Date.now();
await page.goto(`${base}/?scenario=${scenario}&nointro`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
console.log('ready after', Date.now() - t0, 'ms');
await page.evaluate((thr) => {
  const g = window.game;
  const info = g.R.renderer.info;
  const W = () => g.world;
  const evs = [];
  const hook = (w) => {
    for (const k of ['detonation', 'interceptorLaunch', 'threatLaunch', 'shipHit', 'ciwsHit', 'gunFire', 'decoy', 'boosterSep', 'splash'])
      w.events.on(k, () => evs.push(k));
  };
  hook(W());
  g.events.on('restart', (e) => hook(e.world));
  // per-subsystem timers (wrapped methods accumulate into __acc for the current frame)
  window.__acc = {};
  const wrap = (obj, fn, label) => {
    const o = obj[fn];
    if (typeof o !== 'function') return;
    obj[fn] = function (...a) { const t = performance.now(); try { return o.apply(this, a); } finally { window.__acc[label] = (window.__acc[label] ?? 0) + performance.now() - t; } };
  };
  const wrapAll = () => {
    const w = W();
    if (w.__wrapped) return; w.__wrapped = true;
    wrap(w, 'step', 'sim');
    wrap(g.entities, 'update', 'entities');
    wrap(g.fx, 'update', 'fx');
    wrap(g.entities.trails, 'update', 'trails');
  };
  wrapAll();
  g.events.on('restart', wrapAll);
  wrap(g.shipView, 'update', 'shipView');
  if (g.terrainView) wrap(g.terrainView, 'update', 'terrain');
  wrap(g.particles, 'update', 'particles');
  wrap(g.atm, 'update', 'atm');
  wrap(g.ocean, 'update', 'ocean');
  wrap(g.wake, 'update', 'wake');
  wrap(g.rig, 'update', 'rig');
  wrap(g.R.sceneDepth, 'update', 'sceneDepth');
  wrap(g.R, 'render', 'render');
  g.plugins.forEach((p, i) => wrap(p, 'update', 'plugin' + i + (p.constructor?.name ?? '')));
  let last = performance.now();
  let heap = performance.memory?.usedJSHeapSize ?? 0;
  let prev = { p: info.programs.length, t: info.memory.textures, g: info.memory.geometries };
  window.__hitches = [];
  window.__frames = [];
  const loop = () => {
    const now = performance.now();
    const dt = now - last;
    last = now;
    const cur = { p: info.programs.length, t: info.memory.textures, g: info.memory.geometries };
    window.__frames.push(dt);
    const heapNow = performance.memory?.usedJSHeapSize ?? 0;
    const heapDelta = (heapNow - heap) / 1048576;
    heap = heapNow;
    if (dt > thr) {
      const h = {
        dt: Math.round(dt), simT: +W().t.toFixed(1), ts: g.timeScale,
        newProg: cur.p - prev.p, newTex: cur.t - prev.t, newGeo: cur.g - prev.g,
        ev: [...new Set(evs)].join(','), heapMB: +heapDelta.toFixed(1), heapTotMB: Math.round(heapNow / 1048576),
        cam: window.director?.active ? (window.director.shot?.name ?? window.director.current?.kind ?? 'cine') : g.rig.mode,
        threats: W().threats.filter((t) => t.alive).length, ints: W().interceptors.filter((t) => t.alive).length,
      };
      h.acc = Object.fromEntries(Object.entries(window.__acc).filter(([, v]) => v > 3).map(([k, v]) => [k, Math.round(v)]));
      const names = info.programs.slice(prev.p > cur.p ? 0 : Math.max(0, info.programs.length - Math.max(0, cur.p - prev.p))).map((p) => p.name + '|' + p.cacheKey.slice(0, 180).replace(/,/g, ' '));
      if (cur.p > prev.p) h.progs = names;
      window.__hitches.push(h);
      console.log('[hitch] ' + JSON.stringify(h, null, 1));
    }
    evs.length = 0;
    window.__acc = {};
    prev = cur;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}, +thr);
const end = Date.now() + +secs * 1000;
while (Date.now() < end) {
  await page.waitForTimeout(5000);
  const s = await page.evaluate(() => {
    const f = window.__frames; window.__frames = [];
    f.sort((a, b) => a - b);
    const W = window.game.world;
    return { heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576), simT: W.t.toFixed(0), ts: window.game.timeScale, n: f.length, p50: f[f.length >> 1]?.toFixed(1), p99: f[Math.floor(f.length * 0.99)]?.toFixed(1), max: f[f.length - 1]?.toFixed(0), over: W.over, progs: window.game.R.renderer.info.programs.length };
  });
  console.log('[5s]', JSON.stringify(s));
  if (s.over) break;
}
await browser.close();
