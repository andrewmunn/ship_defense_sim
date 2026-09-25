import * as THREE from 'three';
import { Emitter } from '../core/events';
import { Rng, rng } from '../core/rng';
import { destination, upAt, altitude, setAltitude, surfaceDistance, bearingTo, bearingDir, enuAt } from '../core/geo';
import { KNOTS, DEG } from '../core/constants';
import { Ship, Debris, Decoy, Launcher, Entity } from './entities';
import { Threat } from './threat';
import { Interceptor } from './interceptor';
import { Radar, Track } from './radar';
import { Bastion } from './bastion';
import { Ciws, Gun, Illuminator } from './mounts';
import { RoundPool } from './rounds';
import { Terrain } from './terrain';
import { WaveField } from './waves';
import { THREATS, INTERCEPTORS, CIWS_SPEC, GUN_SPEC, InterceptorType, ThreatType } from './specs';
import type { ScenarioConfig } from './scenario';

export type DetKind = 'intercept' | 'selfdestruct' | 'warhead' | 'shipHit' | 'water' | 'shell' | 'debris' | 'breakup';

export interface SimEvents {
  threatLaunch: { threat: Threat; launcher: Launcher };
  boosterSep: { from: Entity; debris: Debris };
  interceptorLaunch: { m: Interceptor; cell: number; launcher: 'fwd' | 'aft' };
  detonation: { pos: THREE.Vector3; vel: THREE.Vector3; kind: DetKind; size: number; entity?: Entity };
  ciwsFire: { mount: Ciws; firing: boolean };
  ciwsHit: { pos: THREE.Vector3; threat: Threat };
  gunFire: { pos: THREE.Vector3; dir: THREE.Vector3 };
  splash: { pos: THREE.Vector3; size: number };
  shipHit: { local: THREE.Vector3; world: THREE.Vector3; damage: number; zone: string };
  track: { track: Track };
  kill: { threat: Threat; by: string };
  decoy: { decoy: Decoy; from: THREE.Vector3 };
  log: { t: number; text: string; level: 'info' | 'warn' | 'alert' | 'kill' | 'good' };
  threatDeath: { threat: Threat; mode: string };
  sunk: {};
}

/** Ship-local positions of weapons/sensors (from the 3D model). */
export interface ShipLayout {
  vlsFwd: THREE.Vector3[];
  vlsAft: THREE.Vector3[];
  ciwsFwd: THREE.Vector3;
  ciwsAft: THREE.Vector3;
  gun: THREE.Vector3;
  illumFwd: THREE.Vector3;
  illumAftP: THREE.Vector3;
  illumAftS: THREE.Vector3;
  decoyLaunchers: { pos: THREE.Vector3; side: number }[];
}

export function defaultLayout(): ShipLayout {
  const cells = (z0: number, rows: number, y: number) => {
    const out: THREE.Vector3[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < 8; c++) out.push(new THREE.Vector3((c - 3.5) * 0.84, y, z0 - r * 1.31));
    return out;
  };
  return {
    vlsFwd: cells(41, 4, 8.3),
    vlsAft: cells(-25, 8, 8.9),
    ciwsFwd: new THREE.Vector3(0, 12.4, 32),
    ciwsAft: new THREE.Vector3(0, 15.5, -49.4),
    gun: new THREE.Vector3(0, 8.6, 47.2),
    illumFwd: new THREE.Vector3(0, 23.2, 23.6),
    illumAftP: new THREE.Vector3(6.4, 14.9, -27.6),
    illumAftS: new THREE.Vector3(-6.4, 14.9, -27.6),
    decoyLaunchers: [
      { pos: new THREE.Vector3(6.2, 10.5, 32.2), side: 1 },
      { pos: new THREE.Vector3(-6.2, 10.5, 32.2), side: -1 },
      { pos: new THREE.Vector3(7.3, 10.5, -12), side: 1 },
      { pos: new THREE.Vector3(-7.3, 10.5, -12), side: -1 },
    ],
  };
}

interface PlannedLaunch {
  time: number;
  type: ThreatType;
  site: number;
  route: THREE.Vector3[];
  arrival: number;
  profile: 'hi' | 'lo';
  wave: number;
  bearing: number;
}

interface VlsCell {
  local: THREE.Vector3;
  type: InterceptorType | null;
  count: number;
  launcher: 'fwd' | 'aft';
  idx: number;
}

export interface Stats {
  launched: number;
  killed: number;
  hits: number;
  byWeapon: Record<string, number>;
  fired: Record<string, number>;
  ciwsRounds: number;
  gunRounds: number;
  decoysSeduced: number;
  splashedOther: number;
  results: Record<string, number>;
}

const _v = new THREE.Vector3(), _u = new THREE.Vector3();

