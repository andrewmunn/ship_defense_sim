import * as THREE from 'three';
import { AudioEngine, LoopHandle, CiwsHandle } from '../audio/audioEngine';
import type { Game, GamePlugin } from './game';
import type { World } from '../sim/world';
import type { Threat } from '../sim/threat';
import type { Interceptor } from '../sim/interceptor';
import { altitude } from '../core/geo';
import { atmUniforms } from '../render/atmosphere';

const MOTOR_RANGE = 9000; // only keep motor loops for missiles this close to the listener
const MAX_MOTORS = 8;

interface Motor {
  h: LoopHandle;
  name: string;
}

/** Maps sim events and state onto the spatial audio engine. */
export class Soundscape implements GamePlugin {
  eng = new AudioEngine();
  private motors = new Map<number, Motor>();
  private ciws: CiwsHandle[] = [];
  private lastCamPos = new THREE.Vector3();
  private camVel = new THREE.Vector3();
  private passes = new Map<number, { prev: number; min: number; done: boolean }>();
  private unsub: (() => void)[] = [];
  ready = false;

  constructor(private g: Game) {
    this.eng.init().then(() => (this.ready = true)).catch((e) => console.warn('[audio] init failed', e));
    (window as any).__audioUnlock = () => this.eng.unlock();
    const unlock = () => this.eng.unlock();
    addEventListener('pointerdown', unlock, { once: true });
    addEventListener('keydown', unlock, { once: true });
  }

  onRestart(w: World) {
    for (const u of this.unsub) u();
    this.unsub = [];
    for (const m of this.motors.values()) m.h.stop(0.2);
    this.motors.clear();
    for (const c of this.ciws) c.stop();
    this.ciws = w.ciws.map(() => this.eng.ciws());
    this.passes.clear();
    const e = this.eng;
    const on = <K extends keyof import('../sim/world').SimEvents>(k: K, f: (ev: import('../sim/world').SimEvents[K]) => void) => this.unsub.push(w.events.on(k, f));
    const at = () => ({ simTime: w.t });
    on('threatLaunch', (ev) => e.play('vls_launch', ev.launcher.pos, { range: 30000, gain: 1.3, ...at() }));
    on('interceptorLaunch', (ev) => {
      const cells = [...w.layout.vlsFwd, ...w.layout.vlsAft];
      const p = cells[ev.cell] ? this.g.shipView.toWorld(cells[ev.cell]) : ev.m.pos;
      e.play('vls_launch', p, { range: 25000, gain: ev.m.spec.type === 'glaive' ? 1.2 : 1, ...at() });
    });
    on('detonation', (ev) => {
      const p = ev.pos;
      switch (ev.kind) {
        case 'intercept': e.play('explosion_air', p, { range: 30000, ...at() }); break;
        case 'selfdestruct': e.play('explosion_air', p, { range: 22000, gain: 0.55, ...at() }); break;
        case 'shell': e.play('explosion_air', p, { range: 14000, gain: 0.32, rate: 1.25, ...at() }); break;
        case 'warhead': e.play('explosion_near', p, { range: 40000, gain: 1.25, priority: 2, ...at() }); break;
        case 'breakup':
          e.play('explosion_air', p, { range: 20000, gain: 0.45, rate: 0.9, ...at() });
          e.play('debris_metal', p, { range: 1500, gain: 0.6, ...at() });
          break;
        case 'water':
          e.play('splash_big', p, { range: 6000, gain: 1.2, ...at() });
          if (ev.size > 50) e.play('explosion_near', p, { range: 30000, gain: 0.9, rate: 0.85, ...at() });
          break;
        case 'shipHit': e.play('explosion_ship_hit', p, { range: 45000, gain: 1.6, priority: 3, ...at() }); break;
        case 'debris': e.play('splash_big', p, { range: 3000, gain: 0.6, ...at() }); break;
      }
    });
    on('splash', (ev) => {
      if (ev.size < 0.5) e.play('splash_small', ev.pos, { range: 450, gain: 0.45, ...at() });
      else e.play('splash_big', ev.pos, { range: 2500 + ev.size * 800, gain: Math.min(1, 0.35 + ev.size * 0.2), ...at() });
    });
    on('gunFire', (ev) => e.play('gun_5in', ev.pos, { range: 25000, gain: 1.1, ...at() }));
    on('ciwsHit', (ev) => e.play('debris_metal', ev.pos, { range: 1800, gain: 0.35, rate: 1.2, ...at() }));
    on('decoy', (ev) => e.play('chaff_launch', ev.from, { range: 4000, ...at() }));
    on('shipHit', () => {
      e.play('alarm_klaxon', null, { gain: 0.5 });
      setTimeout(() => e.play('metal_groan', this.g.world.ship.pos, { range: 3000, gain: 0.8 }), 2500);
    });
    on('kill', () => e.play('ui_kill', null, { gain: 0.35 }));
    on('track', () => e.play('ui_track_new', null, { gain: 0.3 }));
  }

