import * as THREE from 'three';
import { Entity, quatFromVelocity, airDensity } from './entities';
import type { Decoy } from './entities';
import { THREATS, ThreatSpec, ThreatType } from './specs';
import { altitude, upAt, surfaceDistance } from '../core/geo';
import { GRAVITY, L, V, T, gravityAt } from '../core/constants';

/** Guidance gains are authored in 1/s at full scale; they speed up with the compressed timeline. */
const K = 1 / T(1);
import { Rng } from '../core/rng';

export type ThreatPhase = 'boost' | 'climb' | 'cruise' | 'descent' | 'terminal' | 'popup' | 'dive' | 'dead';

const _u = new THREE.Vector3(), _v = new THREE.Vector3(), _a = new THREE.Vector3(), _t = new THREE.Vector3(), _h = new THREE.Vector3();

export class Threat extends Entity {
  kind = 'threat' as const;
  spec: ThreatSpec;
  phase: ThreatPhase = 'boost';
  hp: number;
  /** Planned route (world points at altitude 0) ending at the aim point. */
  route: THREE.Vector3[] = [];
  routeIdx = 0;
  aimPoint = new THREE.Vector3();
  seekerOn = false;
  /** What the seeker is locked on to (ship or decoy). */
  lockTarget: { pos: THREE.Vector3; vel: THREE.Vector3; id: number } | null = null;
  seduced = false;
  weavePhase: number;
  weaveSign: number;
  boosterAttached = true;
  killedBy: string | null = null;
  trackNumber = 0;
  /** Engaged interceptor count (for UI). */
  engagedBy = 0;
  ciwsHits = 0;
  launchTime = 0;
  lastAccel = new THREE.Vector3();
  popupPeak = false;
  /** When destroyed: 'blast' → fireball; 'breakup' → tumbling carcass. */
  deathMode: 'blast' | 'breakup' | 'impact' | 'water' = 'blast';
  terminalAlt: number;
  cruiseAlt: number;
  prevPos = new THREE.Vector3();
  /** Max flight time before fuel exhaustion (s). */
  fuelTime = T(600);
  waveIdx = 0;
  decoyRolls = 0;
  /** Ship-local aim offset (m), so hits spread along the hull. */
  aimLocal = new THREE.Vector3();

  constructor(type: ThreatType, private rng = new Rng()) {
    super();
    this.weavePhase = this.rng.range(0, Math.PI * 2);
    this.weaveSign = this.rng.chance(0.5) ? 1 : -1;
    this.spec = THREATS[type];
    this.hp = this.spec.hp * this.rng.range(0.7, 1.3);
    this.radius = this.spec.length / 2;
    this.name = this.spec.short;
    this.terminalAlt = this.spec.skimAlt * this.rng.range(0.8, 1.3);
    this.cruiseAlt = this.spec.cruiseAlt;
  }

  get type() {
    return this.spec.type;
  }

  /** Commanded acceleration toward a desired velocity direction, limited by g. */
  private steer(desiredDir: THREE.Vector3, gain: number, maxA: number, out: THREE.Vector3) {
    const v = this.vel.length();
    const vd = _v.copy(this.vel).normalize();
    // lateral component of desired direction
    const err = _t.copy(desiredDir).sub(vd.multiplyScalar(desiredDir.dot(vd)));
    out.copy(err).multiplyScalar(gain * v);
    if (out.length() > maxA) out.setLength(maxA);
    return out;
  }

