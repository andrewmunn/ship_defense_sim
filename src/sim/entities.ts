import * as THREE from 'three';
import type { Trackable } from '../camera/cameraRig';
import { upAt, setAltitude, bearingDir, altitude, enuAt } from '../core/geo';
import { RHO0, densityRatio, gravityAt } from '../core/constants';
import type { WaveField } from './waves';

let nextId = 1;
export type EntityKind = 'ship' | 'threat' | 'interceptor' | 'shell' | 'decoy' | 'launcher' | 'debris';

export abstract class Entity implements Trackable {
  id = nextId++;
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  quat = new THREE.Quaternion();
  alive = true;
  radius = 1;
  age = 0;
  name = '';
  abstract kind: EntityKind;
  /** Remove from world on next cleanup. */
  remove = false;
}

const _u = new THREE.Vector3(), _f = new THREE.Vector3(), _x = new THREE.Vector3(), _m = new THREE.Matrix4();

/** Orient a +Z-forward object along v with the local planet up as reference. */
export function quatFromVelocity(pos: THREE.Vector3, v: THREE.Vector3, out: THREE.Quaternion, roll = 0) {
  if (v.lengthSq() < 1e-6) return out;
  upAt(pos, _u);
  _f.copy(v).normalize();
  _x.crossVectors(_u, _f);
  if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0);
  _x.normalize();
  const y = new THREE.Vector3().crossVectors(_f, _x);
  _m.makeBasis(_x, y, _f);
  out.setFromRotationMatrix(_m);
  if (roll) out.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll));
  return out;
}

export function airDensity(alt: number) {
  return RHO0 * densityRatio(alt);
}

export interface HitBox {
  center: THREE.Vector3;
  half: THREE.Vector3;
  zone: 'fwd' | 'mid' | 'aft';
}

export interface FirePoint {
  local: THREE.Vector3;
  intensity: number;
  age: number;
}

export class Ship extends Entity {
  kind = 'ship' as const;
  heading = 0; // radians (bearing)
  speed = 10; // m/s
  targetSpeed = 10;
  targetHeading = 0;
  hp = 100;
  maxHp = 100;
  // wave motion (radians / m)
  heave = 0;
  pitch = 0;
  roll = 0;
  rollVel = 0;
  pitchVel = 0;
  heaveVel = 0;
  list = 0;
  trim = 0;
  sinking = false;
  sunk = false;
  sinkDepth = 0;
  fires: FirePoint[] = [];
  damage = { fwd: 0, mid: 0, aft: 0 };
  hitBoxes: HitBox[] = [];
  dims = { loa: 155.3, beam: 20.1, draft: 9.4, height: 45 };
  localToWorld = new THREE.Matrix4();
  worldToLocal = new THREE.Matrix4();
  hits = 0;
  /** Heel angle from turning (rad). */
  turnHeel = 0;

  constructor() {
    super();
    this.name = 'DDV-01';
    this.radius = 80;
    this.hitBoxes = [
      { center: new THREE.Vector3(0, 3, 58), half: new THREE.Vector3(6, 6, 20), zone: 'fwd' },
      { center: new THREE.Vector3(0, 4, 20), half: new THREE.Vector3(10, 7, 18), zone: 'fwd' },
      { center: new THREE.Vector3(0, 13, 18), half: new THREE.Vector3(8, 10, 12), zone: 'fwd' },
      { center: new THREE.Vector3(0, 4, -18), half: new THREE.Vector3(10, 7, 20), zone: 'mid' },
      { center: new THREE.Vector3(0, 12, -12), half: new THREE.Vector3(6, 8, 16), zone: 'mid' },
      { center: new THREE.Vector3(0, 3.5, -55), half: new THREE.Vector3(9.5, 5.5, 20), zone: 'aft' },
    ];
  }

  setHitBoxes(boxes: { center: number[]; size: number[] }[]) {
    this.hitBoxes = boxes.map((b) => ({
      center: new THREE.Vector3().fromArray(b.center),
      half: new THREE.Vector3().fromArray(b.size).multiplyScalar(0.5),
      zone: b.center[2] > 25 ? 'fwd' : b.center[2] < -25 ? 'aft' : 'mid',
    }));
  }

  forward(out = new THREE.Vector3()) {
    return bearingDir(this.pos, this.heading, out);
  }

