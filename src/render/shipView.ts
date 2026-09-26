import * as THREE from 'three';
import { createModel } from './models/index';
import { atmUniforms } from './atmosphere';
import { OCCLUDER_LAYER } from './sceneDepth';
import { ShipSurface } from './shipSurface';
import type { ShipLayout } from '../sim/world';
import type { World } from '../sim/world';
import type { Ship } from '../sim/entities';

const _v = new THREE.Vector3(), _q = new THREE.Quaternion();

const MAX_SCORCH = 16;
/** Fragment helpers for blast scorches (see ShipView.addScorch). Returns (soot, ember glow). */
const SCORCH_GLSL = /* glsl */ `
varying vec3 vShipLocal;
uniform vec4 uScorch[${MAX_SCORCH}];
uniform float uScorchHeat[${MAX_SCORCH}];
float scHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float scNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(scHash(i), scHash(i + vec3(1, 0, 0)), f.x), mix(scHash(i + vec3(0, 1, 0)), scHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(scHash(i + vec3(0, 0, 1)), scHash(i + vec3(1, 0, 1)), f.x), mix(scHash(i + vec3(0, 1, 1)), scHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
vec2 shipScorch(vec3 p) {
  float soot = 0.0, glow = 0.0;
  for (int i = 0; i < ${MAX_SCORCH}; i++) {
    vec4 s = uScorch[i];
    if (s.w <= 0.0) break;
    float d = length(p - s.xyz) / s.w;
    if (d > 1.6) continue;
    // ragged edge: two octaves of noise, plus fine soot speckle
    float n = scNoise(p * 0.9 + float(i) * 7.1) * 0.55 + scNoise(p * 3.1) * 0.25;
    float e = d + (n - 0.4) * 0.7;
    soot = max(soot, (1.0 - smoothstep(0.45, 1.05, e)) * (0.82 + 0.18 * scNoise(p * 9.0)));
    // burnt-through core glows while hot, flickering in the cracks
    float core = 1.0 - smoothstep(0.0, 0.42, e);
    glow = max(glow, core * uScorchHeat[i] * (0.55 + 0.45 * scNoise(p * 5.0 + float(i))));
  }
  return vec2(soot, glow);
}
`;

interface Hatch {
  obj: THREE.Object3D;
  open: number;
  /** Sim time at which the hatch should start closing. */
  closeAt: number;
}

/**
 * Visual Vanguard: owns the procedural model and animates it from the sim state
 * (pose, trainable mounts, CIWS barrel spin, gun recoil, radars, VLS hatches, props).
 */
export class ShipView {
  root: THREE.Object3D;
  layout: ShipLayout;
  hitBoxes: { center: number[]; size: number[] }[];
  private parts: Record<string, THREE.Object3D | undefined> = {};
  private hatches: Hatch[] = [];
  private gunBarrelRest = 0;
  private radarPhase = 0;
  /** Decoy launcher mouths (ship local) with their direction. */
  decoyMouths: { pos: THREE.Vector3; dir: THREE.Vector3; side: number }[] = [];
  /** Stack exhaust points (ship local). */
  exhausts: THREE.Vector3[] = [];
  bridgeCam: THREE.Object3D | null = null;

