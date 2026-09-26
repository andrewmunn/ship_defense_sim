import * as THREE from 'three';

/**
 * Procedural, tileable terrain detail textures rendered once on the GPU at startup.
 *  hgt  (1024²): R rock height, G soil/pebble height, B vegetation (grass/scrub) height, A sand ripples
 *  var  (1024²): per-material albedo variation (same channel layout, 0.5 = neutral)
 *  n1   (1024²): RG rock normal.xy, BA soil normal.xy
 *  n2   (1024²): RG vegetation normal.xy, BA sand normal.xy
 *  macro (512²): low-frequency tileable fbm in 4 channels for large-scale variation
 */
export interface TerrainTextures {
  hgt: THREE.Texture;
  vari: THREE.Texture;
  n1: THREE.Texture;
  n2: THREE.Texture;
  macro: THREE.Texture;
  /** CPU copy of the macro texture (RGBA8, MACRO_SIZE²) so scatter/land use can match the shader. */
  macroData: Uint8Array;
  dispose(): void;
}
export const MACRO_SIZE = 512;

const NOISE = /* glsl */ `
float th(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 th2(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
// tileable value noise: p in lattice units, per = integer period
float tn(vec2 p, float per){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  float a = th(mod(i, per)), b = th(mod(i + vec2(1,0), per)), c = th(mod(i + vec2(0,1), per)), d = th(mod(i + vec2(1,1), per));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
// uv in [0,1) tile space
float tfbm(vec2 uv, float per, int oct, float gain){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 8; i++){ if (i >= oct) break; s += a * tn(uv * per + float(i) * 17.0 * 0.0, per); n += a; per *= 2.0; a *= gain; }
  return s / n;
}
// tileable voronoi: returns F1, F2, cell hash
vec3 tvor(vec2 uv, float per){
  vec2 p = uv * per;
  vec2 i = floor(p), f = fract(p);
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec2 g = vec2(x, y);
    vec2 cell = mod(i + g, per);
    vec2 o = th2(cell * 1.37 + 3.1);
    float d = length(g + o - f);
    if (d < f1){ f2 = f1; f1 = d; id = th(cell + 11.7); } else if (d < f2) f2 = d;
  }
  return vec3(f1, f2, id);
}
`;

const VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Channel generators share this body; MODE 0 = height, 1 = variation
const GEN_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uMode;
${NOISE}
void main(){
  vec2 uv = vUv;
  // ---------------- rock: blocky fractured limestone with strata (v axis = up on cliff faces)
  vec2 wr = vec2(tfbm(uv, 4.0, 4, 0.5), tfbm(uv + 0.31, 4.0, 4, 0.5)) - 0.5;
  vec3 v1 = tvor(uv + wr * 0.06, 7.0);
  vec3 v2 = tvor(uv + wr * 0.03, 23.0);
  float crack1 = smoothstep(0.0, 0.09, v1.y - v1.x);
  float crack2 = smoothstep(0.0, 0.07, v2.y - v2.x);
  float strata = 0.5 + 0.5 * sin((uv.y * 31.0 + wr.x * 2.2 + tfbm(uv, 8.0, 3, 0.5) * 1.5) * 6.28318);
  float fb = tfbm(uv, 16.0, 6, 0.55);
  float rock = fb * 0.42 + crack1 * 0.24 + crack2 * 0.12 + v1.z * 0.12 + strata * 0.10;
  float rockVar = 0.5 + (v1.z - 0.5) * 0.45 + (tfbm(uv, 32.0, 4, 0.6) - 0.5) * 0.6 - (1.0 - crack1) * 0.18 + (strata - 0.5) * 0.12;
  // lichen / dark weathering spots
  rockVar -= smoothstep(0.62, 0.8, tfbm(uv + 0.7, 24.0, 4, 0.6)) * 0.25;

  // ---------------- soil: dirt with pebbles & clods
  vec3 p1 = tvor(uv, 38.0);
  vec3 p2 = tvor(uv + 0.5, 97.0);
  float peb1 = sqrt(max(0.0, 1.0 - p1.x / (0.28 + p1.z * 0.22))) * step(p1.z, 0.45);
  float peb2 = sqrt(max(0.0, 1.0 - p2.x / 0.35)) * step(p2.z, 0.35);
  float dirt = tfbm(uv, 24.0, 6, 0.55);
  float soil = dirt * 0.45 + peb1 * 0.45 + peb2 * 0.25;
  float soilVar = 0.5 + (dirt - 0.5) * 0.7 + peb1 * (p1.z * 2.0 - 0.45) * 0.9 + peb2 * (p2.z * 2.5 - 0.4) * 0.5;
  soilVar += (tfbm(uv, 6.0, 4, 0.5) - 0.5) * 0.5;

  // ---------------- vegetation: clumps of dry grass / low scrub
  float clump = tfbm(uv + 0.13, 12.0, 5, 0.55);
  vec3 bl = tvor(uv, 180.0);
  float blades = (1.0 - smoothstep(0.0, 0.45, bl.x)) * (0.5 + 0.5 * bl.z);
  float fine = tfbm(uv, 128.0, 3, 0.6);
  float veg = smoothstep(0.38, 0.7, clump) * (0.55 + 0.45 * blades) * (0.7 + 0.3 * fine);
  float vegVar = 0.5 + (tfbm(uv + 0.77, 8.0, 4, 0.5) - 0.5) * 0.9 + (bl.z - 0.5) * 0.35 * blades;

  // ---------------- sand: wind ripples + grain
  float sw = tfbm(uv, 3.0, 4, 0.5);
  float ph = (uv.y + uv.x * 0.0) * 36.0 + sw * 4.0 + tfbm(uv, 12.0, 3, 0.5) * 0.8;
  float rip = fract(ph);
  rip = rip < 0.72 ? rip / 0.72 : (1.0 - rip) / 0.28; // asymmetric ripple profile
  float grain = th(floor(uv * 1024.0) + 0.5);
  float sand = rip * 0.55 * (0.6 + 0.4 * tfbm(uv, 6.0, 3, 0.5)) + tfbm(uv, 64.0, 4, 0.6) * 0.35 + grain * 0.1;
  float sandVar = 0.5 + (tfbm(uv + 0.4, 10.0, 4, 0.55) - 0.5) * 0.5 + (grain - 0.5) * 0.35 + (rip - 0.5) * 0.12;

  if (uMode < 0.5) gl_FragColor = vec4(rock, soil, veg, sand);
  else gl_FragColor = clamp(vec4(rockVar, soilVar, vegVar, sandVar), 0.0, 1.0);
}`;

const NORMAL_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uH;
uniform vec4 uStrength; // per-channel strength
uniform float uPair; // 0: channels R,G → out; 1: channels B,A → out
void main(){
  vec2 px = vec2(1.0 / 1024.0);
  vec4 l = texture2D(uH, vUv - vec2(px.x, 0.0)), r = texture2D(uH, vUv + vec2(px.x, 0.0));
  vec4 d = texture2D(uH, vUv - vec2(0.0, px.y)), u = texture2D(uH, vUv + vec2(0.0, px.y));
  vec4 dx = (r - l) * uStrength, dy = (u - d) * uStrength;
  vec2 a, b;
  if (uPair < 0.5) { a = vec2(dx.x, dy.x); b = vec2(dx.y, dy.y); }
  else { a = vec2(dx.z, dy.z); b = vec2(dx.w, dy.w); }
  vec3 na = normalize(vec3(-a, 1.0)), nb = normalize(vec3(-b, 1.0));
  gl_FragColor = vec4(na.xy * 0.5 + 0.5, nb.xy * 0.5 + 0.5);
}`;