  update(dt: number, t: number, waves: WaveField) {
    this.age += dt;
    // steering
    let dh = this.targetHeading - this.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    const turnRate = 0.035 * Math.min(1, this.speed / 8); // rad/s
    const dHead = THREE.MathUtils.clamp(dh, -turnRate * dt, turnRate * dt);
    this.heading += dHead;
    // heel outward in a turn (smoothed)
    const yawRate = dt > 0 ? dHead / dt : 0;
    this.turnHeel += (-yawRate * this.speed * 0.16 - this.turnHeel) * Math.min(1, dt * 0.6);
    const dmgSlow = 1 - Math.min(0.9, (this.maxHp - this.hp) / this.maxHp);
    const vmax = this.sinking ? 0 : this.targetSpeed * dmgSlow;
    this.speed += THREE.MathUtils.clamp(vmax - this.speed, -0.4 * dt, 0.25 * dt);
    const fwd = this.forward(_f);
    this.vel.copy(fwd).multiplyScalar(this.speed);
    this.pos.addScaledVector(this.vel, dt);

    // Wave response: sample the surface around the hull and low-pass it (big ship = slow response).
    const L = 60, B = 8;
    const p = this.pos;
    const { e, n } = enuAt(p);
    const ahead = fwd, side = _x.crossVectors(upAt(p, _u), fwd).normalize();
    const hc = waves.heightAt(p.x, p.z, t);
    const hb = waves.heightAt(p.x + ahead.x * L, p.z + ahead.z * L, t);
    const hs = waves.heightAt(p.x - ahead.x * L, p.z - ahead.z * L, t);
    const hp = waves.heightAt(p.x + side.x * B, p.z + side.z * B, t);
    const hsb = waves.heightAt(p.x - side.x * B, p.z - side.z * B, t);
    void e; void n;
    const heaveT = (hc * 2 + hb + hs) / 4;
    const pitchT = Math.atan2(hb - hs, 2 * L) * 0.8;
    const rollT = Math.atan2(hp - hsb, 2 * B) * 0.35 + this.turnHeel;
    // second-order responses
    const w0 = 2 * Math.PI / 7.5, z0 = 0.35;
    this.heaveVel += (w0 * w0 * (heaveT - this.heave) - 2 * z0 * w0 * this.heaveVel) * dt;
    this.heave += this.heaveVel * dt;
    const wp = 2 * Math.PI / 6.0;
    this.pitchVel += (wp * wp * (pitchT - this.pitch) - 2 * 0.5 * wp * this.pitchVel) * dt;
    this.pitch += this.pitchVel * dt;
    const wr = 2 * Math.PI / 10.5;
    this.rollVel += (wr * wr * (rollT - this.roll) - 2 * 0.12 * wr * this.rollVel) * dt;
    this.roll += this.rollVel * dt;

    // Damage-induced list/trim and sinking
    if (this.sinking) {
      this.sinkDepth += dt * (0.08 + this.sinkDepth * 0.02);
      this.list += (0.35 - this.list) * dt * 0.02;
      this.trim += (-0.06 - this.trim) * dt * 0.02;
      if (this.sinkDepth > 40) this.sunk = true;
    }
    setAltitude(this.pos, this.heave - this.sinkDepth);
    this.updateFrame();

    for (const f of this.fires) {
      f.age += dt;
      f.intensity = Math.max(0, f.intensity - dt * 0.004);
    }
    this.fires = this.fires.filter((f) => f.intensity > 0.02);
  }

