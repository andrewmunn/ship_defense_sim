/**
 * Audio test bench (audiotest.html): trigger every sound at chosen distances, fly sources past the listener,
 * fire the CIWS, change time scale, move the listener and drive the ambience. Also exposes the offline checks
 * (window.__audioCheck) used by tools/audiocheck.mjs.
 */
import { AudioEngine, AudioEnv, LoopHandle, CiwsHandle, Vec3 } from '../audio/audioEngine';
import * as checks from './audioCheck';

const eng = new AudioEngine();
(window as any).__eng = eng;
(window as any).__audioCheck = checks;

// ------------------------------------------------------------------------------------------------ state
const S = {
  scale: 1, sim: 0, dist: 300, az: 0, height: 5, gain: 1, noDelay: false,
  alt: 12, yaw: 0, lisX: 0,
  env: { shipPos: { x: 0, y: 0, z: 0 }, shipSpeed: 9, seaState: 3, onDeck: true, camAlt: 12, night: 0, shipFires: 0, sinking: false } as AudioEnv,
  flyLoop: 'jet_asm_loop', flySpeed: 285, flyMiss: 30, flyLen: 3000, flyOneShot: true,
  slew: 0, selected: 'explosion_near',
};
(window as any).__dev = S;

const grid = document.getElementById('grid')!;
function section(title: string) {
  const s = document.createElement('section');
  s.innerHTML = `<h2>${title}</h2>`;
  grid.appendChild(s);
  return s;
}
function slider(parent: HTMLElement, label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string = (v) => v.toFixed(2), log = false) {
  const l = document.createElement('label');
  l.innerHTML = `<span class="k">${label}</span><input type="range"><span class="v"></span>`;
  const inp = l.querySelector('input')!, out = l.querySelector('.v')!;
  const toS = (v: number) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min));
  const fromS = (s: number) => (log ? min * Math.pow(max / min, s) : min + s * (max - min));
  inp.min = '0'; inp.max = '1'; inp.step = log ? '0.001' : String(step / (max - min));
  inp.value = String(toS(get()));
  const upd = () => { out.textContent = fmt(get()); };
  inp.oninput = () => { let v = fromS(+inp.value); if (!log) v = Math.round(v / step) * step; set(v); upd(); };
  upd();
  parent.appendChild(l);
  return { refresh: () => { inp.value = String(toS(get())); upd(); } };
}
function check(parent: HTMLElement, label: string, get: () => boolean, set: (v: boolean) => void) {
  const l = document.createElement('label');
  l.innerHTML = `<span class="k">${label}</span><input type="checkbox">`;
  const i = l.querySelector('input')!;
  i.checked = get(); i.onchange = () => set(i.checked);
  parent.appendChild(l);
}
function btn(parent: HTMLElement, text: string, fn: () => void) {
  const b = document.createElement('button');
  b.textContent = text; b.onclick = fn;
  parent.appendChild(b);
  return b;
}
const fmtM = (v: number) => (v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + ' km' : v.toFixed(0) + ' m');

