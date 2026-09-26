import * as THREE from 'three';
import { atmUniforms } from '../atmosphere';
import { ATMOS_FUNCS_GLSL, ATMOS_UNIFORMS_GLSL } from '../shaders/common.glsl';
import { ChunkGenerator, GenParams, surfaceY } from './gen';
import { R_PLANET } from '../../core/constants';

/**
 * Night-time settlement lights: small warm HDR points in coastal towns, villages and along the roads
 * linking them. Deterministic; placed on flat low ground near the coast. Fades in with uNight.
 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Town {
  a: number;
  c: number;
  x: number;
  z: number;
  size: number;
  /** Built-up radius (m). */
  rad: number;
}

/** Deterministic coastal town sites (shared by the night lights and the daytime ground shader). */
export function pickTowns(gen: ChunkGenerator, p: GenParams): Town[] {
  const r = rng(7771);
  const towns: Town[] = [];
  let tries = 0;
  while (towns.length < 34 && tries++ < 4000) {
    const a = (r() * 2 - 1) * 170000;
    const c = p.distance - 9000 + r() * 24000;
    const h = gen.heightAC(a, c);
    if (h < 3 || h > 320) continue;
    const hx = gen.heightAC(a + 150, c), hz = gen.heightAC(a, c + 150);
    if (Math.hypot(hx - h, hz - h) / 150 > 0.12) continue;
    if (towns.some((t) => Math.hypot(t.a - a, t.c - c) < 5500)) continue;
    // coastal towns are bigger
    const coastal = h < 40 ? 1 : 0.4;
    const size = (0.3 + r() * r() * 1.4) * coastal + 0.15;
    towns.push({ a, c, x: gen.toX(a, c), z: gen.toZ(a, c), size, rad: 350 + size * 1100 });
  }
  return towns;
}

export class TownLights {
  points: THREE.Points;
  private mat: THREE.ShaderMaterial;

  constructor(gen: ChunkGenerator, p: GenParams, towns: Town[]) {
    const r = rng(7772);
    const pos: number[] = [];
    const attr: number[] = []; // size, intensity, hue, phase
    const origin = new THREE.Vector3();
    const put = (a: number, c: number, size: number, inten: number) => {
      const h = gen.heightAC(a, c);
      if (h < 1.5) return;
      const x = gen.toX(a, c), z = gen.toZ(a, c);
      const y = surfaceY(x, z);
      const L = R_PLANET;
      const ux = x / L, uy = (y + L) / L, uz = z / L;
      const hh = h + 4;
      pos.push(x + ux * hh - origin.x, y + uy * hh - origin.y, z + uz * hh - origin.z);
      attr.push(size, inten, r(), r() * 6.28);
    };
    for (const t of towns) {
      const n = Math.round(40 + t.size * 260);
      const rad = t.rad;
      for (let k = 0; k < n; k++) {
        // clustered: gaussian-ish radius with a street grid bias
        const rr = rad * Math.pow(r(), 0.8) * (0.4 + 0.6 * r());
        const ang = r() * Math.PI * 2;
        let a = t.a + Math.cos(ang) * rr, c = t.c + Math.sin(ang) * rr;
        if (r() < 0.5) {
          a = t.a + Math.round((a - t.a) / 90) * 90 + (r() - 0.5) * 12;
        }
        put(a, c, 0.8 + r() * 1.2, 0.6 + r() * 0.9);
      }
    }
    // roads between neighbouring towns (sparse lights)
    const sorted = [...towns].sort((u, v) => u.a - v.a);
    for (let i = 0; i + 1 < sorted.length; i++) {
      const A = sorted[i], B = sorted[i + 1];
      const d = Math.hypot(B.a - A.a, B.c - A.c);
      if (d > 30000) continue;
      const n = Math.floor(d / 220);
      const wob = r() * 6.28;
      for (let k = 1; k < n; k++) {
        if (r() < 0.35) continue;
        const f = k / n;
        const off = Math.sin(f * Math.PI * 3 + wob) * 700 * Math.sin(f * Math.PI);
        const nx = -(B.c - A.c) / d, nc = (B.a - A.a) / d;
        put(A.a + (B.a - A.a) * f + nx * off, A.c + (B.c - A.c) * f + nc * off, 0.6, 0.35 + r() * 0.3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aL', new THREE.Float32BufferAttribute(attr, 4));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...atmUniforms, uGlow: { value: 0 }, uPx: { value: 1 }, uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec4 aL;
        uniform float uGlow;
        uniform float uPx;
        uniform float uTime;
        varying vec3 vCol;
        varying vec3 vW;
        void main(){
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          vec4 mv = viewMatrix * wp;
          gl_Position = projectionMatrix * mv;
          float d = -mv.z;
          float flick = 0.85 + 0.15 * sin(uTime * (1.3 + aL.z * 3.0) + aL.w);
          // warm sodium/incandescent mix, some cooler LED whites
          vec3 c = mix(vec3(1.0, 0.62, 0.28), vec3(1.0, 0.85, 0.62), aL.z);
          if (aL.z > 0.86) c = vec3(0.8, 0.88, 1.0);
          // constant-ish pixel size with a distance floor so far towns read as a glow
          float sz = aL.x * uPx * clamp(2400.0 / d, 0.9, 3.0);
          // keep energy roughly constant when the point clamps to its minimum size
          float e = aL.y * uGlow * flick * clamp(2400.0 / d, 0.25, 1.0) * 6.0;
          vCol = c * e;
          gl_PointSize = sz * 2.0;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        ${ATMOS_UNIFORMS_GLSL}
        ${ATMOS_FUNCS_GLSL}
        varying vec3 vCol;
        varying vec3 vW;
        void main(){
          #include <logdepthbuf_fragment>
          vec2 q = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(q, q);
          if (r2 > 1.0) discard;
          float fall = exp(-r2 * 4.0);
          vec3 T = applyAtmosphere(vec3(1.0), vW) - applyAtmosphere(vec3(0.0), vW);
          gl_FragColor = vec4(vCol * fall * T, 1.0);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.name = 'town_lights';
    this.points.visible = false;
  }

  update(night: number, t: number) {
    const u = this.mat.uniforms;
    u.uGlow.value = THREE.MathUtils.smoothstep(night, 0.15, 0.8);
    u.uTime.value = t;
    u.uPx.value = typeof devicePixelRatio !== 'undefined' ? Math.min(devicePixelRatio, 1.5) : 1;
    this.points.visible = u.uGlow.value > 0.001;
  }

  dispose() {
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}
