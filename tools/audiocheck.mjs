// Headless verification of the audio engine.
// Usage:  node tools/audiocheck.mjs [--no-wav] [--no-py]
// Starts its own private Vite server (HMR off, so concurrent edits elsewhere in the repo can't reload the page).
// Renders scenarios with OfflineAudioContext inside Chromium (src/dev/audioCheck.ts), prints parameter tables,
// checks decode / delay / CIWS splice / voice limiting / clipping, writes WAVs to shots/audio/ and runs the
// Python analysis (tools/audiocheck_analyze.py, RMS / spectral centroid / CIWS inter-onset intervals).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'vite';

const args = new Set(process.argv.slice(2));
const OUT = 'shots/audio';
fs.mkdirSync(OUT, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', server: { port: 8779, strictPort: false, hmr: false, watch: null } });
await server.listen();
const BASE = (server.resolvedUrls?.local?.[0] ?? 'http://localhost:8779/').replace(/\/$/, '');
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') { const t = m.text(); if (!t.includes('AudioContext was not allowed')) errors.push(`[${m.type()}] ${t}`); } });
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
await page.goto(BASE + '/audiotest.html');
await page.waitForFunction(() => window.__audioReady === true, null, { timeout: 120000 });

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const saveWav = async (name, id) => {
  if (args.has('--no-wav') || typeof id !== 'number') return;
  const len = await page.evaluate((i) => window.__wavs[i].length, id);
  let b64 = '';
  for (let o = 0; o < len; o += 1 << 20) b64 += await page.evaluate(([i, o]) => window.__wavs[i].slice(o, o + (1 << 20)), [id, o]);
  await page.evaluate((i) => { window.__wavs[i] = null; }, id);
  fs.writeFileSync(path.join(OUT, name + '.wav'), Buffer.from(b64, 'base64'));
};
const pad = (s, n) => String(s).padStart(n);
// retry a scenario if the page reloads underneath us (Vite HMR full-reloads while other files are being edited)
const run = async (fn, ...a) => {
  for (let k = 0; ; k++) {
    try {
      let timer;
      const r = await Promise.race([
        // big results stall Playwright's serializer: keep WAVs in the page (window.__wavs) and return ids instead
        page.evaluate(async ([fn, a]) => {
          const r = await window.__audioCheck[fn](...a);
          window.__wavs ??= [];
          const strip = (o) => { if (o && typeof o === 'object') { if (typeof o.wav === 'string') { window.__wavs.push(o.wav); o.wav = window.__wavs.length - 1; } for (const k in o) if (k !== 'wav') strip(o[k]); } };
          strip(r);
          return r;
        }, [fn, a]),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('step timeout')), 180000); }),
      ]);
      clearTimeout(timer);
      return r;
    } catch (e) {
      if (k >= 2 || !/context was destroyed|navigation|__audioCheck|step timeout/.test(String(e))) throw e;
      console.log(`   (${String(e).slice(0, 60)} during ${fn}; reloading page and retrying)`);
      await page.reload();
      await page.waitForFunction(() => window.__audioReady === true, null, { timeout: 120000 });
    }
  }
};

// ---------------------------------------------------------------------------------------------- 1. decode + table
const manifest = await (await fetch(BASE + '/audio/manifest.json')).json();
const { rows, info } = await run('probeTable');
let decodeOk = true;
for (const [name, s] of Object.entries(manifest.sounds)) {
  const bi = info[name];
  if (!bi) { ok(false, `decoded ${name}`); decodeOk = false; continue; }
  const want = s.variant_durations ?? [s.duration];
  bi.durations.forEach((d, i) => { if (Math.abs(d - want[i]) > 0.006) { decodeOk = false; console.log(`   ${name}[${i}] decoded ${d.toFixed(4)} s vs manifest ${want[i]}`); } });
}
ok(decodeOk, `all ${Object.keys(manifest.sounds).length} manifest sounds decoded, durations match manifest (±6 ms)`);
const trims = Object.entries(info).filter(([, b]) => b.trims.length > 1).map(([n, b]) => `${n}: ${b.trims.map((t) => (20 * Math.log10(t)).toFixed(1)).join('/')} dB`);
console.log('   variant loudness trims: ' + trims.join('; '));

