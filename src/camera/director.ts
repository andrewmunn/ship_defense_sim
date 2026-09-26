import * as THREE from 'three';
import type { Game, GamePlugin } from '../game/game';
import type { World } from '../sim/world';
import type { Threat } from '../sim/threat';
import type { Interceptor } from '../sim/interceptor';
import type { FixedMount } from './cameraRig';
import { ciwsMount, flybyMount, wingMount, nearestThreat } from './shots';
import { upAt, enuAt } from '../core/geo';
import { rng } from '../core/rng';

const _v = new THREE.Vector3(), _u = new THREE.Vector3(), _s = new THREE.Vector3();

interface Shot {
  kind: string;
  prio: number;
  minDur: number;
  maxDur: number;
  start: () => void;
  /** Called each frame while active; return false to end the shot early. */
  tick?: (dt: number) => boolean;
}

/**
 * Cinematic auto-director: watches the sim for interesting moments (launches, intercepts, CIWS
 * engagements, hits) and cuts between framed shots. Any user camera input hands control back.
 */
export class Director implements GamePlugin {
  active = false;
  slowmo = true;
  private cur: Shot | null = null;
  private shotT = 0;
  private evalAcc = 0;
  private recentLaunch: { m: Interceptor; t: number } | null = null;
  private recentThreatLaunch: { th: Threat; t: number } | null = null;
  private recentHit: { pos: THREE.Vector3; t: number } | null = null;
  private idleIdx = 0;
  private savedScale = 1;
  private slowUntil = -1;
  private seenWaves = new Set<number>();
  private usedIntercepts = new Set<number>();
  onChange: (active: boolean) => void = () => {};

  constructor(private g: Game) {
    g.rig.onUserInput = () => {
      if (this.active) this.setActive(false);
    };
  }

  onRestart(w: World) {
    this.cur = null;
    this.seenWaves.clear();
    this.usedIntercepts.clear();
    this.recentLaunch = this.recentThreatLaunch = this.recentHit = null;
    w.events.on('interceptorLaunch', (e) => (this.recentLaunch = { m: e.m, t: w.t }));
    w.events.on('threatLaunch', (e) => {
      if (!this.seenWaves.has(e.threat.waveIdx)) {
        this.seenWaves.add(e.threat.waveIdx);
        this.recentThreatLaunch = { th: e.threat, t: w.t };
      }
    });
    w.events.on('shipHit', (e) => (this.recentHit = { pos: e.world.clone(), t: w.t }));
  }

  setActive(a: boolean) {
    if (a === this.active) return;
    this.active = a;
    if (!a) {
      this.endSlowmo();
      this.cur = null;
    } else {
      this.cur = null;
      this.shotT = 0;
    }
    this.onChange(a);
  }

  private get W() {
    return this.g.world;
  }

  update(dtReal: number) {
    if (!this.active) return;
    this.shotT += dtReal;
    if (this.slowUntil > 0 && this.g.realTime > this.slowUntil) this.endSlowmo();
    if (this.cur?.tick && !this.cur.tick(dtReal)) this.cur = null;
    this.evalAcc += dtReal;
    if (this.evalAcc < 0.15 && this.cur) return;
    this.evalAcc = 0;
    const cand = this.candidates();
    // novelty: a kind we just showed is less interesting for a while
    for (const c of cand) {
      const since = this.g.realTime - (this.lastUsed[c.kind] ?? -1e9);
      const same = this.cur?.kind === c.kind;
      if (c.kind !== 'hit' && (same || since < 7)) c.prio -= c.kind === 'intercept' ? 1.5 : 3.5;
    }
    cand.sort((a, b) => b.prio - a.prio);
    const best = cand[0];
    const cur = this.cur;
    const canCut = !cur || this.shotT > cur.minDur;
    const mustCut = !cur || this.shotT > cur.maxDur;
    if (best && ((canCut && best.prio > (cur?.prio ?? -1)) || mustCut || (best.prio >= (cur?.prio ?? 0) + 3 && this.shotT > 0.8))) {
      if (!cur || best.kind !== cur.kind || mustCut || best.prio > cur.prio) this.cut(best);
    } else if (!best && mustCut) {
      this.cut(this.idleShot());
    }
  }

  private lastUsed: Record<string, number> = {};
  private cut(s: Shot) {
    if (this.cur) this.lastUsed[this.cur.kind] = this.g.realTime;
    this.cur = s;
    this.shotT = 0;
    s.start();
  }

  private endSlowmo() {
    if (this.slowUntil > 0) {
      this.g.timeHold = false;
      if (!this.g.autoTime) this.g.setTimeScale(this.savedScale);
      this.slowUntil = -1;
    }
  }
  private slow(scale: number, realSec: number) {
    if (!this.slowmo || this.g.paused) return;
    if (this.slowUntil < 0) this.savedScale = this.g.timeScale;
    if (this.savedScale <= scale) return;
    this.g.timeHold = true;
    this.g.setTimeScale(scale);
    this.slowUntil = this.g.realTime + realSec;
  }

