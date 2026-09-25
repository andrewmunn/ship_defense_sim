import * as THREE from 'three';
import { atmUniforms } from './atmosphere';
import { ATMOS_UNIFORMS_GLSL } from './shaders/common.glsl';

/**
 * Per-frame dynamic emissive billboards (engine glows, muzzle flashes, lamps).
 * Rebuilt every frame: call begin(), add(...), end().
 */
export class Glows {
  mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private a: Float32Array; // pos.xyz, size
  private b: Float32Array; // color.rgb, minPx
  private at: THREE.InstancedBufferAttribute;
  private bt: THREE.InstancedBufferAttribute;
  n = 0;
  constructor(public cap = 4096) {
    const q = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = q.index;
    g.setAttribute('position', q.getAttribute('position'));
    this.a = new Float32Array(cap * 4);
    this.b = new Float32Array(cap * 4);
    this.at = new THREE.InstancedBufferAttribute(this.a, 4).setUsage(THREE.DynamicDrawUsage);
    this.bt = new THREE.InstancedBufferAttribute(this.b, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aA', this.at);
    g.setAttribute('aB', this.bt);
    g.instanceCount = 0;
    this.geo = g;
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...atmUniforms, uViewportH: { value: 1 } },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec4 aA; attribute vec4 aB;
        uniform float uViewportH;
        uniform float uHazeDensity;
        varying vec2 vUv; varying vec3 vCol; varying float vK;
        void main(){
          vec3 p = aA.xyz;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          float dist = max(-mv.z, 0.1);
          float pxPerM = uViewportH * projectionMatrix[1][1] * 0.5 / dist;
          float size = aA.w;
          float px = size * pxPerM;
          float k = 1.0;
          if (px < aB.w) { k = (px * px) / (aB.w * aB.w); k = mix(k, 1.0, 0.35); size = aB.w / pxPerM; }
          vK = k * exp(-uHazeDensity * dist * 0.6);
          vUv = position.xy + 0.5;
          vCol = aB.rgb;
          mv.xy += position.xy * size;
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying vec2 vUv; varying vec3 vCol; varying float vK;
        void main(){
          #include <logdepthbuf_fragment>
          float r = length(vUv - 0.5) * 2.0;
          float m = exp(-r * r * 6.0) + exp(-r * 3.0) * 0.25;
          m *= smoothstep(1.0, 0.8, r);
          gl_FragColor = vec4(vCol * m * vK, 0.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
  }
  begin(viewportH: number) {
    this.n = 0;
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uViewportH.value = viewportH;
  }
  add(p: THREE.Vector3, size: number, r: number, g: number, b: number, minPx = 3) {
    if (this.n >= this.cap) return;
    const i = this.n++ * 4;
    this.a[i] = p.x; this.a[i + 1] = p.y; this.a[i + 2] = p.z; this.a[i + 3] = size;
    this.b[i] = r; this.b[i + 1] = g; this.b[i + 2] = b; this.b[i + 3] = minPx;
  }
  end() {
    this.geo.instanceCount = this.n;
    if (this.n) {
      this.at.clearUpdateRanges(); this.at.addUpdateRange(0, this.n * 4); this.at.needsUpdate = true;
      this.bt.clearUpdateRanges(); this.bt.addUpdateRange(0, this.n * 4); this.bt.needsUpdate = true;
    }
  }
}

/**
 * Velocity-aligned glowing streaks for projectiles (CIWS rounds, shells).
 * Each streak spans from p0 to p1 (world), rendered camera-facing with a minimum pixel width.
 */
export class Streaks {
  mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private a: Float32Array; // p0.xyz, width
  private b: Float32Array; // p1.xyz, intensity
  private c: Float32Array; // color rgb, minPx
  private at: THREE.InstancedBufferAttribute;
  private bt: THREE.InstancedBufferAttribute;
  private ct: THREE.InstancedBufferAttribute;
  n = 0;
  constructor(public cap = 8192) {
    const q = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = q.index;
    g.setAttribute('position', q.getAttribute('position'));
    this.a = new Float32Array(cap * 4);
    this.b = new Float32Array(cap * 4);
    this.c = new Float32Array(cap * 4);
    this.at = new THREE.InstancedBufferAttribute(this.a, 4).setUsage(THREE.DynamicDrawUsage);
    this.bt = new THREE.InstancedBufferAttribute(this.b, 4).setUsage(THREE.DynamicDrawUsage);
    this.ct = new THREE.InstancedBufferAttribute(this.c, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aA', this.at);
    g.setAttribute('aB', this.bt);
    g.setAttribute('aC', this.ct);
    g.instanceCount = 0;
    this.geo = g;
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...atmUniforms, uViewportH: { value: 1 } },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec4 aA; attribute vec4 aB; attribute vec4 aC;
        uniform float uViewportH;
        uniform float uHazeDensity;
        varying vec2 vUv; varying vec3 vCol; varying float vK;
        void main(){
          vec3 p0 = aA.xyz, p1 = aB.xyz;
          vec3 mid = (p0 + p1) * 0.5;
          vec3 d = p1 - p0;
          float len = length(d);
          vec3 dir = len > 1e-4 ? d / len : vec3(0.0, 1.0, 0.0);
          vec3 toCam = normalize(cameraPosition - mid);
          vec3 side = normalize(cross(dir, toCam) + 1e-5);
          float dist = max(length(cameraPosition - mid), 0.1);
          float pxPerM = uViewportH * projectionMatrix[1][1] * 0.5 / dist;
          float w = aA.w;
          float k = aB.w;
          if (w * pxPerM < aC.w) { k *= w * pxPerM / aC.w; w = aC.w / pxPerM; }
          vK = k * exp(-uHazeDensity * dist * 0.6);
          vUv = position.xy + 0.5;
          vCol = aC.rgb;
          vec3 wp = mid + dir * position.y * (len + w) + side * position.x * w;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying vec2 vUv; varying vec3 vCol; varying float vK;
        void main(){
          #include <logdepthbuf_fragment>
          float x = abs(vUv.x - 0.5) * 2.0;
          float m = exp(-x * x * 4.0) * smoothstep(0.0, 0.15, vUv.y) * (0.35 + 0.65 * vUv.y);
          gl_FragColor = vec4(vCol * m * vK, 0.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
  }
  begin(viewportH: number) {
    this.n = 0;
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uViewportH.value = viewportH;
  }
  add(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, width: number, intensity: number, r: number, g: number, b: number, minPx = 1.5) {
    if (this.n >= this.cap) return;
    const i = this.n++ * 4;
    this.a[i] = x0; this.a[i + 1] = y0; this.a[i + 2] = z0; this.a[i + 3] = width;
    this.b[i] = x1; this.b[i + 1] = y1; this.b[i + 2] = z1; this.b[i + 3] = intensity;
    this.c[i] = r; this.c[i + 1] = g; this.c[i + 2] = b; this.c[i + 3] = minPx;
  }
  end() {
    this.geo.instanceCount = this.n;
    if (this.n) for (const at of [this.at, this.bt, this.ct]) { at.clearUpdateRanges(); at.addUpdateRange(0, this.n * 4); at.needsUpdate = true; }
  }
}

void ATMOS_UNIFORMS_GLSL;
