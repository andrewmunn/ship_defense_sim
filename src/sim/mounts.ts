import * as THREE from 'three';
import { CIWS_SPEC, GUN_SPEC } from './specs';
import { gravityAt, densityRatio, SPEED_OF_SOUND } from '../core/constants';
import { rng } from '../core/rng';
import { altitude, upAt } from '../core/geo';
import type { Ship } from './entities';
import type { Threat } from './threat';
import type { RoundPool } from './rounds';

const _p = new THREE.Vector3(), _d = new THREE.Vector3(), _l = new THREE.Vector3(), _u = new THREE.Vector3(), _q = new THREE.Quaternion();

export type MountState = 'standby' | 'track' | 'fire' | 'reload' | 'out' | 'disabled';

/** Common trainable-mount kinematics (yaw/pitch in ship frame). */
abstract class Mount {
  yaw = 0; // relative to ship bow (+ = to port, rotation about +Y)
  pitch = 0;
  yawGoal = 0;
  pitchGoal = 0;
  state: MountState = 'standby';
  target: Threat | null = null;
  worldPos = new THREE.Vector3();
  worldDir = new THREE.Vector3();
  enabled = true;
  constructor(
    public name: string,
    /** Ship-local pivot position. */
    public local: THREE.Vector3,
    /** Relative bearing of the arc centre (rad, 0 = bow, + = port). */
    public arcCenter: number,
    public arcHalf: number,
    public minEl: number,
    public maxEl: number,
    public slew: number,
    public elevRate: number,
    public muzzleLen: number
  ) {
    this.yaw = this.yawGoal = arcCenter;
  }

  updatePose(ship: Ship) {
    this.worldPos.copy(this.local).applyMatrix4(ship.localToWorld);
    this.dirLocal(this.yaw, this.pitch, _d);
    this.worldDir.copy(_d).applyQuaternion(ship.quat);
  }
  dirLocal(yaw: number, pitch: number, out: THREE.Vector3) {
    return out.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  }
  /** Convert a world direction to ship-local yaw/pitch. */
  toLocalAngles(ship: Ship, dir: THREE.Vector3) {
    _l.copy(dir).applyQuaternion(_q.copy(ship.quat).invert());
    return { yaw: Math.atan2(_l.x, _l.z), pitch: Math.asin(THREE.MathUtils.clamp(_l.y, -1, 1)) };
  }
  inArc(yaw: number, pitch: number) {
    let d = yaw - this.arcCenter;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d) <= this.arcHalf && pitch >= this.minEl && pitch <= this.maxEl;
  }
  slewTo(dt: number) {
    let d = this.yawGoal - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.yaw += THREE.MathUtils.clamp(d, -this.slew * dt, this.slew * dt);
    this.pitch += THREE.MathUtils.clamp(this.pitchGoal - this.pitch, -this.elevRate * dt, this.elevRate * dt);
    return Math.abs(d) + Math.abs(this.pitchGoal - this.pitch);
  }
  muzzle(out: THREE.Vector3) {
    return out.copy(this.worldPos).addScaledVector(this.worldDir, this.muzzleLen);
  }
}

const _rp = new THREE.Vector3(), _rv = new THREE.Vector3(), _tp = new THREE.Vector3(), _d0 = new THREE.Vector3(), _d1 = new THREE.Vector3(), _d2 = new THREE.Vector3(), _d3 = new THREE.Vector3(), _r1 = new THREE.Vector3();

/**
 * Lead solution for a projectile with quadratic drag k (1/m) and muzzle speed v0, fired from m on a
 * mount moving at shooterVel (the round inherits it), against a target at p with velocity v (and
 * optional accel a). Returns time of flight; writes the aim point (the direction to lay the barrel).
 *
 * An analytic drag estimate gives the first guess; it is then refined by flying the round through the
 * same physics as RoundPool (drag in the exponential atmosphere, inverse-square gravity) and shifting
 * the aim point by the miss at closest approach, like a fire-control computer's ballistic kernel.
 */
