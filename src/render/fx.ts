import * as THREE from 'three';
import { Particles, PT, ParticleSpec } from './particles';
import { Glows, Streaks } from './glows';
import type { World, DetKind } from '../sim/world';
import type { ShipView } from './shipView';
import { upAt, altitude } from '../core/geo';
import { rng } from '../core/rng';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _u = new THREE.Vector3(), _d = new THREE.Vector3();

const rv = (s: number, out = new THREE.Vector3()) => out.set(rng.gauss(), rng.gauss(), rng.gauss()).multiplyScalar(s);
/** Random unit vector biased toward up. */
function sphereDir(up: THREE.Vector3, upBias: number, out = new THREE.Vector3()) {
  out.set(rng.gauss(), rng.gauss(), rng.gauss()).normalize();
  out.addScaledVector(up, upBias).normalize();
  return out;
}

/** A short-lived light (explosions, muzzle flashes) that the lighting pool may pick up. */
interface Flash {
  pos: THREE.Vector3;
  color: THREE.Color;
  intensity: number; // peak (candela-ish)
  range: number;
  t0: number;
  dur: number;
  /** ship-attached: position given in ship local space */
  local?: THREE.Vector3;
}

/** Visual effects driven by sim events and continuous state. All times are sim time. */
export class Fx {
  group = new THREE.Group();
  private lights: THREE.PointLight[] = [];
  private flashes: Flash[] = [];
  /** Ocean explosion light uniforms (xyz rel grid, w = radius) — filled by update(). */
  oceanLights: { pos: THREE.Vector3; color: THREE.Color; radius: number }[] = [];
  /** Screen shake requests (consumed by the game). */
  shake = 0;
  /** Recent notable events for the cinematic director. */
  onBig: (pos: THREE.Vector3, kind: string, size: number) => void = () => {};
  private ciwsFlashAcc = [0, 0];
  private smokeAcc = 0;

  constructor(private world: World, private ship: ShipView, private particles: Particles, private glows: Glows, private streaks: Streaks) {
    for (let i = 0; i < 6; i++) {
      const L = new THREE.PointLight(0xffaa66, 0, 100, 2);
      L.castShadow = false;
      this.lights.push(L);
      this.group.add(L);
    }
    this.bind();
  }

  private spawn(s: ParticleSpec) {
    this.particles.spawn(s);
  }

  private addFlash(pos: THREE.Vector3, color: [number, number, number], intensity: number, range: number, dur: number, local?: THREE.Vector3) {
    this.flashes.push({ pos: pos.clone(), color: new THREE.Color(...color), intensity, range, t0: this.world.t, dur, local: local?.clone() });
    if (this.flashes.length > 64) this.flashes.shift();
  }

  private bind() {
    const W = this.world;
    const ev = W.events;
    ev.on('detonation', (e) => this.detonation(e.pos, e.vel, e.kind, e.size));
    ev.on('splash', (e) => this.splash(e.pos, e.size));
    ev.on('ciwsHit', (e) => {
      const p = e.pos;
      this.spawn({ pos: p.clone(), life: 0.08, size0: 1.2, size1: 3, color: [1, 0.85, 0.6], alpha: 30, type: PT.FLASH });
      for (let i = 0; i < 10; i++) this.spawn({ pos: p.clone(), vel: rv(80).add(_v.copy(e.threat.vel).multiplyScalar(0.7)), life: 0.4 + rng.next() * 0.5, size0: 0.25, size1: 0.1, drag: 1, gravity: 9.8, color: [1, 0.8, 0.5], alpha: 6, type: PT.SPARK });
      this.spawn({ pos: p.clone(), vel: _v.copy(e.threat.vel).multiplyScalar(0.4), life: 3, size0: 0.6, size1: 4, drag: 2, color: [0.3, 0.3, 0.3], alpha: 0.5, type: PT.SMOKE });
    });
    ev.on('gunFire', (e) => this.gunFire(e.pos, e.dir));
    ev.on('interceptorLaunch', (e) => this.vlsLaunch(e.cell, e.m.spec.type));
    ev.on('threatLaunch', (e) => this.threatLaunch(e.threat.pos, e.threat.vel));
    ev.on('boosterSep', (e) => {
      const p = e.debris.pos;
      this.spawn({ pos: p.clone(), vel: e.from.vel.clone().multiplyScalar(0.8), life: 0.3, size0: 1, size1: 5, color: [1, 0.7, 0.4], alpha: 10, type: PT.FLASH });
      for (let i = 0; i < 5; i++) this.spawn({ pos: p.clone(), vel: e.from.vel.clone().multiplyScalar(0.5).add(rv(5)), life: 6, size0: 1, size1: 6, drag: 1.5, color: [0.75, 0.73, 0.7], alpha: 0.5, type: PT.SMOKE });
    });
    ev.on('decoy', (e) => {
      const p = e.from;
      this.spawn({ pos: p.clone(), life: 0.12, size0: 0.5, size1: 3.5, color: [1, 0.8, 0.5], alpha: 25, type: PT.FLASH });
      for (let i = 0; i < 6; i++) this.spawn({ pos: p.clone(), vel: e.decoy.vel.clone().multiplyScalar(0.15).add(rv(2)), life: 5, size0: 0.6, size1: 4, drag: 2, rise: 1, color: [0.75, 0.75, 0.75], alpha: 0.55, type: PT.SMOKE });
      this.addFlash(p, [1, 0.7, 0.4], 800, 60, 0.15);
    });
    ev.on('shipHit', (e) => {
      this.shake += 2.5;
      this.onBig(e.world, 'shipHit', e.damage);
    });
  }