const MACRO_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
${NOISE}
void main(){
  vec2 uv = vUv;
  float a = tfbm(uv, 4.0, 6, 0.55);
  float b = tfbm(uv + 0.37, 8.0, 6, 0.55);
  float c = tfbm(uv + 0.71, 16.0, 5, 0.6);
  vec3 v = tvor(uv, 12.0);
  float d = mix(v.z, tfbm(uv, 48.0, 3, 0.5), 0.35);
  gl_FragColor = vec4(a, b, c, d);
}`;

function makeRT(size: number) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: false,
    anisotropy: 8,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  return rt;
}

export function makeTerrainTextures(renderer: THREE.WebGLRenderer): TerrainTextures {
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const quad = new THREE.Mesh(g);
  quad.frustumCulled = false;
  scene.add(quad);

  const prevRT = renderer.getRenderTarget();
  const prevAuto = renderer.autoClear;
  renderer.autoClear = false;
  const draw = (mat: THREE.ShaderMaterial, rt: THREE.WebGLRenderTarget) => {
    quad.material = mat;
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
  };

  const genMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: GEN_FRAG, uniforms: { uMode: { value: 0 } }, depthTest: false, depthWrite: false });
  const hgt = makeRT(1024);
  const vari = makeRT(1024);
  draw(genMat, hgt);
  genMat.uniforms.uMode.value = 1;
  draw(genMat, vari);

  // normals are generated from a non-mipmapped read of hgt (level 0)
  const nMat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: NORMAL_FRAG,
    uniforms: { uH: { value: hgt.texture }, uStrength: { value: new THREE.Vector4(9, 7, 6, 5) }, uPair: { value: 0 } },
    depthTest: false,
    depthWrite: false,
  });
  const n1 = makeRT(1024);
  const n2 = makeRT(1024);
  draw(nMat, n1);
  nMat.uniforms.uPair.value = 1;
  draw(nMat, n2);

  const mMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: MACRO_FRAG, depthTest: false, depthWrite: false });
  const macro = makeRT(MACRO_SIZE);
  draw(mMat, macro);
  const macroData = new Uint8Array(MACRO_SIZE * MACRO_SIZE * 4);
  renderer.readRenderTargetPixels(macro, 0, 0, MACRO_SIZE, MACRO_SIZE, macroData);

  renderer.setRenderTarget(prevRT);
  renderer.autoClear = prevAuto;
  genMat.dispose();
  nMat.dispose();
  mMat.dispose();
  g.dispose();

  const rts = [hgt, vari, n1, n2, macro];
  return {
    hgt: hgt.texture,
    vari: vari.texture,
    n1: n1.texture,
    n2: n2.texture,
    macro: macro.texture,
    macroData,
    dispose() {
      for (const r of rts) r.dispose();
    },
  };
}