  constructor() {
    this.root = createModel('vanguard')!;
    this.root.matrixAutoUpdate = false;
    const get = (n: string) => this.root.getObjectByName(n) ?? undefined;
    for (const n of [
      'gun_mount', 'gun_elev', 'gun_muzzle',
      'ciws_fwd_mount', 'ciws_fwd_elev', 'ciws_fwd_barrels', 'ciws_fwd_muzzle',
      'ciws_aft_mount', 'ciws_aft_elev', 'ciws_aft_barrels', 'ciws_aft_muzzle',
      'illum_fwd', 'illum_fwd_elev', 'illum_aft_port', 'illum_aft_port_elev', 'illum_aft_stbd', 'illum_aft_stbd_elev',
      'radar_surface', 'radar_horizon', 'prop_port', 'prop_stbd', 'rudder_port', 'rudder_stbd', 'helo_rotor', 'helo_tail_rotor',
      'vls_fwd', 'vls_aft', 'bridge_cam', 'mast_top',
    ]) this.parts[n] = get(n);
    this.bridgeCam = this.parts.bridge_cam ?? null;
    const gunElev = this.parts.gun_elev;
    if (gunElev) this.gunBarrelRest = gunElev.position.z;
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
        const mt = m.material as THREE.Material;
        // thin wires/rails would throw SSAO halos onto the hull: keep them out of the occluder prepass
        if (!mt.transparent && !/stanch|wire|net|rail|antenna|whip/i.test(m.name)) m.layers.enable(OCCLUDER_LAYER);
      }
    });
    this.root.updateMatrixWorld(true);
    // root is at identity here, so matrixWorld == ship-local for the static parts
    const statics: THREE.Mesh[] = [];
    this.root.getObjectByName('ship_static')?.traverse((o) => { if ((o as THREE.Mesh).isMesh && !((o as THREE.Mesh).material as THREE.Material).transparent) statics.push(o as THREE.Mesh); });
    this.surface = new ShipSurface(statics);
    this.wetHull();
    this.layout = this.deriveLayout();
    this.hitBoxes = this.root.userData.hitBoxes;
    for (const prefix of ['vls_fwd', 'vls_aft']) {
      const g = this.parts[prefix];
      if (!g) continue;
      const n = (g.userData.cells as unknown[]).length;
      for (let i = 0; i < n; i++) {
        const h = g.getObjectByName(`${prefix}_hatch_${i}`);
        if (h) this.hatches.push({ obj: h, open: 0, closeAt: -1 });
      }
    }
    this.root.traverse((o) => {
      if (o.name.startsWith('stack_') && o.name.includes('_exhaust_')) this.exhausts.push(this.localPos(o));
    });
  }

  /** Wet, darker, glossier band on the hull just above the waterline (splash zone), fading upward. */
  private wetHull() {
    const done = new Set<THREE.Material>();
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        const sm = mat as THREE.MeshStandardMaterial;
        if (done.has(sm) || !sm.isMeshStandardMaterial || sm.transparent) continue;
        done.add(sm);
        sm.onBeforeCompile = (shader) => {
          Object.assign(shader.uniforms, atmUniforms, this.scorchUniforms);
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying float vShipY;\nvarying vec3 vShipLocal;\nuniform mat4 uShipInv;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShipY = (modelMatrix * vec4(transformed, 1.0)).y - (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).y;\nvShipLocal = (uShipInv * modelMatrix * vec4(transformed, 1.0)).xyz;');
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying float vShipY;\n' + SCORCH_GLSL)
            .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nfloat wet = smoothstep(1.6, 0.1, vShipY) * smoothstep(-2.5, -0.5, vShipY);\nroughnessFactor = mix(roughnessFactor, roughnessFactor * 0.35, wet);\nroughnessFactor = mix(roughnessFactor, 1.0, scorch.x);')
            .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor *= 1.0 - scorch.x;')
            .replace('#include <color_fragment>', '#include <color_fragment>\n{ float wet2 = smoothstep(1.6, 0.1, vShipY) * smoothstep(-2.5, -0.5, vShipY); diffuseColor.rgb *= mix(1.0, 0.62, wet2); }\nvec2 scorch = shipScorch(vShipLocal);\ndiffuseColor.rgb *= mix(1.0, 0.035, scorch.x);')
            .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.32, 0.07) * scorch.y;');
        };
        sm.customProgramCacheKey = () => 'wetHull';
        sm.needsUpdate = true;
      }
    });
  }

  private localPos(o: THREE.Object3D) {
    return o.getWorldPosition(new THREE.Vector3()); // root is at identity during construction
  }

  /** Weapon/sensor positions for the sim, measured from the model. */
  private deriveLayout(): ShipLayout {
    const cellsOf = (prefix: string) => {
      const g = this.parts[prefix];
      return ((g?.userData.cells ?? []) as { x: number; y: number; z: number }[]).map((c) => new THREE.Vector3(c.x, c.y, c.z));
    };
    const pivot = (name: string, fallback: THREE.Vector3) => {
      const o = this.parts[name];
      return o ? this.localPos(o) : fallback;
    };
    const decoys: ShipLayout['decoyLaunchers'] = [];
    this.root.traverse((o) => {
      if (!o.name.startsWith('decoy_launcher_')) return;
      const p = this.localPos(o);
      const d = new THREE.Vector3(0, 0, 1).applyQuaternion(o.getWorldQuaternion(_q));
      const side = p.x > 0 ? 1 : -1;
      decoys.push({ pos: p, side });
      this.decoyMouths.push({ pos: p, dir: d, side });
    });
    return {
      vlsFwd: cellsOf('vls_fwd'),
      vlsAft: cellsOf('vls_aft'),
      ciwsFwd: pivot('ciws_fwd_elev', new THREE.Vector3(0, 12.4, 32)),
      ciwsAft: pivot('ciws_aft_elev', new THREE.Vector3(0, 15.5, -49.4)),
      gun: pivot('gun_elev', new THREE.Vector3(0, 8.6, 47.2)),
      illumFwd: pivot('illum_fwd_elev', new THREE.Vector3(0, 23.2, 23.6)),
      illumAftP: pivot('illum_aft_port_elev', new THREE.Vector3(6.4, 14.9, -27.6)),
      illumAftS: pivot('illum_aft_stbd_elev', new THREE.Vector3(-6.4, 14.9, -27.6)),
      decoyLaunchers: decoys,
    };
  }

  /** Open a VLS hatch (index into the combined fwd+aft cell list) for a launch. */
  openHatch(cell: number, t: number) {
    const h = this.hatches[cell];
    if (h) h.closeAt = t + 4.5;
  }

  /** World position of a named part (e.g. 'ciws_fwd_muzzle'). */
  partWorld(name: string, out = new THREE.Vector3()) {
    const o = this.parts[name] ?? this.root.getObjectByName(name);
    return o ? o.getWorldPosition(out) : out.copy(this.root.position);
  }

  update(world: World, dtSim: number, dtReal: number) {
    const ship: Ship = world.ship;
    const t = world.t;
    this.root.position.copy(ship.pos);
    this.root.quaternion.copy(ship.quat);
    this.root.updateMatrix();
    this.updateScorch(t);
    const P = this.parts;
    // trainable mounts
    const ciwsNames = ['ciws_fwd', 'ciws_aft'];
    world.ciws.forEach((c, i) => {
      const m = P[`${ciwsNames[i]}_mount`], e = P[`${ciwsNames[i]}_elev`], b = P[`${ciwsNames[i]}_barrels`];
      if (m) m.rotation.y = c.yaw;
      if (e) e.rotation.x = -c.pitch;
      if (b) b.rotation.z += c.spin * 75 * dtSim; // ~ 12 rev/s at full rate
    });
    const g = world.gun;
    if (P.gun_mount) P.gun_mount.rotation.y = g.yaw;
    if (P.gun_elev) {
      P.gun_elev.rotation.x = -g.pitch;
      // recoil: barrel/cradle slides back ~0.6 m and returns
      const r = g.recoil > 0.7 ? (1 - g.recoil) / 0.3 : g.recoil / 0.7;
      P.gun_elev.position.z = this.gunBarrelRest - 0.55 * Math.max(0, Math.min(1, r)) * (g.recoil > 0 ? 1 : 0);
    }
    const ilNames = ['illum_fwd', 'illum_aft_port', 'illum_aft_stbd'];
    world.illuminators.forEach((il, i) => {
      const y = P[ilNames[i]], e = P[`${ilNames[i]}_elev`];
      if (y) y.rotation.y = il.yaw;
      if (e) e.rotation.x = -il.pitch;
    });
    this.radarPhase += dtSim;
    if (P.radar_surface) P.radar_surface.rotation.y = this.radarPhase * 2.6;
    if (P.radar_horizon) P.radar_horizon.rotation.y = -this.radarPhase * 1.9;
    const propRate = ship.speed * 0.9;
    if (P.prop_port) P.prop_port.rotation.z += propRate * dtSim;
    if (P.prop_stbd) P.prop_stbd.rotation.z -= propRate * dtSim;
    let dh = ship.targetHeading - ship.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    const rud = THREE.MathUtils.clamp(dh * 3, -0.6, 0.6);
    if (P.rudder_port) P.rudder_port.rotation.y = rud;
    if (P.rudder_stbd) P.rudder_stbd.rotation.y = rud;
    // VLS hatches: snap open fast, close slowly
    for (const h of this.hatches) {
      const want = h.closeAt > t ? 1 : 0;
      h.open += THREE.MathUtils.clamp(want - h.open, -dtSim * 0.8, dtSim * 6);
      h.obj.rotation.x = h.open * 1.65;
    }
    void dtReal;
    this.root.updateMatrixWorld(true);
  }

  /**
   * Navigation / deck lighting. Before general quarters the ship burns normal nav lights;
   * once a hostile is declared she goes to "darkened ship" (dim red only).
   */
  lights(glows: import('./glows').Glows, night: number, darkened: boolean, t: number) {
    if (night < 0.05) return;
    const k = Math.min(1, night * 1.5);
    const mt = this.parts.mast_top ?? this.root.getObjectByName('mast_top');
    const pts: [THREE.Vector3, number, number, number, number][] = [];
    if (!darkened) {
      if (mt) pts.push([mt.getWorldPosition(new THREE.Vector3()), 1, 0.95, 0.85, 1.0]);
      pts.push([this.toWorld(new THREE.Vector3(8.2, 17.5, 22.5)), 1, 0.05, 0.03, 1]); // port sidelight
      pts.push([this.toWorld(new THREE.Vector3(-8.2, 17.5, 22.5)), 0.05, 1, 0.2, 1]); // stbd sidelight
      pts.push([this.toWorld(new THREE.Vector3(0, 5.6, -77.2)), 1, 0.95, 0.85, 0.8]); // stern light
      pts.push([this.toWorld(new THREE.Vector3(0, 30, -12)), 1, 0.95, 0.85, 0.8]); // aft masthead
      // flight deck floods (dim)
      for (const x of [-7, 7]) pts.push([this.toWorld(new THREE.Vector3(x, 8.6, -57)), 1, 0.85, 0.6, 0.35]);
    } else {
      const blink = 0.6 + 0.4 * Math.sin(t * 2.1);
      if (mt) pts.push([mt.getWorldPosition(new THREE.Vector3()), 1, 0.1, 0.05, 0.4 * blink]);
      pts.push([this.toWorld(new THREE.Vector3(0, 16.9, 29.4)), 0.8, 0.08, 0.04, 0.25]); // red-lit bridge
    }
    for (const [p, r, g, b, i] of pts) glows.add(p, 0.9, r * 14 * i * k, g * 14 * i * k, b * 14 * i * k, 2.2);
  }

  private surface: ShipSurface;
  /** Blast scorches: xyz ship-local surface point, w radius; heat decays with sim time. */
  private scorches: { p: THREE.Vector3; r: number; t0: number; heat: number }[] = [];
  private scorchUniforms = {
    uShipInv: { value: new THREE.Matrix4() },
    uScorch: { value: Array.from({ length: MAX_SCORCH }, () => new THREE.Vector4()) },
    uScorchHeat: { value: new Float32Array(MAX_SCORCH) },
  };

  /**
   * Scorch the paint around a ship-local hit point. Rendered in the ship's own shaders (no decal
   * geometry): the hull is ~300k triangles, and clipping decals against it cost 10-170 ms per hit.
   */
  addScorch(local: THREE.Vector3, size: number, t = 0) {
    // find the nearest outer surface by casting inward from a few directions
    let best: { point: THREE.Vector3; normal: THREE.Vector3 } | null = null;
    const sx = Math.sign(local.x) || 1, sz = Math.sign(local.z) || 1;
    for (const d of [new THREE.Vector3(sx, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, sz), new THREE.Vector3(-sx, 0, 0)]) {
      const h = this.surface.raycast(local.clone().addScaledVector(d, 25), d.clone().negate(), 40);
      if (h && (!best || h.point.distanceTo(local) < best.point.distanceTo(local))) best = h;
    }
    const p = best?.point ?? local.clone();
    if (this.scorches.length >= MAX_SCORCH) {
      // merge into the nearest existing scar instead of dropping the hit
      let bi = 0;
      this.scorches.forEach((s, i) => { if (s.p.distanceTo(p) < this.scorches[bi].p.distanceTo(p)) bi = i; });
      const s = this.scorches[bi];
      s.r = Math.max(s.r, size * 0.5) * 1.1;
      s.t0 = t;
      return;
    }
    this.scorches.push({ p, r: size * 0.5, t0: t, heat: 1 });
  }

  private updateScorch(t: number) {
    const u = this.scorchUniforms;
    u.uShipInv.value.copy(this.root.matrix).invert();
    const S = u.uScorch.value, H = u.uScorchHeat.value;
    for (let i = 0; i < MAX_SCORCH; i++) {
      const s = this.scorches[i];
      if (!s) { S[i].set(0, 0, 0, 0); H[i] = 0; continue; }
      S[i].set(s.p.x, s.p.y, s.p.z, s.r);
      // embers: white-hot flash, then a slow orange smoulder
      const age = Math.max(0, t - s.t0);
      H[i] = 6 * Math.exp(-age * 1.5) + 1.2 * Math.exp(-age / 25);
    }
  }

  clearDamage() {
    this.scorches = [];
  }

  /** Ship-local → world. */
  toWorld(local: THREE.Vector3, out = new THREE.Vector3()) {
    return out.copy(local).applyMatrix4(this.root.matrixWorld);
  }
  worldDir(localDir: THREE.Vector3, out = new THREE.Vector3()) {
    return out.copy(localDir).applyQuaternion(this.root.quaternion);
  }
}

void _v;
