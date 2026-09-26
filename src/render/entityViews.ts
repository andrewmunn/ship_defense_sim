import * as THREE from 'three';
import { createModel } from './models/index';
import { Plume, PlumeKind } from './plume';
import { Trails, TrailSlot, TrailStyle } from './trails';
import { Glows } from './glows';
import { Particles, PT } from './particles';
import type { World } from '../sim/world';
import type { Threat } from '../sim/threat';
import type { Interceptor } from '../sim/interceptor';
import type { Debris, Decoy, Launcher, Entity } from '../sim/entities';
import { altitude, upAt } from '../core/geo';
import { rng } from '../core/rng';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _u = new THREE.Vector3(), _q = new THREE.Quaternion();

const templates = new Map<string, THREE.Object3D>();
function instance(name: string): THREE.Object3D {
  let t = templates.get(name);
  if (!t) {
    t = createModel(name) ?? fallbackModel(name);
    t.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = false;
      }
    });
    templates.set(name, t);
  }
  return t.clone(true);
}

/** Every model the combat views instantiate (built up front so first launches don't hitch). */
const PREWARM_MODELS = ['halberd', 'glaive', 'stiletto', 'asm_subsonic', 'asm_supersonic', 'asm_heavy', 'booster', 'tel'];

/**
 * Build all model templates plus representative plumes/throats and return them in a group, so the
 * caller can compile their shaders and upload their textures during loading instead of at the
 * first launch of each type.
 */
export function prewarmGroup(): THREE.Group {
  const g = new THREE.Group();
  PREWARM_MODELS.forEach((n, i) => {
    const o = instance(n);
    o.position.set((i - PREWARM_MODELS.length / 2) * 12, 0, 0);
    g.add(o);
  });
  for (const k of ['solid', 'turbojet', 'ramjet', 'booster'] as PlumeKind[]) g.add(new Plume(k, 0.3, 5).group);
  g.add(new THREE.Mesh(throatGeo, throatMat()));
  return g;
}

function fallbackModel(name: string) {
  const g = new THREE.Group();
  if (name === 'tel') {
    const body = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 12), new THREE.MeshStandardMaterial({ color: 0x6b6a4e, roughness: 0.8 }));
    body.position.y = 2;
    g.add(body);
    const rack = new THREE.Group();
    rack.name = 'tel_rack';
    rack.position.set(0, 3.6, -5.5);
    for (const x of [-0.6, 0.6]) {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 8.5, 16).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x5d5e45, roughness: 0.7 }));
      c.position.set(x, 0, 4.25);
      rack.add(c);
    }
    g.add(rack);
  } else {
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 5, 12).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xcccccc })));
  }
  return g;
}

/** Smoke trail styles. */
const TRAIL: Record<string, TrailStyle> = {
  interceptor: { width0: 1.8, growth: 2.0, opacity: 0.7, color: [0.92, 0.92, 0.9], life: 28, rise: 0.25, spacing: 6 },
  glaiveBoost: { width0: 2.6, growth: 2.4, opacity: 0.8, color: [0.9, 0.9, 0.88], life: 32, rise: 0.25, spacing: 6 },
  stiletto: { width0: 1.3, growth: 1.7, opacity: 0.65, color: [0.9, 0.9, 0.88], life: 22, rise: 0.25, spacing: 5 },
  threatBoost: { width0: 1.4, growth: 2.0, opacity: 0.85, color: [0.78, 0.76, 0.72], life: 24, rise: 0.3, spacing: 4 },
  turbojet: { width0: 0.5, growth: 0.45, opacity: 0.08, color: [0.55, 0.55, 0.55], life: 7, rise: 0.1, spacing: 6 },
  ramjet: { width0: 0.8, growth: 0.9, opacity: 0.16, color: [0.7, 0.7, 0.72], life: 12, rise: 0.1, spacing: 10 },
  rocket: { width0: 1.8, growth: 2.2, opacity: 0.75, color: [0.85, 0.85, 0.83], life: 26, rise: 0.2, spacing: 10 },
  carcass: { width0: 1.2, growth: 1.8, opacity: 0.85, color: [0.14, 0.13, 0.12], life: 18, rise: 0.8, spacing: 3 },
  wisp: { width0: 0.4, growth: 0.6, opacity: 0.3, color: [0.8, 0.8, 0.8], life: 6, rise: 0.2, spacing: 3 },
};