  // ------------------------------------------------------------------ recipes
  detonation(pos: THREE.Vector3, vel: THREE.Vector3, kind: DetKind, size: number) {
    upAt(pos, _u);
    const up = _u.clone();
    const alt = altitude(pos);
    const s = Math.cbrt(Math.max(size, 1) / 60); // scale relative to a ~60 kg warhead
    switch (kind) {
      case 'intercept':
      case 'selfdestruct':
      case 'shell': {
        const k = kind === 'shell' ? 0.45 : kind === 'selfdestruct' ? 0.7 : 1;
        // the burst keeps only a little of the interceptor's closing momentum
        const cv = _v3.copy(vel).multiplyScalar(0.08);
        this.spawn({ pos: pos.clone(), vel: cv.clone(), life: 0.09, size0: 3 * k, size1: 14 * k, color: [1, 0.85, 0.6], alpha: 9, type: PT.FLASH });
        this.spawn({ pos: pos.clone(), vel: cv.clone(), life: 0.12, size0: 2 * k, size1: 26 * k, color: [1, 0.95, 0.85], alpha: 0.25, type: PT.SHOCK });
        // tight fireball: overlapping, fast-growing, hot core
        const nf = Math.round(9 * k) + 2;
        for (let i = 0; i < nf; i++)
          this.spawn({ pos: _v.copy(pos).add(rv(0.8 * k)), vel: rv(6 * k).add(cv), life: 0.7 + rng.next() * 0.5, size0: 2 * k, size1: (7 + rng.next() * 4) * k, drag: 5, rise: 1.5, color: [1, 0.92, 0.82], alpha: 2.6, type: PT.FIRE, param: 0.32 });
        // one merged smoke mass: many overlapping puffs, slow drift, long life
        const ns = Math.round(22 * k);
        for (let i = 0; i < ns; i++)
          this.spawn({ pos: _v.copy(pos).add(rv(1.6 * k)), vel: rv(3.5 * k).add(cv), life: 35 + rng.next() * 25, size0: 5 * k, size1: (22 + rng.next() * 14) * k, drag: 0.9, rise: 0.5, color: kind === 'shell' ? [0.2, 0.19, 0.18] : [0.26, 0.245, 0.23], alpha: 0.65, type: PT.SMOKE, delay: 0.05 + rng.next() * 0.15 });
        // warhead fragments: fast glowing sparks with varied length
        const nfr = Math.round(34 * k);
        for (let i = 0; i < nfr; i++)
          this.spawn({ pos: pos.clone(), vel: sphereDir(up, 0, _d).multiplyScalar(120 + rng.next() * 380).add(cv), life: 0.15 + rng.next() * 0.45, size0: 0.12 + rng.next() * 0.25, size1: 0.06, drag: 1.5, gravity: 9.8, color: [1, 0.62, 0.3], alpha: 3 + rng.next() * 3, type: PT.SPARK });
        // a few burning pieces trailing smoke tendrils (airframe + interceptor debris)
        if (kind !== 'shell') this.addFragments(pos, _v2.copy(vel).multiplyScalar(0.25), up, Math.round(4 + 4 * k), 40, 110, 0.6);
        this.addFlash(pos, [1, 0.7, 0.4], 5e4 * k, 900 * k, 0.4);
        if (kind !== 'shell') this.onBig(pos, kind, size);
        break;
      }
      case 'warhead': {
        // The target's own warhead goes off (hard kill): big fireball + black smoke
        const cv = _v3.copy(vel).multiplyScalar(0.1);
        this.spawn({ pos: pos.clone(), vel: cv.clone(), life: 0.14, size0: 6 * s, size1: 30 * s, color: [1, 0.8, 0.55], alpha: 12, type: PT.FLASH });
        this.spawn({ pos: pos.clone(), vel: cv.clone(), life: 0.15, size0: 4, size1: 45 * s, color: [1, 0.95, 0.85], alpha: 0.25, type: PT.SHOCK });
        for (let i = 0; i < 22; i++)
          this.spawn({ pos: _v.copy(pos).add(rv(2 * s)), vel: rv(12 * s).add(cv), life: 1.2 + rng.next() * 1.0, size0: 4 * s, size1: (13 + rng.next() * 6) * s, drag: 3.5, rise: 5, color: [1, 0.88, 0.75], alpha: 2.6, type: PT.FIRE, param: 0.42 });
        for (let i = 0; i < 34; i++)
          this.spawn({ pos: _v.copy(pos).add(rv(3 * s)), vel: rv(6 * s).add(cv), life: 45 + rng.next() * 30, size0: 7 * s, size1: (34 + rng.next() * 20) * s, drag: 0.8, rise: 1.6, color: [0.13, 0.12, 0.11], alpha: 0.75, type: PT.SMOKE, delay: 0.12 + rng.next() * 0.35 });
        for (let i = 0; i < 70; i++)
          this.spawn({ pos: pos.clone(), vel: sphereDir(up, 0.2, _d).multiplyScalar(80 + rng.next() * 250).add(cv), life: 0.4 + rng.next() * 1.2, size0: 0.15 + rng.next() * 0.3, size1: 0.08, drag: 1.2, gravity: 9.8, color: [1, 0.6, 0.3], alpha: 4 + rng.next() * 3, type: PT.SPARK });
        this.addFragments(pos, _v2.copy(vel).multiplyScalar(0.3), up, 10, 50, 140, 1);
        this.addFlash(pos, [1, 0.62, 0.3], 2e5 * s, 2000 * s, 0.6);
        if (alt < 35) this.waterColumn(pos, 0.8 + s * 0.8, false);
        else if (alt < 80) this.waterSurge(pos, 18 * s, 0.6);
        this.onBig(pos, 'warhead', size);
        break;
      }
      case 'breakup': {
        const cv = _v3.copy(vel).multiplyScalar(0.4);
        this.spawn({ pos: pos.clone(), vel: cv.clone(), life: 0.1, size0: 3, size1: 12, color: [1, 0.8, 0.5], alpha: 10, type: PT.FLASH });
        for (let i = 0; i < 30; i++)
          this.spawn({ pos: pos.clone(), vel: rv(50).add(cv), life: 0.6 + rng.next() * 1.5, size0: 0.15 + rng.next() * 0.25, size1: 0.1, drag: 0.8, gravity: 9.8, color: [1, 0.7, 0.4], alpha: 5, type: PT.SPARK });
        for (let i = 0; i < 10; i++)
          this.spawn({ pos: _v.copy(pos).add(rv(1.5)), vel: rv(4).add(cv), life: 18, size0: 3, size1: 16, drag: 1.2, rise: 0.8, color: [0.16, 0.15, 0.14], alpha: 0.6, type: PT.SMOKE });
        this.addFragments(pos, cv, up, 4, 30, 80, 0.5);
        this.addFlash(pos, [1, 0.6, 0.3], 1e4, 400, 0.25);
        this.onBig(pos, 'breakup', size);
        break;
      }
      case 'water': {
        // Missile hits the sea (seduced / out of fuel / clipped a wave): column + surge
        this.waterColumn(pos, 1.0 + s * 0.6, true);
        this.onBig(pos, 'water', size);
        break;
      }
      case 'shipHit': {
        const k = Math.max(1, s);
        this.spawn({ pos: pos.clone(), life: 0.3, size0: 14 * k, size1: 70 * k, color: [1, 0.78, 0.5], alpha: 20, type: PT.FLASH });
        this.spawn({ pos: pos.clone(), life: 0.18, size0: 8, size1: 90 * k, color: [1, 0.95, 0.85], alpha: 0.3, type: PT.SHOCK });
        for (let i = 0; i < 40; i++)
          this.spawn({ pos: _v.copy(pos).add(rv(3)), vel: sphereDir(up, 0.8, _d).multiplyScalar(12 + rng.next() * 22 * k), life: 1.5 + rng.next() * 1.5, size0: 5 * k, size1: (16 + rng.next() * 10) * k, drag: 2.5, rise: 6, color: [1, 0.9, 0.8], alpha: 2.8, type: PT.FIRE, param: 0.45 });
        this.addFragments(pos, new THREE.Vector3(), up, 12, 30, 90, 1.2);
        for (let i = 0; i < 40; i++)
          this.spawn({ pos: _v.copy(pos).add(rv(5)), vel: sphereDir(up, 1.2, _d).multiplyScalar(8 + rng.next() * 18), life: 35 + rng.next() * 25, size0: 8, size1: 55 * k, drag: 0.9, rise: 4, color: [0.07, 0.065, 0.06], alpha: 0.92, type: PT.SMOKE, delay: 0.2 + rng.next() * 0.6 });
        for (let i = 0; i < 200; i++)
          this.spawn({ pos: pos.clone(), vel: sphereDir(up, 0.6, _d).multiplyScalar(60 + rng.next() * 260), life: 1 + rng.next() * 2.5, size0: 0.5, size1: 0.2, drag: 0.8, gravity: 9.8, color: [1, 0.7, 0.4], alpha: 8, type: PT.SPARK });
        // Hang the light a few metres off the hull, out and up from the hit. Right on the plating the
        // point light's 1/d² (capped at 100×) drives the hull past the half-float HDR range → Inf,
        // which the post chain turns into NaN and bloom smears over the whole frame (black screen).
        const out = _d.copy(pos).sub(this.world.ship.pos);
        out.addScaledVector(up, -out.dot(up));
        if (out.lengthSq() > 1e-6) out.normalize();
        this.addFlash(_v.copy(pos).addScaledVector(out, 4).addScaledVector(up, 3), [1, 0.55, 0.25], 5e5 * k, 2500, 1.2);
        this.waterSurge(pos, 25, 0.7);
        break;
      }
      case 'debris': {
        this.splash(pos, 2);
        break;
      }
    }
  }

