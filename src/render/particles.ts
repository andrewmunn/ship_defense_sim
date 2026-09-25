import * as THREE from 'three';
import { atmUniforms } from './atmosphere';
import { ATMOS_FUNCS_GLSL, ATMOS_UNIFORMS_GLSL } from './shaders/common.glsl';
import { Rng } from '../core/rng';

/** Particle behaviour types (shader switch). */
export const PT = { SMOKE: 0, FIRE: 1, SPARK: 2, SPRAY: 3, FLASH: 4, GLINT: 5, SHOCK: 6, STEAM: 7 } as const;

export interface ParticleSpec {
  pos: THREE.Vector3;
  vel?: THREE.Vector3;
  life: number;
  size0: number;
  size1: number;
  /** Velocity relaxation rate (1/s) toward the wind + rise velocity. */
  drag?: number;
  /** Terminal vertical velocity (m/s, + up). */
  rise?: number;
  /** Gravity (m/s², + down). */
  gravity?: number;
  color: THREE.Color | [number, number, number];
  /** Opacity for smoke, HDR intensity for emissive types. */
  alpha?: number;
  type: number;
  /** Delay before the particle appears (s). */
  delay?: number;
  /** Type-specific parameter (fire: time at which fire has turned to smoke, 0..1 of life). */
  param?: number;
}