export function leadSolve(m: THREE.Vector3, v0: number, k: number, p: THREE.Vector3, v: THREE.Vector3, a: THREE.Vector3 | null, aim: THREE.Vector3, shooterVel: THREE.Vector3 | null = null) {
  let t = p.distanceTo(m) / v0;
  const altM = altitude(m);
  const target = (tau: number, out: THREE.Vector3) => {
    out.copy(p).addScaledVector(v, tau);
    if (a) out.addScaledVector(a, 0.5 * tau * tau);
    return out;
  };
  for (let i = 0; i < 6; i++) {
    target(t, aim);
    const s = aim.distanceTo(m);
    // drag in the air along the path (thinner at altitude): density at the mean height
    const ke = k * densityRatio((altM + altitude(aim)) / 2);
    const x = ke * s;
    if (x > 5) return Infinity;
    t = (Math.exp(x) - 1) / (ke * v0);
  }
  upAt(aim, _u);
  aim.addScaledVector(_u, 0.5 * gravityAt((altM + altitude(aim)) / 2) * t * t);

  // Ballistic refinement: fly the round, correct the aim by the miss vector.
  const h = THREE.MathUtils.clamp(t / 30, 0.002, 1 / 30);
  for (let it = 0; it < 3; it++) {
    _rv.copy(aim).sub(m).setLength(v0);
    if (shooterVel) _rv.add(shooterVel);
    _rp.copy(m);
    let best = Infinity, bestT = t;
    const miss = _d1.set(0, 0, 0);
    _d0.copy(_rp).sub(target(0, _tp));
    const tEnd = t * 1.6 + 0.5;
    for (let tau = 0; tau < tEnd; ) {
      const alt = altitude(_rp);
      _rv.multiplyScalar(Math.max(0, 1 - k * densityRatio(alt) * _rv.length() * h));
      upAt(_rp, _u);
      _rv.addScaledVector(_u, -gravityAt(alt) * h);
      _rp.addScaledVector(_rv, h);
      tau += h;
      // closest approach within this step (relative motion ~linear over a step)
      const r1 = _r1.copy(_rp).sub(target(tau, _tp));
      const dr = _d2.copy(_d0).sub(r1);
      const f = THREE.MathUtils.clamp(_d0.dot(dr) / Math.max(dr.lengthSq(), 1e-9), 0, 1);
      const dist = _d3.copy(_d0).lerp(r1, f).length();
      if (dist < best) {
        best = dist;
        bestT = tau - h + f * h;
        miss.copy(_d3);
      }
      if (tau > bestT + 4 * h && dist > best * 1.5) break;
      _d0.copy(r1);
    }
    if (!isFinite(best)) return Infinity;
    aim.sub(miss);
    t = bestT;
    if (best < 0.05) break;
  }
  return t;
}

/** Hornet CIWS (20 mm rotary cannon). */
export class Ciws extends Mount {
  ammo = CIWS_SPEC.magazine;
  reloadLeft = 0;
  fireAcc = 0;
  /** Barrel spin rate (0..1) for visuals & audio. */
  spin = 0;
  firing = false;
  lockT = 0;
  /** Systematic aim bias (rad), reduced by closed-loop spotting. */
  biasYaw = 0;
  biasPitch = 0;
  burstT = 0;
  roundsFired = 0;
  kills = 0;
  engageStart = 0;
  aim = new THREE.Vector3();
  tof = 0;
  lastSwitch = -10;
  constructor(name: string, local: THREE.Vector3, arcCenter: number, public idx: number) {
    super(name, local, arcCenter, (135 * Math.PI) / 180, (-20 * Math.PI) / 180, (80 * Math.PI) / 180, CIWS_SPEC.slewRate, CIWS_SPEC.elevRate, 2.2);
    this.pitch = this.pitchGoal = 0.1;
  }

