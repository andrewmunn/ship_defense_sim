import * as THREE from 'three';
import { Entity, quatFromVelocity } from './entities';
import { INTERCEPTORS, InterceptorSpec, InterceptorType } from './specs';
import { altitude, upAt } from '../core/geo';
import { GRAVITY, L, T, V, densityRatio, gravityAt } from '../core/constants';
import { motorAccel, MIN_USEFUL_SPEED } from './flyout';
import { flyTime } from './flytime';
import { rng } from '../core/rng';
import type { Threat } from './threat';
import type { Track } from './radar';

/** Guidance gains are authored in 1/s at full scale; they speed up with the compressed timeline. */
const K = 1 / T(1);
/** Mid-course uplink interval (s). */
const UPLINK = T(0.5);

export type InterceptorPhase = 'vertical' | 'turnover' | 'midcourse' | 'terminal' | 'coast' | 'dead';

const _u = new THREE.Vector3(), _v = new THREE.Vector3(), _a = new THREE.Vector3(), _r = new THREE.Vector3(), _vr = new THREE.Vector3(), _w = new THREE.Vector3();

export class Interceptor extends Entity {
  kind = 'interceptor' as const;
  spec: InterceptorSpec;
  phase: InterceptorPhase = 'vertical';
  target: Threat;
  track: Track;
  /** Planned intercept point (updated by uplink). */
  pip = new THREE.Vector3();
  motorOn = true;
  boosterAttached: boolean;
  /** Where it left the deck (the uplink times the flight from here). */
  launchPos = new THREE.Vector3();
  /** Launch axis (cell up at launch time). */
  launchUp = new THREE.Vector3();
  thrust = 0;
  /** Needs illumination during terminal (semi-active). */
  illuminated = false;
  illuminator = -1;
  /** Illuminator fire control reserved for this missile's terminal window (-1 = none). */
  plannedIllum = -1;
  missDist = Infinity;
  result: 'pending' | 'kill' | 'miss' | 'noillum' = 'pending';
  lastRange = Infinity;
  closing = true;
  seekerNoise = new THREE.Vector3();
  selfDestructAt = -1;
  cell = -1;
  launcher: 'fwd' | 'aft' = 'fwd';
  salvoIdx = 0;
  /** Expected single-shot Pk used by the planner. */
  plannedPk = 0.8;
  tgo = 0;
  lastAccel = new THREE.Vector3();
  /** Fly at `pip` as given, without mid-course uplink updates (fire-control time-of-flight tables). */
  holdPip = false;
  /** Distance to the PIP when mid-course guidance began (sets the loft profile). */
  loftDist = 0;
  private nextUplink = 0;

  constructor(type: InterceptorType, target: Threat, track: Track) {
    super();
    this.spec = INTERCEPTORS[type];
    this.target = target;
    this.track = track;
    this.boosterAttached = this.spec.boosterSep > 0;
    this.radius = this.spec.length / 2;
    this.name = this.spec.short;
  }
  get type() {
    return this.spec.type;
  }

  /**
   * Mid-course uplink: re-solve the predicted intercept point from the latest radar track. The flight
   * is timed from the launch point with fire control's measured time-of-flight table (flytime.ts), so
   * the rest of it takes the table time less the time already flown.
   */
  private uplink(speed: number) {
    const tr = this.track;
    if (tr.lost || tr.dead) return;
    const h0 = altitude(this.launchPos);
    let t = this.pos.distanceTo(tr.estPos) / Math.max(speed, 1);
    for (let i = 0; i < 6; i++) {
      _r.copy(tr.estPos).addScaledVector(tr.estVel, t);
      const d = _r.distanceTo(this.launchPos);
      const elev = Math.asin(THREE.MathUtils.clamp((altitude(_r) - h0) / Math.max(d, 1), 0, 1));
      const f = flyTime(this.spec.type, d, elev);
      // beyond the table (out of energy on paper): keep closing at the current speed
      t = isFinite(f.t) ? Math.max(f.t - this.age, 0.1) : _r.distanceTo(this.pos) / Math.max(speed, 1);
    }
    this.pip.copy(tr.estPos).addScaledVector(tr.estVel, t);
  }