  /** Burning debris pieces on ballistic arcs, each laying a smoke tendril (the classic airburst "octopus"). */
  private frags: { p: THREE.Vector3; v: THREE.Vector3; life: number; age: number; acc: number; heat: number }[] = [];
  addFragments(pos: THREE.Vector3, vel: THREE.Vector3, up: THREE.Vector3, n: number, vMin: number, vMax: number, heat: number) {
    for (let i = 0; i < n; i++) {
      const d = sphereDir(up, 0.35, new THREE.Vector3());
      this.frags.push({ p: pos.clone(), v: d.multiplyScalar(vMin + rng.next() * (vMax - vMin)).add(vel), life: 2 + rng.next() * 3, age: 0, acc: 0, heat });
    }
    if (this.frags.length > 160) this.frags.splice(0, this.frags.length - 160);
  }
  private stepFragments(dt: number) {
    if (dt <= 0) return;
    for (const f of this.frags) {
      f.age += dt;
      upAt(f.p, _u);
      f.v.addScaledVector(_u, -9.8 * dt).multiplyScalar(Math.max(0, 1 - 0.35 * dt));
      f.p.addScaledVector(f.v, dt);
      f.acc += f.v.length() * dt;
      const a = 1 - f.age / f.life;
      let back = 0;
      while (f.acc > 1.4) {
        f.acc -= 1.4;
        back += 1.4;
        this.spawn({ pos: _v.copy(f.v).normalize().multiplyScalar(-back).add(f.p), vel: _v2.copy(f.v).multiplyScalar(0.04), life: 8 + rng.next() * 8, size0: 1.2, size1: 5 + rng.next() * 4, drag: 1.5, rise: 0.5, color: [0.22, 0.21, 0.2], alpha: 0.32 * a + 0.08, type: PT.SMOKE });
      }
      if (f.heat > 0) this.glows.add(f.p, 0.6, 12 * a * f.heat, 5 * a * f.heat, 1.5 * a * f.heat, 1.4);
      if (altitude(f.p) < 0) f.age = f.life;
    }
    this.frags = this.frags.filter((f) => f.age < f.life);
  }

