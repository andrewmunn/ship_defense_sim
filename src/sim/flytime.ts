import * as THREE from 'three';
import { Interceptor } from './interceptor';
import { INTERCEPTORS, InterceptorType } from './specs';
import { setAltitude } from '../core/geo';
import { DEG, L, T } from '../core/constants';
import { Rng } from '../core/rng';
import type { Threat } from './threat';
import type { Track } from './radar';

/**
 * Time-of-flight tables for fire control, measured by flying the real Interceptor (its motor, drag,
 * mid-course loft and lift, pitch-over and terminal homing) at fixed points over a grid of distances
 * and elevations. The straight-ray fly-out model (flyout.ts) misses the loft into thin air and the
 * mid-course lift, so it over-estimated long shots (Halberd ~17%, Glaive ~25% at the edge of their
 * envelopes), which put intercepts, and illuminator windows, far later than they happened.
 */
const ELEVS = [0, 10, 20, 35, 50, 70, 90].map((d) => d * DEG);
const N_DIST = 26;
const DT = 1 / 30;

interface Table {
  dist: number[];
  /** t[e][i], v[e][i]: time (s) and speed (m/s) arriving at dist[i] on elevation ELEVS[e]; Infinity = can't get there. */
  t: number[][];
  v: number[][];
}

const tables = new Map<InterceptorType, Table>();

/** Fly one missile from the deck to a fixed point `d` metres away at elevation `e`. */
function fly(type: InterceptorType, d: number, e: number) {
  const launch = new THREE.Vector3(0, 12, 0);
  const p = launch.clone().add(new THREE.Vector3(Math.cos(e), Math.sin(e), 0).multiplyScalar(d));
  setAltitude(p, 12 + d * Math.sin(e));
  const still = new THREE.Vector3();
  const target = { pos: p, vel: still, alive: true, lastAccel: still, spec: { interceptPkMod: 1 } } as unknown as Threat;
  const track = { estPos: p, estVel: still, lost: false, dead: false } as unknown as Track;
  const m = new Interceptor(type, target, track, new Rng(0x51f17));
  m.pos.copy(launch);
  m.launchUp.set(0, 1, 0);
  m.vel.set(0, 25, 0);
  m.pip.copy(p);
  m.holdPip = true;
  while (m.age < T(120)) {
    const r = m.update(DT, () => true);
    if (r === 'detonate') return { t: m.age, v: m.vel.length() };
    if (r || !m.alive) break;
  }
  return { t: Infinity, v: 0 };
}

function table(type: InterceptorType): Table {
  let tb = tables.get(type);
  if (tb) return tb;
  const max = INTERCEPTORS[type].maxRange * 1.3;
  const d0 = L(400);
  // denser at short range, where time of flight bends most
  const dist = Array.from({ length: N_DIST }, (_, i) => d0 + (max - d0) * (i / (N_DIST - 1)) ** 1.5);
  const t: number[][] = [], v: number[][] = [];
  for (const e of ELEVS) {
    const te: number[] = [], ve: number[] = [];
    let reached = false, spent = false;
    for (const d of dist) {
      // Too close to turn onto is a miss too, but once a ray has been reached and then runs out of
      // energy, everything further along it is out of reach.
      const f = spent ? { t: Infinity, v: 0 } : fly(type, d, e);
      if (isFinite(f.t)) reached = true;
      else if (reached) spent = true;
      te.push(f.t);
      ve.push(f.v);
    }
    t.push(te);
    v.push(ve);
  }
  tb = { dist, t, v };
  tables.set(type, tb);
  return tb;
}

/** Build every interceptor's table now (at scenario load), rather than on the first shot mid-fight. */
export function prepareFlyTimes() {
  for (const k of Object.keys(INTERCEPTORS) as InterceptorType[]) table(k);
}

function alongRay(type: InterceptorType, tb: Table, e: number, d: number) {
  const D = tb.dist;
  if (d < D[0]) return fly(type, d, ELEVS[e]);
  let i = 0;
  while (i < D.length - 2 && d > D[i + 1]) i++;
  if (d > D[D.length - 1]) return { t: Infinity, v: 0 };
  const f = (d - D[i]) / (D[i + 1] - D[i]);
  const t0 = tb.t[e][i], t1 = tb.t[e][i + 1];
  if (f < 1e-9) return { t: t0, v: tb.v[e][i] };
  if (f > 1 - 1e-9) return { t: t1, v: tb.v[e][i + 1] };
  // At the minimum turn distance the lower point may be unreachable while the upper is valid.
  // Measure this short flight instead of interpolating Infinity or inventing reachability.
  if (!isFinite(t0) && isFinite(t1)) return fly(type, d, ELEVS[e]);
  if (!isFinite(t0) || !isFinite(t1)) return { t: Infinity, v: 0 };
  return { t: t0 + (t1 - t0) * f, v: tb.v[e][i] + (tb.v[e][i + 1] - tb.v[e][i]) * f };
}

/**
 * Fire-control time of flight: seconds for an interceptor launched now to reach a point `dist` metres
 * away at elevation `elev`, and its speed there. Infinity if it runs out of energy first.
 */
export function flyTime(type: InterceptorType, dist: number, elev: number) {
  if (!Number.isFinite(dist) || dist <= 0 || !Number.isFinite(elev)) return { t: Infinity, v: 0 };
  const tb = table(type);
  const e = Math.min(Math.max(elev, 0), ELEVS[ELEVS.length - 1]);
  let j = 0;
  while (j < ELEVS.length - 2 && e > ELEVS[j + 1]) j++;
  const w = (e - ELEVS[j]) / (ELEVS[j + 1] - ELEVS[j]);
  const a = alongRay(type, tb, j, dist), b = alongRay(type, tb, j + 1, dist);
  if (!isFinite(a.t) || !isFinite(b.t)) {
    // on the edge of the envelope: trust the nearer elevation row
    const near = w < 0.5 ? a : b;
    return isFinite(near.t) ? near : { t: Infinity, v: 0 };
  }
  return { t: a.t * (1 - w) + b.t * w, v: a.v * (1 - w) + b.v * w };
}

/** For checks: the measured flight to one point, bypassing the table. */
export function flyTimeDirect(type: InterceptorType, dist: number, elev: number) {
  return fly(type, dist, elev);
}
