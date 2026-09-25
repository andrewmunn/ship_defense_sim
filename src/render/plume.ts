import * as THREE from 'three';

export type PlumeKind = 'solid' | 'turbojet' | 'ramjet' | 'liquid' | 'booster';

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vLocal;
varying vec3 vN;
varying vec3 vV;
void main(){
  vLocal = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uLen;
uniform float uThrottle;
uniform vec3 uCore;
uniform vec3 uEdge;
uniform float uDiamonds;
uniform float uIntensity;
uniform float uSeed;
varying vec3 vLocal;
varying vec3 vN;
varying vec3 vV;
float h1(float n){ return fract(sin(n) * 43758.5453); }
float n1(float x){ float i = floor(x), f = fract(x); return mix(h1(i), h1(i + 1.0), f * f * (3.0 - 2.0 * f)); }
void main(){
  #include <logdepthbuf_fragment>
  // local: nozzle at z=0, plume extends to z=-uLen (geometry is unit length scaled)
  float z = clamp(-vLocal.z, 0.0, 1.0);
  float fres = abs(dot(normalize(vN), normalize(vV)));
  float body = pow(fres, 1.6);
  float flick = 0.82 + 0.18 * n1(uTime * 37.0 + uSeed * 10.0) + 0.1 * n1(uTime * 83.0 + z * 6.0);
  float taper = pow(1.0 - z, 1.4);
  float diamonds = 1.0 + uDiamonds * 0.8 * pow(max(cos(z * 6.2831 * 4.0), 0.0), 6.0) * smoothstep(0.55, 0.0, z);
  float core = smoothstep(0.35, 0.0, z) * pow(fres, 3.0);
  vec3 col = mix(uEdge, uCore, clamp(core * 1.6 + (1.0 - z) * 0.2, 0.0, 1.0));
  float I = uIntensity * uThrottle * flick * taper * body * diamonds;
  gl_FragColor = vec4(col * I, 0.0);
}`;

const STYLE: Record<PlumeKind, { core: [number, number, number]; edge: [number, number, number]; diamonds: number; intensity: number }> = {
  solid: { core: [1.0, 0.92, 0.75], edge: [1.0, 0.45, 0.12], diamonds: 0.6, intensity: 26 },
  booster: { core: [1.0, 0.9, 0.7], edge: [1.0, 0.5, 0.15], diamonds: 0.4, intensity: 30 },
  turbojet: { core: [0.9, 0.55, 0.35], edge: [0.35, 0.2, 0.3], diamonds: 0.0, intensity: 1.2 },
  ramjet: { core: [0.75, 0.75, 1.0], edge: [0.9, 0.35, 0.6], diamonds: 1.0, intensity: 9 },
  liquid: { core: [1.0, 0.8, 0.55], edge: [1.0, 0.35, 0.1], diamonds: 0.8, intensity: 18 },
};

let _geo: THREE.BufferGeometry | null = null;
function plumeGeo() {
  if (_geo) return _geo;
  // unit plume: radius 1 at the widest, from z=0 to z=-1, bulged profile
  const pts: THREE.Vector2[] = [];
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const r = 0.42 + 0.58 * Math.sin(Math.min(1, t * 1.8) * Math.PI * 0.5) * (1 - t * 0.6);
    pts.push(new THREE.Vector2(Math.max(r * (1 - Math.pow(t, 6)), 0.001), -t));
  }
  const g = new THREE.LatheGeometry(pts, 24);
  // lathe is around Y: rotate so the axis is Z
  g.rotateX(Math.PI / 2);
  g.rotateX(Math.PI);
  _geo = g;
  return g;
}

/** Exhaust flame attached at a nozzle (object's -Z is downstream). */
export class Plume {
  group = new THREE.Group();
  mat: THREE.ShaderMaterial;
  inner: THREE.Mesh;
  outer: THREE.Mesh;
  constructor(public kind: PlumeKind, public radius: number, public length: number) {
    const s = STYLE[kind];
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLen: { value: length },
        uThrottle: { value: 1 },
        uCore: { value: new THREE.Vector3(...s.core) },
        uEdge: { value: new THREE.Vector3(...s.edge) },
        uDiamonds: { value: s.diamonds },
        uIntensity: { value: s.intensity },
        uSeed: { value: Math.random() * 100 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.inner = new THREE.Mesh(plumeGeo(), this.mat);
    this.inner.scale.set(radius, radius, length);
    this.outer = new THREE.Mesh(plumeGeo(), this.mat);
    this.outer.scale.set(radius * 1.9, radius * 1.9, length * 0.6);
    this.group.add(this.inner, this.outer);
    this.inner.renderOrder = this.outer.renderOrder = 13;
    this.inner.frustumCulled = this.outer.frustumCulled = false;
  }
  update(t: number, throttle: number, stretch = 1) {
    this.mat.uniforms.uTime.value = t;
    this.mat.uniforms.uThrottle.value = throttle;
    this.group.visible = throttle > 0.01;
    this.inner.scale.z = this.length * stretch;
    this.outer.scale.z = this.length * 0.6 * stretch;
  }
  dispose() {
    this.mat.dispose();
  }
}