  /** Big white water column with collapsing curtain + surge ring. */
  waterColumn(pos: THREE.Vector3, k: number, explode: boolean) {
    upAt(pos, _u);
    const up = _u.clone();
    const base = pos.clone();
    const a = altitude(base);
    base.addScaledVector(up, -a + 0.2);
    if (explode) {
      this.spawn({ pos: base.clone(), life: 0.18, size0: 6 * k, size1: 28 * k, color: [1, 0.8, 0.55], alpha: 10, type: PT.FLASH });
      this.addFlash(base, [1, 0.65, 0.35], 5e4 * k, 1200, 0.3);
    }
    for (let i = 0; i < 60; i++) {
      const h = rng.next();
      const out = rv(1).addScaledVector(up, -rv(1).dot(up));
      this.spawn({ pos: _v.copy(base).addScaledVector(out, 2 * k), vel: _v2.copy(up).multiplyScalar((25 + 45 * h) * k).addScaledVector(out, (4 + 10 * (1 - h)) * k), life: 3 + h * 3, size0: 3 * k, size1: (10 + 10 * h) * k, drag: 0.5, gravity: 9.8, color: [0.92, 0.95, 0.97], alpha: 0.7, type: PT.SPRAY, delay: h * 0.2 });
    }
    // mist
    for (let i = 0; i < 16; i++)
      this.spawn({ pos: _v.copy(base).add(rv(6 * k)), vel: rv(4).addScaledVector(up, 10 * k), life: 10, size0: 8 * k, size1: 40 * k, drag: 1, rise: 1.5, color: [0.9, 0.93, 0.95], alpha: 0.35, type: PT.STEAM, delay: 0.4 + rng.next() });
    this.waterSurge(pos, 16 * k, 0.9);
  }