/** A trail that transparently chains to a new slot when its buffer fills. */
class ChainTrail {
  slot: TrailSlot | null;
  constructor(private trails: Trails, private style: TrailStyle, p: THREE.Vector3) {
    this.slot = trails.start({ ...style }, p);
  }
  push(p: THREE.Vector3, t: number, speed: number) {
    if (!this.slot) return;
    // adaptive spacing: faster → coarser samples (keeps long flights inside the buffer)
    this.slot.style.spacing = THREE.MathUtils.clamp(speed * 0.028, this.style.spacing, 40);
    this.slot.push(p, t);
    if (!this.slot.emitting) this.slot = this.trails.start({ ...this.style }, p);
  }
  stop(t: number) {
    this.slot?.stop(t);
    this.slot = null;
  }
}

const throatGeo = new THREE.CircleGeometry(1, 20);
const throatMat = () => new THREE.MeshBasicMaterial({ color: 0xffb070, toneMapped: false, side: THREE.DoubleSide, depthWrite: false });

interface MissileVis {
  throat: THREE.Mesh | null;
  e: Threat | Interceptor;
  obj: THREE.Object3D;
  plume: Plume | null;
  boostPlume: Plume | null;
  booster: THREE.Object3D | null;
  trail: ChainTrail | null;
  boostTrail: ChainTrail | null;
  fins: THREE.Object3D[];
  seen: boolean;
  motor: string;
}

interface DebrisVis {
  e: Debris;
  obj: THREE.Object3D;
  trail: ChainTrail | null;
  fire: number;
}

interface DecoyVis {
  e: Decoy;
  obj: THREE.Object3D | null;
  emitted: number;
}

interface LauncherVis {
  e: Launcher;
  obj: THREE.Object3D;
  rack: THREE.Object3D | null;
}

/** Renders all moving entities of the sim: threats, interceptors, debris, decoys, coastal launchers. */
export class EntityViews {
  group = new THREE.Group();
  trails = new Trails(220);
  private missiles = new Map<number, MissileVis>();
  private debris = new Map<number, DebrisVis>();
  private decoys = new Map<number, DecoyVis>();
  private launchers = new Map<number, LauncherVis>();
  /** Screen-legibility & night visibility glows. */
  constructor(private particles: Particles, private glows: Glows) {
    this.group.add(this.trails.group);
  }

  /** Release per-run resources; model templates and their geometry/materials are shared. */
  dispose() {
    for (const v of this.missiles.values()) this.removeMissile(v, 0);
    for (const v of this.decoys.values()) this.removeDecoy(v);
    this.decoys.clear();
    this.debris.clear();
    this.launchers.clear();
    this.trails.dispose();
    this.group.clear();
    this.group.removeFromParent();
  }

