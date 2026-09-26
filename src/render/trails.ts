import * as THREE from 'three';
import { atmUniforms } from './atmosphere';
import { ATMOS_FUNCS_GLSL, ATMOS_UNIFORMS_GLSL, NOISE_GLSL } from './shaders/common.glsl';

const MAXP = 1024;

export interface TrailStyle {
  width0: number;
  /** Width growth (m per sqrt(s)). */
  growth: number;
  opacity: number;
  color: [number, number, number];
  /** Seconds for the trail to dissipate. */
  life: number;
  rise: number;
  /** Min sample spacing (m). */
  spacing: number;
}

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aTan;
attribute vec4 aData; // birth, side, width0, dist
uniform float uTime;
uniform vec3 uWind;
uniform float uGrowth;
uniform float uLife;
uniform float uRise;
uniform float uPlanetR2;
uniform vec2 uViewport;
varying float vAge;
varying float vSide;
varying float vDist;
varying float vWidth;
varying vec3 vWorld;
varying vec3 vSideDir;
varying float vFade;
void main(){
  float age = uTime - aData.x;
  vAge = age;
  vSide = aData.y;
  vDist = aData.w;
  if (aData.x < -1e8 || age > uLife) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  age = max(age, 0.0);
  vec3 up = normalize(position - vec3(0.0, -uPlanetR2, 0.0));
  // slow billowing: low-frequency lateral wander grows with age
  float wob = sin(aData.w * 0.013 + age * 0.3) * 0.6 + sin(aData.w * 0.041 - age * 0.5) * 0.4;
  vec3 p = position + uWind * age + up * (uRise * age) + normalize(cross(aTan, up) + 1e-4) * wob * sqrt(age) * uGrowth * 0.4;
  float w = aData.z + uGrowth * sqrt(age);
  vec3 toCam = normalize(cameraPosition - p);
  vec3 side = normalize(cross(aTan, toCam));
  vSideDir = side;
  float dist = max(length(cameraPosition - p), 0.1);
  float pxPerM = uViewport.y * projectionMatrix[1][1] * 0.5 / dist;
  float hw = w * 0.5;
  vFade = 1.0;
  float minPx = 1.3;
  if (hw * 2.0 * pxPerM < minPx) { vFade = (hw * 2.0 * pxPerM) / minPx; hw = minPx * 0.5 / pxPerM; }
  vWidth = w;
  vec3 wp = p + side * aData.y * hw;
  vWorld = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMOS_UNIFORMS_GLSL}