  // hooks for the HUD
  vampire() {
    this.eng.play('ui_alert', null, { gain: 0.5 });
    this.eng.play('alarm_gq', null, { gain: 0.45 });
  }
  brace() {
    this.eng.play('alarm_klaxon', null, { gain: 0.55 });
  }
  click() {
    this.eng.play('ui_click', null, { gain: 0.4 });
  }

  update(dtReal: number, dtSim: number) {
    if (!this.ready) return;
    const g = this.g, W = g.world, cam = g.camera;
    // listener velocity in sim metres per sim second (for doppler)
    if (dtSim > 1e-5) {
      this.camVel.copy(cam.position).sub(this.lastCamPos).divideScalar(dtSim);
      if (this.camVel.length() > 3000) this.camVel.set(0, 0, 0);
    }
    this.lastCamPos.copy(cam.position);
    const L = cam.position;
    const camAlt = altitude(L);
    let fires = 0;
    for (const f of W.ship.fires) fires += f.intensity;
    this.eng.update(dtReal, W.t, g.paused ? 0 : g.timeScale, { pos: L, quat: cam.quaternion, vel: this.camVel }, {
      shipPos: W.ship.pos,
      shipSpeed: W.ship.speed,
      seaState: W.cfg.env.seaState,
      onDeck: L.distanceTo(W.ship.pos) < 120 && camAlt < 60,
      camAlt,
      night: atmUniforms.uNight.value as number,
      shipFires: fires,
      sinking: W.ship.sinking,
    });

    // ---------------------------------------------------------------- motor loops (nearest few)
    const cands: { e: Threat | Interceptor; d: number; name: string; gain: number }[] = [];
    for (const th of W.threats) {
      if (!th.alive || th.age > th.fuelTime) continue;
      const d = th.pos.distanceTo(L);
      if (d > MOTOR_RANGE) continue;
      const boost = th.phase === 'boost';
      const name = boost || th.spec.motor === 'rocket' ? 'rocket_motor_loop' : th.spec.motor === 'ramjet' ? 'ramjet_loop' : 'jet_asm_loop';
      cands.push({ e: th, d, name, gain: boost ? 1.1 : th.spec.motor === 'turbojet' ? 0.8 : 1 });
    }
    for (const m of W.interceptors) {
      if (!m.alive || !m.motorOn) continue;
      const d = m.pos.distanceTo(L);
      if (d > MOTOR_RANGE) continue;
      cands.push({ e: m, d, name: 'rocket_motor_loop', gain: m.spec.type === 'glaive' ? 1.1 : 0.9 });
    }
    cands.sort((a, b) => a.d - b.d);
    const keep = new Set<number>();
    for (const c of cands.slice(0, MAX_MOTORS)) {
      keep.add(c.e.id);
      let m = this.motors.get(c.e.id);
      if (m && m.name !== c.name) {
        m.h.stop(0.15);
        m = undefined;
      }
      if (!m) {
        m = { h: this.eng.loop(c.name, { gain: c.gain, range: c.name === 'jet_asm_loop' ? 5000 : 9000 }), name: c.name };
        this.motors.set(c.e.id, m);
      }
      m.h.set(c.e.pos, c.e.vel, c.gain);
    }
    for (const [id, m] of this.motors) {
      if (!keep.has(id)) {
        m.h.stop(0.25);
        this.motors.delete(id);
      }
    }

    // ---------------------------------------------------------------- CIWS
    W.ciws.forEach((c, i) => {
      const h = this.ciws[i];
      if (!h) return;
      const muzzle = g.shipView.partWorld(i === 0 ? 'ciws_fwd_muzzle' : 'ciws_aft_muzzle');
      const slew = Math.abs(c.yawGoal - c.yaw) > 0.01 || Math.abs(c.pitchGoal - c.pitch) > 0.01 ? 2 : 0;
      h.set(muzzle, c.firing && !g.paused, slew);
    });

    // ---------------------------------------------------------------- close passes (fly-by / sonic boom)
    for (const th of W.threats) {
      if (!th.alive) continue;
      const d = th.pos.distanceTo(L);
      let p = this.passes.get(th.id);
      if (d > 600) {
        if (p) this.passes.delete(th.id);
        continue;
      }
      if (!p) {
        p = { prev: d, min: d, done: false };
        this.passes.set(th.id, p);
      }
      p.min = Math.min(p.min, d);
      if (!p.done && d > p.prev + 0.01 && p.min < 140) {
        p.done = true;
        const sup = th.vel.length() > 360;
        this.eng.play(sup ? 'sonic_boom' : 'missile_flyby', th.pos, { range: 3000, gain: 1.1, vel: th.vel, simTime: W.t });
      }
      p.prev = d;
    }
  }
}