  /** Radial spray ring at the waterline. */
  waterSurge(pos: THREE.Vector3, r: number, a: number) {
    upAt(pos, _u);
    const up = _u.clone();
    const base = pos.clone().addScaledVector(up, -altitude(pos) + 0.3);
    for (let i = 0; i < 24; i++) {
      const out = rv(1).addScaledVector(up, -rv(1).dot(up)).normalize();
      this.spawn({ pos: _v.copy(base).addScaledVector(out, r * 0.2), vel: _v2.copy(out).multiplyScalar(r * 1.4).addScaledVector(up, r * 0.5), life: 2.5, size0: r * 0.2, size1: r * 0.6, drag: 1.2, gravity: 6, color: [0.92, 0.95, 0.97], alpha: 0.5 * a, type: PT.SPRAY });
    }
    this.foamBursts.push({ pos: base.clone(), r: r * 1.5, t: this.world.t });
  }
  /** Foam patches for the ocean foam map (consumed by the wake renderer). */
  foamBursts: { pos: THREE.Vector3; r: number; t: number }[] = [];

  splash(pos: THREE.Vector3, size: number) {
    upAt(pos, _u);
    const base = _v.copy(pos).addScaledVector(_u, -altitude(pos) + 0.1).clone();
    if (size < 0.5) {
      // 20 mm round / fragment: thin spout
      this.spawn({ pos: base, vel: _v2.copy(_u).multiplyScalar(9 + rng.next() * 6), life: 1.2, size0: 0.3, size1: 1.6, drag: 0.6, gravity: 9.8, color: [0.9, 0.93, 0.95], alpha: 0.55, type: PT.SPRAY });
      return;
    }
    const k = Math.sqrt(size);
    for (let i = 0; i < 10 * k; i++)
      this.spawn({ pos: base.clone(), vel: _v2.copy(_u).multiplyScalar((8 + rng.next() * 12) * k).add(rv(2 * k)), life: 1.5 + rng.next() * 1.5, size0: 0.7 * k, size1: 3 * k, drag: 0.6, gravity: 9.8, color: [0.9, 0.93, 0.95], alpha: 0.6, type: PT.SPRAY });
    if (size >= 1.5) this.foamBursts.push({ pos: base.clone(), r: 4 * k, t: this.world.t });
  }