  update(dt: number, t: number, targets: { ship: { pos: THREE.Vector3; vel: THREE.Vector3; id: number; rcs: number }; decoys: Decoy[] }, terrainH: (x: number, z: number) => number) {
    if (!this.alive) return;
    this.prevPos.copy(this.pos);
    this.age += dt;
    const s = this.spec;
    const alt = altitude(this.pos);
    upAt(this.pos, _u);
    const speed = this.vel.length();
    const acc = _a.set(0, 0, 0);
    const g = gravityAt(alt);
    /** Lift (+ any vertical thrust component) along local up, as a multiple of local gravity. */
    let lift = 1;
    const maxA = s.maxG * GRAVITY * Math.min(1, (speed / V(250)) ** 2) * Math.min(1, airDensity(alt) / 0.4 + 0.3);

    // Current aim: seeker lock if on, else route point
    let aim: THREE.Vector3 = this.route[Math.min(this.routeIdx, this.route.length - 1)] ?? this.aimPoint;
    const distAim = surfaceDistance(this.pos, this.aimPoint);

    // Seeker logic
    if (!this.seekerOn && distAim < s.seekerRange && this.routeIdx >= this.route.length - 1) {
      this.seekerOn = true;
      this.lockTarget = targets.ship;
    }
    if (this.seekerOn) {
      // Decoy seduction checks
      for (const d of targets.decoys) {
        if (d.remove || d.effectiveRcs() <= 0) continue;
        const toD = _h.copy(d.pos).sub(this.pos);
        const rd = toD.length();
        const toS = _v.copy(targets.ship.pos).sub(this.pos);
        const rs = toS.length();
        if (rd > s.seekerRange * 1.1) continue;
        const ang = toD.normalize().angleTo(toS.normalize());
        // decoy must appear inside the seeker gate (range/angle) around the current lock
        const gate = Math.abs(rd - rs) < L(900);
        if (ang < 0.25 && gate && this.decoyRolls < 2 && this.lockTarget !== d && !d.userDataTried?.has(this.id)) {
          this.decoyRolls++;
          (d.userDataTried ??= new Set()).add(this.id);
          const p = s.decoySusceptibility * Math.min(1.5, d.effectiveRcs() / targets.ship.rcs) * (rs > L(3000) ? 1 : 0.4);
          if (this.rng.chance(p)) {
            this.lockTarget = d;
            this.seduced = true;
          }
        }
      }
      if (this.lockTarget && (this.lockTarget as any).remove) {
        // re-acquire only if the ship is inside the seeker field of view
        const toS = _v.copy(targets.ship.pos).sub(this.pos).normalize();
        const fwd = _h.copy(this.vel).normalize();
        if (toS.dot(fwd) > Math.cos(0.5)) {
          this.lockTarget = targets.ship;
          this.seduced = false;
        } else {
          this.lockTarget = null;
          this.fuelTime = Math.min(this.fuelTime, this.age + T(20));
        }
      }
    }

    const tgt = this.seekerOn && this.lockTarget ? this.lockTarget : null;
    const rangeToTgt = tgt ? this.pos.distanceTo(tgt.pos) : distAim;

    // Phase transitions
    if (this.phase === 'boost' && this.age > s.boostTime) {
      this.phase = 'climb';
    }
    const descentAt = s.terminal === 'dive' ? s.descentRange : Math.max(s.descentRange, this.descentDistance(alt, speed));
    if ((this.phase === 'climb' || this.phase === 'cruise') && distAim < descentAt && this.routeIdx >= this.route.length - 1) {
      this.phase = s.terminal === 'dive' ? 'dive' : 'descent';
    }
    if (this.phase === 'descent' && Math.abs(alt - this.terminalAlt) < 5 && this.seekerOn) this.phase = 'terminal';
    if (this.phase === 'terminal' && s.terminal === 'popup' && rangeToTgt < L(4500) && !this.popupPeak) this.phase = 'popup';

    // Horizontal guidance direction
    const aimPos = tgt ? tgt.pos : this.seekerOn ? this.pos.clone().addScaledVector(this.vel, T(30)) : aim;
    const toAim = _h.copy(aimPos).sub(this.pos);
    // Lead the target (seeker) - proportional-ish: aim at predicted intercept
    if (tgt) {
      const tgo = toAim.length() / Math.max(speed, 1);
      toAim.addScaledVector(tgt.vel, tgo);
    }
    // route waypoint advance
    if (!tgt && this.routeIdx < this.route.length - 1 && surfaceDistance(this.pos, aim) < L(3000)) this.routeIdx++;

    const horiz = toAim.clone().addScaledVector(_u, -toAim.dot(_u));
    const hdist = horiz.length();
    horiz.normalize();

    let targetAlt = this.cruiseAlt;
    let targetSpeed = s.speed;
    // Minimum terrain clearance
    const ground = Math.max(0, terrainH(this.pos.x, this.pos.z));
    const lookAhead = this.pos.clone().addScaledVector(this.vel, 4);
    const groundAhead = Math.max(0, terrainH(lookAhead.x, lookAhead.z));
    switch (this.phase) {
      case 'boost': {
        // Boost along the launch direction with thrust; minimal steering
        const dir = _v.copy(this.vel).normalize();
        acc.addScaledVector(dir, s.boostAccel);
        lift = 1.4; // pitched-up thrust + wing lift: climbs off the rail
        break;
      }
      case 'climb':
      case 'cruise':
      case 'descent': {
        if (this.phase === 'descent') targetAlt = this.terminalAlt;
        if (this.phase === 'climb' && Math.abs(alt - this.cruiseAlt) < 30) this.phase = 'cruise';
        if (ground > 0 || groundAhead > 0) targetAlt = Math.max(targetAlt, ground + 60, groundAhead + 60);
        const desired = this.altitudeHoldDir(horiz, alt, targetAlt, speed, this.phase === 'descent' ? 0.35 : 0.5);
        this.steer(desired, 1.6 * K, maxA, acc);
        break;
      }
      case 'terminal': {
        targetAlt = ground > 0 ? Math.max(this.terminalAlt, ground + 30) : this.terminalAlt;
        targetSpeed = s.terminalSpeed;
        const desired = this.altitudeHoldDir(horiz, alt, targetAlt, speed, 0.25);
        this.steer(desired, 2.4 * K, maxA, acc);
        if (s.terminal === 'weave' && rangeToTgt < L(9000) && rangeToTgt > L(700)) {
          const side = _v.crossVectors(_u, horiz).normalize();
          const w = Math.sin(this.age * 2.1 * K + this.weavePhase) * this.weaveSign;
          acc.addScaledVector(side, w * s.maxG * GRAVITY * 0.7);
        }
        break;
      }
      case 'popup': {
        targetSpeed = s.terminalSpeed;
        if (!this.popupPeak && (alt > L(180) || rangeToTgt < L(2200))) this.popupPeak = true;
        if (!this.popupPeak) {
          const desired = horiz.clone().multiplyScalar(Math.cos(0.5)).addScaledVector(_u, Math.sin(0.5)).normalize();
          this.steer(desired, 2.0 * K, maxA, acc);
        } else {
          const desired = toAim.clone().normalize();
          this.steer(desired, 3.0 * K, maxA, acc);
        }
        break;
      }
      case 'dive': {
        targetSpeed = s.terminalSpeed;
        // Stay high until the dive angle to the target reaches ~ 40°, then dive with PN-ish pursuit.
        const ang = Math.atan2(alt, hdist);
        if (ang < 0.6 && alt > L(500)) {
          const desired = this.altitudeHoldDir(horiz, alt, this.cruiseAlt, speed, 0.5);
          this.steer(desired, 1.4 * K, maxA, acc);
        } else {
          const desired = toAim.clone().normalize();
          this.steer(desired, 2.5 * K, maxA, acc);
        }
        break;
      }
    }

    // Speed control (thrust vs drag), gravity compensation for lift in powered flight
    if (this.phase !== 'boost') {
      const vdir = _v.copy(this.vel).normalize();
      const dv = targetSpeed - speed;
      acc.addScaledVector(vdir, THREE.MathUtils.clamp(dv * 0.6 * K, -25, 40));
      if (this.phase === 'dive') lift = 0.5;
    }
    // Fuel exhaustion: no more thrust or lift, it falls into the sea
    if (this.age > this.fuelTime) {
      acc.set(0, 0, 0).addScaledVector(this.vel, -0.02 * K);
      lift = 0;
    }
    // Gravity (weaker with altitude); lift balances it in level flight, partially in the dive
    acc.addScaledVector(_u, (lift - 1) * g);
    this.lastAccel.copy(acc);
    this.vel.addScaledVector(acc, dt);
    this.pos.addScaledVector(this.vel, dt);
    // Roll into turns for visuals
    const lat = acc.clone().sub(_v.copy(this.vel).normalize().multiplyScalar(acc.dot(_v)));
    const bank = Math.atan2(lat.dot(_t.crossVectors(this.vel, _u).normalize()), GRAVITY) * 0.8;
    quatFromVelocity(this.pos, this.vel, this.quat, THREE.MathUtils.clamp(-bank, -1.3, 1.3));
  }

