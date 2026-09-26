import * as THREE from 'three';
import { INTERCEPTORS, InterceptorType, THREATS, GUN_SPEC } from './specs';
import { altitude, upAt } from '../core/geo';
import { L, T, SPEED_OF_SOUND } from '../core/constants';
import { flyTime, prepareFlyTimes } from './flytime';
import type { Track } from './radar';
import type { Interceptor } from './interceptor';
import type { World } from './world';

export interface Solution {
  weapon: InterceptorType;
  tInt: number;
  pip: THREE.Vector3;
  rangeAtInt: number;
  /** Illuminator reserved for the terminal window (-1 = active seeker, needs none). */
  illum: number;
}

const _p = new THREE.Vector3(), _u = new THREE.Vector3();

/**
 * Bastion combat system (automatic doctrine): threat evaluation, weapon assignment,
 * VLS launch scheduling, illuminator time-sharing, gun & decoy employment.
 */
export class Bastion {
  inventory: Record<InterceptorType, number> = { halberd: 0, glaive: 0, stiletto: 0 };
  launcherReady = { fwd: 0, aft: 0 };
  /** Planned semi-active terminal windows (sim time), each reserved on one illuminator. */
  windows: { start: number; end: number; id: number; il: number }[] = [];
  private nextEval = 0;
  private decoyCool = { port: 0, stbd: 0 };
  shots = 0;
  constructor(private world: World) {
    prepareFlyTimes();
  }