  gunFire(pos: THREE.Vector3, dir: THREE.Vector3) {
    this.spawn({ pos: pos.clone().addScaledVector(dir, 2), vel: this.world.ship.vel.clone(), life: 0.1, size0: 2.5, size1: 8, color: [1, 0.8, 0.5], alpha: 16, type: PT.FLASH });
    for (let i = 0; i < 10; i++) {
      const d = dir.clone().multiplyScalar(20 + rng.next() * 50).add(rv(6)).add(this.world.ship.vel);
      this.spawn({ pos: pos.clone().addScaledVector(dir, 1.5), vel: d, life: 4 + rng.next() * 3, size0: 1, size1: 7, drag: 3.5, rise: 0.6, color: [0.8, 0.79, 0.76], alpha: 0.55, type: PT.SMOKE });
    }
    for (let i = 0; i < 5; i++) this.spawn({ pos: pos.clone().addScaledVector(dir, 1), vel: dir.clone().multiplyScalar(30).add(rv(8)).add(this.world.ship.vel), life: 0.3, size0: 1.2, size1: 3, drag: 6, color: [1, 1, 1], alpha: 3, type: PT.FIRE, param: 0.6 });
    this.addFlash(pos.clone().addScaledVector(dir, 3), [1, 0.7, 0.4], 4000, 250, 0.12);
    this.shake += 0.25;
  }

  vlsLaunch(cell: number, type: string) {
    this.ship.openHatch(cell, this.world.t + 0.0);
    const W = this.world;
    const cells = [...W.layout.vlsFwd, ...W.layout.vlsAft];
    const local = cells[cell];
    if (!local) return;
    const p = this.ship.toWorld(local, new THREE.Vector3());
    upAt(p, _u);
    const up = _u.clone();
    const sv = W.ship.vel.clone();
    const big = type === 'glaive' ? 1.4 : type === 'stiletto' ? 0.8 : 1;
    // Ignition: fire and exhaust blasts out of the cell and the module uptake
    this.spawn({ pos: p.clone().addScaledVector(up, 1), vel: sv, life: 0.3, size0: 3, size1: 9 * big, color: [1, 0.75, 0.45], alpha: 12, type: PT.FLASH });
    for (let i = 0; i < 14; i++)
      this.spawn({ pos: p.clone().addScaledVector(up, 0.5), vel: _v.copy(up).multiplyScalar(10 + rng.next() * 25).add(rv(6)).add(sv), life: 0.6 + rng.next() * 0.4, size0: 1.5, size1: 5 * big, drag: 3, rise: 3, color: [1, 1, 1], alpha: 3.5, type: PT.FIRE, param: 0.5, delay: rng.next() * 0.3 });
    // billowing launch smoke that rolls across the deck and drifts downwind
    for (let i = 0; i < 46; i++) {
      const out = rv(1).addScaledVector(up, -rv(1).dot(up));
      const h = rng.next();
      this.spawn({ pos: _v.copy(p).addScaledVector(up, 0.5 + h * 6), vel: _v2.copy(out).multiplyScalar(3 + rng.next() * 9).addScaledVector(up, 2 + h * 16).add(sv), life: 10 + rng.next() * 10, size0: 4, size1: (16 + rng.next() * 18) * big, drag: 1.1, rise: 1.0, color: [0.8, 0.79, 0.77], alpha: 0.55, type: PT.SMOKE, delay: h * 1.1 });
    }
    this.addFlash(p.clone().addScaledVector(up, 3), [1, 0.7, 0.4], 6000 * big, 400, 1.1, local.clone().add(new THREE.Vector3(0, 3, 0)));
    this.shake += 0.35;
    this.onBig(p, 'vls', 1);
  }