  updateFrame() {
    const up = upAt(this.pos, _u);
    const fwd = this.forward(_f);
    const port = _x.crossVectors(up, fwd).normalize();
    _m.makeBasis(port, up, fwd);
    this.quat.setFromRotationMatrix(_m);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-this.pitch - this.trim, 0, this.roll + this.list, 'YXZ'));
    this.quat.multiply(q);
    this.localToWorld.compose(this.pos, this.quat, new THREE.Vector3(1, 1, 1));
    this.worldToLocal.copy(this.localToWorld).invert();
  }

  /** Segment test against hit boxes (world coords). Returns local hit point or null. */
  segmentHit(a: THREE.Vector3, b: THREE.Vector3, pad = 0): { local: THREE.Vector3; box: HitBox } | null {
    const la = a.clone().applyMatrix4(this.worldToLocal);
    const lb = b.clone().applyMatrix4(this.worldToLocal);
    if (Math.min(la.length(), lb.length()) > 150 && la.distanceTo(lb) < 100) return null;
    const d = lb.clone().sub(la);
    let best: { t: number; box: HitBox } | null = null;
    for (const box of this.hitBoxes) {
      let tmin = 0, tmax = 1;
      let ok = true;
      for (const ax of ['x', 'y', 'z'] as const) {
        const lo = box.center[ax] - box.half[ax] - pad, hi = box.center[ax] + box.half[ax] + pad;
        if (Math.abs(d[ax]) < 1e-9) {
          if (la[ax] < lo || la[ax] > hi) { ok = false; break; }
        } else {
          let t1 = (lo - la[ax]) / d[ax], t2 = (hi - la[ax]) / d[ax];
          if (t1 > t2) [t1, t2] = [t2, t1];
          tmin = Math.max(tmin, t1);
          tmax = Math.min(tmax, t2);
          if (tmin > tmax) { ok = false; break; }
        }
      }
      if (ok && (!best || tmin < best.t)) best = { t: tmin, box };
    }
    if (!best) return null;
    return { local: la.addScaledVector(d, best.t), box: best.box };
  }
}

export type DebrisKind = 'booster' | 'carcass' | 'fragment' | 'canister_cap';

/** Ballistic junk: spent boosters, broken missiles. */
export class Debris extends Entity {
  kind = 'debris' as const;
  spin = new THREE.Vector3();
  life = 60;
  splashed = false;
  constructor(public debrisKind: DebrisKind, public model: string | null, public scale = 1, public dragK = 0.002) {
    super();
    this.radius = 2;
  }
  update(dt: number) {
    this.age += dt;
    const alt = altitude(this.pos);
    upAt(this.pos, _u);
    const rho = densityRatio(alt);
    const v = this.vel.length();
    this.vel.addScaledVector(_u, -gravityAt(alt) * dt);
    if (v > 0) this.vel.multiplyScalar(Math.max(0, 1 - this.dragK * rho * v * dt));
    this.pos.addScaledVector(this.vel, dt);
    const dq = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.spin.x * dt, this.spin.y * dt, this.spin.z * dt));
    this.quat.multiply(dq);
    if (this.age > this.life) this.remove = true;
  }
}

export type DecoyKind = 'chaff' | 'wisp';
export class Decoy extends Entity {
  kind = 'decoy' as const;
  life: number;
  rcs: number;
  constructor(public decoyKind: DecoyKind) {
    super();
    this.life = decoyKind === 'chaff' ? 45 : 25;
    this.rcs = decoyKind === 'chaff' ? 6000 : 9000;
    this.radius = decoyKind === 'chaff' ? 60 : 3;
  }
  update(dt: number, wind: THREE.Vector3) {
    this.age += dt;
    if (this.decoyKind === 'chaff') {
      // bloom: decelerate, drift with wind, slowly fall
      this.vel.lerp(wind, 1 - Math.exp(-dt * 1.2));
      upAt(this.pos, _u);
      this.pos.addScaledVector(this.vel, dt).addScaledVector(_u, -0.6 * dt);
      this.radius = Math.min(80, 10 + this.age * 20);
    } else {
      // Brake the launch climb and correct altitude from either side of the hover height.
      upAt(this.pos, _u);
      const alt = altitude(this.pos);
      const climb = THREE.MathUtils.clamp((40 - alt) * 2, -30, 30);
      this.vel.addScaledVector(_u, (climb - this.vel.dot(_u)) * (1 - Math.exp(-dt * 4)));
      this.pos.addScaledVector(this.vel, dt);
    }
    if (this.age > this.life) this.remove = true;
  }
  /** Effective RCS (chaff blooms up, then decays). */
  effectiveRcs() {
    if (this.decoyKind === 'chaff') return this.rcs * Math.min(1, this.age / 3) * Math.max(0, 1 - this.age / this.life);
    return this.age > 1.5 ? this.rcs : 0;
  }
}

/** Land-based transporter-erector-launcher. */
export class Launcher extends Entity {
  kind = 'launcher' as const;
  rounds: number;
  /** Rack elevation 0..1 (visual). */
  erect = 0;
  erectGoal = 0;
  heading = 0;
  lastFire = -100;
  constructor(public site: number, rounds: number) {
    super();
    this.rounds = rounds;
    this.radius = 8;
  }
  update(dt: number) {
    this.erect += THREE.MathUtils.clamp(this.erectGoal - this.erect, -dt / 8, dt / 8);
  }
}