console.log('\nComputed spatial parameters (gain = direct gain at listener incl. vol; LPF = air-absorption cutoff; send = reverb send)');
console.log(`${pad('sound', 20)} ${pad('dist', 8)} ${pad('gain dB', 8)} ${pad('LPF near', 9)} ${pad('LPF far', 8)} ${pad('near/far', 10)} ${pad('send', 7)} ${pad('wet/dry dB', 10)} ${pad('delay s', 8)}  pan`);
let lastName = '';
for (const r of rows) {
  if (r.name !== lastName && lastName) console.log('');
  lastName = r.name;
  const wd = 20 * Math.log10(Math.max(r.send, 1e-9) / Math.max(r.gain, 1e-9));
  console.log(`${pad(r.name, 20)} ${pad(r.dist >= 1000 ? r.dist / 1000 + ' km' : r.dist + ' m', 8)} ${pad((20 * Math.log10(Math.max(r.gain, 1e-9))).toFixed(1), 8)} ${pad(r.cutoffNear.toFixed(0), 9)} ${pad(r.farName ? r.cutoffFar.toFixed(0) : '-', 8)} ${pad(r.nearW.toFixed(2) + '/' + r.farW.toFixed(2), 10)} ${pad(r.send.toFixed(3), 7)} ${pad(wd.toFixed(1), 10)} ${pad(r.delay.toFixed(2), 8)}  ${r.panning}`);
}

// ---------------------------------------------------------------------------------------------- 2. propagation delay
console.log('\nPropagation delay (sim time):');
const delays = await run('delayChecks');
for (const d of delays) {
  console.log(`   d=${d.d} m scale=${d.scale}× listener→src ${d.lv} m/s: expected ${d.expected.toFixed(3)} s real, measured ${d.onset.toFixed(3)} s − asset onset ${d.baseline.toFixed(3)} s → err ${d.err_ms.toFixed(1)} ms`);
  ok(Math.abs(d.err_ms) < 6, `delay d=${d.d} scale=${d.scale} lv=${d.lv}`);
}

// ---------------------------------------------------------------------------------------------- 3. CIWS splice
console.log('\nCIWS splice:');
const cw = await run('ciwsCheck', {});
await saveWav('ciws_burst_20m', cw.wav);
const st = cw.info.log.find((e) => e.ev === 'start'), sp = cw.info.log.find((e) => e.ev === 'stop');
console.log(`   spinup ${cw.spinDur.toFixed(5)} s, loop ${cw.loopDur.toFixed(5)} s, tail ${cw.tailDur.toFixed(5)} s`);
console.log(`   start @ ${st.t.toFixed(5)}  loop @ ${st.tLoop.toFixed(5)}  (Δ ${(st.tLoop - st.t).toFixed(6)} s)  stop/tail @ ${sp.t.toFixed(5)} phase ${(sp.phaseAtStop * 48000).toFixed(1)} smp  (mod 636 = ${((sp.phaseAtStop * 48000) % 636).toFixed(2)})`);
ok(Math.abs(st.tLoop - st.t - cw.spinDur) < 1e-6, 'loop starts exactly at end of ciws_spinup buffer');
ok(Math.abs(((sp.phaseAtStop * 48000) % 636) - 20) < 0.05, 'tail spliced on the shot grid (loop phase ≡ 20 samples mod 636)');
ok(cw.clip === 0, `CIWS burst at 20 m does not clip (peak ${cw.peak_dB.toFixed(1)} dBFS)`);
const cwShort = await run('ciwsCheck', { on: 0.1, off: 0.25, dur: 4 });
await saveWav('ciws_burst_short', cwShort.wav);
const sp2 = cwShort.info.log.find((e) => e.ev === 'stop'), st2 = cwShort.info.log.find((e) => e.ev === 'start');
ok(Math.abs(sp2.t - st2.tLoop) < 1e-9, 'burst released during spin-up: tail starts exactly at spin-up end, loop skipped');
const cwSlow = await run('ciwsCheck', { on: 0.1, off: 2.4, dur: 6, scale: 1, rateSwitchAt: 0.3, scale2: 0.25 });
await saveWav('ciws_burst_slowmo', cwSlow.wav);
const sp3 = cwSlow.info.log.find((e) => e.ev === 'stop');
ok(Math.abs(((sp3.phaseAtStop * 48000) % 636) - 20) < 0.5, `slow-mo switch mid-burst keeps the splice on the grid (rate ${sp3.rate})`);
const cwFar = await run('ciwsCheck', { d: 2500, on: 0.1, off: 1.6, dur: 11 });
await saveWav('ciws_burst_2500m', cwFar.wav);
ok(Math.abs(cwFar.onset - (0.1 + 2500 / 343)) < 0.08, `CIWS at 2.5 km heard after ${cwFar.onset.toFixed(2)} s (expected ${(0.1 + 2500 / 343).toFixed(2)})`);