  update(dt: number, t: number, ship: Ship, threats: Threat[], rounds: RoundPool, enabled: boolean, onFireChange: (c: Ciws, firing: boolean) => void) {
    this.updatePose(ship);
    const S = CIWS_SPEC;
    if (!this.enabled) {
      this.state = 'disabled';
      this.setFiring(false, onFireChange);
      this.spin = Math.max(0, this.spin - dt);
      return;
    }
    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      this.state = 'reload';
      if (this.reloadLeft <= 0) this.ammo = S.magazine;
    }
    // Target selection: own search radar, highest threat (lowest time-to-go) in arc.
    if (this.target && (!this.target.alive || this.target.remove)) {
      this.target = null;
      this.burstT = 0.35; // short trailing burst finishes after the kill
    }
    const shipPos = ship.pos;
    let best: Threat | null = null, bestTtg = Infinity;
    for (const th of threats) {
      if (!th.alive) continue;
      const r = th.pos.distanceTo(this.worldPos);
      if (r > 5500) continue;
      _d.copy(th.pos).sub(this.worldPos).normalize();
      const ang = this.toLocalAngles(ship, _d);
      if (!this.inArc(ang.yaw, ang.pitch)) continue;
      if (altitude(th.pos) < -0.5) continue;
      const rel = th.pos.clone().sub(shipPos);
      const closing = -rel.dot(th.vel.clone().sub(ship.vel)) / Math.max(rel.length(), 1);
      if (closing < 20 && r > 400) continue; // outbound / passing
      const ttg = r / Math.max(closing, 20);
      if (ttg < bestTtg) { bestTtg = ttg; best = th; }
    }
    if (best && best !== this.target) {
      // switch only if the new one is clearly more urgent (avoid flip-flopping)
      const curTtg = this.target ? this.target.pos.distanceTo(shipPos) / Math.max(this.target.vel.length(), 50) : Infinity;
      if (!this.target || (bestTtg < curTtg * 0.6 && t - this.lastSwitch > 1.0)) {
        this.target = best;
        this.lockT = 0;
        this.lastSwitch = t;
        this.engageStart = t;
        // new target: fresh systematic bias
        this.biasYaw = rng.gauss() * 0.0035;
        this.biasPitch = rng.gauss() * 0.0035;
      }
    }
    const tgt = this.target;
    let wantFire = false;
    if (tgt && enabled) {
      if (this.state !== 'reload') this.state = 'track';
      this.lockT += dt;
      // aim
      const tof = leadSolve(this.muzzle(_p), S.muzzleVel, S.dragK, tgt.pos, tgt.vel, tgt.lastAccel, this.aim, ship.vel);
      this.tof = tof;
      _d.copy(this.aim).sub(this.worldPos).normalize();
      const ang = this.toLocalAngles(ship, _d);
      this.yawGoal = ang.yaw;
      this.pitchGoal = THREE.MathUtils.clamp(ang.pitch, this.minEl, this.maxEl);
      const err = this.slewTo(dt);
      const r = tgt.pos.distanceTo(this.worldPos);
      const fast = tgt.vel.length() > 1.5 * SPEED_OF_SOUND;
      const openRange = fast ? S.openFireRange * 1.35 : S.openFireRange;
      if (this.lockT > S.lockTime && err < 0.02 && r < openRange && isFinite(tof) && this.ammo > 0 && this.reloadLeft <= 0) {
        wantFire = true;
        this.state = 'fire';
      }
    } else {
      // return to stow / track trailing burst
      if (this.state !== 'reload') this.state = 'standby';
      if (this.burstT <= 0) {
        this.yawGoal = this.arcCenter;
        this.pitchGoal = 0.1;
      }
      this.slewTo(dt);
    }
    if (this.burstT > 0) {
      this.burstT -= dt;
      if (this.ammo > 0 && this.reloadLeft <= 0) wantFire = true;
    }
    this.spin = THREE.MathUtils.clamp(this.spin + (wantFire || tgt ? dt * 4 : -dt * 1.2), 0, 1);
    if (wantFire && this.spin > 0.6) {
      this.setFiring(true, onFireChange);
      this.fireAcc += dt * (S.rpm / 60);
      // closed-loop spotting: bias shrinks while firing
      const k = Math.exp(-dt * 1.4);
      this.biasYaw *= k;
      this.biasPitch *= k;
      const m = this.muzzle(_p);
      const shipV = ship.vel;
      while (this.fireAcc >= 1 && this.ammo > 0) {
        this.fireAcc -= 1;
        this.ammo--;
        this.roundsFired++;
        const y = this.yaw + this.biasYaw + rng.gauss() * S.dispersion;
        const pch = this.pitch + this.biasPitch + rng.gauss() * S.dispersion;
        this.dirLocal(y, pch, _d).applyQuaternion(ship.quat);
        const v = _d.multiplyScalar(S.muzzleVel).add(shipV);
        // stagger spawn along the step so the stream is continuous
        const back = rng.next() * dt;
        const pos = m.clone().addScaledVector(v, -back * 0.0);
        rounds.spawn(pos, v, 8, this.idx);
      }
      if (this.ammo <= 0) {
        this.reloadLeft = S.reloadTime;
        this.state = 'reload';
      }
    } else {
      this.fireAcc = 0;
      this.setFiring(false, onFireChange);
    }
  }
  private setFiring(f: boolean, cb: (c: Ciws, f: boolean) => void) {
    if (f !== this.firing) {
      this.firing = f;
      cb(this, f);
    }
  }
}