/** Procedural smoke-puff atlas: 4x4 variations. RGB = billboard-space normal, A = density. */
function makeSmokeAtlas(size = 1024) {
  const tiles = 4, ts = size / tiles;
  const data = new Uint8Array(size * size * 4);
  const rng = new Rng(4711);
  // value-noise helper
  const N = 64;
  const lat = new Float32Array(N * N * 16).map(() => rng.next());
  const vn = (x: number, y: number, o: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const g = (i: number, j: number) => lat[o * N * N + (((j % N) + N) % N) * N + (((i % N) + N) % N)];
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = g(xi, yi), b = g(xi + 1, yi), c = g(xi, yi + 1), d = g(xi + 1, yi + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
  const dens = new Float32Array(ts * ts);
  for (let t = 0; t < tiles * tiles; t++) {
    const ox = (t % tiles) * ts, oy = Math.floor(t / tiles) * ts;
    // a few overlapping blobs + fbm erosion
    const blobs: [number, number, number][] = [];
    const nb = 5 + rng.int(0, 4);
    for (let b = 0; b < nb; b++) {
      const a = rng.next() * Math.PI * 2, r = rng.range(0, 0.22);
      blobs.push([0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r, rng.range(0.16, 0.3)]);
    }
    for (let j = 0; j < ts; j++) {
      for (let i = 0; i < ts; i++) {
        const u = (i + 0.5) / ts, v = (j + 0.5) / ts;
        let d = 0;
        for (const [bx, by, br] of blobs) {
          const dd = ((u - bx) ** 2 + (v - by) ** 2) / (br * br);
          d += Math.exp(-dd * 2.2);
        }
        let n = 0, amp = 0.5, f = 5;
        for (let o = 0; o < 5; o++) {
          n += amp * vn(u * f + t * 7.3, v * f + t * 3.1, t);
          amp *= 0.5;
          f *= 2.05;
        }
        const r = Math.hypot(u - 0.5, v - 0.5) * 2;
        const edge = Math.max(0, 1 - r * r);
        let x = d * 0.9 * (0.45 + n * 1.1) * edge;
        x = Math.max(0, Math.min(1, (x - 0.12) * 1.6));
        dens[j * ts + i] = x;
      }
    }
    // normals from density height field
    for (let j = 0; j < ts; j++) {
      for (let i = 0; i < ts; i++) {
        const h = (a: number, b: number) => dens[Math.min(ts - 1, Math.max(0, b)) * ts + Math.min(ts - 1, Math.max(0, a))];
        const dx = (h(i + 2, j) - h(i - 2, j)) * 2.5, dy = (h(i, j + 2) - h(i, j - 2)) * 2.5;
        let nx = -dx, ny = -dy, nz = 0.35 + dens[j * ts + i] * 0.6;
        // bias toward a sphere normal so billboards read as round puffs
        const u = (i + 0.5) / ts * 2 - 1, v = (j + 0.5) / ts * 2 - 1;
        nx += u * 0.8;
        ny += v * 0.8;
        const l = Math.hypot(nx, ny, nz);
        nx /= l; ny /= l; nz /= l;
        const o = ((oy + j) * size + ox + i) * 4;
        data[o] = Math.round((nx * 0.5 + 0.5) * 255);
        data[o + 1] = Math.round((-ny * 0.5 + 0.5) * 255);
        data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
        data[o + 3] = Math.round(dens[j * ts + i] * 255);
      }
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aA; // pos.xyz, birth
attribute vec4 aB; // vel.xyz, life
attribute vec4 aC; // size0, size1, drag, rise
attribute vec4 aD; // color.rgb, alpha/intensity
attribute vec4 aE; // type, seed, gravity, param
uniform float uTime;
uniform vec3 uWind;
uniform vec2 uViewport;
uniform float uPlanetR2;
varying vec2 vUv;
varying vec4 vColor;
varying float vT;
varying float vType;
varying float vSeed;
varying vec3 vWorld;
varying float vParam;
varying float vFade;
varying vec3 vRight;
varying vec3 vUpV;
varying float vSize;
void main(){
  float age = uTime - aA.w;
  float life = aB.w;
  vType = aE.x;
  vSeed = aE.y;
  vParam = aE.w;
  if (age < 0.0 || age > life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float t = age / life;
  vT = t;
  vec3 up = normalize(aA.xyz - vec3(0.0, -uPlanetR2, 0.0));
  float k = aC.z;
  float f = k > 1e-4 ? (1.0 - exp(-k * age)) / k : age;
  vec3 vTerm = uWind + up * aC.w;
  vec3 p = aA.xyz + aB.xyz * f + vTerm * (age - f) - up * (0.5 * aE.z * age * age);
  vec3 vel = aB.xyz * exp(-k * age) + vTerm * (1.0 - exp(-k * age)) - up * aE.z * age;
  // size growth: fast early expansion, slowing later
  float g = 1.0 - pow(1.0 - t, 2.2);
  float size = mix(aC.x, aC.y, g);
  if (vType == 4.0) size = mix(aC.x, aC.y, t);           // flash
  if (vType == 6.0) size = mix(aC.x, aC.y, sqrt(t));     // shock ring
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec4 mvCenter = viewMatrix * vec4(p, 1.0);
  float dist = max(-mvCenter.z, 0.1);
  // minimum on-screen size (px) for legibility at range; conserve energy by fading
  float pxPerM = uViewport.y * projectionMatrix[1][1] * 0.5 / dist;
  float minPx = (vType == 2.0 || vType == 5.0) ? 1.6 : 2.2;
  float px = size * pxPerM;
  vFade = 1.0;
  if (px < minPx) { vFade = (px * px) / (minPx * minPx); size = minPx / pxPerM; }
  // rotation
  float rot = aE.y * 6.2831 + age * (aE.y - 0.5) * 0.6;
  float cr = cos(rot), sr = sin(rot);
  vec2 corner = position.xy; // -0.5..0.5
  vUv = corner + 0.5;
  vec3 wp;
  if (vType == 2.0) {
    // streak aligned with velocity (screen-space)
    vec3 vv = vel;
    float sp = length(vv);
    vec3 dir = sp > 1e-3 ? vv / sp : camUp;
    vec3 side = normalize(cross(dir, normalize(cameraPosition - p)));
    float len = size + sp * 0.035;
    wp = p + dir * corner.y * len + side * corner.x * size;
  } else {
    vec2 rc = vec2(corner.x * cr - corner.y * sr, corner.x * sr + corner.y * cr);
    wp = p + (camRight * rc.x + camUp * rc.y) * size;
    vRight = camRight * cr + camUp * sr;
    vUpV = -camRight * sr + camUp * cr;
  }
  vSize = size;
  vWorld = p;
  vColor = aD;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMOS_UNIFORMS_GLSL}
${ATMOS_FUNCS_GLSL}
uniform sampler2D uAtlas;
uniform float uTime;
uniform vec3 uAmbient;
varying vec2 vUv;
varying vec4 vColor;
varying float vT;
varying float vType;
varying float vSeed;
varying vec3 vWorld;
varying float vParam;
varying float vFade;
varying vec3 vRight;
varying vec3 vUpV;
varying float vSize;

vec3 blackbody(float x){
  // x: 0 (cool, dull red) .. 1 (white hot)
  vec3 c = mix(vec3(0.9, 0.12, 0.02), vec3(1.0, 0.45, 0.08), smoothstep(0.0, 0.35, x));
  c = mix(c, vec3(1.0, 0.8, 0.45), smoothstep(0.35, 0.7, x));
  c = mix(c, vec3(1.0, 0.97, 0.9), smoothstep(0.7, 1.0, x));
  return c;
}

void main(){
  #include <logdepthbuf_fragment>
  float tile = floor(vSeed * 16.0);
  vec2 tuv = (vec2(mod(tile, 4.0), floor(tile / 4.0)) + vUv) / 4.0;
  vec2 c = vUv - 0.5;
  float r = length(c) * 2.0;
  vec3 col; float a;
  float type = vType;
  float alt = atmAlt(vWorld);
  if (type == 0.0 || type == 3.0 || type == 7.0 || (type == 1.0 && vT > vParam)) {
    vec4 tx = texture2D(uAtlas, tuv);
    float d = tx.a;
    vec3 nb = tx.rgb * 2.0 - 1.0;
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 N = normalize(vRight * nb.x + vUpV * nb.y + V * nb.z);
    vec3 L = uSunDir;
    float sunUp = smoothstep(-0.05, 0.1, dot(L, atmUp(vWorld)));
    float wrap = clamp(dot(N, L) * 0.6 + 0.4, 0.0, 1.0);
    // forward scattering when looking toward the sun through thin smoke
    float fwd = pow(max(dot(-V, L), 0.0), 8.0) * (1.0 - d) * 1.5;
    vec3 sun = uSunColor * 0.085 * (wrap + fwd) * sunUp;
    vec3 amb = uAmbient;
    vec3 base = vColor.rgb;
    float dens = d;
    if (type == 3.0) { dens = d * smoothstep(1.0, 0.2, r); }
    col = base * (sun + amb);
    // fire that has turned to smoke keeps a faint ember glow at the start
    if (type == 1.0) {
      float e = smoothstep(vParam + 0.15, vParam, vT);
      col = mix(col * 0.5, col, 1.0 - e) + blackbody(0.2) * e * vColor.a * 0.4 * d;
      dens *= 0.9;
    }
    float life = type == 1.0 ? (vT - vParam) / (1.0 - vParam) : vT;
    float fadeIn = smoothstep(0.0, 0.04, life);
    float fadeOut = 1.0 - smoothstep(0.55, 1.0, life);
    float op = type == 1.0 ? 0.85 : vColor.a;
    a = dens * op * fadeIn * fadeOut;
    // soft intersection with the sea surface
    a *= smoothstep(-0.2 * vSize, 0.35 * vSize, alt);
    col = applyAtmosphere(col, vWorld);
    a *= vFade;
    gl_FragColor = vec4(col * a, a);
  } else if (type == 1.0) {
    // fire: emissive, temperature falls over its burning life
    vec4 tx = texture2D(uAtlas, tuv);
    float lt = vT / max(vParam, 0.01);
    float temp = 1.0 - lt;
    float d = tx.a;
    float core = smoothstep(0.0, 0.7, d);
    vec3 e = blackbody(temp * (0.6 + 0.4 * core)) * vColor.a * (0.4 + temp * temp * 1.6) * vColor.rgb;
    // dark smoky edge as it cools
    float sm = smoothstep(0.3, 1.0, lt);
    a = d * sm * 0.6;
    col = e * d * (1.0 - sm * 0.5);
    float T = exp(-uHazeDensity * length(vWorld - cameraPosition) * 0.7);
    gl_FragColor = vec4(col * T * vFade + vec3(0.02) * a, a * vFade);
  } else if (type == 2.0) {
    // spark streak
    float w = 1.0 - abs(c.x) * 2.0;
    float l = 1.0 - smoothstep(0.3, 0.5, abs(c.y));
    float temp = 1.0 - vT;
    vec3 e = blackbody(0.3 + temp * 0.7) * vColor.a * (0.3 + temp);
    float m = w * w * l;
    float T = exp(-uHazeDensity * length(vWorld - cameraPosition) * 0.7);
    gl_FragColor = vec4(e * m * T * vFade * vColor.rgb, 0.0);
  } else if (type == 4.0) {
    // flash
    float m = exp(-r * r * 5.0) + exp(-r * 12.0) * 0.8;
    float fl = pow(1.0 - vT, 2.0);
    vec3 e = vColor.rgb * vColor.a * m * fl;
    float T = exp(-uHazeDensity * length(vWorld - cameraPosition) * 0.6);
    gl_FragColor = vec4(e * T * vFade, 0.0);
  } else if (type == 5.0) {
    // chaff glint: twinkling sparkles
    float tw = pow(max(sin(uTime * (7.0 + vSeed * 19.0) + vSeed * 50.0), 0.0), 12.0);
    float m = exp(-r * r * 9.0);
    vec3 e = vColor.rgb * vColor.a * m * (0.15 + tw * 2.0) * (1.0 - vT);
    gl_FragColor = vec4(e * vFade, m * 0.25 * (1.0 - vT) * vFade);
  } else {
    // shock ring
    float ring = exp(-pow((r - 0.85) * 9.0, 2.0));
    float fl = pow(1.0 - vT, 1.5);
    vec3 e = vColor.rgb * vColor.a * ring * fl;
    gl_FragColor = vec4(e, ring * fl * 0.25);
  }
}`;

/**
 * GPU particle system: particles are spawned into a ring buffer with analytic motion,
 * so the CPU never touches them after spawn. One draw call for everything.
 */
export class Particles {
  cap: number;
  mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private A: Float32Array; private B: Float32Array; private C: Float32Array; private D: Float32Array; private E: Float32Array;
  private attrs: THREE.InstancedBufferAttribute[];
  private head = 0;
  private dirtyLo = Infinity;
  private dirtyHi = -1;
  private wrapped = false;
  material: THREE.ShaderMaterial;
  now = 0;
  private rng = new Rng(99);
  spawned = 0;

  constructor(cap = 1 << 17) {
    this.cap = cap;
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    this.A = new Float32Array(cap * 4); this.B = new Float32Array(cap * 4); this.C = new Float32Array(cap * 4);
    this.D = new Float32Array(cap * 4); this.E = new Float32Array(cap * 4);
    // mark all as dead
    for (let i = 0; i < cap; i++) { this.A[i * 4 + 3] = -1e9; this.B[i * 4 + 3] = 0; }
    this.attrs = ['aA', 'aB', 'aC', 'aD', 'aE'].map((n, i) => {
      const arr = [this.A, this.B, this.C, this.D, this.E][i];
      const at = new THREE.InstancedBufferAttribute(arr, 4);
      at.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(n, at);
      return at;
    });
    geo.instanceCount = cap;
    this.geo = geo;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...atmUniforms,
        uAtlas: { value: makeSmokeAtlas() },
        uTime: { value: 0 },
        uWind: { value: new THREE.Vector3() },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uPlanetR2: { value: atmUniforms.uPlanetR.value },
        uAmbient: { value: new THREE.Vector3(0.3, 0.33, 0.38) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }

  spawn(s: ParticleSpec) {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    if (this.head === 0) this.wrapped = true;
    const o = i * 4;
    const A = this.A, B = this.B, C = this.C, D = this.D, E = this.E;
    A[o] = s.pos.x; A[o + 1] = s.pos.y; A[o + 2] = s.pos.z; A[o + 3] = this.now + (s.delay ?? 0);
    const v = s.vel;
    B[o] = v ? v.x : 0; B[o + 1] = v ? v.y : 0; B[o + 2] = v ? v.z : 0; B[o + 3] = s.life;
    C[o] = s.size0; C[o + 1] = s.size1; C[o + 2] = s.drag ?? 0; C[o + 3] = s.rise ?? 0;
    const c = s.color as any;
    if (Array.isArray(c)) { D[o] = c[0]; D[o + 1] = c[1]; D[o + 2] = c[2]; }
    else { D[o] = c.r; D[o + 1] = c.g; D[o + 2] = c.b; }
    D[o + 3] = s.alpha ?? 1;
    E[o] = s.type; E[o + 1] = this.rng.next(); E[o + 2] = s.gravity ?? 0; E[o + 3] = s.param ?? 0.3;
    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;
    this.spawned++;
  }

  update(simTime: number, wind: THREE.Vector3, viewportH: number, ambient: THREE.Vector3) {
    this.now = simTime;
    const u = this.material.uniforms;
    u.uTime.value = simTime;
    u.uWind.value.copy(wind);
    u.uViewport.value.set(1, viewportH);
    u.uAmbient.value.copy(ambient);
  }

  /** Upload changed ranges (call once per frame before rendering). */
  flush() {
    if (this.dirtyHi < 0) return;
    const lo = this.dirtyLo, hi = this.dirtyHi;
    for (const at of this.attrs) {
      at.clearUpdateRanges();
      at.addUpdateRange(lo * 4, (hi - lo + 1) * 4);
      at.needsUpdate = true;
    }
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
    void this.wrapped;
  }
}
