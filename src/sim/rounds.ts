import * as THREE from 'three';
import { R_PLANET, GRAVITY } from '../core/constants';

/**
 * Struct-of-arrays pool of small ballistic projectiles (20 mm CIWS rounds, 5-inch shells).
 * Positions in world meters (double precision).
 */
export class RoundPool {
  cap: number;
  n = 0;
  px: Float64Array; py: Float64Array; pz: Float64Array;
  vx: Float64Array; vy: Float64Array; vz: Float64Array;
  // previous position (for swept collision + tracer rendering)
  ox: Float64Array; oy: Float64Array; oz: Float64Array;
  age: Float32Array;
  life: Float32Array;
  owner: Int16Array;
  /** Per-round random (tracer flicker, etc.). */
  seed: Float32Array;
  alive: Uint8Array;
  /** Round id (monotonic), so renderers can keep stable per-round state. */
  uid: Uint32Array;
  private nextUid = 1;
  dragK: number;

  constructor(cap: number, dragK: number) {
    this.cap = cap;
    this.dragK = dragK;
    this.px = new Float64Array(cap); this.py = new Float64Array(cap); this.pz = new Float64Array(cap);
    this.vx = new Float64Array(cap); this.vy = new Float64Array(cap); this.vz = new Float64Array(cap);
    this.ox = new Float64Array(cap); this.oy = new Float64Array(cap); this.oz = new Float64Array(cap);
    this.age = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.owner = new Int16Array(cap);
    this.seed = new Float32Array(cap);
    this.alive = new Uint8Array(cap);
    this.uid = new Uint32Array(cap);
  }

  spawn(p: THREE.Vector3, v: THREE.Vector3, life: number, owner: number) {
    if (this.n >= this.cap) return -1;
    const i = this.n++;
    this.px[i] = this.ox[i] = p.x; this.py[i] = this.oy[i] = p.y; this.pz[i] = this.oz[i] = p.z;
    this.vx[i] = v.x; this.vy[i] = v.y; this.vz[i] = v.z;
    this.age[i] = 0;
    this.life[i] = life;
    this.owner[i] = owner;
    this.seed[i] = Math.random();
    this.alive[i] = 1;
    this.uid[i] = this.nextUid++;
    return i;
  }

  /** Integrate; gravity toward the planet centre, quadratic drag. */
  step(dt: number) {
    const k = this.dragK;
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      const x = this.px[i], y = this.py[i], z = this.pz[i];
      this.ox[i] = x; this.oy[i] = y; this.oz[i] = z;
      const cy = y + R_PLANET;
      const rr = Math.sqrt(x * x + cy * cy + z * z);
      const alt = rr - R_PLANET;
      const rho = Math.exp(-Math.max(alt, 0) / 8500);
      let vx = this.vx[i], vy = this.vy[i], vz = this.vz[i];
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const f = Math.max(0, 1 - k * rho * sp * dt);
      vx *= f; vy *= f; vz *= f;
      const g = GRAVITY * dt / rr;
      vx -= x * g; vy -= cy * g; vz -= z * g;
      this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
      this.px[i] = x + vx * dt; this.py[i] = y + vy * dt; this.pz[i] = z + vz * dt;
      this.age[i] += dt;
    }
  }

  altitude(i: number) {
    const x = this.px[i], y = this.py[i] + R_PLANET, z = this.pz[i];
    return Math.sqrt(x * x + y * y + z * z) - R_PLANET;
  }

  /** Swept test of round i against a sphere moving from c0 to c1 during the step. Returns t in [0,1] or -1. */
  sweptHit(i: number, c0: THREE.Vector3, c1: THREE.Vector3, r: number) {
    // relative motion: round moves o->p, sphere moves c0->c1: test segment (o-c0) -> (p-c1) against origin
    const ax = this.ox[i] - c0.x, ay = this.oy[i] - c0.y, az = this.oz[i] - c0.z;
    const bx = this.px[i] - c1.x, by = this.py[i] - c1.y, bz = this.pz[i] - c1.z;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const dd = dx * dx + dy * dy + dz * dz;
    let t = dd > 1e-9 ? -(ax * dx + ay * dy + az * dz) / dd : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + dx * t, cy = ay + dy * t, cz = az + dz * t;
    return cx * cx + cy * cy + cz * cz <= r * r ? t : -1;
  }

  kill(i: number) {
    this.alive[i] = 0;
  }

  /** Remove dead rounds (swap-compact). */
  compact() {
    let j = 0;
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      if (i !== j) {
        this.px[j] = this.px[i]; this.py[j] = this.py[i]; this.pz[j] = this.pz[i];
        this.vx[j] = this.vx[i]; this.vy[j] = this.vy[i]; this.vz[j] = this.vz[i];
        this.ox[j] = this.ox[i]; this.oy[j] = this.oy[i]; this.oz[j] = this.oz[i];
        this.age[j] = this.age[i]; this.life[j] = this.life[i]; this.owner[j] = this.owner[i];
        this.seed[j] = this.seed[i]; this.alive[j] = 1; this.uid[j] = this.uid[i];
      }
      j++;
    }
    this.n = j;
  }
}
