import * as THREE from 'three';
import { INTERCEPTORS, InterceptorType, THREATS } from './specs';
import { upAt } from '../core/geo';
import type { Track } from './radar';
import type { Interceptor } from './interceptor';
import type { World } from './world';

export interface Solution {
  weapon: InterceptorType;
  tInt: number;
  pip: THREE.Vector3;
  rangeAtInt: number;
}

const _p = new THREE.Vector3(), _u = new THREE.Vector3();

/**
 * Bastion combat system (automatic doctrine): threat evaluation, weapon assignment,
 * VLS launch scheduling, illuminator time-sharing, gun & decoy employment.
 */
export class Bastion {
  inventory: Record<InterceptorType, number> = { halberd: 0, glaive: 0, stiletto: 0 };
  launcherReady = { fwd: 0, aft: 0 };
  /** Planned semi-active terminal windows (sim time) for illuminator scheduling. */
  windows: { start: number; end: number; id: number }[] = [];
  private nextEval = 0;
  private decoyCool = { port: 0, stbd: 0 };
  shots = 0;
  constructor(private world: World) {}

  /** Predict intercept for weapon w against a track (straight-line threat extrapolation). */
  solve(w: InterceptorType, tr: Track): Solution | null {
    const spec = INTERCEPTORS[w];
    const ship = this.world.ship;
    upAt(ship.pos, _u);
    const launch = _p.copy(ship.pos).addScaledVector(_u, 12);
    let t = tr.range / (spec.avgSpeed + tr.estVel.length());
    const pip = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      pip.copy(tr.estPos).addScaledVector(tr.estVel, t);
      const d = pip.distanceTo(launch);
      // short shots don't reach average speed
      const vavg = spec.avgSpeed * Math.min(1, 0.55 + d / 20000);
      t = spec.verticalTime + 1.2 + d / vavg;
    }
    const rangeAtInt = pip.distanceTo(ship.pos);
    if (rangeAtInt < spec.minRange || rangeAtInt > spec.maxRange) return null;
    if (t > tr.ttg - 0.5) return null; // would arrive after the threat reaches us
    return { weapon: w, tInt: t, pip, rangeAtInt };
  }

  illumCapacity() {
    const W = this.world;
    return W.illuminators.filter((i) => i.enabled).length * W.cfg.doctrine.illumShare;
  }

  /** Can a semi-active shot with terminal window [a,b] be supported? */
  illumAvailable(a: number, b: number) {
    const cap = this.illumCapacity();
    let n = 0;
    for (const w of this.windows) if (w.start < b && w.end > a) n++;
    return n < cap;
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

    const tracks = W.radar.activeTracks().filter((tr) => tr.cls === 'hostile' && t - tr.hostileTime >= W.cfg.doctrine.reaction * 0.5);
    tracks.sort((a, b) => a.ttg - b.ttg);
    for (const tr of tracks) {
      tr.engagedBy = tr.engagedBy.filter((m) => m.alive && m.result === 'pending');
      const inFlight = tr.engagedBy;
      let pSurvive = 1;
      for (const m of inFlight) pSurvive *= 1 - m.plannedPk;
      const policy = W.cfg.doctrine.policy;
      const need = policy === 'salvo' ? 0.9 : 0.75;
      if (1 - pSurvive >= need) continue;
      // Candidate weapons by preference
      const th = tr.threat.spec;
      const fast = th.speed > 500;
      const order: InterceptorType[] = fast ? ['glaive', 'halberd', 'stiletto'] : ['stiletto', 'halberd', 'glaive'];
      let sol: Solution | null = null;
      for (const w of order) {
        if (this.inventory[w] <= 0) continue;
        const s = this.solve(w, tr);
        if (!s) continue;
        // Don't waste long-range shots on far-away subsonic threats: prefer Stiletto envelope when it'll come
        if (!fast && w === 'halberd' && s.rangeAtInt > 30000 && tr.ttg > 90) continue;
        if (INTERCEPTORS[w].semiActive && !this.illumAvailable(t + s.tInt - INTERCEPTORS[w].terminalTime - 0.5, t + s.tInt + 0.5)) continue;
        sol = s;
        break;
      }
      if (!sol) continue;
      // Shots this pass: salvo of two, or one (shoot-look-shoot) when there's time for a second look
      let n = 1;
      if (policy === 'salvo') n = 2;
      else if (policy === 'auto') {
        const lookTime = sol.tInt + 2.5 + sol.tInt * 0.8;
        const ttgAfter = tr.ttg - lookTime;
        n = ttgAfter > 6 ? 1 : 2;
        if (fast) n = 2;
      }
      n = Math.max(1, Math.min(n, 3 - inFlight.length));
      for (let k = 0; k < n; k++) {
        if (!this.fire(sol, tr, t, k)) break;
      }
    }

    // Gun: engage the most urgent in-arc threat within range
    if (W.cfg.doctrine.gun && W.gun.enabled) {
      let best: Track | null = null;
      for (const tr of tracks) {
        if (tr.range > 12000 || tr.range < 1600 || tr.ttg < 3) continue;
        if (!best || tr.ttg < best.ttg) best = tr;
      }
      W.gunTarget = best ? best.threat : null;
    } else W.gunTarget = null;

    // Soft kill: Wisp / chaff against ASCMs that are homing
    if (W.cfg.doctrine.decoys) {
      for (const tr of tracks) {
        if (tr.decoyed || tr.range > 17000 || tr.range < 2500) continue;
        if (tr.threat.spec.terminal === 'dive' && tr.range > 9000) continue;
        const side = W.relativeSide(tr.estPos);
        const key = side > 0 ? 'port' : 'stbd';
        if (this.decoyCool[key] > 0) continue;
        if (W.launchDecoys(side, tr)) {
          tr.decoyed = true;
          this.decoyCool[key] = 7;
        }
      }
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
    if (spec.semiActive) this.windows.push({ start: t + sol.tInt - spec.terminalTime - 0.5, end: t + sol.tInt + 0.5, id: m.id });
    void THREATS;
  }
}