  /**
   * Ground distance a descent from `alt` to skim height needs (m), so a high cruiser is down before it
   * reaches the target rather than overflying it: a glide at the descent's flight-path limit, then
   * altitudeHoldDir's exponential flare (time constant 1/(0.3K)) down to ~20 m above skim height.
   */
  private descentDistance(alt: number, speed: number) {
    const gamma = 0.35, tau = 1 / (0.3 * K), done = 20;
    const dh = alt - this.terminalAlt;
    const flare = speed * Math.sin(gamma) * tau;
    if (dh <= done) return 0;
    if (dh <= flare) return speed * tau * Math.log(dh / done);
    return 1.1 * ((dh - flare) / Math.tan(gamma) + speed * tau * Math.log(flare / done));
  }

  /** Direction combining horizontal heading with a climb/dive angle to reach target altitude. */
  private altitudeHoldDir(horiz: THREE.Vector3, alt: number, targetAlt: number, speed: number, maxGamma: number) {
    const err = targetAlt - alt;
    // Commanded climb rate with a braking profile, so the missile can flare out in time
    const aAvail = Math.max(15, this.spec.maxG * GRAVITY * 0.3);
    const vz = Math.sign(err) * Math.min(Math.abs(err) * 0.3 * K, Math.sqrt(2 * aAvail * Math.abs(err)) * 0.7);
    const gamma = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(vz / Math.max(speed, V(50)), -1, 1)), -maxGamma, maxGamma);
    return new THREE.Vector3().copy(horiz).multiplyScalar(Math.cos(gamma)).addScaledVector(_u, Math.sin(gamma)).normalize();
  }
}

declare module './entities' {
  interface Decoy {
    userDataTried?: Set<number>;
  }
}