  private removeDecoy(v: DecoyVis) {
    if (!v.obj) return;
    v.obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
    });
    v.obj.removeFromParent();
  }

  /** Object3D for an entity (for cameras that want the true model transform). */
  objectFor(id: number) {
    return this.missiles.get(id)?.obj ?? this.debris.get(id)?.obj ?? this.launchers.get(id)?.obj ?? null;
  }

  private addMissile(e: Threat | Interceptor) {
    const kind = e.kind;
    const obj = instance(e.spec.model);
    obj.matrixAutoUpdate = true;
    const exhaust = obj.getObjectByName('exhaust');
    const boosterEx = obj.getObjectByName('booster_exhaust');
    const booster = obj.getObjectByName('booster') ?? null;
    let motor: string;
    let plume: Plume | null = null, boostPlume: Plume | null = null;
    const R = e.spec.diameter / 2;
    if (kind === 'threat') {
      const th = e as Threat;
      motor = th.spec.motor;
      const pk: PlumeKind = motor === 'turbojet' ? 'turbojet' : motor === 'ramjet' ? 'ramjet' : 'solid';
      plume = new Plume(pk, R * (pk === 'turbojet' ? 0.35 : 0.9), pk === 'turbojet' ? 0.9 : pk === 'ramjet' ? 5.5 : 9);
      if (th.spec.booster && boosterEx) boostPlume = new Plume('booster', 0.22, 6);
      else if (!th.spec.booster && motor !== 'rocket') boostPlume = new Plume('booster', R * 0.85, 9);
    } else {
      motor = 'rocket';
      plume = new Plume('solid', R * 0.85, e.spec.type === 'stiletto' ? 5 : 7);
      if (booster && boosterEx) boostPlume = new Plume('booster', 0.26, 9);
    }
    if (plume && exhaust) exhaust.add(plume.group);
    if (boostPlume) (boosterEx ?? exhaust)?.add(boostPlume.group);
    const fins: THREE.Object3D[] = [];
    obj.traverse((o) => { if (/^(fin|wing)_\d$/.test(o.name)) fins.push(o); });
    // glowing nozzle throat (reads in close chase shots while the motor burns)
    let throat: THREE.Mesh | null = null;
    if (exhaust) {
      throat = new THREE.Mesh(throatGeo, throatMat());
      throat.scale.setScalar(R * 0.55);
      throat.position.z = -0.12;
      throat.renderOrder = 12;
      exhaust.add(throat);
    }
    this.group.add(obj);
    const v: MissileVis = { e, obj, plume, boostPlume, booster, trail: null, boostTrail: null, fins, seen: false, motor, throat };
    this.missiles.set(e.id, v);
    return v;
  }

  private removeMissile(v: MissileVis, t: number) {
    if (v.throat) (v.throat.material as THREE.Material).dispose();
    v.trail?.stop(t);
    v.boostTrail?.stop(t);
    v.plume?.dispose();
    v.boostPlume?.dispose();
    this.group.remove(v.obj);
    this.missiles.delete(v.e.id);
  }

  update(world: World, cam: THREE.Camera, dtSim: number) {
    const t = world.t;
    const live = new Set<number>();
    // ------------------------------------------------ missiles
    const all: (Threat | Interceptor)[] = [...world.threats, ...world.interceptors];
    for (const e of all) {
      if (!e.alive) continue;
      live.add(e.id);
      const v = this.missiles.get(e.id) ?? this.addMissile(e);
      this.updateMissile(v, t, dtSim, cam);
    }
    for (const [id, v] of this.missiles) if (!live.has(id)) this.removeMissile(v, t);

    // ------------------------------------------------ debris
    const liveD = new Set<number>();
    for (const d of world.debris) {
      if (d.remove) continue;
      liveD.add(d.id);
      let v = this.debris.get(d.id);
      if (!v) {
        const obj = d.debrisKind === 'booster' ? instance('booster') : d.model ? instance(d.model) : instance('booster');
        if (d.debrisKind === 'carcass') {
          // broken airframe: drop the booster, char it
          obj.getObjectByName('booster')?.removeFromParent();
        }
        this.group.add(obj);
        v = { e: d, obj, trail: null, fire: d.debrisKind === 'carcass' ? 1 : 0 };
        if (d.debrisKind === 'carcass') v.trail = new ChainTrail(this.trails, TRAIL.carcass, d.pos);
        else if (d.debrisKind === 'booster') v.trail = new ChainTrail(this.trails, { ...TRAIL.threatBoost, opacity: 0.35, width0: 0.8, life: 14 }, d.pos);
        this.debris.set(d.id, v);
      }
      v.obj.position.copy(d.pos);
      v.obj.quaternion.copy(d.quat);
      v.trail?.push(d.pos, t, d.vel.length());
      if (v.fire > 0 && dtSim > 0) {
        v.fire = Math.max(0, v.fire - dtSim * 0.08);
        this.emitFire(d.pos, d.vel, v.fire, dtSim, 1.2);
      }
    }
    for (const [id, v] of this.debris) {
      if (!liveD.has(id)) {
        v.trail?.stop(t);
        this.group.remove(v.obj);
        this.debris.delete(id);
      }
    }

    // ------------------------------------------------ decoys
    const liveC = new Set<number>();
    for (const d of world.decoys) {
      if (d.remove) continue;
      liveC.add(d.id);
      let v = this.decoys.get(d.id);
      if (!v) {
        v = { e: d, obj: null, emitted: 0 };
        this.decoys.set(d.id, v);
      }
      this.updateDecoy(v, t, dtSim);
    }
    for (const [id, v] of this.decoys) {
      if (!liveC.has(id)) {
        this.removeDecoy(v);
        this.decoys.delete(id);
      }
    }

    // ------------------------------------------------ launchers
    for (const L of world.launchers) {
      let v = this.launchers.get(L.id);
      if (!v) {
        const obj = instance('tel');
        this.group.add(obj);
        v = { e: L, obj, rack: obj.getObjectByName('tel_rack') ?? null };
        this.launchers.set(L.id, v);
        // settle on the ground facing the planned heading
        obj.position.copy(L.pos);
        obj.quaternion.copy(L.quat);
      }
      if (v.rack) v.rack.rotation.x = -L.erect * 0.55;
    }
  }

  private updateMissile(v: MissileVis, t: number, dt: number, cam: THREE.Camera) {
    const e = v.e;
    const obj = v.obj;
    obj.position.copy(e.pos);
    obj.quaternion.copy(e.quat);
    const speed = e.vel.length();
    const alt = altitude(e.pos);
    // fin deflection from lateral acceleration (purely cosmetic)
    if (v.fins.length) {
      const la = e.lastAccel;
      _q.copy(e.quat).invert();
      _v.copy(la).applyQuaternion(_q);
      const defl = THREE.MathUtils.clamp(Math.hypot(_v.x, _v.y) / 400, 0, 0.35);
      v.fins.forEach((f, i) => (f.rotation.x = Math.sin(i * 1.7 + t * 3) * defl * 0.5 + defl * (i % 2 ? 1 : -1) * 0.3));
    }
    let main = 0, boost = 0;
    if (e.kind === 'threat') {
      const th = e as Threat;
      const boosting = th.phase === 'boost';
      if (th.spec.booster) {
        if (v.booster) v.booster.visible = th.boosterAttached;
        boost = boosting ? 1 : 0;
        main = boosting ? 0.3 : 1;
      } else if (th.spec.motor === 'rocket') {
        main = 1;
        boost = 0;
      } else {
        // ramjet: integral rocket booster first
        boost = boosting ? 1 : 0;
        main = boosting ? 0 : 1;
      }
      if (th.age > th.fuelTime) main = boost = 0;
      // trails
      if (boost > 0) {
        if (!v.boostTrail) v.boostTrail = new ChainTrail(this.trails, TRAIL.threatBoost, e.pos);
        v.boostTrail.push(this.nozzle(v, _v2), t, speed);
      } else if (v.boostTrail) {
        v.boostTrail.stop(t);
        v.boostTrail = null;
      }
      if (main > 0 && !boosting) {
        const st = th.spec.motor === 'turbojet' ? TRAIL.turbojet : th.spec.motor === 'ramjet' ? TRAIL.ramjet : TRAIL.rocket;
        if (!v.trail) v.trail = new ChainTrail(this.trails, st, e.pos);
        v.trail.push(this.nozzle(v, _v2), t, speed);
      } else if (v.trail && main === 0) {
        v.trail.stop(t);
        v.trail = null;
      }
      // sea-skimmer spray / rooster tail when very low
      if (alt < 12 && speed > 200 && dt > 0) {
        const n = Math.floor(dt * 110 * (1 - alt / 12) + rng.next());
        upAt(e.pos, _u);
        const side = _v3.crossVectors(e.vel, _u).normalize();
        for (let i = 0; i < n; i++) {
          const p = _v.copy(e.pos).addScaledVector(_u, -alt + 0.2).addScaledVector(e.vel, -rng.next() * dt);
          const sgn = rng.chance(0.5) ? 1 : -1;
          this.particles.spawn({ pos: p, vel: _v2.copy(e.vel).multiplyScalar(0.18).addScaledVector(_u, 5 + rng.next() * 7).addScaledVector(side, sgn * (3 + rng.next() * 5)), life: 2 + rng.next(), size0: 0.8, size1: 7 + rng.next() * 6, drag: 1.1, gravity: 5, color: [0.88, 0.91, 0.93], alpha: 0.32 * (1 - alt / 12), type: PT.SPRAY });
        }
      }
    } else {
      const m = e as Interceptor;
      if (v.booster) v.booster.visible = m.boosterAttached;
      if (m.boosterAttached) {
        boost = m.motorOn ? 1 : 0;
        main = 0;
      } else main = m.motorOn ? THREE.MathUtils.clamp(m.thrust / 120, 0.35, 1.2) : 0;
      if (main > 0 || boost > 0) {
        const st = boost > 0 ? TRAIL.glaiveBoost : m.spec.type === 'stiletto' ? TRAIL.stiletto : TRAIL.interceptor;
        if (!v.trail) v.trail = new ChainTrail(this.trails, st, e.pos);
        v.trail.push(this.nozzle(v, _v2), t, speed);
      } else if (v.trail) {
        v.trail.stop(t);
        v.trail = null;
      }
      // booster just separated → drop a tumbling booster puff
      if (v.boostPlume && !m.boosterAttached && v.boostPlume.group.visible) {
        this.particles.spawn({ pos: e.pos.clone(), vel: e.vel.clone().multiplyScalar(0.8), life: 1.2, size0: 1, size1: 6, drag: 2, color: [1, 0.7, 0.4], alpha: 8, type: PT.FLASH });
      }
    }
    if (v.throat) {
      const hot = Math.max(main * (v.motor === 'turbojet' ? 0.35 : 1), boost > 0 && !v.booster ? 1 : 0);
      v.throat.visible = hot > 0.01;
      (v.throat.material as THREE.MeshBasicMaterial).color.setRGB(3.5 * hot, 2.0 * hot, 1.0 * hot);
    }
    const stretch = THREE.MathUtils.clamp(0.7 + speed / 900, 0.6, 1.8) * (alt > 8000 ? 1.6 : 1);
    v.plume?.update(t, main, stretch);
    v.boostPlume?.update(t, boost, stretch);
    // Nozzle glow: carries the motor's presence to long range & at night. Up close the plume mesh
    // does the work, so the sprite fades with projected size and with how much the nozzle faces us.
    const nz = this.nozzle(v, _v);
    const toCam = _v2.copy(cam.position).sub(nz);
    const dCam = toCam.length();
    toCam.divideScalar(Math.max(dCam, 1e-3));
    _u.set(0, 0, 1).applyQuaternion(e.quat);
    const facing = THREE.MathUtils.smoothstep(-_u.dot(toCam), -0.2, 0.7);
    const px = (e.spec.diameter * 6 * innerHeight * 0.9) / Math.max(dCam, 1);
    const near = THREE.MathUtils.clamp(14 / Math.max(px, 1e-3), 0.12, 1);
    const k = near * THREE.MathUtils.lerp(0.25, 1, facing);
    // sit the sprite just behind the nozzle, nudged toward the camera so the body doesn't cut it
    nz.addScaledVector(_u, -e.spec.diameter * 0.4).addScaledVector(toCam, e.spec.diameter * 0.8);
    if (boost > 0 || (main > 0 && v.motor !== 'turbojet')) {
      const I = (boost > 0 ? 6 : v.motor === 'ramjet' ? 3 : 5 * Math.min(main, 1)) * k;
      const col = v.motor === 'ramjet' && boost === 0 ? [0.8, 0.75, 1.0] : [1.0, 0.72, 0.42];
      this.glows.add(nz, e.spec.diameter * 6, col[0] * I, col[1] * I, col[2] * I, 3.5);
    } else if (main > 0) {
      this.glows.add(nz, e.spec.diameter * 1.5, 0.8 * k, 0.35 * k, 0.15 * k, 1.5);
    }
    void cam;
  }

  private nozzle(v: MissileVis, out: THREE.Vector3) {
    const e = v.e;
    _u.set(0, 0, 1).applyQuaternion(e.quat);
    return out.copy(e.pos).addScaledVector(_u, -e.spec.length * 0.5);
  }

  private updateDecoy(v: DecoyVis, t: number, dt: number) {
    const d = v.e;
    if (d.decoyKind === 'chaff') {
      // bloom: emit glinting dipole cloud particles for the first seconds
      if (dt > 0 && d.age < 6) {
        const n = Math.round(dt * (d.age < 2 ? 260 : 60));
        for (let i = 0; i < n; i++) {
          const r = d.radius * 0.4;
          _v.set(rng.gauss(), rng.gauss() * 0.6, rng.gauss()).multiplyScalar(r).add(d.pos);
          this.particles.spawn({ pos: _v, vel: _v2.set(rng.gauss(), rng.gauss(), rng.gauss()).multiplyScalar(4).add(d.vel), life: 30 + rng.next() * 15, size0: 0.5, size1: 0.9, drag: 0.8, rise: -0.5, color: [0.9, 0.92, 1.0], alpha: 1.6, type: PT.GLINT });
        }
        if (rng.chance(dt * 6)) this.particles.spawn({ pos: _v.set(rng.gauss(), rng.gauss() * 0.5, rng.gauss()).multiplyScalar(d.radius * 0.35).add(d.pos), vel: d.vel, life: 25, size0: d.radius * 0.4, size1: d.radius * 0.9, drag: 0.8, color: [0.7, 0.72, 0.75], alpha: 0.07, type: PT.SMOKE });
        if (d.age < 0.5 && v.emitted === 0) {
          v.emitted = 1;
          this.particles.spawn({ pos: d.pos.clone(), life: 0.25, size0: 2, size1: 14, color: [1, 0.85, 0.6], alpha: 18, type: PT.FLASH });
          for (let i = 0; i < 6; i++)
            this.particles.spawn({ pos: d.pos.clone(), vel: new THREE.Vector3(rng.gauss(), rng.gauss(), rng.gauss()).multiplyScalar(6), life: 8, size0: 2, size1: 10, drag: 1.2, rise: 0.4, color: [0.7, 0.7, 0.7], alpha: 0.4, type: PT.SMOKE });
        }
      }
    } else {
      // Wisp: hovering active decoy with strobe
      if (!v.obj) {
        const g = new THREE.Group();
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 0.9, 12), new THREE.MeshStandardMaterial({ color: 0x9aa0a0, roughness: 0.5, metalness: 0.3 }));
        g.add(body);
        const rot = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.02, 0.1), new THREE.MeshStandardMaterial({ color: 0x333333 }));
        rot.position.y = 0.5;
        rot.name = 'rotor';
        g.add(rot);
        this.group.add(g);
        v.obj = g;
      }
      v.obj.position.copy(d.pos);
      upAt(d.pos, _u);
      v.obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _u);
      const rot = v.obj.getObjectByName('rotor');
      if (rot) rot.rotation.y += dt * 60;
      const blink = Math.sin(t * 9) > 0.6 ? 1 : 0;
      if (blink) this.glows.add(d.pos, 1.2, 12, 3, 2, 3);
    }
  }

  /** Fire + smoke emission for burning objects (sim-time rate). */
  emitFire(p: THREE.Vector3, vel: THREE.Vector3, intensity: number, dt: number, scale = 1) {
    const n = rng.chance(dt * 40 * intensity) ? 1 : 0;
    for (let i = 0; i < n; i++) {
      this.particles.spawn({ pos: p.clone(), vel: vel.clone().multiplyScalar(0.85), life: 0.5, size0: 1.0 * scale, size1: 2.4 * scale, drag: 1, rise: 1, color: [1, 0.95, 0.9], alpha: 2.2, type: PT.FLAME });
      this.particles.spawn({ pos: p.clone(), vel: vel.clone().multiplyScalar(0.5), life: 12, size0: 2 * scale, size1: 12 * scale, drag: 2, rise: 2.5, color: [0.1, 0.09, 0.08], alpha: 0.7, type: PT.SMOKE });
    }
  }

  /** Trackable-style info for each entity's model radius (for camera framing). */
  static radiusOf(e: Entity) {
    return e.radius;
  }
}