  /**
   * Predict intercept for weapon w against a track (straight-line threat extrapolation), timing the
   * interceptor's fly-out from its measured time-of-flight table (flytime.ts). Null if it can't get
   * there with energy to spare.
   */
  solve(w: InterceptorType, tr: Track): Solution | null {
    const spec = INTERCEPTORS[w];
    const ship = this.world.ship;
    if (tr.range < spec.minRange) return null;
    upAt(ship.pos, _u);
    const launch = _p.copy(ship.pos).addScaledVector(_u, 12);
    let t = tr.range / (spec.avgSpeed + tr.estVel.length());
    const pip = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      pip.copy(tr.estPos).addScaledVector(tr.estVel, t);
      const d = pip.distanceTo(launch);
      const elev = Math.asin(Math.min(1, Math.max(0, altitude(pip) - 12) / Math.max(d, 1)));
      const fo = flyTime(w, d, elev);
      if (!isFinite(fo.t)) return null;
      t = fo.t;
    }
    const rangeAtInt = pip.distanceTo(ship.pos);
    if (rangeAtInt < spec.minRange || rangeAtInt > spec.maxRange) return null;
    if (t > tr.ttg - 0.5) return null; // would arrive after the threat reaches us
    return { weapon: w, tInt: t, pip, rangeAtInt, illum: -1 };
  }

  /** Terminal illumination window (sim time) for a semi-active shot fired at t that intercepts after tInt. */
  private termWindow(w: InterceptorType, t: number, tInt: number) {
    return { start: t + tInt - INTERCEPTORS[w].terminalTime - 0.5, end: t + tInt + 0.5 };
  }

  /**
   * Keep the illuminator schedule honest. A reservation is released once its missile is gone or can
   * no longer use it, and from mid-course on it slides with the missile's own time-to-go: lofted shots
   * reach the target well before the launch-time fly-out estimate, and a stale window would otherwise
   * hold a Lantern for a missile that has already hit or missed, blocking new shots.
   */
  private refreshWindows(t: number) {
    if (!this.windows.length) return;
    const live = new Map<number, Interceptor>();
    for (const m of this.world.interceptors) if (m.alive) live.set(m.id, m);
    this.windows = this.windows.filter((w) => {
      const m = live.get(w.id);
      if (!m || m.result !== 'pending') return false;
      if (m.phase === 'midcourse' || m.phase === 'terminal') {
        const win = this.termWindow(m.spec.type, t, m.tgo);
        w.start = win.start;
        w.end = win.end;
      }
      return w.end > t;
    });
  }

  /**
   * Least-booked illuminator that can see the intercept point and has a free slot for the whole
   * terminal window [a,b], or -1. Only mounts whose arc covers the PIP count: a threat off the bow
   * can be lit by the forward Lantern alone.
   */
  illumFor(pip: THREE.Vector3, a: number, b: number) {
    const W = this.world;
    const share = W.cfg.doctrine.illumShare;
    let best = -1, bestN = Infinity;
    W.illuminators.forEach((il, i) => {
      if (!il.enabled || !il.canSee(W.ship, pip)) return;
      let n = 0;
      for (const w of this.windows) if (w.il === i && w.start < b && w.end > a) n++;
      if (n < share && n < bestN) {
        best = i;
        bestN = n;
      }
    });
    return best;
  }

  update(dt: number, t: number) {
    const W = this.world;
    this.launcherReady.fwd -= dt;
    this.launcherReady.aft -= dt;
    this.decoyCool.port -= dt;
    this.decoyCool.stbd -= dt;
    this.windows = this.windows.filter((w) => w.end > t);
    if (t < this.nextEval) return;
    this.nextEval = t + 0.25;
    if (W.ship.sunk || W.ship.sinking) return;
    this.refreshWindows(t);

    const tracks = W.radar.activeTracks().filter((tr) => tr.cls === 'hostile' && t - tr.hostileTime >= W.cfg.doctrine.reaction * 0.5);
    tracks.sort((a, b) => a.ttg - b.ttg);
    this.maneuver(tracks, t);
    for (const tr of tracks) {
      const hadPending = tr.engagedBy.length > 0;
      tr.engagedBy = tr.engagedBy.filter((m) => m.alive && m.result === 'pending');
      const inFlight = tr.engagedBy;
      if (hadPending && !inFlight.length) tr.lastLook = t;
      const policy = W.cfg.doctrine.policy;
      if (policy === 'sls' && (inFlight.length || (tr.lastLook >= 0 && t - tr.lastLook < T(2.5)))) continue;
      let pSurvive = 1;
      for (const m of inFlight) pSurvive *= 1 - m.plannedPk;
      const need = policy === 'salvo' ? 0.9 : 0.75;
      if (1 - pSurvive >= need) continue;
      // Candidate weapons by preference
      const th = tr.threat.spec;
      const fast = th.speed > 1.5 * SPEED_OF_SOUND;
      const order: InterceptorType[] = fast ? ['glaive', 'halberd', 'stiletto'] : ['stiletto', 'halberd', 'glaive'];
      let sol: Solution | null = null;
      for (const w of order) {
        if (this.inventory[w] <= 0) continue;
        const s = this.solve(w, tr);
        if (!s) continue;
        // Don't waste long-range shots on far-away subsonic threats: prefer Stiletto envelope when it'll come
        if (!fast && w === 'halberd' && s.rangeAtInt > L(30000) && tr.ttg > T(90)) continue;
        if (INTERCEPTORS[w].semiActive) {
          const win = this.termWindow(w, t, s.tInt);
          s.illum = this.illumFor(s.pip, win.start, win.end);
          if (s.illum < 0) continue;
        }
        sol = s;
        break;
      }
      if (!sol) continue;
      // Shots this pass: salvo of two, or one (shoot-look-shoot) when there's time for a second look
      let n = 1;
      if (policy === 'salvo') n = 2;
      else if (policy === 'auto') {
        const lookTime = sol.tInt + T(2.5) + sol.tInt * 0.8;
        const ttgAfter = tr.ttg - lookTime;
        n = ttgAfter > T(6) ? 1 : 2;
        if (fast) n = 2;
      }
      // n is the desired total pending salvo, not a fresh allowance on every evaluation.
      if (policy === 'auto' && n === 1 && tr.lastLook >= 0 && t - tr.lastLook < T(2.5)) continue;
      n = Math.max(0, Math.min(n - inFlight.length, 3 - inFlight.length));
      for (let k = 0; k < n; k++) {
        // each extra salvo round needs its own illuminator slot
        if (k > 0 && INTERCEPTORS[sol.weapon].semiActive) {
          const win = this.termWindow(sol.weapon, t, sol.tInt);
          sol.illum = this.illumFor(sol.pip, win.start, win.end);
          if (sol.illum < 0) break;
        }
        if (!this.fire(sol, tr, t, k)) break;
      }
    }

    // Gun: engage the most urgent in-arc threat within range
    if (W.cfg.doctrine.gun && W.gun.enabled) {
      let best: Track | null = null;
      for (const tr of tracks) {
        if (tr.range > GUN_SPEC.maxRange || tr.range < GUN_SPEC.minRange || tr.ttg < 3) continue;
        if (!W.gun.canEngage(W.ship, tr.threat)) continue;
        if (!best || tr.ttg < best.ttg) best = tr;
      }
      W.gunTarget = best ? best.threat : null;
    } else W.gunTarget = null;

    // Soft kill: Wisp / chaff against ASCMs that are homing
    if (W.cfg.doctrine.decoys) {
      for (const tr of tracks) {
        // time the launch so the decoys have bloomed as the threat's seeker comes on
        const seeker = tr.threat.spec.seekerRange;
        if (tr.decoyed || tr.range > seeker * 0.95 || tr.range < L(2500)) continue;
        if (tr.threat.spec.terminal === 'dive' && tr.range > L(9000)) continue;
        const side = W.relativeSide(tr.estPos);
        const key = side > 0 ? 'port' : 'stbd';
        if (this.decoyCool[key] > 0) continue;
        if (W.launchDecoys(side, tr)) {
          tr.decoyed = true;
          this.decoyCool[key] = T(7);
        }
      }
    }
  }

  private nextManeuver = 0;
  /** Threat-axis maneuvering: flank speed, put the (weighted) threat bearing ~70° off the bow. */
  private maneuver(tracks: Track[], t: number) {
    const W = this.world;
    if (W.cfg.doctrine.maneuver === false || !tracks.length || t < this.nextManeuver) return;
    this.nextManeuver = t + 15;
    const ship = W.ship;
    ship.targetSpeed = Math.max(ship.targetSpeed, 30 * 0.514444);
    // urgency-weighted mean threat bearing
    let sx = 0, sy = 0;
    for (const tr of tracks) {
      const w = 1 / Math.max(tr.ttg, 5);
      sx += Math.sin(tr.bearing) * w;
      sy += Math.cos(tr.bearing) * w;
    }
    const axis = Math.atan2(sx, sy);
    const off = 70 * (Math.PI / 180);
    const wrap = (a: number) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
    const c1 = axis + off, c2 = axis - off;
    const pick = Math.abs(wrap(c1 - ship.heading)) < Math.abs(wrap(c2 - ship.heading)) ? c1 : c2;
    const newH = (pick + 2 * Math.PI) % (2 * Math.PI);
    if (Math.abs(wrap(newH - ship.targetHeading)) > 10 * (Math.PI / 180)) {
      ship.targetHeading = newH;
      W.log(`Bastion: come to ${String(Math.round((newH * 180) / Math.PI)).padStart(3, '0')}°, flank speed — unmasking both mounts to threat axis ${String(Math.round((((axis * 180) / Math.PI) % 360 + 360) % 360)).padStart(3, '0')}°`, 'info');
    }
  }

  private fire(sol: Solution, tr: Track, t: number, salvoIdx: number) {
    const W = this.world;
    const w = sol.weapon;
    // choose launcher by bearing (both can fire any direction; alternate for rate)
    const which: 'fwd' | 'aft' = this.launcherReady.fwd <= this.launcherReady.aft ? 'fwd' : 'aft';
    if (this.launcherReady[which] > 0) return false;
    const m = W.launchInterceptor(w, tr, sol.pip, which);
    if (!m) {
      // this launcher has none of that type: try the other
      const other = which === 'fwd' ? 'aft' : 'fwd';
      if (this.launcherReady[other] > 0) return false;
      const m2 = W.launchInterceptor(w, tr, sol.pip, other);
      if (!m2) return false;
      this.afterLaunch(m2, sol, tr, t, salvoIdx, other);
      return true;
    }
    this.afterLaunch(m, sol, tr, t, salvoIdx, which);
    return true;
  }

  private afterLaunch(m: Interceptor, sol: Solution, tr: Track, t: number, salvoIdx: number, which: 'fwd' | 'aft') {
    const spec = INTERCEPTORS[sol.weapon];
    this.launcherReady[which] = 1.0;
    this.inventory[sol.weapon]--;
    this.shots++;
    m.salvoIdx = salvoIdx;
    m.plannedPk = spec.basePk * tr.threat.spec.interceptPkMod;
    tr.engagedBy.push(m);
    tr.shots++;
    if (spec.semiActive) {
      this.windows.push({ ...this.termWindow(sol.weapon, t, sol.tInt), id: m.id, il: sol.illum });
      m.plannedIllum = sol.illum;
    }
    void THREATS;
  }
}