// ------------------------------------------------------------------------------------------------ geometry
function listener() {
  const half = (S.yaw * Math.PI) / 360;
  // yaw about +Y (positive = turn left, like three.js)
  return { pos: { x: S.lisX, y: S.alt, z: 0 }, quat: { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, vel: { x: 0, y: 0, z: 0 } };
}
/** Source position: horizontal distance S.dist from the listener at azimuth S.az (0 = north/−Z, + = east/right). */
function srcPos(): Vec3 {
  const a = (S.az * Math.PI) / 180;
  return { x: S.lisX + Math.sin(a) * S.dist, y: S.height, z: -Math.cos(a) * S.dist };
}

// ------------------------------------------------------------------------------------------------ panels
const pTime = section('Time & master');
{
  const row = document.createElement('div'); row.className = 'btns';
  const scales = [0, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32];
  const bs: HTMLButtonElement[] = [];
  for (const s of scales) {
    const b = btn(row, s === 0 ? 'pause' : s + '×', () => { S.scale = s; bs.forEach((x) => x.classList.toggle('hot', x === b)); });
    if (s === 1) b.classList.add('hot');
    bs.push(b);
  }
  pTime.appendChild(row);
  slider(pTime, 'master', 0, 1, 0.01, () => eng.master, (v) => (eng.master = v));
  check(pTime, 'muted', () => eng.muted, (v) => (eng.muted = v));
  check(pTime, 'ambience', () => eng.ambience, (v) => (eng.ambience = v));
}

const pSrc = section('Source placement');
slider(pSrc, 'distance', 5, 30000, 1, () => S.dist, (v) => (S.dist = v), fmtM, true);
slider(pSrc, 'azimuth', -180, 180, 1, () => S.az, (v) => (S.az = v), (v) => v.toFixed(0) + '°');
slider(pSrc, 'height', 0, 3000, 1, () => S.height, (v) => (S.height = v), fmtM);
slider(pSrc, 'gain', 0, 2, 0.01, () => S.gain, (v) => (S.gain = v));
check(pSrc, 'noDelay', () => S.noDelay, (v) => (S.noDelay = v));

const pSounds = section('One-shots (click = play at source position; UI/alarm are 2D)');
const soundRow = document.createElement('div'); soundRow.className = 'btns';
pSounds.appendChild(soundRow);

const pFly = section('Fly-by (loop with doppler + retarded time)');
{
  const sel = document.createElement('select');
  for (const n of ['jet_asm_loop', 'rocket_motor_loop', 'ramjet_loop']) { const o = document.createElement('option'); o.value = o.textContent = n; sel.appendChild(o); }
  sel.onchange = () => (S.flyLoop = sel.value);
  pFly.appendChild(sel);
  slider(pFly, 'speed', 50, 1000, 5, () => S.flySpeed, (v) => (S.flySpeed = v), (v) => v.toFixed(0) + ' m/s (M' + (v / 343).toFixed(2) + ')');
  slider(pFly, 'miss dist', 5, 5000, 1, () => S.flyMiss, (v) => (S.flyMiss = v), fmtM, true);
  slider(pFly, 'half-length', 500, 20000, 10, () => S.flyLen, (v) => (S.flyLen = v), fmtM, true);
  check(pFly, 'flyby 1-shot', () => S.flyOneShot, (v) => (S.flyOneShot = v));
  const row = document.createElement('div'); row.className = 'btns'; pFly.appendChild(row);
  btn(row, 'Launch fly-by', () => startFlyby());
  btn(row, 'Stop all fly-bys', () => { flybys.forEach((f) => f.h.stop(0.3)); flybys.length = 0; });
}

const pCiws = section('CIWS');
let ciws: CiwsHandle | null = null;
let ciwsFiring = false, ciwsBurstEnd = -1;
{
  const row = document.createElement('div'); row.className = 'btns'; pCiws.appendChild(row);
  btn(row, 'Burst 1.5 s (sim)', () => { ciwsFiring = true; ciwsBurstEnd = S.sim + 1.5; });
  btn(row, 'Burst 0.2 s', () => { ciwsFiring = true; ciwsBurstEnd = S.sim + 0.2; });
  const hold = btn(row, 'Hold to fire', () => { });
  hold.onmousedown = () => { ciwsFiring = true; ciwsBurstEnd = Infinity; };
  hold.onmouseup = hold.onmouseleave = () => { if (ciwsBurstEnd === Infinity) ciwsFiring = false; };
  btn(row, 'Release handle', () => { ciws?.stop(); ciws = null; ciwsFiring = false; });
  slider(pCiws, 'slew rate', 0, 2.5, 0.05, () => S.slew, (v) => (S.slew = v), (v) => v.toFixed(2) + ' rad/s');
  const n = document.createElement('div'); n.style.color = 'var(--dim)';
  n.textContent = 'Mount sits at the source position (distance / azimuth / height).';
  pCiws.appendChild(n);
}

const pRaid = section('Stress');
{
  const row = document.createElement('div'); row.className = 'btns'; pRaid.appendChild(row);
  btn(row, '20-splash salvo', () => { const p = srcPos(); for (let i = 0; i < 20; i++) eng.play('splash_small', { x: p.x + (Math.random() - 0.5) * 30, y: 0, z: p.z + (Math.random() - 0.5) * 30 }); });
  btn(row, 'Splash storm 1000/s × 3 s', () => { stormUntil = S.sim + 3; });
  btn(row, '10 booms 1–20 km', () => { for (let i = 0; i < 10; i++) { const a = Math.random() * 6.28, r = 1000 + Math.random() * 19000; eng.play('explosion_near', { x: Math.cos(a) * r, y: 200, z: Math.sin(a) * r }); } });
  btn(row, 'Ship hit (at ship)', () => eng.play('explosion_ship_hit', { x: 0, y: 8, z: 20 }));
}

const pLis = section('Listener & ambience');
slider(pLis, 'altitude', 2, 150000, 1, () => S.alt, (v) => { S.alt = v; S.env.camAlt = v; S.env.onDeck = autoDeck(); }, fmtM, true);
slider(pLis, 'offset E', 0, 30000, 1, () => Math.max(S.lisX, 0), (v) => { S.lisX = v < 6 ? 0 : v; S.env.onDeck = autoDeck(); }, fmtM);
slider(pLis, 'yaw', -180, 180, 1, () => S.yaw, (v) => (S.yaw = v), (v) => v.toFixed(0) + '°');
slider(pLis, 'sea state', 0, 6, 1, () => S.env.seaState, (v) => (S.env.seaState = v), (v) => v.toFixed(0));
slider(pLis, 'ship speed', 0, 16, 0.1, () => S.env.shipSpeed, (v) => (S.env.shipSpeed = v), (v) => v.toFixed(1) + ' m/s');
slider(pLis, 'ship fires', 0, 5, 0.1, () => S.env.shipFires, (v) => (S.env.shipFires = v), (v) => v.toFixed(1));
slider(pLis, 'night', 0, 1, 0.01, () => S.env.night, (v) => (S.env.night = v));
check(pLis, 'sinking', () => S.env.sinking, (v) => (S.env.sinking = v));
function autoDeck() { return S.alt < 60 && S.lisX < 120; }

const pStats = section('Engine');
const statsPre = document.createElement('pre'); pStats.appendChild(statsPre);
const pProbe = section('Probe (selected sound vs distance)');
const probeDiv = document.createElement('div'); pProbe.appendChild(probeDiv);

// ------------------------------------------------------------------------------------------------ actions
function playSel(name: string) {
  S.selected = name;
  const def2d = name.startsWith('ui_') || name.startsWith('alarm_');
  const p = srcPos();
  const vel = name === 'missile_flyby' ? { x: Math.cos((S.az * Math.PI) / 180) * 285, y: 0, z: Math.sin((S.az * Math.PI) / 180) * 285 } : undefined;
  eng.play(name, def2d ? null : p, { gain: S.gain, noDelay: S.noDelay, vel });
  renderProbe();
}

interface Fly { h: LoopHandle; x0: number; v: number; miss: number; len: number; t0: number; boomed: boolean; oneShot: boolean }
const flybys: Fly[] = [];
function startFlyby() {
  const h = eng.loop(S.flyLoop);
  flybys.push({ h, x0: -S.flyLen, v: S.flySpeed, miss: S.flyMiss, len: S.flyLen, t0: S.sim, boomed: false, oneShot: false });
}
function tickFlybys() {
  for (let i = flybys.length - 1; i >= 0; i--) {
    const f = flybys[i];
    const t = S.sim - f.t0;
    const x = f.x0 + f.v * t;
    const p = { x: S.lisX + x, y: Math.max(S.alt - 2, 5), z: -f.miss };
    if (x > f.len) { f.h.stop(0.5); flybys.splice(i, 1); continue; }
    f.h.set(p, { x: f.v, y: 0, z: 0 });
    // pre-rendered pass one-shot: closest approach is heard 1.5 s into the file
    if (S.flyOneShot && !f.oneShot && f.miss < 200 && f.v < 343 && x > -f.v * 1.5) { f.oneShot = true; eng.play('missile_flyby', p, { vel: { x: f.v, y: 0, z: 0 } }); }
    // sonic boom when a supersonic source passes abeam (engine delays it by propagation)
    if (!f.boomed && f.v > 343 && x >= 0) { f.boomed = true; eng.play('sonic_boom', p); }
  }
}
let stormUntil = -1;
function tickStorm(dtSim: number) {
  if (S.sim > stormUntil) return;
  const n = Math.round(1000 * dtSim);
  const c = srcPos();
  for (let i = 0; i < n; i++) eng.play('splash_small', { x: c.x + (Math.random() - 0.5) * 80, y: 0, z: c.z + (Math.random() - 0.5) * 80 });
}
function tickCiws() {
  if (!ciws && !ciwsFiring) return;
  if (!ciws) ciws = eng.ciws();
  if (ciwsFiring && S.sim >= ciwsBurstEnd) ciwsFiring = false;
  ciws.set(srcPos(), ciwsFiring, S.slew);
}

function renderProbe() {
  const ds = [5, 30, 100, 300, 1000, 3000, 10000, 20000, 30000];
  const rows = ds.map((d) => eng.probe(S.selected, d));
  const f = (x: number, n = 0) => x.toFixed(n);
  probeDiv.innerHTML = `<div style="margin-bottom:4px">${S.selected}${rows[0].farName ? ' ↔ ' + rows[0].farName : ''} · ref ${f(rows[0].ref)} m · range ${fmtM(rows[0].range)} · k ${rows[0].k.toFixed(2)}</div>
  <table><tr><th>dist</th><th>gain dB</th><th>LPF near</th><th>LPF far</th><th>near/far</th><th>send</th><th>delay</th><th>pan</th></tr>
  ${rows.map((r) => `<tr><td>${fmtM(r.dist)}</td><td>${f(20 * Math.log10(Math.max(r.gain, 1e-9)), 1)}</td><td>${f(r.cutoffNear)}</td><td>${r.farName ? f(r.cutoffFar) : '–'}</td><td>${r.nearW.toFixed(2)}/${r.farW.toFixed(2)}</td><td>${r.send.toFixed(3)}</td><td>${r.delay.toFixed(2)} s</td><td>${r.panning}</td></tr>`).join('')}</table>`;
}

// ------------------------------------------------------------------------------------------------ loop
let lastT = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  const dtSim = dt * S.scale;
  S.sim += dtSim;
  tickFlybys();
  tickStorm(dtSim);
  tickCiws();
  eng.update(dt, S.sim, S.scale, listener(), S.env);
  requestAnimationFrame(frame);
}