  // ------------------------------------------------------------------ candidates
  private candidates(): Shot[] {
    const W = this.W, g = this.g, t = W.t;
    const out: Shot[] = [];
    // ship hit: wide, dramatic
    if (this.recentHit && t - this.recentHit.t < 1.5) {
      const p = this.recentHit.pos;
      out.push({
        kind: 'hit', prio: 10, minDur: 4, maxDur: 8,
        start: () => {
          g.rig.follow(W.ship, { dist: 420, mode: 'orbit' });
          g.rig.pitchGoal = 0.12;
          g.rig.yawGoal = this.yawFromShipTo(p) + 0.9;
          g.rig.fovGoal = 45;
          this.slow(0.35, 3);
        },
      });
      this.recentHit = null;
    }
    // imminent intercept
    let bestI: Interceptor | null = null;
    for (const m of W.interceptors) {
      if (!m.alive || !m.target.alive || m.phase !== 'terminal' || this.usedIntercepts.has(m.id)) continue;
      if (m.tgo < 2.0 && m.tgo > 0.35 && (!bestI || m.tgo < bestI.tgo)) bestI = m;
    }
    if (bestI) {
      const m = bestI;
      out.push({
        kind: 'intercept', prio: 9, minDur: Math.min(8, (m.tgo + 1.5) / 0.25), maxDur: 10,
        start: () => {
          this.usedIntercepts.add(m.id);
          const pip = _v.copy(m.target.pos).addScaledVector(m.target.vel, m.tgo);
          upAt(pip, _u);
          const los = m.target.vel.clone().normalize();
          const side = _s.crossVectors(los, _u).normalize();
          const d = THREE.MathUtils.clamp(m.target.vel.length() * 0.35, 80, 260);
          const place = pip.clone().addScaledVector(side, d * (rng.chance(0.5) ? 1 : -1)).addScaledVector(los, -d * 0.6).addScaledVector(_u, d * 0.1);
          this.setMount(flybyMount(g, m.target, place, 34));
          // hold slow motion through the detonation and the first second of the fireball
          this.slow(0.25, THREE.MathUtils.clamp((m.tgo + 1.5) / 0.25, 3, 9));
        },
      });
    }
    // leaker close to the ship: dramatic defense shot from behind the ship along the threat axis
    const near = nearestThreat(g, 6000);
    if (near) {
      const r = near.pos.distanceTo(W.ship.pos);
      const firing = W.ciws.some((c) => c.firing);
      out.push({
        kind: 'defense', prio: firing ? 8 : 7, minDur: 3, maxDur: 7,
        start: () => {
          const th = near;
          if (firing && rng.chance(0.5)) {
            const idx = W.ciws.findIndex((c) => c.firing);
            this.setMount(ciwsMount(g, Math.max(0, idx)));
            return;
          }
          this.setMount(this.defenseMount(th));
          if (r < 2500) this.slow(0.3, 3);
        },
      });
    }
    // our own VLS launch
    if (this.recentLaunch && t - this.recentLaunch.t < 1.2 && this.recentLaunch.m.alive) {
      const m = this.recentLaunch.m;
      out.push({
        kind: 'vls', prio: 6, minDur: 3, maxDur: 5,
        start: () => {
          const ship = W.ship;
          const side = rng.chance(0.5) ? 1 : -1;
          const cell = m.launcher === 'fwd' ? 40 : -28;
          const place = new THREE.Vector3(side * (70 + rng.next() * 40), 12 + rng.next() * 18, cell - 30 - rng.next() * 40).applyMatrix4(ship.localToWorld);
          this.setMount(flybyMount(g, m, place, 38));
        },
      });
      this.recentLaunch = null;
    }
    // first launch of each wave: go to the coast
    if (this.recentThreatLaunch && t - this.recentThreatLaunch.t < 1.5 && this.recentThreatLaunch.th.alive) {
      const th = this.recentThreatLaunch.th;
      out.push({
        kind: 'coast', prio: 6.5, minDur: 4, maxDur: 7,
        start: () => {
          g.rig.follow(th, { dist: 60, mode: 'orbit' });
          g.rig.yawGoal = this.yawFromShipTo(th.pos) + Math.PI * 0.6;
          g.rig.pitchGoal = 0.12;
          g.rig.fovGoal = 40;
        },
      });
      this.recentThreatLaunch = null;
    }
    // missiles in flight toward us (midcourse): chase occasionally
    if (!this.cur || this.cur.kind === 'idle') {
      const fly = W.threats.filter((x) => x.alive && x.phase !== 'boost');
      if (fly.length && rng.chance(0.25)) {
        const th = fly[Math.floor(rng.next() * fly.length)];
        out.push({
          kind: 'chase', prio: 3, minDur: 5, maxDur: 8,
          start: () => {
            g.rig.follow(th, { dist: 38, mode: 'chase' });
            g.rig.pitchGoal = 0.08;
            g.rig.chaseYawOffset = (rng.next() - 0.5) * 0.8;
            g.rig.fovGoal = 45;
          },
        });
      }
      const up = W.interceptors.filter((x) => x.alive && x.phase === 'midcourse');
      if (up.length && rng.chance(0.3)) {
        const m = up[Math.floor(rng.next() * up.length)];
        out.push({
          kind: 'interceptor', prio: 3.5, minDur: 4, maxDur: 7,
          start: () => {
            g.rig.follow(m, { dist: 26, mode: 'chase' });
            g.rig.pitchGoal = 0.15;
            g.rig.chaseYawOffset = (rng.next() - 0.5) * 1.2;
            g.rig.fovGoal = 50;
          },
        });
      }
    }
    return out;
  }