export class World {
  t = 0;
  events = new Emitter<SimEvents>();
  ship: Ship;
  threats: Threat[] = [];
  interceptors: Interceptor[] = [];
  debris: Debris[] = [];
  decoys: Decoy[] = [];
  launchers: Launcher[] = [];
  sites: THREE.Vector3[] = [];
  radar = new Radar();
  bastion: Bastion;
  ciws: Ciws[];
  gun: Gun;
  gunTarget: Threat | null = null;
  illuminators: Illuminator[];
  ciwsRounds = new RoundPool(6000, CIWS_SPEC.dragK);
  shells = new RoundPool(200, GUN_SPEC.dragK);
  terrain: Terrain;
  waves: WaveField;
  wind = new THREE.Vector3();
  plan: PlannedLaunch[] = [];
  cells: VlsCell[] = [];
  stats: Stats = { launched: 0, killed: 0, hits: 0, byWeapon: {}, fired: { halberd: 0, glaive: 0, stiletto: 0 }, ciwsRounds: 0, gunRounds: 0, decoysSeduced: 0, splashedOther: 0, results: {} };
  wisp: number;
  chaff: number;
  over = false;
  outcome: '' | 'survived' | 'sunk' = '';
  private rngS: Rng;
  totalPlanned = 0;
  /** Persistent seeker target proxy for the ship (seekers hold a reference to it). */
  shipTarget = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), id: 0, rcs: 9000 };
  firstArrival = Infinity;

  constructor(public cfg: ScenarioConfig, public layout: ShipLayout = defaultLayout()) {
    this.rngS = new Rng(cfg.seed * 7919 + 17);
    this.waves = new WaveField(cfg.env.seaState, (cfg.env.windDeg + 180) * DEG);
    const wsp = 3 + cfg.env.seaState * 2.5;
    const wb = (cfg.env.windDeg + 180) * DEG; // wind blows toward
    this.wind.set(Math.sin(wb) * wsp, 0, -Math.cos(wb) * wsp);
    this.terrain = new Terrain(cfg.coastBearing * DEG, cfg.coastKm * 1000);

    const ship = (this.ship = new Ship());
    ship.heading = ship.targetHeading = cfg.ship.heading * DEG;
    ship.speed = ship.targetSpeed = cfg.ship.speedKts * KNOTS;
    ship.setHitBoxes([
      { center: [0, 2.5, 60], size: [11, 11, 34] },
      { center: [0, 2.5, 20], size: [20, 11, 46] },
      { center: [0, 2.5, -30], size: [19.5, 11, 54] },
      { center: [0, 2.5, -66], size: [17, 9, 22] },
      { center: [0, 13, 21], size: [16, 14, 28] },
      { center: [0, 14, -6], size: [14, 17, 26] },
      { center: [0, 8.5, -38], size: [18.5, 8, 36] },
    ]);
    ship.updateFrame();

    const L = this.layout;
    this.ciws = [new Ciws('CIWS 1 (fwd)', L.ciwsFwd, 0, 0), new Ciws('CIWS 2 (aft)', L.ciwsAft, Math.PI, 1)];
    this.gun = new Gun(L.gun);
    this.gun.ammo = cfg.loadout.gunRounds;
    for (const c of this.ciws) c.ammo = cfg.loadout.ciwsRounds;
    this.illuminators = [
      new Illuminator('LANTERN #1 (fwd)', L.illumFwd, 0, 160 * DEG),
      new Illuminator('LANTERN #2 (aft P)', L.illumAftP, 150 * DEG, 110 * DEG),
      new Illuminator('LANTERN #3 (aft S)', L.illumAftS, -150 * DEG, 110 * DEG),
    ];
    this.bastion = new Bastion(this);
    this.wisp = cfg.loadout.wisp;
    this.chaff = cfg.loadout.chaff;
    this.loadVls();
    this.placeSites();
    this.planRaid();
  }

  // ------------------------------------------------------------------ setup
  private loadVls() {
    const L = this.layout;
    const lo = this.cfg.loadout;
    const all: VlsCell[] = [
      ...L.vlsFwd.map((p, i) => ({ local: p, type: null, count: 0, launcher: 'fwd' as const, idx: i })),
      ...L.vlsAft.map((p, i) => ({ local: p, type: null, count: 0, launcher: 'aft' as const, idx: L.vlsFwd.length + i })),
    ];
    const r = new Rng(this.cfg.seed + 3);
    const free = all.slice();
    const take = () => free.splice(r.int(0, free.length - 1), 1)[0];
    const put = (type: InterceptorType, n: number) => {
      const per = INTERCEPTORS[type].perCell;
      let left = n;
      while (left > 0 && free.length) {
        const c = take();
        c.type = type;
        c.count = Math.min(per, left);
        left -= c.count;
      }
    };
    put('stiletto', lo.stiletto);
    put('glaive', lo.glaive);
    put('halberd', lo.halberd);
    this.cells = all;
    this.bastion.inventory = { halberd: lo.halberd, glaive: lo.glaive, stiletto: lo.stiletto };
    // actual counts (limited by cells)
    for (const k of ['halberd', 'glaive', 'stiletto'] as InterceptorType[]) this.bastion.inventory[k] = all.filter((c) => c.type === k).reduce((a, c) => a + c.count, 0);
  }

  /** Point on the coastline along a bearing from the origin (binary search on the land mask). */
  coastPoint(bearing: number) {
    const o = new THREE.Vector3();
    let lo = 1000, hi = 250000;
    const T = this.terrain;
    const f = (d: number) => {
      const p = destination(o, bearing, d);
      return T.inland(p.x, p.z) > 0 && T.height(p.x, p.z) > 2;
    };
    // walk out until land
    let d = 1000;
    while (d < hi && !f(d)) d += 500;
    hi = d;
    lo = Math.max(1000, d - 500);
    for (let i = 0; i < 20; i++) {
      const m = (lo + hi) / 2;
      if (f(m)) hi = m;
      else lo = m;
    }
    return hi;
  }

  private placeSites() {
    const n = Math.max(1, this.cfg.sites);
    const cb = this.cfg.coastBearing * DEG;
    const spread = Math.min(70, 12 + n * 9) * DEG;
    for (let i = 0; i < n; i++) {
      const b = cb + (n === 1 ? 0 : (i / (n - 1) - 0.5) * 2 * spread) + this.rngS.gauss() * 2 * DEG;
      const dCoast = this.coastPoint(b);
      const d = dCoast + 1500 + this.rngS.range(0, 1500);
      const p = destination(new THREE.Vector3(), b, d);
      const h = Math.max(this.terrain.height(p.x, p.z), 2);
      setAltitude(p, h);
      this.sites.push(p);
      for (let k = 0; k < 2; k++) {
        const L = new Launcher(i, 4);
        const off = bearingDir(p, b + Math.PI / 2, new THREE.Vector3()).multiplyScalar((k - 0.5) * 60);
        L.pos.copy(p).add(off);
        setAltitude(L.pos, Math.max(this.terrain.height(L.pos.x, L.pos.z), 2) + 0.05);
        L.heading = b + Math.PI; // facing the sea
        L.name = `Battery ${String.fromCharCode(65 + i)}-${k + 1}`;
        const { e, n: nn, u } = enuAt(L.pos);
        const f = nn.clone().multiplyScalar(Math.cos(L.heading)).addScaledVector(e, Math.sin(L.heading));
        const x = new THREE.Vector3().crossVectors(u, f).normalize();
        L.quat.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, u, f));
        this.launchers.push(L);
      }
    }
  }

  /** Build the launch schedule: route each missile to arrive from its axis at its planned time. */
  private planRaid() {
    const shipV = this.ship.vel.clone();
    this.ship.forward(shipV).multiplyScalar(this.ship.speed);
    let wi = 0;
    for (const w of this.cfg.waves) {
      const spec = THREATS[w.type];
      for (let k = 0; k < w.count; k++) {
        const axis = w.axes <= 1 ? 0 : k % w.axes;
        const axT = w.axes <= 1 ? 0 : axis / (w.axes - 1) - 0.5;
        const bearing = (this.cfg.coastBearing + axT * 2 * w.fan + this.rngS.gauss() * 3) * DEG;
        const arrival = w.time + k * w.spacing + this.rngS.range(0, 0.3) * w.spacing;
        const aim = this.ship.pos.clone().addScaledVector(shipV, arrival);
        // choose the site closest to the approach bearing
        let site = 0, bestD = Infinity;
        this.sites.forEach((s, i) => {
          let d = Math.abs(bearingTo(new THREE.Vector3(), s) - bearing);
          if (d > Math.PI) d = 2 * Math.PI - d;
          const jitter = this.rngS.range(0, 0.25);
          if (d + jitter < bestD) { bestD = d + jitter; site = i; }
        });
        const sp = this.sites[site];
        const route: THREE.Vector3[] = [];
        // Waypoint on the approach axis at ~45% of the coast distance (dog-leg for multi-axis attacks)
        const dSite = surfaceDistance(aim, sp);
        const wpD = Math.min(dSite * 0.55, 22000);
        const wp = destination(aim, bearing, wpD);
        const siteBrg = bearingTo(aim, sp);
        let dB = Math.abs(siteBrg - bearing);
        if (dB > Math.PI) dB = 2 * Math.PI - dB;
        if (dB > 4 * DEG) route.push(wp);
        route.push(aim);
        let len = 0, prev = sp;
        for (const p of route) { len += surfaceDistance(prev, p); prev = p; }
        const climb = w.profile === 'hi' && spec.cruiseAlt > 1000 ? spec.cruiseAlt * 1.2 : 0;
        const flight = spec.boostTime + (len + climb) / (spec.speed * 0.97) + 4;
        let time = arrival - flight;
        if (time < 2 + k * 0.4) time = 2 + k * 0.4 + this.rngS.range(0, 1);
        this.plan.push({ time, type: w.type, site, route, arrival, profile: w.profile, wave: wi, bearing });
      }
      wi++;
    }
    this.plan.sort((a, b) => a.time - b.time);
    this.totalPlanned = this.plan.length;
    this.firstArrival = Math.min(...this.plan.map((p) => p.arrival), Infinity);
  }

  log(text: string, level: SimEvents['log']['level'] = 'info') {
    this.events.emit('log', { t: this.t, text, level });
  }

  relativeSide(p: THREE.Vector3) {
    const fwd = this.ship.forward(new THREE.Vector3());
    upAt(this.ship.pos, _u);
    const port = new THREE.Vector3().crossVectors(_u, fwd);
    return p.clone().sub(this.ship.pos).dot(port) > 0 ? 1 : -1;
  }

  // ------------------------------------------------------------------ actions
  launchInterceptor(type: InterceptorType, tr: Track, pip: THREE.Vector3, launcher: 'fwd' | 'aft') {
    const cands = this.cells.filter((c) => c.type === type && c.count > 0 && c.launcher === launcher);
    if (!cands.length) return null;
    const cell = cands[Math.floor(rng.next() * cands.length)];
    cell.count--;
    const m = new Interceptor(type, tr.threat, tr);
    const ship = this.ship;
    m.pos.copy(cell.local).applyMatrix4(ship.localToWorld);
    m.launchUp.set(0, 1, 0).applyQuaternion(ship.quat).normalize();
    m.pos.addScaledVector(m.launchUp, 0.5);
    m.vel.copy(ship.vel).addScaledVector(m.launchUp, 25);
    m.pip.copy(pip);
    m.cell = cell.idx;
    m.launcher = launcher;
    this.interceptors.push(m);
    this.stats.fired[type]++;
    this.events.emit('interceptorLaunch', { m, cell: cell.idx, launcher });
    const brg = Math.round((tr.bearing / DEG + 360) % 360);
    this.log(`${INTERCEPTORS[type].short} away → TN ${tr.tn} brg ${String(brg).padStart(3, '0')} rng ${(tr.range / 1000).toFixed(1)} km`, 'info');
    return m;
  }

  launchDecoys(side: number, tr: Track) {
    const ship = this.ship;
    let fired = false;
    const mounts = this.layout.decoyLaunchers.filter((s) => s.side === side);
    if (!mounts.length) return false;
    const mnt = mounts[Math.floor(rng.next() * mounts.length)];
    const from = mnt.pos.clone().applyMatrix4(ship.localToWorld);
    upAt(ship.pos, _u);
    const toThreat = tr.estPos.clone().sub(ship.pos);
    toThreat.addScaledVector(_u, -toThreat.dot(_u)).normalize();
    if (this.wisp > 0) {
      this.wisp--;
      const d = new Decoy('wisp');
      d.pos.copy(from);
      // Wisp flies out perpendicular-ish, away from the ship toward the threat side
      const fwd = ship.forward(new THREE.Vector3());
      const dir = toThreat.clone().multiplyScalar(0.4).addScaledVector(fwd, rng.chance(0.5) ? 0.6 : -0.6).normalize();
      d.vel.copy(ship.vel).addScaledVector(dir, 28).addScaledVector(_u, 30);
      this.decoys.push(d);
      this.events.emit('decoy', { decoy: d, from });
      fired = true;
    }
    if (this.chaff > 0) {
      this.chaff--;
      const d = new Decoy('chaff');
      d.pos.copy(from);
      d.vel.copy(ship.vel).addScaledVector(toThreat, 70).addScaledVector(_u, 55);
      this.decoys.push(d);
      this.events.emit('decoy', { decoy: d, from });
      fired = true;
    }
    if (fired) this.log(`Decoys launched (${side > 0 ? 'port' : 'stbd'}) vs TN ${tr.tn}`, 'info');
    return fired;
  }

  private requestIllum = (m: Interceptor) => {
    const cap = this.cfg.doctrine.illumShare;
    // pick the least-loaded illuminator that can see the target
    let best: Illuminator | null = null;
    for (const il of this.illuminators) {
      if (!il.enabled || il.assigned.length >= cap) continue;
      if (!il.canSee(this.ship, m.target.pos)) continue;
      if (!best || il.assigned.length < best.assigned.length) best = il;
    }
    if (!best) {
      this.log(`No illuminator for ${m.spec.short} vs TN ${m.track.tn} — engagement degraded`, 'warn');
      return false;
    }
    best.assigned.push({ id: m.id, target: m.target });
    m.illuminator = this.illuminators.indexOf(best);
    return true;
  };

  private releaseIllum(m: Interceptor) {
    if (m.illuminator < 0) return;
    const il = this.illuminators[m.illuminator];
    il.assigned = il.assigned.filter((a) => a.id !== m.id);
    m.illuminator = -1;
  }

  private killThreat(th: Threat, by: string, mode: 'blast' | 'breakup') {
    if (!th.alive) return;
    th.alive = false;
    th.killedBy = by;
    th.deathMode = mode;
    this.stats.killed++;
    this.stats.byWeapon[by] = (this.stats.byWeapon[by] ?? 0) + 1;
    this.radar.markDead(th, this.t);
    const rng1 = th.pos.distanceTo(this.ship.pos);
    this.events.emit('kill', { threat: th, by });
    this.log(`SPLASH TN ${th.trackNumber || '----'} (${th.spec.short.split(' ')[0]}) by ${by} at ${(rng1 / 1000).toFixed(2)} km`, 'kill');
    if (mode === 'blast') {
      this.events.emit('detonation', { pos: th.pos.clone(), vel: th.vel.clone().multiplyScalar(0.3), kind: 'warhead', size: th.spec.warheadKg, entity: th });
      th.remove = true;
    } else {
      // Airframe breaks up: the carcass keeps its momentum and may still reach the ship
      const d = new Debris('carcass', th.spec.model, 1, 0.0006);
      d.pos.copy(th.pos);
      d.vel.copy(th.vel);
      d.quat.copy(th.quat);
      d.spin.set(rng.gauss() * 2, rng.gauss() * 2, rng.gauss() * 4);
      d.life = 40;
      d.radius = th.spec.length / 2;
      (d as any).warheadKg = th.spec.warheadKg;
      (d as any).live = rng.chance(0.25);
      this.debris.push(d);
      this.events.emit('detonation', { pos: th.pos.clone(), vel: th.vel.clone().multiplyScalar(0.5), kind: 'breakup', size: 20, entity: th });
      th.remove = true;
    }
    this.events.emit('threatDeath', { threat: th, mode });
  }

  private shipHit(pos: THREE.Vector3, local: THREE.Vector3, zone: string, warheadKg: number, name: string) {
    const ship = this.ship;
    const dmg = Math.min(110, warheadKg * 0.21 + 4);
    ship.hp = Math.max(0, ship.hp - dmg);
    ship.hits++;
    this.stats.hits++;
    (ship.damage as any)[zone] += dmg;
    ship.fires.push({ local: local.clone(), intensity: Math.min(1, 0.4 + warheadKg / 300), age: 0 });
    this.events.emit('shipHit', { local: local.clone(), world: pos.clone(), damage: dmg, zone });
    this.events.emit('detonation', { pos: pos.clone(), vel: new THREE.Vector3(), kind: 'shipHit', size: warheadKg });
    this.log(`!!! ${name} IMPACT — ${zone.toUpperCase()} — damage ${Math.round(dmg)}% (hull ${Math.round(ship.hp)}%)`, 'alert');
    // Systems in the blast radius go down
    const R = 10 + warheadKg / 25;
    const knock = (p: THREE.Vector3, off: () => void, label: string) => {
      const d = p.distanceTo(local);
      if (d < R && rng.chance(1 - d / R + 0.15)) {
        off();
        this.log(`${label} OFFLINE`, 'warn');
      }
    };
    const L = this.layout;
    knock(L.ciwsFwd, () => (this.ciws[0].enabled = false), 'CIWS 1');
    knock(L.ciwsAft, () => (this.ciws[1].enabled = false), 'CIWS 2');
    knock(L.gun, () => (this.gun.enabled = false), 'ANVIL');
    knock(L.illumFwd, () => (this.illuminators[0].enabled = false), 'LANTERN #1');
    knock(L.illumAftP, () => (this.illuminators[1].enabled = false), 'LANTERN #2');
    knock(L.illumAftS, () => (this.illuminators[2].enabled = false), 'LANTERN #3');
    knock(new THREE.Vector3(0, 14, 20), () => (this.radar.degraded = Math.min(1, this.radar.degraded + 0.5)), 'SENTINEL ARRAY');
    knock(L.vlsFwd[0], () => this.cells.filter((c) => c.launcher === 'fwd').forEach((c) => (c.count = 0)), 'FWD VLS');
    knock(L.vlsAft[0], () => this.cells.filter((c) => c.launcher === 'aft').forEach((c) => (c.count = 0)), 'AFT VLS');
    this.syncInventory();
    if (ship.hp <= 0 && !ship.sinking) {
      ship.sinking = true;
      this.log('ABANDON SHIP — the ship is sinking', 'alert');
      this.ciws.forEach((c) => (c.enabled = false));
      this.gun.enabled = false;
      this.radar.enabled = false;
    }
  }

  syncInventory() {
    for (const k of ['halberd', 'glaive', 'stiletto'] as InterceptorType[]) this.bastion.inventory[k] = this.cells.filter((c) => c.type === k).reduce((a, c) => a + c.count, 0);
  }

  // ------------------------------------------------------------------ main step
  step(dt: number) {
    this.t += dt;
    const t = this.t;
    const ship = this.ship;

    // Scheduled launches
    while (this.plan.length && this.plan[0].time <= t) {
      const pl = this.plan.shift()!;
      this.launchThreat(pl);
    }
    for (const L of this.launchers) L.update(dt);

    ship.update(dt, t, this.waves);
    upAt(ship.pos, _u);

    // Threats
    const shipTarget = this.shipTarget;
    shipTarget.pos.copy(ship.pos).addScaledVector(_u, 4);
    shipTarget.vel.copy(ship.vel);
    shipTarget.id = ship.id;
    const th = this.terrain;
    const tH = (x: number, z: number) => th.height(x, z);
    for (const m of this.threats) {
      if (!m.alive) continue;
      const wasBoost = m.boosterAttached;
      m.update(dt, t, { ship: shipTarget, decoys: this.decoys }, tH);
      if (wasBoost && m.spec.booster && m.phase !== 'boost') {
        m.boosterAttached = false;
        const d = new Debris('booster', 'booster', 1, 0.004);
        d.pos.copy(m.pos).addScaledVector(m.vel.clone().normalize(), -m.spec.length * 0.45);
        d.vel.copy(m.vel).multiplyScalar(0.92);
        d.quat.copy(m.quat);
        d.spin.set(rng.gauss() * 1.5, rng.gauss() * 1.5, rng.gauss());
        d.life = 30;
        this.debris.push(d);
        this.events.emit('boosterSep', { from: m, debris: d });
      }
      if (m.seduced && m.lockTarget && (m.lockTarget as any).kind === 'decoy') {
        if (!(m as any)._seducedLogged) {
          (m as any)._seducedLogged = true;
          this.stats.decoysSeduced++;
          this.log(`TN ${m.trackNumber} seduced by decoy`, 'good');
        }
      }
      // Ship impact
      const hit = ship.sinking && ship.sinkDepth > 15 ? null : ship.segmentHit(m.prevPos, m.pos, m.spec.diameter);
      if (hit) {
        m.alive = false;
        m.remove = true;
        m.killedBy = 'IMPACT';
        const wp = hit.local.clone().applyMatrix4(ship.localToWorld);
        this.radar.markDead(m, t);
        this.shipHit(wp, hit.local, hit.box.zone, m.spec.warheadKg, `TN ${m.trackNumber || '----'} ${m.spec.short}`);
        this.events.emit('threatDeath', { threat: m, mode: 'impact' });
        continue;
      }
      // Sea impact
      const alt = altitude(m.pos);
      if (alt < -1 || (alt < 0.5 && m.phase !== 'boost' && m.age > 3 && this.waves.heightAt(m.pos.x, m.pos.z, t) > alt)) {
        m.alive = false;
        m.remove = true;
        m.killedBy = 'SEA';
        this.stats.splashedOther++;
        this.radar.markDead(m, t);
        this.events.emit('detonation', { pos: m.pos.clone(), vel: m.vel.clone().multiplyScalar(0.2), kind: 'water', size: m.spec.warheadKg, entity: m });
        this.events.emit('threatDeath', { threat: m, mode: 'water' });
        this.log(`TN ${m.trackNumber || '----'} impacted the sea`, 'good');
        if ((globalThis as any).__dbg) console.log(`SEA ${m.spec.short} ph=${m.phase} alt=${alt.toFixed(1)} age=${m.age.toFixed(0)} fuel=${m.fuelTime.toFixed(0)} sed=${m.seduced} lock=${!!m.lockTarget} rng=${m.pos.distanceTo(ship.pos).toFixed(0)} v=${m.vel.length().toFixed(0)} hp=${m.hp.toFixed(1)}`);
        continue;
      }
    }

    // Radar & C2
    this.radar.update(dt, t, ship.pos, ship.vel, this.threats, (tr) => {
      this.events.emit('track', { track: tr });
      const brg = Math.round((tr.bearing / DEG + 360) % 360);
      this.log(`New track TN ${tr.tn} brg ${String(brg).padStart(3, '0')} rng ${(tr.range / 1000).toFixed(1)} km alt ${Math.round(altitude(tr.estPos))} m`, 'alert');
    }, this.cfg.doctrine.reaction);
    this.bastion.update(dt, t);

    // Interceptors
    for (const m of this.interceptors) {
      if (!m.alive) continue;
      const r = m.update(dt, this.requestIllum);
      if (r) {
        const key = r === 'detonate' ? 'det' : m.target.alive ? m.result : 'tgtDead';
        this.stats.results[key] = (this.stats.results[key] ?? 0) + 1;
      }
      if (r === 'detonate') {
        m.alive = false;
        m.remove = true;
        this.releaseIllum(m);
        const pk = m.pkAt(m.missDist);
        this.events.emit('detonation', { pos: m.pos.clone(), vel: m.vel.clone().multiplyScalar(0.25), kind: 'intercept', size: 60, entity: m });
        if (m.target.alive && rng.chance(pk)) {
          this.stats.results.detKill = (this.stats.results.detKill ?? 0) + 1;
          m.result = 'kill';
          this.killThreat(m.target, m.spec.short, rng.chance(0.45) ? 'blast' : 'breakup');
        } else {
          m.result = 'miss';
          if (m.target.alive) {
            m.target.hp -= 1.5;
            this.log(`${m.spec.short} missed TN ${m.track.tn} (miss ${m.missDist.toFixed(1)} m)`, 'warn');
          }
        }
      } else if (r === 'selfdestruct') {
        m.alive = false;
        m.remove = true;
        this.releaseIllum(m);
        this.events.emit('detonation', { pos: m.pos.clone(), vel: m.vel.clone().multiplyScalar(0.25), kind: 'selfdestruct', size: 30, entity: m });
        if (m.target.alive && m.result !== 'kill') this.log(`${m.spec.short} vs TN ${m.track.tn}: ${m.result === 'noillum' ? 'no illumination' : 'miss'} — self-destruct`, 'warn');
      } else if (!m.alive) {
        this.releaseIllum(m);
      }
    }
    for (const il of this.illuminators) il.update(dt, ship);

    // CIWS
    const alive = this.threats.filter((x) => x.alive);
    for (const c of this.ciws) {
      const before = c.roundsFired;
      c.update(dt, t, ship, alive, this.ciwsRounds, this.cfg.doctrine.ciws && !ship.sinking, (mount, firing) => this.events.emit('ciwsFire', { mount, firing }));
      this.stats.ciwsRounds += c.roundsFired - before;
    }
    this.stepRounds(dt, alive);

    // Gun
    this.gun.update(dt, ship, this.gunTarget && this.gunTarget.alive ? this.gunTarget : null, (pos, vel, fuze) => {
      this.shells.spawn(pos, vel, fuze, 0);
      this.stats.gunRounds++;
      this.events.emit('gunFire', { pos, dir: vel.clone().normalize() });
    });
    this.stepShells(dt, alive);

    // Decoys & debris
    for (const d of this.decoys) d.update(dt, this.wind);
    for (const d of this.debris) {
      d.update(dt);
      const alt = altitude(d.pos);
      if (d.debrisKind === 'carcass' && !d.splashed) {
        const hit = ship.segmentHit(d.pos.clone().addScaledVector(d.vel, -dt), d.pos, 0.5);
        if (hit) {
          d.remove = true;
          d.splashed = true;
          const wp = hit.local.clone().applyMatrix4(ship.localToWorld);
          const live = (d as any).live;
          const kg = live ? (d as any).warheadKg * 0.8 : 25;
          this.shipHit(wp, hit.local, hit.box.zone, kg, live ? 'DEBRIS (warhead)' : 'DEBRIS');
          continue;
        }
      }
      if (alt < 0 && !d.splashed) {
        d.splashed = true;
        d.remove = true;
        this.events.emit('splash', { pos: d.pos.clone(), size: d.debrisKind === 'carcass' ? 3 : d.debrisKind === 'booster' ? 2 : 0.6 });
      }
    }

    // Kill-assessed tracks → keep engagement bookkeeping clean
    if (Math.floor(t * 2) !== Math.floor((t - dt) * 2)) {
      this.radar.cleanup(t);
      this.threats = this.threats.filter((x) => !x.remove);
      this.interceptors = this.interceptors.filter((x) => !x.remove);
      this.debris = this.debris.filter((x) => !x.remove);
      this.decoys = this.decoys.filter((x) => !x.remove);
      this.ciwsRounds.compact();
      this.shells.compact();
    }

    // End conditions
    if (!this.over) {
      if (ship.sunk || (ship.sinking && ship.sinkDepth > 6)) {
        this.over = true;
        this.outcome = 'sunk';
        this.events.emit('sunk', {});
      } else if (!this.plan.length && this.threats.every((x) => !x.alive) && this.stats.launched > 0 && this.debris.every((d) => d.debrisKind !== 'carcass')) {
        this.over = true;
        this.outcome = 'survived';
        this.log(`RAID DEFEATED — ${this.stats.killed}/${this.stats.launched} killed, ${this.stats.hits} hits taken`, 'good');
      }
    }
  }

  private launchThreat(pl: PlannedLaunch) {
    const cands = this.launchers.filter((l) => l.site === pl.site);
    const L = cands.sort((a, b) => a.lastFire - b.lastFire)[0];
    const m = new Threat(pl.type);
    m.waveIdx = pl.wave;
    m.cruiseAlt = pl.profile === 'lo' ? Math.max(12, m.spec.skimAlt * 2) : m.spec.cruiseAlt;
    // Canister exit: from the launcher, pitched up ~ 15–25°
    const brg = bearingTo(L.pos, pl.route[0]);
    const dir = bearingDir(L.pos, brg, new THREE.Vector3());
    upAt(L.pos, _u);
    const elev = (pl.type === 'asm_subsonic' ? 18 : 30) * DEG;
    dir.multiplyScalar(Math.cos(elev)).addScaledVector(_u, Math.sin(elev));
    m.pos.copy(L.pos).addScaledVector(_u, 4).addScaledVector(dir, 5);
    m.prevPos.copy(m.pos);
    m.vel.copy(dir).multiplyScalar(40);
    m.route = pl.route;
    m.aimPoint.copy(pl.route[pl.route.length - 1]);
    m.launchTime = this.t;
    m.fuelTime = (pl.arrival - pl.time) * 1.5 + 30;
    L.lastFire = this.t;
    L.erectGoal = 1;
    L.heading = brg;
    this.threats.push(m);
    this.stats.launched++;
    this.events.emit('threatLaunch', { threat: m, launcher: L });
  }

  private stepRounds(dt: number, alive: Threat[]) {
    const R = this.ciwsRounds;
    R.step(dt);
    const near = alive.filter((th) => th.pos.distanceTo(this.ship.pos) < 6000);
    const S = CIWS_SPEC;
    const t = this.t;
    for (let i = 0; i < R.n; i++) {
      if (!R.alive[i]) continue;
      for (const th of near) {
        if (!th.alive) continue;
        const dx = R.px[i] - th.pos.x, dy = R.py[i] - th.pos.y, dz = R.pz[i] - th.pos.z;
        const reach = 1100 * dt + th.vel.length() * dt + 12;
        if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
        const hitT = R.sweptHit(i, th.prevPos, th.pos, S.hitRadius + th.spec.diameter / 2 + th.spec.length * 0.08);
        if (hitT >= 0) {
          R.kill(i);
          th.ciwsHits++;
          th.hp -= rng.range(0.6, 1.4);
          const hp = new THREE.Vector3().lerpVectors(th.prevPos, th.pos, hitT);
          this.events.emit('ciwsHit', { pos: hp, threat: th });
          if (rng.chance(S.pkPerHit)) this.killThreat(th, 'CIWS', 'blast');
          else if (th.hp <= 0) this.killThreat(th, 'CIWS', 'breakup');
          break;
        }
      }
      if (!R.alive[i]) continue;
      if (R.age[i] > R.life[i]) {
        R.kill(i);
        continue;
      }
      const alt = R.altitude(i);
      if (alt < 1.5) {
        const h = this.waves.heightAt(R.px[i], R.pz[i], t);
        if (alt < h) {
          R.kill(i);
          if (rng.chance(0.35)) this.events.emit('splash', { pos: new THREE.Vector3(R.px[i], R.py[i], R.pz[i]), size: 0.25 });
        }
      }
    }
  }

  private stepShells(dt: number, alive: Threat[]) {
    const S = this.shells;
    S.step(dt);
    for (let i = 0; i < S.n; i++) {
      if (!S.alive[i]) continue;
      const p = new THREE.Vector3(S.px[i], S.py[i], S.pz[i]);
      let det = S.age[i] >= S.life[i];
      if (!det) {
        for (const th of alive) {
          if (!th.alive) continue;
          if (S.sweptHit(i, th.prevPos, th.pos, GUN_SPEC.fuzeRadius) >= 0) {
            det = true;
            break;
          }
        }
      }
      if (S.altitude(i) < 0) {
        S.kill(i);
        this.events.emit('splash', { pos: p, size: 1.2 });
        continue;
      }
      if (det) {
        S.kill(i);
        this.events.emit('detonation', { pos: p, vel: new THREE.Vector3(S.vx[i], S.vy[i], S.vz[i]).multiplyScalar(0.1), kind: 'shell', size: 8 });
        for (const th of alive) {
          if (!th.alive) continue;
          const d = th.pos.distanceTo(p);
          if (d < GUN_SPEC.fuzeRadius * 1.3) {
            const pk = GUN_SPEC.pkInFuze * (1 - d / (GUN_SPEC.fuzeRadius * 1.3)) * (th.spec.speed > 500 ? 0.4 : 1);
            if (rng.chance(pk)) this.killThreat(th, 'ANVIL', 'breakup');
          }
        }
      }
    }
  }

  /** All entities the camera may follow. */
  trackables(): Entity[] {
    return [this.ship, ...this.threats.filter((x) => x.alive), ...this.interceptors.filter((x) => x.alive), ...this.launchers];
  }
}

export { KNOTS };