${NOISE_GLSL}
${ATMOS_FUNCS_GLSL}
uniform float uTime;
uniform float uLife;
uniform float uOpacity;
uniform vec3 uColor;
uniform vec3 uAmbient;
uniform float uWidth0;
varying float vAge;
varying float vSide;
varying float vDist;
varying float vWidth;
varying vec3 vWorld;
varying vec3 vSideDir;
varying float vFade;
void main(){
  #include <logdepthbuf_fragment>
  float across = vSide; // -1..1
  float ax = abs(across);
  // puffy, turbulent cross-section: gaussian core eroded by noise, lumpy along the length
  float sc = max(vWidth * 1.2, 1.0);
  float n = fbm(vec2(vDist / sc, across * 1.1 + vAge * 0.04) + vec2(vAge * 0.015, 0.0));
  float n2 = fbm(vec2(vDist / (sc * 0.35) + 3.7, across * 2.3 - vAge * 0.03));
  float prof = exp(-ax * ax * (2.2 + 2.0 * (1.0 - n)));
  float edge = smoothstep(1.0, 0.55 + 0.35 * n, ax);
  float body = prof * edge * (0.45 + 0.75 * n2);
  // density decays with age and spreading (mass conservation)
  float spread = uWidth0 / max(vWidth, uWidth0);
  float dens = uOpacity * mix(1.0, spread, 0.65) * body;
  float t = vAge / uLife;
  // dissipate: thins steadily from early on, gone by the end of life
  float fadeOut = 1.0 - smoothstep(0.08, 1.0, t);
  dens *= smoothstep(0.0, 0.03, vAge) * fadeOut * fadeOut;
  // lighting: soft volumetric (half cylinder normal blended toward the viewer)
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 N = normalize(vSideDir * across * 0.7 + V * sqrt(max(1.0 - across * across, 0.0)) + atmUp(vWorld) * (n2 - 0.5));
  vec3 L = uSunDir;
  float sunUp = smoothstep(-0.05, 0.1, dot(L, atmUp(vWorld)));
  float wrap = clamp(dot(N, L) * 0.45 + 0.55, 0.0, 1.0);
  float fwd = pow(max(dot(-V, L), 0.0), 8.0) * (1.0 - clamp(dens, 0.0, 1.0)) * 1.3;
  vec3 col = uColor * (uSunColor * 0.085 * (wrap * (0.75 + 0.25 * n) + fwd) * sunUp + uAmbient * (0.8 + 0.3 * n2));
  float alt = atmAlt(vWorld);
  dens *= smoothstep(-0.3 * vWidth, 0.4 * vWidth, alt);
  dens = clamp(dens, 0.0, 1.0) * vFade;
  col = applyAtmosphere(col, vWorld);
  gl_FragColor = vec4(col * dens, dens);
}`;

class TrailSlot {
  geo: THREE.BufferGeometry;
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  pos: Float32Array;
  tan: Float32Array;
  data: Float32Array;
  n = 0;
  dist = 0;
  last = new THREE.Vector3();
  lastT = 0;
  active = false;
  emitting = false;
  endTime = 0;
  style!: TrailStyle;
  private posAttr: THREE.BufferAttribute;
  private tanAttr: THREE.BufferAttribute;
  private dataAttr: THREE.BufferAttribute;
  private dirtyLo = Infinity;

  constructor(base: THREE.ShaderMaterial) {
    this.pos = new Float32Array(MAXP * 2 * 3);
    this.tan = new Float32Array(MAXP * 2 * 3);
    this.data = new Float32Array(MAXP * 2 * 4);
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.tanAttr = new THREE.BufferAttribute(this.tan, 3).setUsage(THREE.DynamicDrawUsage);
    this.dataAttr = new THREE.BufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('aTan', this.tanAttr);
    g.setAttribute('aData', this.dataAttr);
    const idx = new Uint32Array((MAXP - 1) * 6);
    for (let i = 0; i < MAXP - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.set([a, c, b, b, c, d], i * 6);
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    this.geo = g;
    this.mat = base.clone();
    // share the global atmosphere uniforms by reference
    for (const k of Object.keys(atmUniforms)) (this.mat.uniforms as any)[k] = (atmUniforms as any)[k];
    this.mat.uniforms.uTime = base.uniforms.uTime;
    this.mat.uniforms.uWind = base.uniforms.uWind;
    this.mat.uniforms.uViewport = base.uniforms.uViewport;
    this.mat.uniforms.uAmbient = base.uniforms.uAmbient;
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    this.mesh.visible = false;
  }

  start(style: TrailStyle, p: THREE.Vector3, t: number) {
    this.style = style;
    this.n = 0;
    this.dist = 0;
    this.active = true;
    this.emitting = true;
    this.mesh.visible = true;
    const u = this.mat.uniforms;
    u.uGrowth.value = style.growth;
    u.uLife.value = style.life;
    u.uRise.value = style.rise;
    u.uOpacity.value = style.opacity;
    u.uColor.value.set(...style.color);
    u.uWidth0.value = style.width0;
    this.dirtyLo = 0;
    this.push(p, t, true);
  }

  private write(i: number, p: THREE.Vector3, tan: THREE.Vector3, t: number, dist: number) {
    for (let s = 0; s < 2; s++) {
      const v = i * 2 + s;
      this.pos[v * 3] = p.x; this.pos[v * 3 + 1] = p.y; this.pos[v * 3 + 2] = p.z;
      this.tan[v * 3] = tan.x; this.tan[v * 3 + 1] = tan.y; this.tan[v * 3 + 2] = tan.z;
      this.data[v * 4] = t; this.data[v * 4 + 1] = s ? 1 : -1; this.data[v * 4 + 2] = this.style.width0; this.data[v * 4 + 3] = dist;
    }
    if (i < this.dirtyLo) this.dirtyLo = i;
  }

  /** Add a sample (or move the live head sample). */
  push(p: THREE.Vector3, t: number, force = false) {
    if (!this.emitting) return;
    const d = this.n ? p.distanceTo(this.last) : 0;
    const tan = this.n ? p.clone().sub(this.last).normalize() : new THREE.Vector3(0, 1, 0);
    if (this.n === 0 || force || d >= this.style.spacing) {
      if (this.n >= MAXP) {
        this.emitting = false;
        this.endTime = t;
        return;
      }
      this.dist += d;
      // smooth previous tangent
      if (this.n > 0) {
        const pi = (this.n - 1) * 2;
        const pt = new THREE.Vector3(this.tan[pi * 3], this.tan[pi * 3 + 1], this.tan[pi * 3 + 2]).add(tan).normalize();
        for (let s = 0; s < 2; s++) { const v = pi + s; this.tan[v * 3] = pt.x; this.tan[v * 3 + 1] = pt.y; this.tan[v * 3 + 2] = pt.z; }
        if (this.n === 1) {
          for (let s = 0; s < 2; s++) { const v = s; this.tan[v * 3] = tan.x; this.tan[v * 3 + 1] = tan.y; this.tan[v * 3 + 2] = tan.z; }
        }
      }
      this.write(this.n, p, tan, t, this.dist);
      this.n++;
      this.last.copy(p);
      this.lastT = t;
    } else {
      // live head: a provisional point at the emitter so the ribbon reaches the nozzle
      if (this.n < MAXP) this.write(this.n, p, tan, t, this.dist + d);
    }
    this.geo.setDrawRange(0, Math.max(0, Math.min(this.n + 1, MAXP) - 1) * 6);
  }

  stop(t: number) {
    if (this.emitting) {
      this.emitting = false;
      this.endTime = t;
      this.geo.setDrawRange(0, Math.max(0, this.n - 1) * 6);
    }
  }

  flush() {
    if (this.dirtyLo === Infinity) return;
    const lo = this.dirtyLo, hi = Math.min(this.n + 1, MAXP);
    for (const [at, k] of [[this.posAttr, 3], [this.tanAttr, 3], [this.dataAttr, 4]] as [THREE.BufferAttribute, number][]) {
      at.addUpdateRange(lo * 2 * k, Math.max(1, hi - lo) * 2 * k);
      at.needsUpdate = true;
    }
    this.dirtyLo = Infinity;
  }
}

/** Pool of camera-facing smoke-trail ribbons. */
export class Trails {
  group = new THREE.Group();
  private slots: TrailSlot[] = [];
  private base: THREE.ShaderMaterial;
  now = 0;
  constructor(max = 160) {
    this.base = new THREE.ShaderMaterial({
      uniforms: {
        ...atmUniforms,
        uTime: { value: 0 },
        uWind: { value: new THREE.Vector3() },
        uGrowth: { value: 1 },
        uLife: { value: 30 },
        uRise: { value: 0.3 },
        uOpacity: { value: 0.8 },
        uColor: { value: new THREE.Vector3(1, 1, 1) },
        uAmbient: { value: new THREE.Vector3(0.3, 0.33, 0.38) },
        uWidth0: { value: 1 },
        uPlanetR2: { value: atmUniforms.uPlanetR.value },
        uViewport: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    for (let i = 0; i < max; i++) {
      const s = new TrailSlot(this.base);
      this.slots.push(s);
      this.group.add(s.mesh);
    }
  }

  /** Start a new trail; returns a handle (or null if the pool is exhausted). */
  start(style: TrailStyle, p: THREE.Vector3): TrailSlot | null {
    let s = this.slots.find((x) => !x.active);
    if (!s) {
      // recycle the oldest finished trail
      s = this.slots.filter((x) => !x.emitting).sort((a, b) => a.endTime - b.endTime)[0];
      if (!s) return null;
    }
    s.start(style, p, this.now);
    return s;
  }

  /** Drop every trail (scenario restart). */
  clear() {
    for (const s of this.slots) {
      s.active = false;
      s.emitting = false;
      s.mesh.visible = false;
    }
  }

  update(t: number, wind: THREE.Vector3, viewportH: number, ambient: THREE.Vector3) {
    this.now = t;
    const u = this.base.uniforms;
    u.uTime.value = t;
    u.uWind.value.copy(wind);
    u.uViewport.value.set(1, viewportH);
    u.uAmbient.value.copy(ambient);
    for (const s of this.slots) {
      if (!s.active) continue;
      if (!s.emitting && t - s.endTime > s.style.life) {
        s.active = false;
        s.mesh.visible = false;
        continue;
      }
      s.flush();
    }
  }
}
export type { TrailSlot };