  private idleShot(): Shot {
    const g = this.g, W = this.W;
    const shots: (() => Shot)[] = [
      () => ({
        kind: 'idle', prio: 0, minDur: 7, maxDur: 11,
        start: () => {
          g.rig.follow(W.ship, { dist: 190 + rng.next() * 80, mode: 'orbit' });
          g.rig.pitchGoal = 0.04 + rng.next() * 0.08;
          g.rig.yawGoal = rng.next() * Math.PI * 2;
          g.rig.fovGoal = 40;
        },
        tick: (dt) => { g.rig.yawGoal += dt * 0.05; return true; },
      }),
      () => ({
        kind: 'idle', prio: 0, minDur: 6, maxDur: 10,
        start: () => {
          // long lens from a distance at wave height
          const ship = W.ship;
          const place = new THREE.Vector3((rng.next() - 0.5) * 1200, 3, 900 + rng.next() * 600).applyMatrix4(ship.localToWorld);
          this.setMount(flybyMount(g, ship, place, 9));
        },
      }),
      () => ({
        kind: 'idle', prio: 0, minDur: 6, maxDur: 10,
        start: () => {
          g.rig.follow(W.ship, { dist: 1400, mode: 'orbit' });
          g.rig.pitchGoal = 0.75;
          g.rig.yawGoal = W.ship.heading + Math.PI + (rng.next() - 0.5);
          g.rig.fovGoal = 35;
        },
        tick: (dt) => { g.rig.yawGoal += dt * 0.02; return true; },
      }),
      () => ({
        kind: 'idle', prio: 0, minDur: 6, maxDur: 9,
        start: () => this.setMount(wingMount(g)),
      }),
      () => ({
        kind: 'idle', prio: 0, minDur: 6, maxDur: 10,
        start: () => {
          g.rig.follow(W.ship, { dist: 95, mode: 'orbit' });
          g.rig.pitchGoal = 0.02;
          g.rig.yawGoal = W.ship.heading + (rng.chance(0.5) ? 0.5 : -0.5);
          g.rig.fovGoal = 55;
        },
        tick: (dt) => { g.rig.yawGoal += dt * 0.035; return true; },
      }),
    ];
    this.idleIdx = (this.idleIdx + 1 + Math.floor(rng.next() * 2)) % shots.length;
    return shots[this.idleIdx]();
  }

  /** Camera behind & beside the ship looking out along the threat axis, keeping both in frame. */
  private defenseMount(th: Threat): FixedMount {
    const g = this.g, W = this.W;
    const look = new THREE.Vector3().copy(W.ship.pos);
    const sideSign = rng.chance(0.5) ? 1 : -1;
    const back = 110 + rng.next() * 80;
    const hgt = 14 + rng.next() * 30;
    return {
      fov: 42,
      get(pos, lk, up) {
        const ship = W.ship;
        upAt(ship.pos, up);
        const dir = _v.copy(th.alive ? th.pos : look).sub(ship.pos);
        dir.addScaledVector(up, -dir.dot(up)).normalize();
        const side = _s.crossVectors(dir, up).normalize();
        pos.copy(ship.pos).addScaledVector(dir, -back).addScaledVector(side, sideSign * back * 0.35).addScaledVector(up, hgt);
        const goal = th.alive ? _u.copy(ship.pos).lerp(th.pos, Math.min(0.5, 800 / Math.max(th.pos.distanceTo(ship.pos), 1))) : ship.pos;
        look.lerp(goal, 0.08);
        lk.copy(look);
        return true;
      },
    };
  }

  private setMount(m: FixedMount) {
    this.g.rig.setFixed(m);
    this.g.rig.fovGoal = m.fov ?? 50;
  }

  private yawFromShipTo(p: THREE.Vector3) {
    const { e, n } = enuAt(this.W.ship.pos);
    _v.copy(p).sub(this.W.ship.pos);
    return Math.atan2(_v.dot(e), _v.dot(n));
  }
}