let statT = 0;
setInterval(() => {
  const st = eng.stats();
  statT++;
  const li = eng.loopInfo();
  const ci = eng.ciwsInfo();
  statsPre.textContent =
    `ctx ${st.ctxState} / ui ${st.uiState}   t=${st.time.toFixed(2)}  sim=${st.sim.toFixed(2)}  scale=${st.scale}  rate=${st.timeRate.toFixed(2)}${st.paused ? '  PAUSED' : ''}\n` +
    `voices ${st.voices} world · ${st.voices2d} 2D · ${st.uiVoices} ui   loops ${st.loopsReal}/${st.loops} real   pending ${st.pending}   deck ${st.deckW.toFixed(2)}\n` +
    `played ${st.counters.played} started ${st.counters.started}  dropped: cull ${st.counters.cull} rate ${st.counters.rate} budget ${st.counters.budget} scale ${st.counters.scale} queue ${st.counters.queue} · clustered ${st.counters.clustered} stolen ${st.counters.stolen}\n` +
    li.map((l) => `  loop ${l.name}: ${l.real ? 'REAL' : 'virt'} ${l.audible ? '' : '(not yet heard) '}d=${fmtM(l.dist)} doppler=${l.dop.toFixed(2)} rate=${l.rate.toFixed(2)}`).join('\n') +
    (ci.length ? `\n  ciws: ${ci.map((c) => c.state).join(', ')}` : '');
}, 200);

// ------------------------------------------------------------------------------------------------ boot
const startEl = document.getElementById('start')!;
document.getElementById('startBtn')!.onclick = () => { eng.unlock(); startEl.remove(); };
window.addEventListener('keydown', () => eng.unlock());
eng.init('/audio/').then(() => {
  const names = eng.soundNames().sort();
  for (const n of names) btn(soundRow, n, () => playSel(n));
  renderProbe();
  (window as any).__audioReady = true;
});
requestAnimationFrame(frame);