  threatLaunch(pos: THREE.Vector3, vel: THREE.Vector3) {
    upAt(pos, _u);
    const up = _u.clone();
    this.spawn({ pos: pos.clone(), life: 0.4, size0: 4, size1: 18, color: [1, 0.75, 0.45], alpha: 14, type: PT.FLASH });
    // dust + smoke cloud kicked up around the TEL
    const ground = pos.clone().addScaledVector(up, -3);
    for (let i = 0; i < 40; i++) {
      const out = rv(1).addScaledVector(up, -rv(1).dot(up)).normalize();
      this.spawn({ pos: _v.copy(ground).addScaledVector(out, rng.next() * 6), vel: _v2.copy(out).multiplyScalar(6 + rng.next() * 18).addScaledVector(up, 1 + rng.next() * 6).addScaledVector(vel, -0.05), life: 14 + rng.next() * 10, size0: 3, size1: 22 + rng.next() * 16, drag: 1.1, rise: 1, color: [0.62, 0.56, 0.47], alpha: 0.7, type: PT.SMOKE, delay: rng.next() * 0.8 });
    }
    for (let i = 0; i < 12; i++)
      this.spawn({ pos: pos.clone(), vel: vel.clone().multiplyScalar(-0.2).add(rv(6)), life: 0.8, size0: 2, size1: 7, drag: 3, rise: 2, color: [1, 1, 1], alpha: 3.5, type: PT.FIRE, param: 0.5 });
    this.addFlash(pos, [1, 0.7, 0.4], 3e4, 900, 1.0);
    this.onBig(pos, 'threatLaunch', 1);
  }