// ---------------------------------------------------------------------------------------------- 4. voice limiting
console.log('\nVoice limiting (2000 splashes + 20-salvo + 100 explosions in one frame):');
const vl = await run('voiceLimitCheck');
await saveWav('voice_limit', vl.wav);
console.log(`   max simultaneous world voices ${vl.maxVoices}, unique starts ${vl.uniqueStarts}, max identical starts per 50 ms: ${JSON.stringify(vl.maxIn50)}`);
console.log(`   counters ${JSON.stringify(vl.stats.counters)}  peak ${vl.peak_dB.toFixed(1)} dBFS`);
ok(vl.maxVoices <= 40, 'voice cap (40) respected');
ok((vl.maxIn50.splash_small ?? 0) <= 2 && (vl.maxIn50.explosion_near ?? 0) <= 3, '50 ms identical-start limit respected');
ok(vl.clip === 0, 'no clipping under a 2000-event burst');

// ---------------------------------------------------------------------------------------------- 5. slow-mo rates
const sm = await run('slowmoCheck');
console.log('\nSlow motion playbackRate (explosion voice):');
for (const r of sm.filter((_, i) => i % 2 === 0)) console.log(`   t=${r.t.toFixed(2)} timeRate=${r.timeRate.toFixed(3)} voice rates=${r.rates.map((x) => x.toFixed(3)).join(',')}`);
ok(Math.abs(sm.at(-1).timeRate - 0.35) < 1e-6, 'scale 0.1 → playbackRate factor 0.35 (clamped)');

// ---------------------------------------------------------------------------------------------- 6. doppler
console.log('\nDoppler fly-by (jet_asm_loop, 285 m/s, 30 m miss, retarded position):');
const dp = await run('dopplerCheck', 'jet_asm_loop', 285, 30, 3000);
await saveWav('flyby_jet_285', dp.wav);
for (const r of dp.trace.filter((_, i) => i % 10 === 0)) console.log(`   t=${r.t.toFixed(2)} src x=${r.x.toFixed(0)} heard d=${(r.dist ?? 0).toFixed(0)} dop=${(r.dop ?? 0).toFixed(3)} rate=${(r.rate ?? 0).toFixed(3)} ${r.real ? 'REAL' : 'virt'}`);
const dops = dp.trace.map((r) => r.dop).filter((x) => x);
const theoryIn = 343 / (343 - 285), theoryOut = 343 / (343 + 285);
ok(Math.max(...dops) > 2.0 && Math.min(...dops) < 0.6, `doppler spans ${Math.min(...dops).toFixed(2)}–${Math.max(...dops).toFixed(2)} (theory ${theoryOut.toFixed(2)}–${theoryIn.toFixed(2)}, clamp 0.5–2.2)`);
const dps = await run('dopplerCheck', 'ramjet_loop', 700, 50, 3000);
await saveWav('flyby_ramjet_700', dps.wav);
const firstHeard = dps.trace.find((r) => r.audible);
console.log(`   supersonic ramjet (M2.0): first heard at t=${firstHeard?.t.toFixed(2)} s when source x=${firstHeard?.x.toFixed(0)} m (silent on approach, Mach cone)`);
ok(firstHeard && firstHeard.x > 0, 'supersonic source is silent until its Mach cone passes the listener');

