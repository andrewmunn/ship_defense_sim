import { World } from './sim/world';
import { PRESETS, cloneScenario } from './sim/scenario';
import { altitude } from './core/geo';
import type { Interceptor } from './sim/interceptor';
import { INTERCEPTORS, InterceptorType } from './sim/specs';
import { flyoutState, flyoutTime } from './sim/flyout';
import { DEG, SPEED_OF_SOUND } from './core/constants';
import * as THREE from 'three';
import { RoundPool } from './sim/rounds';
import { leadSolve } from './sim/mounts';
import { GUN_SPEC } from './sim/specs';
import { setAltitude } from './core/geo';

// Headless balance test: runs presets at full speed and prints outcomes.
const P = new URLSearchParams(location.search);
const out = document.getElementById('out')!;
const lines: string[] = [];
const log = (s: string) => { lines.push(s); out.textContent = lines.join('\n'); console.log(s); };
const only = P.get('p');
const runs = parseInt(P.get('n') ?? '1');
const verbose = P.has('v');
const trace = P.has('trace');
const gunBursts: number[] = [], gunKills: string[] = [];
const gunTargets = new Map<number, number>();
(globalThis as any).__dbg = P.has('dbg');
for (const preset of PRESETS) {
  if (only && !preset.name.toLowerCase().includes(only.toLowerCase())) continue;
  for (let r = 0; r < runs; r++) {
    const cfg = cloneScenario(preset);
    cfg.seed = 1 + r;
    const w = new World(cfg);
    if (verbose) w.events.on('log', (e) => log(`  ${e.t.toFixed(1).padStart(6)} ${e.text}`));
    // geometry/timing metrics (to check balance survives world-scale changes)
    const det: number[] = [], kills: number[] = [];
    let tDet = Infinity;
    w.events.on('track', (e) => { det.push(e.track.range); tDet = Math.min(tDet, w.t); });
    w.events.on('log', (e) => { const m = /^SPLASH .* at ([\d.]+) km/.exec(e.text); if (m) kills.push(+m[1] * 1000); });
    // ?trace: one line per interceptor (fly-out, closest approach, how it ended)
    const traced: { m: Interceptor; t0: number; r0: number; minD: number; minAt: number; vMax: number; vMin: number; altMin: number; tAltMin: number; phMin: string; done: boolean }[] = [];
    if (trace) w.events.on('interceptorLaunch', (e) => traced.push({ m: e.m, t0: w.t, r0: e.m.target.pos.distanceTo(w.ship.pos), minD: Infinity, minAt: 0, vMax: 0, vMin: Infinity, altMin: 0, tAltMin: 0, phMin: '', done: false }));
    // ?gun: how close 5" shells get to missiles (burst distance to the nearest live threat)
    if (P.has('gun')) {
      w.events.on('detonation', (e) => {
        if (e.kind !== 'shell') return;
        let d = Infinity;
        for (const th of w.threats) if (th.alive) d = Math.min(d, th.pos.distanceTo(e.pos));
        gunBursts.push(d);
      });
      w.events.on('kill', (e) => { if (e.by === 'ANVIL') gunKills.push(e.threat.spec.short); });
      w.events.on('gunFire', () => { if (!gunTargets.has(w.gunTarget!.id)) gunTargets.set(w.gunTarget!.id, w.gunTarget!.pos.distanceTo(w.ship.pos)); });
    }
    const t0 = performance.now();
    while (!w.over && w.t < 900) {
      w.step(1 / 60);
      for (const x of traced) {
        if (x.done) continue;
        const m = x.m;
        const d = m.pos.distanceTo(m.target.pos);
        const v = m.vel.length();
        x.vMax = Math.max(x.vMax, v);
        if (m.phase !== 'vertical' && m.phase !== 'turnover') x.vMin = Math.min(x.vMin, v);
        if (P.has('deep') && m.target.alive && m.alive && x.r0 > 30000 && Math.round(m.age * 60) % 15 === 0 && m.tgo < 12) {
          const los = m.target.pos.clone().sub(m.pos).normalize();
          const herr = Math.acos(Math.min(1, los.dot(m.vel.clone().normalize()))) / DEG;
          const lat = m.lastAccel.clone().addScaledVector(m.vel.clone().normalize(), -m.lastAccel.dot(m.vel.clone().normalize())).length();
          log(`      #${m.id} t=${m.age.toFixed(2)} ${m.phase} d=${d.toFixed(0)} tgo=${m.tgo.toFixed(1)} v=${m.vel.length().toFixed(0)} vt=${m.target.vel.length().toFixed(0)} herr=${herr.toFixed(1)}° lat=${(lat / 9.81).toFixed(1)}g alt=${altitude(m.pos).toFixed(0)} pipErr=${m.pip.distanceTo(m.target.pos).toFixed(0)}`);
        }
        if (d < x.minD && m.target.alive) { x.minD = d; x.minAt = m.age; x.altMin = altitude(m.pos); x.tAltMin = altitude(m.target.pos); x.phMin = m.phase; }
        if (!m.alive) {
          x.done = true;
          log(`   ${m.spec.short.padEnd(8)} → ${m.target.spec.short.padEnd(15)} launch rng ${(x.r0 / 1000).toFixed(1).padStart(5)} km · closest ${x.minD.toFixed(0).padStart(5)} m @ ${x.minAt.toFixed(1)} s (${x.phMin}, alt ${x.altMin.toFixed(0)} vs tgt ${x.tAltMin.toFixed(0)}) · v max ${x.vMax.toFixed(0)} min ${x.vMin.toFixed(0)} end ${v.toFixed(0)} · ${m.result} · ${m.phase} age ${m.age.toFixed(1)}`);
        }
      }
    }
    const s = w.stats;
    if (!w.over) for (const th of w.threats.filter((x) => x.alive)) log(`   alive: ${th.spec.short} phase ${th.phase} alt ${th.pos.y.toFixed(0)} age ${th.age.toFixed(0)} fuel ${th.fuelTime.toFixed(0)} seduced ${th.seduced} lock ${!!th.lockTarget} rng ${th.pos.distanceTo(w.ship.pos).toFixed(0)}`);
    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length / 1000 : 0).toFixed(1);
    log(`  geo: detect avg ${avg(det)} km (min ${(Math.min(...det) / 1000).toFixed(1)}) · kill avg ${avg(kills)} km (max ${(Math.max(...kills, 0) / 1000).toFixed(1)}) · first track t=${tDet.toFixed(0)} · fight ${(w.t - tDet).toFixed(0)} s`);
    log(`${preset.name.padEnd(18)} seed ${cfg.seed}: ${w.outcome || 'timeout'} t=${w.t.toFixed(0)}s launched ${s.launched} killed ${s.killed} hits ${s.hits} hp ${w.ship.hp.toFixed(0)} | by ${JSON.stringify(s.byWeapon)} fired ${JSON.stringify(s.fired)} ciws ${s.ciwsRounds} gun ${s.gunRounds} seduced ${s.decoysSeduced} sea ${s.splashedOther} res ${JSON.stringify(s.results)} | ${(performance.now() - t0).toFixed(0)} ms`);
  }
}
if (P.has('leadtest')) {
  // Fire one shell at a synthetic constant-velocity target and measure the actual miss
  for (const [range, alt, vt] of [[2000, 10, 200], [5000, 10, 200], [6000, 300, 200], [4000, 2000, 500]]) {
    const pool = new RoundPool(4, GUN_SPEC.dragK);
    const m = new THREE.Vector3(0, 10, 0), shipV = new THREE.Vector3(15, 0, 0);
    const p = new THREE.Vector3(0, 0, -range); setAltitude(p, alt);
    const v = new THREE.Vector3(0, 0, vt);
    const aim = new THREE.Vector3();
    const tof = leadSolve(m, GUN_SPEC.muzzleVel, GUN_SPEC.dragK, p, v, null, aim, shipV);
    pool.spawn(m, aim.clone().sub(m).setLength(GUN_SPEC.muzzleVel).add(shipV), 60, 0);
    let best = Infinity, bestT = 0;
    for (let t = 0; t < 40; t += 1 / 120) {
      pool.step(1 / 120);
      const tp = p.clone().addScaledVector(v, t + 1 / 120);
      const d = Math.hypot(pool.px[0] - tp.x, pool.py[0] - tp.y, pool.pz[0] - tp.z);
      if (d < best) { best = d; bestT = t + 1 / 120; }
    }
    log(`lead: range ${range} alt ${alt} v ${vt}: tof ${tof.toFixed(2)} actual ${bestT.toFixed(2)} miss ${best.toFixed(2)} m`);
  }
}
if (P.has('gun')) {
  const n = gunBursts.length;
  const within = (r: number) => gunBursts.filter((d) => d < r).length;
  log(`GUN: ${n} shells · burst within 14 m of a missile: ${within(14)} · 30 m: ${within(30)} · 100 m: ${within(100)} · kills ${gunKills.length} (${gunKills.join(', ')}) · targets engaged ${gunTargets.size}, first-shot range avg ${([...gunTargets.values()].reduce((a, b) => a + b, 0) / Math.max(1, gunTargets.size) / 1000).toFixed(1)} km`);
}
if (P.has('flyout')) {
  // Kinematic fly-out summary per interceptor: peak speed, time to range, energy-limited max range
  for (const type of Object.keys(INTERCEPTORS) as InterceptorType[]) {
    const s = INTERCEPTORS[type];
    for (const e of [0, 20, 50]) {
      let vmax = 0, tmax = 0;
      for (let t = 0; t < 60; t += 0.1) { const v = flyoutState(type, e * DEG, t).v; if (v > vmax) { vmax = v; tmax = t; } }
      const ts = [5, 10, 20, 30, 45].map((km) => { const f = flyoutTime(type, km * 1000, e * DEG); return `${km}km ${isFinite(f.t) ? f.t.toFixed(1) + 's/' + f.v.toFixed(0) : '—'}`; });
      let maxR = 0;
      for (let d = 1000; d < 200000; d += 500) { if (isFinite(flyoutTime(type, d, e * DEG).t)) maxR = d; else break; }
      log(`${s.short.padEnd(9)} el ${String(e).padStart(2)}°: vmax ${vmax.toFixed(0)} (M${(vmax / SPEED_OF_SOUND).toFixed(1)}) @ ${tmax.toFixed(1)} s · kinematic max ${(maxR / 1000).toFixed(0)} km (spec ${(s.maxRange / 1000).toFixed(0)}) · ${ts.join(' · ')}`);
    }
  }
}
log('DONE');
(window as any).__ready = true;
if (P.has('fly')) {
  // Interceptor fly-out profile vs a static far target
  const cfg = cloneScenario(PRESETS[0]);
  const w = new World(cfg);
  for (let i = 0; i < 60 * 150 && !w.interceptors.length; i++) w.step(1 / 60);
  const m = w.interceptors[0];
  if (m) {
    for (let i = 0; i < 60 * 40 && m.alive; i++) {
      w.step(1 / 60);
      if (i % 60 === 0) log(`fly t=${m.age.toFixed(1)} ${m.phase} v=${m.vel.length().toFixed(0)} alt=${(m.pos.y).toFixed(0)} rng=${m.pos.distanceTo(w.ship.pos).toFixed(0)} tgt=${m.pos.distanceTo(m.target.pos).toFixed(0)}`);
    }
  }
}