  // ------------------------------------------------------------------ per-frame
  update(dtSim: number, cam: THREE.Camera, viewportH: number) {
    const W = this.world;
    const t = W.t;
    const ship = W.ship;
    void viewportH;
    this.stepFragments(dtSim);
    // CIWS rounds as glowing tracers (every round rendered; brighter every 5th "tracer")
    const R = W.ciwsRounds;
    for (let i = 0; i < R.n; i++) {
      if (!R.alive[i]) continue;
      const tr = R.uid[i] % 5 === 0;
      const vx = R.vx[i], vy = R.vy[i], vz = R.vz[i];
      const L = tr ? 0.016 : 0.009;
      const x1 = R.px[i], y1 = R.py[i], z1 = R.pz[i];
      const fade = Math.max(0, 1 - R.age[i] / 4.5);
      const I = (tr ? 26 : 7) * fade;
      this.streaks.add(x1 - vx * L, y1 - vy * L, z1 - vz * L, x1, y1, z1, tr ? 0.16 : 0.07, I, 1.0, 0.55, 0.22, tr ? 2.4 : 1.2);
    }
    // 5-inch shells: bright fuzed rounds with a visible glow
    const S = W.shells;
    for (let i = 0; i < S.n; i++) {
      if (!S.alive[i]) continue;
      const L = 0.02;
      this.streaks.add(S.px[i] - S.vx[i] * L, S.py[i] - S.vy[i] * L, S.pz[i] - S.vz[i] * L, S.px[i], S.py[i], S.pz[i], 0.3, 10, 1, 0.6, 0.3, 1.6);
    }

    // CIWS muzzle flashes + smoke while firing
    W.ciws.forEach((c, idx) => {
      if (!c.firing) return;
      const muzzle = this.ship.partWorld(idx === 0 ? 'ciws_fwd_muzzle' : 'ciws_aft_muzzle', _v);
      const fl = 0.6 + rng.next() * 0.8;
      this.glows.add(muzzle.addScaledVector(c.worldDir, 0.6), 1.3 * fl, 16 * fl, 9 * fl, 4 * fl, 3);
      // muzzle blast: a short, bright, forward-thrown flash each few rounds
      if (rng.chance(0.5)) this.spawn({ pos: muzzle.clone().addScaledVector(c.worldDir, 0.8), vel: _v2.copy(c.worldDir).multiplyScalar(30).add(ship.vel), life: 0.03, size0: 1.2, size1: 2.8, color: [1, 0.75, 0.4], alpha: 10, type: PT.FLASH });
      this.ciwsFlashAcc[idx] += dtSim;
      if (this.ciwsFlashAcc[idx] > 0.05) {
        this.ciwsFlashAcc[idx] = 0;
        this.addFlash(muzzle, [1, 0.7, 0.4], 250, 60, 0.06);
        this.spawn({ pos: muzzle.clone().addScaledVector(c.worldDir, 1.5), vel: _v2.copy(c.worldDir).multiplyScalar(22).add(ship.vel).add(rv(2)), life: 5 + rng.next() * 3, size0: 1.2, size1: 9 + rng.next() * 5, drag: 2.2, rise: 0.8, color: [0.72, 0.71, 0.69], alpha: 0.28, type: PT.SMOKE });
        // spent links / cases? (Phalanx retains them) — occasional muzzle sparks instead
        if (rng.chance(0.5)) this.spawn({ pos: muzzle.clone(), vel: _v2.copy(c.worldDir).multiplyScalar(60).add(rv(15)).add(ship.vel), life: 0.15, size0: 0.2, size1: 0.1, color: [1, 0.8, 0.5], alpha: 5, type: PT.SPARK });
      }
    });

    // Ship fires (damage): fire + thick black smoke plumes from each fire point
    if (dtSim > 0) {
      for (const f of ship.fires) {
        const p = this.ship.toWorld(f.local, _v);
        upAt(p, _u);
        const rate = 18 * f.intensity;
        const n = Math.floor(rate * dtSim + rng.next());
        for (let i = 0; i < n; i++) {
          this.spawn({ pos: _v2.copy(p).add(rv(1.2)), vel: _d.copy(ship.vel).addScaledVector(_u, 1 + rng.next() * 2).add(rv(0.6)), life: 0.7 + rng.next() * 0.5, size0: 1.5 + f.intensity * 1.5, size1: 2.5 + 3.5 * f.intensity, drag: 1, rise: 2, color: [1, 0.95, 0.9], alpha: 2.2, type: PT.FLAME });
          if (rng.chance(0.3)) this.spawn({ pos: _v2.copy(p).addScaledVector(_u, 2).add(rv(1)), vel: _d.copy(ship.vel).addScaledVector(_u, 5).add(rv(1)), life: 1.0, size0: 2, size1: 5 + 3 * f.intensity, drag: 2, rise: 5, color: [1, 0.9, 0.8], alpha: 1.6, type: PT.FIRE, param: 0.4 });
          this.spawn({ pos: _v2.copy(p).addScaledVector(_u, 3).add(rv(1)), vel: _d.copy(ship.vel).multiplyScalar(0.2).addScaledVector(_u, 6 + rng.next() * 4), life: 28 + rng.next() * 16, size0: 4, size1: 30 + 20 * f.intensity, drag: 0.7, rise: 5, color: [0.11, 0.1, 0.095], alpha: 0.85, type: PT.SMOKE });
        }
        this.addFlash(p, [1, 0.5, 0.2], 1500 * f.intensity * (0.8 + 0.4 * rng.next()), 60, 0.05, f.local);
      }
      // Stack exhaust haze (gas turbines): faint, warm-grey, subtle
      this.smokeAcc += dtSim;
      if (this.smokeAcc > 0.25) {
        this.smokeAcc = 0;
        for (const ex of this.ship.exhausts) {
          const p = this.ship.toWorld(ex, _v);
          upAt(p, _u);
          this.spawn({ pos: p.clone(), vel: _d.copy(ship.vel).multiplyScalar(0.3).addScaledVector(_u, 5), life: 9, size0: 1.2, size1: 12, drag: 1.2, rise: 1.5, color: [0.55, 0.54, 0.52], alpha: 0.05, type: PT.SMOKE });
        }
      }
    }

    // Lighting pool: pick the strongest active flashes near the camera
    const cand: { f: Flash; w: number; I: number; p: THREE.Vector3 }[] = [];
    this.flashes = this.flashes.filter((f) => t - f.t0 < f.dur);
    for (const f of this.flashes) {
      const a = (t - f.t0) / f.dur;
      const I = f.intensity * (1 - a) * (1 - a);
      const p = f.local ? this.ship.toWorld(f.local, new THREE.Vector3()) : f.pos;
      const d = p.distanceTo(cam.position);
      cand.push({ f, I, p, w: I / (d * d + 100) });
    }
    cand.sort((a, b) => b.w - a.w);
    // NB: the pool lights stay visible permanently (intensity 0 when idle). Toggling visibility
    // changes the scene's light count, which forces every lit material to recompile its shader.
    this.lights.forEach((L, i) => {
      const c = cand[i];
      if (!c) {
        L.intensity = 0;
        return;
      }
      L.position.copy(c.p);
      L.color.copy(c.f.color);
      L.intensity = c.I;
      L.distance = c.f.range * 2;
    });
    this.oceanLights = cand.slice(0, 4).map((c) => {
      const r = c.f.range * 0.3;
      // colour = illuminance at distance r (the shader's attenuation is normalised to 1 there)
      return { pos: c.p, color: c.f.color.clone().multiplyScalar((c.I / (r * r)) * 2.2), radius: r };
    });

    // decay foam bursts
    this.foamBursts = this.foamBursts.filter((b) => t - b.t < 40);
  }
}