// ---------------------------------------------------------------------------------------------- 7. distance sweeps
console.log('\nRendered distance sweeps (offline, noDelay):');
// fixed variants (aliases) so renders differ only by distance
const sweeps = [
  ['explosion_near_1', [20, 100, 300, 1000, 3000, 10000, 20000], 8],
  ['gun_5in_1', [30, 300, 1000, 3000, 10000], 6],
  ['splash_small_1', [5, 30, 100, 300], 1.5],
  ['vls_launch_1', [30, 300, 1000, 3000, 8000], 10],
];
for (const [name, ds, dur] of sweeps) {
  const res = await run('distanceSweep', name, ds, dur);
  for (const r of res) { await saveWav(`sweep_${name}_${r.d}m`, r.wav); console.log(`   ${pad(name, 15)} ${pad(r.d, 6)} m  rms ${r.rms_dB.toFixed(1)} dBFS  peak ${r.peak_dB.toFixed(1)}`); }
  let mono = true;
  for (let i = 1; i < res.length; i++) if (res[i].rms_dB > res[i - 1].rms_dB + 0.5) mono = false;
  ok(mono, `${name}: level falls monotonically with distance`);
}

// ---------------------------------------------------------------------------------------------- 8. ambience + raid
console.log('\nAmbience beds:');
const amb = await run('ambienceCheck');
for (const a of amb) { await saveWav('amb_' + a.label.replace(/[^a-z0-9]+/gi, '_'), a.wav); console.log(`   ${pad(a.label, 26)} rms ${a.rms_dB.toFixed(1)} dBFS  peak ${a.peak_dB.toFixed(1)}`); }
console.log('\nRaid mix (on deck: CIWS, 8 inbound, airbursts, 5in, splash storm, VLS, ship hit, GQ alarm):');
const raid = await run('raidCheck');
await saveWav('raid_mix', raid.wav);
console.log(`   rms ${raid.rms_dB.toFixed(1)} dBFS  peak ${raid.peak_dB.toFixed(2)} dBFS  clipped samples ${raid.clip}  counters ${JSON.stringify(raid.stats.counters)}`);
ok(raid.clip === 0, 'raid mix does not clip (compressor + limiter)');

// ---------------------------------------------------------------------------------------------- 9. realtime pause / suspend
const pz = await page.evaluate(async () => {
  const eng = window.__eng, dev = window.__dev;
  eng.unlock();
  await new Promise((r) => setTimeout(r, 300));
  const before = eng.stats().ctxState;
  dev.scale = 0;
  await new Promise((r) => setTimeout(r, 500));
  const paused = eng.stats().ctxState;
  const ui = eng.stats().uiState;
  dev.scale = 1;
  await new Promise((r) => setTimeout(r, 500));
  const after = eng.stats().ctxState;
  // hammer play() in realtime: 5000 calls in one tick must not throw
  const t0 = performance.now();
  for (let i = 0; i < 5000; i++) eng.play('splash_small', { x: Math.random() * 300, y: 0, z: Math.random() * 300 });
  eng.play('no_such_sound', null); eng.play('no_such_sound', null);
  const l = eng.loop('no_such_loop'); l.set({ x: 0, y: 0, z: 0 }); l.stop();
  const ms = performance.now() - t0;
  return { before, paused, ui, after, ms };
});
console.log(`\nRealtime: ctx ${pz.before} → pause → ${pz.paused} (ui ctx ${pz.ui}) → resume → ${pz.after}; 5000 play() calls took ${pz.ms.toFixed(1)} ms`);
ok(pz.before === 'running' && pz.paused === 'suspended' && pz.after === 'running' && pz.ui === 'running', 'pause suspends the world context (UI context stays live), unpause resumes');
ok(pz.ms < 100, '5000 play() calls in < 100 ms');

await browser.close();
await server.close();
const unknownWarn = errors.filter((e) => e.includes('unknown sound'));
const other = errors.filter((e) => !e.includes('unknown sound'));
ok(unknownWarn.length === 2, `missing names warn once per name (2 names × 2 calls → ${unknownWarn.length} warnings)`);
if (other.length) { console.log('\nConsole errors/warnings:'); other.slice(0, 20).forEach((e) => console.log('   ' + e)); }
ok(other.length === 0, 'no page errors');

if (!args.has('--no-py') && !args.has('--no-wav')) {
  console.log('\nPython analysis (tools/audiocheck_analyze.py):');
  const py = fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3';
  const r = spawnSync(py, ['tools/audiocheck_analyze.py', OUT], { stdio: 'inherit' });
  if (r.status !== 0) fails++;
}
console.log(`\n${fails ? fails + ' FAILED' : 'ALL CHECKS PASSED'}`);
process.exit(fails ? 1 : 0);