  /** Returns 'detonate' if the proximity fuze fired this step. */
  update(dt: number, requestIllum: (m: Interceptor) => boolean): 'detonate' | 'selfdestruct' | null {
    if (!this.alive) return null;
    if (this.age === 0) this.launchPos.copy(this.pos);
    this.age += dt;
    const s = this.spec;
    upAt(this.pos, _u);
    const alt = altitude(this.pos);
    const speed = this.vel.length();
    const rho = densityRatio(alt);
    const g = gravityAt(alt);
    this.thrust = motorAccel(s, this.age);
    this.motorOn = this.thrust > 0;
    if (this.boosterAttached && this.age > s.boosterSep) this.boosterAttached = false;

    const tgt = this.target;
    if (!this.holdPip && (this.phase === 'turnover' || this.phase === 'midcourse') && this.age >= this.nextUplink) {
      this.nextUplink = this.age + UPLINK;
      this.uplink(speed);
    }
    // Relative geometry (uplink uses track estimate; terminal seeker sees truth + noise)
    const useSeeker = this.phase === 'terminal';
    const tp = useSeeker ? tgt.pos : this.track.estPos;
    const tv = useSeeker ? tgt.vel : this.track.estVel;
    _r.copy(tp).sub(this.pos);
    const range = _r.length();
    _vr.copy(tv).sub(this.vel);
    const closingSpeed = Math.max(1, -_r.dot(_vr) / Math.max(range, 1));
    this.tgo = range / closingSpeed;

    // Max lateral acceleration: aero authority scales with dynamic pressure (air density × speed²,
    // normalised to Mach ~2 at sea level), so it fades in the thin air of a loft; TVC helps under power.
    const q = rho * (speed / V(700)) ** 2;
    const maxA = s.maxG * GRAVITY * Math.min(1, q * 1.6) + (this.motorOn ? 8 * GRAVITY : 0);

    const acc = _a.set(0, 0, 0);
    if (this.phase === 'vertical') {
      acc.addScaledVector(this.launchUp, this.thrust);
      if (this.age > s.verticalTime) this.phase = 'turnover';
    } else {
      // desired direction
      let desired: THREE.Vector3;
      if (this.phase === 'terminal') {
        // Proportional navigation (N=4) with augmented target acceleration term
        const N = 4;
        const r2 = Math.max(range * range, 1);
        const omega = _w.copy(_r).cross(_vr).multiplyScalar(1 / r2);
        const vDir = _v.copy(this.vel).normalize();
        const cmd = new THREE.Vector3().crossVectors(vDir, omega).multiplyScalar(-N * closingSpeed);
        // Seeker noise (glint); worse without illumination for semi-active missiles
        const noiseAmp = this.illuminated || !s.semiActive ? 1.2 : 40;
        if (rng.chance(dt * 6 * K)) this.seekerNoise.set(rng.gauss(), rng.gauss(), rng.gauss()).multiplyScalar(noiseAmp);
        cmd.add(this.seekerNoise);
        cmd.addScaledVector(tgt.lastAccel, 0.5 * N * 0.5);
        // remove along-velocity component
        cmd.addScaledVector(vDir, -cmd.dot(vDir));
        if (cmd.length() > maxA) cmd.setLength(maxA);
        acc.add(cmd);
        // gravity compensation
        acc.addScaledVector(_u, g * 0.9);
        desired = vDir;
      } else {
        // Mid-course: fly toward the (uplinked) predicted intercept point. Long shots loft into thin air
        // (less drag), aiming above the PIP by a share of the remaining distance; the loft fades out over
        // the back half of the fly-out so the missile comes down onto the target's altitude, not over it.
        const toPip = _v.copy(this.pip).sub(this.pos);
        const dPip = toPip.length();
        if (this.phase === 'midcourse' && !this.loftDist) this.loftDist = dPip;
        const d0 = this.loftDist || dPip;
        const loft = Math.min(0.3, d0 / L(70000)) * THREE.MathUtils.smoothstep(dPip / d0, 0.35, 0.8);
        desired = toPip.addScaledVector(_u, loft * dPip).normalize();
        const vDir = _w.copy(this.vel).normalize();
        const err = desired.clone().addScaledVector(vDir, -desired.dot(vDir));
        const gain = (this.phase === 'turnover' ? 6 : 3) * K;
        const cmd = err.multiplyScalar(gain * speed);
        const lim = this.phase === 'turnover' ? Math.max(maxA, s.turnoverG * GRAVITY) : maxA;
        if (cmd.length() > lim) cmd.setLength(lim);
        acc.add(cmd);
        acc.addScaledVector(_u, g * 0.9);
        if (this.phase === 'turnover' && desired.dot(vDir) > 0.97) this.phase = 'midcourse';
        if (this.phase === 'midcourse' && this.tgo < s.terminalTime) {
          this.phase = 'terminal';
          if (s.semiActive) {
            this.illuminated = requestIllum(this);
            if (!this.illuminated) this.result = 'noillum';
          }
        }
      }
      // axial thrust
      acc.addScaledVector(_v.copy(this.vel).normalize(), this.thrust);
    }

    // Drag (quadratic) + induced drag from maneuvering
    const lat = acc.clone();
    const vd = _v.copy(this.vel).normalize();
    lat.addScaledVector(vd, -lat.dot(vd));
    const latG = lat.length() / GRAVITY;
    const drag = s.dragK * rho * speed * speed * (1 + 0.004 * latG * latG);
    acc.addScaledVector(vd, -drag);
    // Gravity
    acc.addScaledVector(_u, -g);
    this.lastAccel.copy(acc);

    const prevPos = _w.copy(this.pos);
    const prevT = tgt.pos.clone().addScaledVector(tgt.vel, -dt);
    this.vel.addScaledVector(acc, dt);
    this.pos.addScaledVector(this.vel, dt);
    quatFromVelocity(this.pos, this.vel, this.quat, this.age * 1.5);

    // Proximity fuze: closest approach during this step (relative linear motion)
    if (tgt.alive && this.phase === 'terminal' && range < 400) {
      const a0 = prevPos.clone().sub(prevT);
      const a1 = this.pos.clone().sub(tgt.pos);
      const d = a1.clone().sub(a0);
      const tt = THREE.MathUtils.clamp(-a0.dot(d) / Math.max(d.lengthSq(), 1e-9), 0, 1);
      const miss = a0.addScaledVector(d, tt).length();
      if (miss < this.missDist) this.missDist = miss;
      if (miss < s.lethalRadius) {
        // Detonate at the closest-approach point
        this.pos.lerpVectors(prevPos, this.pos, tt);
        return 'detonate';
      }
    }
    // Miss detection: range opening after closest approach, or energy depleted
    if (tgt.alive) {
      const rTrue = this.pos.distanceTo(tgt.pos);
      if (this.phase === 'terminal' && rTrue > this.lastRange && rTrue > s.lethalRadius && this.lastRange < 2000) {
        if (this.selfDestructAt < 0) {
          this.selfDestructAt = this.age + 0.6;
          this.result = this.result === 'noillum' ? 'noillum' : 'miss';
        }
      }
      this.lastRange = rTrue;
    } else if (this.selfDestructAt < 0) {
      // Target destroyed by someone else: divert? keep flying briefly then self-destruct
      this.selfDestructAt = this.age + 1.5;
      if (this.result === 'pending') this.result = 'miss';
    }
    if (!this.motorOn && speed < MIN_USEFUL_SPEED && this.phase !== 'vertical' && this.selfDestructAt < 0) {
      this.selfDestructAt = this.age + 0.3;
      if (this.result === 'pending') this.result = 'miss';
    }
    if (this.age > T(90) && this.selfDestructAt < 0) this.selfDestructAt = this.age;
    if (alt < -1) {
      this.alive = false;
      this.remove = true;
      return null;
    }
    if (this.selfDestructAt >= 0 && this.age >= this.selfDestructAt) return 'selfdestruct';
    return null;
  }

  /** Kill probability for the achieved miss distance (called at detonation). */
  pkAt(miss: number) {
    const R = this.spec.lethalRadius;
    const x = miss / R;
    const base = x < 0.3 ? 1 : 1 - (x - 0.3) * 0.8;
    // Low-altitude intercepts suffer from multipath / clutter-degraded fuzing
    const low = altitude(this.target.pos) < 40 ? 0.82 : 1;
    return THREE.MathUtils.clamp(base * this.spec.basePk * low * this.target.spec.interceptPkMod, 0.05, 0.98);
  }
}