/** Anvil 5-inch gun with proximity-fuzed rounds. */
export class Gun extends Mount {
  ammo = GUN_SPEC.magazine;
  cooldown = 0;
  aim = new THREE.Vector3();
  tof = 0;
  recoil = 0;
  shots = 0;
  constructor(local: THREE.Vector3) {
    super('ANVIL', local, 0, (150 * Math.PI) / 180, (-10 * Math.PI) / 180, (65 * Math.PI) / 180, GUN_SPEC.slewRate, GUN_SPEC.elevRate, 7.0);
    this.pitch = this.pitchGoal = 0.02;
  }
  update(dt: number, ship: Ship, target: Threat | null, fire: (pos: THREE.Vector3, vel: THREE.Vector3, fuze: number) => void) {
    this.updatePose(ship);
    this.recoil = Math.max(0, this.recoil - dt * 2.5);
    this.cooldown -= dt;
    this.target = target;
    if (!this.enabled) {
      this.state = 'disabled';
      return;
    }
    if (!target || this.ammo <= 0) {
      this.state = this.ammo <= 0 ? 'out' : 'standby';
      this.yawGoal = 0;
      this.pitchGoal = 0.02;
      this.slewTo(dt);
      return;
    }
    this.state = 'track';
    const m = this.muzzle(_p);
    const tof = leadSolve(m, GUN_SPEC.muzzleVel, GUN_SPEC.dragK, target.pos, target.vel, null, this.aim, ship.vel);
    this.tof = tof;
    _d.copy(this.aim).sub(this.worldPos).normalize();
    const ang = this.toLocalAngles(ship, _d);
    if (!this.inArc(ang.yaw, ang.pitch)) {
      this.slewTo(dt);
      return;
    }
    this.yawGoal = ang.yaw;
    this.pitchGoal = ang.pitch;
    const err = this.slewTo(dt);
    if (err < 0.01 && this.cooldown <= 0 && isFinite(tof) && tof < 30) {
      this.cooldown = 60 / GUN_SPEC.roundsPerMin;
      this.ammo--;
      this.shots++;
      this.recoil = 1;
      this.state = 'fire';
      const y = this.yaw + rng.gauss() * 0.002, p = this.pitch + rng.gauss() * 0.002;
      this.dirLocal(y, p, _d).applyQuaternion(ship.quat);
      const v = _d.clone().multiplyScalar(GUN_SPEC.muzzleVel).add(ship.vel);
      fire(m.clone(), v, tof + rng.gauss() * 0.05);
    }
  }
}

/** Lantern fire-control illuminator. */
export class Illuminator extends Mount {
  /** Missiles currently being illuminated. */
  assigned: { id: number; target: Threat }[] = [];
  constructor(name: string, local: THREE.Vector3, arcCenter: number, arcHalf: number) {
    super(name, local, arcCenter, arcHalf, (-5 * Math.PI) / 180, (88 * Math.PI) / 180, 1.8, 1.5, 0);
    this.pitch = this.pitchGoal = 0.2;
  }
  canSee(ship: Ship, p: THREE.Vector3) {
    this.updatePose(ship);
    _d.copy(p).sub(this.worldPos).normalize();
    const a = this.toLocalAngles(ship, _d);
    return this.inArc(a.yaw, a.pitch);
  }
  update(dt: number, ship: Ship) {
    this.updatePose(ship);
    const tgt = this.assigned[0]?.target;
    if (tgt && tgt.alive) {
      _d.copy(tgt.pos).sub(this.worldPos).normalize();
      const a = this.toLocalAngles(ship, _d);
      this.yawGoal = a.yaw;
      this.pitchGoal = a.pitch;
      this.state = 'track';
    } else {
      this.state = 'standby';
    }
    this.slewTo(dt);
  }
}
