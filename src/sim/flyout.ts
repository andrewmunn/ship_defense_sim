import { INTERCEPTORS, InterceptorSpec, InterceptorType } from './specs';
import { DEG, R_PLANET, T, V, densityRatio, gravityAt } from '../core/constants';

/**
 * Kinematic fly-out tables for fire control: each interceptor flown along straight rays at a few
 * elevations with its real motor, drag (exponential atmosphere) and gravity. Bastion plans intercepts
 * from these, and the mid-course uplink uses them to predict the rest of a missile's flight, so the
 * planner always agrees with the missile physics however the motors are tuned.
 */
const ELEVS = [0, 10, 20, 35, 50, 70, 90].map((d) => d * DEG);
const DT = 0.05;
const T_MAX = T(120);
/** Below this speed a missile can no longer manoeuvre usefully (it also self-destructs). */
export const MIN_USEFUL_SPEED = V(350);

interface Profile {
  /** Distance flown (m) and speed (m/s) at t = i·DT. */
  s: Float64Array;
  v: Float64Array;
}

export function motorAccel(spec: InterceptorSpec, t: number) {
  for (const [d, a] of spec.motor) {
    if (t < d) return a;
    t -= d;
  }
  return 0;
}

function build(spec: InterceptorSpec, elev: number): Profile {
  const n = Math.ceil(T_MAX / DT) + 1;
  const s = new Float64Array(n), v = new Float64Array(n);
  const sin = Math.sin(elev), cos = Math.cos(elev);
  let dist = 0, speed = 25;
  for (let i = 0; i < n; i++) {
    s[i] = dist;
    v[i] = speed;
    const t = i * DT;
    // straight ray from the deck; the planet curves away beneath it
    const h = 12 + dist * sin + (dist * cos) ** 2 / (2 * R_PLANET);
    // pops straight up out of the cell first
    const climb = t < spec.verticalTime ? 1 : sin;
    const a = motorAccel(spec, t) - spec.dragK * densityRatio(h) * speed * speed - gravityAt(h) * climb;
    speed = Math.max(1, speed + a * DT);
    dist += speed * DT;
  }
  return { s, v };
}

const tables = new Map<InterceptorType, Profile[]>();
function profiles(type: InterceptorType) {
  let p = tables.get(type);
  if (!p) {
    p = ELEVS.map((e) => build(INTERCEPTORS[type], e));
    tables.set(type, p);
  }
  return p;
}

/** Profile pair bracketing an elevation, with the blend weight. */
function bracket(type: InterceptorType, elev: number) {
  const P = profiles(type);
  const e = Math.min(Math.max(elev, 0), ELEVS[ELEVS.length - 1]);
  let j = 0;
  while (j < ELEVS.length - 2 && e > ELEVS[j + 1]) j++;
  const w = (e - ELEVS[j]) / (ELEVS[j + 1] - ELEVS[j]);
  return { a: P[j], b: P[j + 1], w };
}

function sampleAt(p: Profile, arr: Float64Array, t: number) {
  const x = Math.min(Math.max(t / DT, 0), p.s.length - 1.001);
  const i = Math.floor(x), f = x - i;
  return arr[i] + (arr[i + 1] - arr[i]) * f;
}

/** Distance flown and speed at time t after launch, along a ray at the given elevation. */
export function flyoutState(type: InterceptorType, elev: number, t: number) {
  const { a, b, w } = bracket(type, elev);
  const s = sampleAt(a, a.s, t) * (1 - w) + sampleAt(b, b.s, t) * w;
  const v = sampleAt(a, a.v, t) * (1 - w) + sampleAt(b, b.v, t) * w;
  return { s, v };
}

/**
 * Time to fly `dist` metres from launch at the given elevation, and the speed on arrival.
 * Infinity if the missile runs out of energy (below MIN_USEFUL_SPEED) first.
 */
export function flyoutTime(type: InterceptorType, dist: number, elev: number) {
  const { a, b, w } = bracket(type, elev);
  const n = a.s.length;
  let lo = 0, hi = n - 1;
  const S = (i: number) => a.s[i] * (1 - w) + b.s[i] * w;
  if (S(hi) < dist) return { t: Infinity, v: 0 };
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (S(m) < dist) lo = m;
    else hi = m;
  }
  const f = (dist - S(lo)) / Math.max(S(hi) - S(lo), 1e-6);
  const t = (lo + f) * DT;
  const v = sampleAt(a, a.v, t) * (1 - w) + sampleAt(b, b.v, t) * w;
  if (v < MIN_USEFUL_SPEED && t > INTERCEPTORS[type].motor.reduce((x, [d]) => x + d, 0)) return { t: Infinity, v };
  return { t, v };
}
