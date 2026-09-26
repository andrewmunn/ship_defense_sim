import * as THREE from 'three';
import { atmUniforms } from '../atmosphere';
import { ATMOS_UNIFORMS_GLSL } from '../shaders/common.glsl';
import { TerrainTextures } from './textures';
import { HOR_MAX_SIN } from './gen';

/**
 * Terrain surface material: MeshStandardMaterial (sun, env, shadows, aerial-perspective fog all
 * come from three / the atmosphere chunks) with a custom layered albedo / normal / roughness block.
 *
 * Per-vertex inputs (see gen.ts): aTex = (uvx, uvz, height m, cavity), aHor0/aHor1 = horizon angles.
 */
export const MAX_TOWNS = 40;
export const MAX_CLEARINGS = 8;

export function createTerrainMaterial(tex: TerrainTextures) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  mat.envMapIntensity = 0.45;
  const uniforms = {
    tHgt: { value: tex.hgt },
    tVar: { value: tex.vari },
    tN1: { value: tex.n1 },
    tN2: { value: tex.n2 },
    tMacro: { value: tex.macro },
    tTime: { value: 0 },
    tDetailDist: { value: 3500 },
    /** camera x, z, and the distance band over which flat scrub gives way to 3D scatter */
    tNear: { value: new THREE.Vector4(0, 0, 0, 0) },
    /** Up to MAX_CLEARINGS worn-ground patches (x, z, radius, 1) */
    tClear: { value: Array.from({ length: MAX_CLEARINGS }, () => new THREE.Vector4(0, 0, 0, 0)) },
    tNClear: { value: 0 },
    tClearBound: { value: new THREE.Vector4(0, 0, 0, 0) },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, atmUniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aTex;
attribute vec4 aHor0;
attribute vec4 aHor1;
attribute vec4 aExt;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uPlanetR;
varying vec4 vTex;
varying vec2 vTX; // x: terrain horizon (sin elevation) toward the key light, y: urban weight
#ifndef USE_FOG
varying vec3 vTWP;
#endif`
      )
      .replace(
        '#include <fog_vertex>',
        `#include <fog_vertex>
  {
    vTex = aTex;
    vec3 wpv = (modelMatrix * vec4(transformed, 1.0)).xyz;
    #ifndef USE_FOG
    vTWP = wpv;
    #endif
    // Resolve the 8-azimuth horizon for the current key light here (1 varying instead of 8).
    // Key light = sun while it is up, else the moon (mirrors Atmosphere.apply()).
    vec3 upv = normalize(wpv - vec3(0.0, -uPlanetR, 0.0));
    vec3 K = dot(uSunDir, upv) > -0.06 ? uSunDir : uMoonDir;
    vec3 lt = K - upv * dot(K, upv);
    float f = atan(lt.z, lt.x) * (8.0 / 6.28318530718);
    if (f < 0.0) f += 8.0;
    vec4 d0 = abs(vec4(f) - vec4(0.0, 1.0, 2.0, 3.0));
    vec4 d1 = abs(vec4(f) - vec4(4.0, 5.0, 6.0, 7.0));
    d0 = min(d0, 8.0 - d0);
    d1 = min(d1, 8.0 - d1);
    float hv = (dot(aHor0, max(1.0 - d0, 0.0)) + dot(aHor1, max(1.0 - d1, 0.0))) * ${HOR_MAX_SIN.toFixed(3)};
    vTX = vec2(hv, aExt.x);
  }`
      );

    const lf = THREE.ShaderChunk.lights_fragment_begin;
    const i0 = lf.indexOf('DirectionalLight directionalLight;');
    const i1 = lf.indexOf('RE_Direct( directLight', i0);
    const lightsPatched = lf.slice(0, i1) + 'directLight.color *= terrHorShadow( directLight.direction );\n\t\t' + lf.slice(i1);

    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', FRAG_PARS + '\nvoid main() {')
      .replace('#include <map_fragment>', FRAG_ALBEDO)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize( ( viewMatrix * vec4( tNW, 0.0 ) ).xyz );')
      .replace('#include <lights_fragment_begin>', lightsPatched)
      // dry, dusty ground: damp the grazing-angle sky reflection that GGX gives rough dielectrics
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n  reflectedLight.indirectSpecular *= tSpecK;\n  reflectedLight.directSpecular *= mix(0.6, 1.0, tSpecK);')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n#ifdef DBG_ALBEDO\n  gl_FragColor = vec4(diffuseColor.rgb, 1.0);\n#endif');
  };
  mat.customProgramCacheKey = () => 'terrain-v6';
  return { material: mat, uniforms };
}

const FRAG_PARS = /* glsl */ `
#ifndef USE_FOG
${ATMOS_UNIFORMS_GLSL}
#endif
uniform sampler2D tHgt;
uniform sampler2D tVar;
uniform sampler2D tN1;
uniform sampler2D tN2;
uniform sampler2D tMacro;
uniform float tTime;
uniform float tDetailDist;
uniform vec4 tNear;
uniform vec4 tClear[${MAX_CLEARINGS}];
uniform int tNClear;
uniform vec4 tClearBound; // circle enclosing all clearings (x, z, r)
varying vec4 vTex;
varying vec2 vTX;
#ifdef USE_FOG
#define T_WP vFogWorldPos
#else
varying vec3 vTWP;
#define T_WP vTWP
#endif
vec3 tUp;

float tH21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

// Large-scale terrain self-shadow from the precomputed 8-azimuth horizon angles.
float terrHorShadow(vec3 dirView){
  #ifdef NO_HOR
  return 1.0;
  #endif
  vec3 L = normalize((vec4(dirView, 0.0) * viewMatrix).xyz);
  float se = dot(L, tUp);
  float hv = vTX.x;
  return smoothstep(hv - 0.01, hv + 0.025, se);
}
vec3 tPert(vec3 n, vec2 d, vec3 tu, vec3 tv, float s){
  tu = normalize(tu - n * dot(tu, n));
  tv = normalize(tv - n * dot(tv, n));
  return n + (tu * d.x + tv * d.y) * s;
}
// anti-aliased "inside band" (distance d from a line, half width w, pixel footprint fw)
float tBand(float d, float w, float fw){ return 1.0 - smoothstep(w - fw, w + fw, d); }

// Agricultural field systems (rotated per 2.4 km estate). Returns the field color; hedge = boundary mask.
vec3 tFields(vec2 wp, float fw, vec3 ground, vec3 scrub, float paintTrees, out float hedge, out float rough){
  vec2 cell = floor(wp / 2400.0);
  vec2 lc = wp - (cell + 0.5) * 2400.0;
  float ang = tH21(cell + 7.1) * 3.14159;
  float ca = cos(ang), sa = sin(ang);
  vec2 q = vec2(ca * lc.x - sa * lc.y, sa * lc.x + ca * lc.y);
  vec2 fsz = vec2(60.0 + 70.0 * tH21(cell + 1.3), 110.0 + 120.0 * tH21(cell + 2.9));
  float row = floor(q.y / fsz.y);
  float rh = tH21(vec2(row, cell.x + cell.y * 17.0));
  fsz.x *= 0.55 + 0.9 * rh;
  q.x += rh * 3.7 * fsz.x;
  vec2 id = floor(q / fsz);
  vec2 f = q - id * fsz;
  float r = tH21(id + cell * 31.7);
  float r2 = tH21(id * 1.7 + cell * 3.1 + 5.0);
  vec2 e = min(f, fsz - f);
  float edgeD = min(e.x, e.y);
  hedge = tBand(edgeD, 1.8, max(fw, 0.4) * 1.2) * step(0.35, tH21(id + 9.0 + cell));
  float furrowFade = smoothstep(1.2, 0.3, fw);
  float furrow = (0.5 + 0.5 * sin(q.x * 2.513)) * furrowFade;
  vec3 c;
  rough = 0.95;
  if (r < 0.2) {
    // golden stubble / hay
    c = mix(vec3(0.27, 0.20, 0.09), vec3(0.40, 0.31, 0.15), r2);
    c *= 0.9 + 0.12 * furrow;
  } else if (r < 0.31) {
    // ploughed terra rossa / brown
    c = mix(vec3(0.17, 0.085, 0.045), vec3(0.26, 0.17, 0.10), r2);
    c *= 0.82 + 0.3 * furrow;
    rough = 0.98;
  } else if (r < 0.37) {
    // irrigated green crop
    c = mix(vec3(0.05, 0.08, 0.03), vec3(0.10, 0.12, 0.05), r2) * (0.9 + 0.15 * furrow);
  } else if (r < 0.75) {
    // olive grove: regular canopy dots over pale soil
    vec2 g = fract(q / 7.0 + r2) - 0.5;
    float d = length(g) * 7.0;
    float cov = 0.28;
    float canopy = mix(cov, tBand(d, 2.1, fw * 0.8), smoothstep(5.0, 1.5, fw));
    vec3 soilC = mix(vec3(0.30, 0.24, 0.16), vec3(0.24, 0.15, 0.09), r2);
    // near the camera the 3D olive trees exist: keep only a faint litter ring under each
    c = mix(soilC, vec3(0.06, 0.075, 0.04), canopy * mix(0.12, 1.0, paintTrees));
  } else {
    c = ground;
  }
  return c;
}

// Built-up areas: street blocks + roofs (white / cream / terracotta) with gardens and trees.
vec3 tTownColor(vec2 wp, float dens, float fw, vec4 m4, out float rough){
  vec2 bq = wp / 46.0;
  vec2 bf = fract(bq) * 46.0;
  float street = tBand(min(bf.x, bf.y), 3.2, fw);
  vec2 id = floor(wp / 11.5);
  float rb = tH21(id + 0.37);
  float bld = step(1.0 - dens * 0.85, tH21(id * 1.31 + 4.2));
  vec3 roof = rb < 0.55 ? mix(vec3(0.24, 0.085, 0.045), vec3(0.34, 0.14, 0.07), tH21(id + 1.7))
                        : mix(vec3(0.30, 0.29, 0.26), vec3(0.44, 0.42, 0.38), tH21(id + 2.9));
  // gardens / courtyards with trees
  vec3 garden = mix(vec3(0.03, 0.05, 0.022), vec3(0.16, 0.13, 0.08), tH21(id + 5.1));
  vec3 c = mix(garden, roof, bld);
  c = mix(c, vec3(0.11, 0.105, 0.1), street);
  vec3 avg = mix(vec3(0.09, 0.09, 0.06), vec3(0.27, 0.22, 0.17), dens * 0.85);
  rough = mix(0.85, 0.7, bld);
  return mix(c, avg, smoothstep(2.0, 6.0, fw));
}
`;

const FRAG_ALBEDO = /* glsl */ `
  vec3 vWP = T_WP;
  float vVD = length(vViewPosition);
  tUp = normalize(vWP - vec3(0.0, -uPlanetR, 0.0));
  vec3 gN = normalize((vec4(vNormal, 0.0) * viewMatrix).xyz);
  // Anything below the waterline is hidden by the opaque ocean anyway; drop it so the seabed can
  // never poke through where the (coarse, chordal) far ocean mesh sags below the true sphere.
  if (vTex.z < -0.3) discard;
  float th = vTex.z;
  float cav = vTex.w;
  float slope = 1.0 - clamp(dot(gN, tUp), 0.0, 1.0);
  vec2 wuv = vTex.xy;
  vec2 wp = vWP.xz;
  float fw = length(fwidth(wp));
  // 1 beyond the 3D scatter radius, 0 inside (where real shrubs/trees replace painted ones)
  float farV = smoothstep(tNear.z, tNear.w, length(wp - tNear.xy));
  float det = smoothstep(tDetailDist, tDetailDist * 0.2, vVD);

  vec4 M1 = texture2D(tMacro, wp / 23040.0);
  vec4 M2 = texture2D(tMacro, wp / 3170.0 + 0.5);
  vec4 M3 = texture2D(tMacro, wuv / 512.0 + 0.25);
  vec4 M4 = texture2D(tMacro, wuv / 128.0 + 0.6);

  // ---- detail samples (skipped far away)
  vec4 hR = vec4(0.5), vR = vec4(0.5), hS = vec4(0.5), vS = vec4(0.5), hV = vec4(0.5), vV = vec4(0.5), hD = vec4(0.5), vD = vec4(0.5);
  vec2 nS = vec2(0.0), nV = vec2(0.0), nD = vec2(0.0);
  vec3 nRockW = gN;
  vec3 X = vec3(1.0, 0.0, 0.0), Z = vec3(0.0, 0.0, 1.0);
  #ifdef NO_DETAIL
  det = 0.0;
  #endif
  if (det > 0.002) {
    // rock: triplanar (top + two sides; strata run horizontally on cliffs) — sides only where steep
    vec2 uT = wuv / 25.6;
    vec4 hT = texture2D(tHgt, uT);
    vec4 vT = texture2D(tVar, uT);
    vec2 nT = texture2D(tN1, uT).xy * 2.0 - 1.0;
    hR = hT; vR = vT;
    nRockW = tPert(gN, nT, X, Z, 1.0);
    if (slope > 0.09) {
      vec3 bw = pow(abs(gN), vec3(4.0));
      bw /= (bw.x + bw.y + bw.z);
      vec2 uX = vec2(wuv.y, th) / 25.6, uZ = vec2(wuv.x, th) / 25.6;
      vec4 hX = texture2D(tHgt, uX), hZ = texture2D(tHgt, uZ);
      vec4 vX = texture2D(tVar, uX), vZ = texture2D(tVar, uZ);
      vec2 nXx = texture2D(tN1, uX).xy * 2.0 - 1.0, nZz = texture2D(tN1, uZ).xy * 2.0 - 1.0;
      hR = hT * bw.y + hX * bw.x + hZ * bw.z;
      vR = vT * bw.y + vX * bw.x + vZ * bw.z;
      nRockW = normalize(nRockW * bw.y + tPert(gN, nXx, Z, tUp, 1.0) * bw.x + tPert(gN, nZz, X, tUp, 1.0) * bw.z);
    }
    vec4 hR2 = texture2D(tHgt, wuv / 204.8 + 0.3);
    hR.r = hR.r * 0.7 + hR2.r * 0.3;
    // soil at two scales
    vec2 uS = wuv / 6.4, uS2 = wuv / 40.96;
    vec4 hS2 = texture2D(tHgt, uS2);
    hS = mix(texture2D(tHgt, uS), hS2, 0.35);
    vS = texture2D(tVar, uS);
    vS.g = mix(vS.g, hS2.g, 0.4);
    nS = (texture2D(tN1, uS).zw * 2.0 - 1.0);
    // very close: fine grit / pebbles / straw litter at 1.6 m
    if (vVD < 70.0) {
      float nearK = smoothstep(70.0, 15.0, vVD);
      vec2 uF = wuv / 1.6;
      vec4 hF = texture2D(tHgt, uF), vF = texture2D(tVar, uF);
      hS = mix(hS, hS * 0.55 + hF * 0.6 - 0.075, nearK);
      vS = mix(vS, vS * 0.5 + vF * 0.5, nearK);
      nS += (texture2D(tN1, uF).zw * 2.0 - 1.0) * 0.9 * nearK;
    }
    // vegetation
    vec2 uV = wuv / 12.8;
    hV = texture2D(tHgt, uV);
    vV = texture2D(tVar, uV);
    if (vVD < 1500.0) nV = texture2D(tN2, uV).xy * 2.0 - 1.0;
    // sand (only near sea level); rotated, period preserved (0.8/0.6 * 1024/5.12 integral)
    if (th < 30.0) {
      vec2 uD = vec2(wuv.x * 0.8 + wuv.y * 0.6, -wuv.x * 0.6 + wuv.y * 0.8) / 5.12;
      hD = texture2D(tHgt, uD);
      vD = texture2D(tVar, uD);
      nD = texture2D(tN2, uD).zw * 2.0 - 1.0;
    }
  }
  float dR = mix(0.5, hR.r, det), dS = mix(0.5, hS.g, det), dV = mix(0.5, hV.b, det), dD = mix(0.5, hD.a, det);
  float alt = th;

  // ---- natural ground: calcareous soil / terra rossa / dry grass / garrigue, alpine stony ground up high
  vec3 soilC = mix(vec3(0.19, 0.12, 0.06), vec3(0.34, 0.26, 0.16), clamp(M2.g * 1.4 - 0.2 + (vS.g - 0.5) * 0.8, 0.0, 1.0));
  soilC = mix(soilC, vec3(0.24, 0.145, 0.075), smoothstep(0.52, 0.75, M1.r) * 0.5);
  vec3 grassC = mix(vec3(0.17, 0.15, 0.065), vec3(0.42, 0.32, 0.14), clamp(M3.b * 1.5 - 0.3 + (vV.b - 0.5) * 0.7 + (M1.g - 0.5) * 0.6, 0.0, 1.0));
  vec3 garrigueC = mix(vec3(0.075, 0.085, 0.05), vec3(0.16, 0.16, 0.11), clamp(vV.b + (M4.r - 0.5), 0.0, 1.0));
  vec3 alpC = mix(vec3(0.14, 0.125, 0.105), vec3(0.26, 0.23, 0.19), clamp(M2.a + (vS.g - 0.5) * 0.6, 0.0, 1.0));
  vec3 scrubC = mix(vec3(0.025, 0.04, 0.018), vec3(0.075, 0.085, 0.04), clamp(vV.b + (M3.g - 0.5) * 0.6, 0.0, 1.0));
  vec3 rockC = mix(vec3(0.13, 0.12, 0.11), vec3(0.44, 0.41, 0.36), clamp(vR.r * 1.1 - 0.05 + (M2.b - 0.5) * 0.4, 0.0, 1.0));
  rockC = mix(rockC, rockC * vec3(1.1, 0.93, 0.8), smoothstep(0.4, 0.8, M1.a));
  // far away (no detail) the average rock reads warmer and darker: weathered faces, shadows, lichen
  rockC = mix(rockC * vec3(0.78, 0.74, 0.68), rockC, det);
  vec3 sandC = mix(vec3(0.28, 0.215, 0.14), vec3(0.43, 0.35, 0.235), clamp(vD.a + (M2.b - 0.5) * 0.5, 0.0, 1.0));
  vec3 shingleC = mix(vec3(0.16, 0.155, 0.145), vec3(0.34, 0.33, 0.31), clamp(hS.g * 1.2 - 0.1, 0.0, 1.0));
  vec3 snowC = vec3(0.86, 0.88, 0.92) * (0.9 + 0.1 * dS);

  float grassMix = clamp(0.5 + (M2.a - 0.5) * 1.6 + (M3.g - 0.5) * 1.2 + cav * 0.6, 0.0, 1.0)
                 * (1.0 - smoothstep(0.14, 0.32, slope)) * (1.0 - smoothstep(1000.0, 1700.0, alt));
  float garr = smoothstep(0.45, 0.7, M4.g * 0.6 + M2.r * 0.6) * smoothstep(60.0, 250.0, alt) * (1.0 - smoothstep(1100.0, 1500.0, alt));
  float alpine = smoothstep(800.0, 1500.0, alt + (M2.r - 0.5) * 500.0);
  float grassCover = smoothstep(0.3, 0.7, grassMix * 0.85 + (hV.b - 0.5) * 1.3 * det + (M4.r - 0.5) * 0.5 + 0.05);
  vec3 ground = mix(soilC * (0.8 + 0.4 * mix(0.5, vS.g, det)), grassC * (0.85 + 0.3 * mix(0.5, vV.b, det)), grassCover);
  // limestone pebbles in bare soil
  ground = mix(ground, vec3(0.30, 0.285, 0.26) * (0.8 + 0.4 * vS.g), smoothstep(0.62, 0.8, hS.g) * det * (1.0 - grassCover * 0.7));
  ground = mix(ground, garrigueC, garr * 0.8);
  ground = mix(ground, alpC, alpine);

  // ---- land use on flat lowlands: fields, olive groves, towns
  float flatL = 1.0 - smoothstep(0.02, 0.07, slope);
  float lowland = (1.0 - smoothstep(150.0, 420.0, alt)) * smoothstep(4.0, 12.0, alt);
  float agri = flatL * lowland * smoothstep(0.5, 0.62, M2.r * 0.55 + M1.a * 0.45 + (M3.a - 0.5) * 0.3);
  float fRough = 0.95, hedge = 0.0;
  vec3 col = ground;
  #ifdef NO_FIELDS
  agri = 0.0;
  #endif
  if (agri > 0.01) {
    vec3 fc = tFields(wp, fw, ground, scrubC, farV, hedge, fRough);
    col = mix(col, mix(fc, scrubC * 1.2, hedge), agri * 0.85);
  }
  // scrub (maquis) coverage: denser in hollows and on the lower hills, patchy
  float vegCov = clamp(0.2 + cav * 1.2 + (M2.b - 0.5) * 1.4 + (M1.b - 0.5) * 1.0 + (M3.r - 0.5) * 0.8, 0.0, 1.0);
  vegCov *= (1.0 - smoothstep(900.0, 1500.0, alt)) * smoothstep(3.0, 10.0, alt) * (1.0 - smoothstep(0.24, 0.45, slope)) * (1.0 - agri * 0.85);
  float vw = mix(0.4, 0.1, det * det);
  float vegDet = smoothstep(1.0 - vegCov - vw, 1.0 - vegCov + vw, hV.b * 0.8 + hS.g * 0.25);
  float vegW = mix(vegCov * 0.75, vegDet, det);
  // near the camera the 3D shrubs take over from the painted scrub (a faint brown litter tint remains)
  col = mix(col, mix(col * vec3(0.72, 0.66, 0.6), scrubC, farV), vegW * mix(0.45, 1.0, farV));

  // forest: holm-oak / pine on the mountain mid-slopes (denser in hollows), pinewoods behind the beaches
  float forest = smoothstep(0.5, 0.68, M1.b * 0.45 + M2.g * 0.45 + cav * 0.9 + (M3.g - 0.5) * 0.25)
               * smoothstep(180.0, 420.0, alt) * (1.0 - smoothstep(1250.0, 1650.0, alt + (M2.a - 0.5) * 300.0));
  forest = max(forest, smoothstep(0.56, 0.7, M2.b * 0.6 + M3.g * 0.5) * smoothstep(2.5, 5.0, alt) * (1.0 - smoothstep(18.0, 40.0, alt)));
  forest *= (1.0 - smoothstep(0.32, 0.5, slope)) * (1.0 - agri);
  vec3 forestC = mix(vec3(0.025, 0.035, 0.017), vec3(0.055, 0.068, 0.032), clamp(vV.b * 0.8 + (M4.g - 0.5) * 0.8 + 0.1, 0.0, 1.0));
  // canopy texture: crowns with gaps at close range
  float crowns = mix(0.85, smoothstep(0.3, 0.55, hV.b * 0.7 + hS.g * 0.4), det * det);
  col = mix(col, mix(col * 0.55, forestC, crowns), forest * mix(0.55, 1.0, farV));

  // towns (per-vertex radial weight + noisy edges)
  float uV = vTX.y;
  float urban = clamp(uV * 1.3 + ((M4.b - 0.5) * 0.9 + (M3.r - 0.5) * 0.6) * step(0.01, uV), 0.0, 1.0);
  urban *= (1.0 - smoothstep(0.08, 0.2, slope)) * smoothstep(1.5, 4.0, alt);
  float uRough = 0.9;
  if (urban > 0.01) {
    vec3 tc = tTownColor(wp, urban, fw, M4, uRough);
    col = mix(col, tc, smoothstep(0.0, 0.25, urban));
  }

  // rock on steep slopes, exposed ridges at altitude, limestone outcrops in the hills
  float rockT = 0.2 - 0.08 * smoothstep(400.0, 1600.0, alt) + (M2.g - 0.5) * 0.12 + (M3.b - 0.5) * 0.05;
  float rockW = smoothstep(rockT - 0.05, rockT + 0.05, slope + (dR - 0.5) * 0.16 - cav * 0.06);
  rockW = max(rockW, smoothstep(0.2, 0.7, -cav) * smoothstep(1400.0, 2600.0, alt) * 0.4);
  rockW = max(rockW, smoothstep(0.64, 0.82, M3.a * 0.6 + dR * 0.5) * smoothstep(0.05, 0.13, slope) * 0.9);
  col = mix(col, rockC, rockW);

  // beach: narrow sand / shingle strip, wet band and a lapping foam line
  float beachTop = 0.7 + 2.0 * M2.r * M2.r;
  float sandW = (1.0 - smoothstep(beachTop - 0.5, beachTop + 0.8, alt + (dD - 0.5) * 0.8)) * (1.0 - smoothstep(0.06, 0.16, slope));
  float shingle = smoothstep(0.55, 0.7, M1.b * 0.7 + M4.a * 0.5);
  vec3 beachC = mix(sandC, shingleC, shingle);
  float runup = 0.2 + 0.45 * (0.5 + 0.5 * sin(tTime * 0.55 + dot(wp, vec2(0.013, 0.021)) + M3.r * 6.0));
  float wetW = (1.0 - smoothstep(runup + 0.05, runup + 0.6 + 0.4 * M2.g, alt)) * (1.0 - smoothstep(0.2, 0.4, slope));
  float foamN = mix(0.5, hD.a * 0.6 + hS.g * 0.5, det);
  float foamW = (1.0 - smoothstep(0.0, 0.12, abs(alt - runup))) * smoothstep(0.35, 0.65, foamN) * (1.0 - smoothstep(0.1, 0.25, slope));
  col = mix(col, beachC, sandW);
  col = mix(col, beachC * vec3(0.45, 0.45, 0.48), wetW);
  col = mix(col, vec3(0.7, 0.72, 0.73), foamW * 0.8);

  // worn ground at emplacements (vehicle tracks, trampled grass)
  float worn = 0.0;
  #ifndef NO_CLEAR
  if (tNClear > 0 && distance(wp, tClearBound.xy) < tClearBound.z)
  for (int i = 0; i < ${MAX_CLEARINGS}; i++) {
    if (i >= tNClear) break;
    vec2 d = wp - tClear[i].xy;
    float r = tClear[i].z;
    float dd = dot(d, d);
    if (dd > r * r * 2.25) continue;
    worn = max(worn, 1.0 - smoothstep(r * 0.5, r * 1.5, sqrt(dd) * (0.85 + 0.3 * mix(0.5, hS.g, det))));
  }
  #endif
  col = mix(col, soilC * vec3(0.78, 0.74, 0.7) * (0.85 + 0.3 * mix(0.5, vS.g, det)), worn * 0.8);

  // snow caps (flatter slopes, lingering in gullies)
  // high, flatter summits only (scattered caps from orbit, not a white maze on every ridge)
  float snowLine = 2650.0 + (M1.g - 0.5) * 700.0 + (M2.r - 0.5) * 250.0 - max(cav, 0.0) * 200.0;
  float snowW = smoothstep(snowLine - 60.0, snowLine + 160.0, alt + (dS - 0.5) * 60.0)
              * (1.0 - smoothstep(0.12 + max(cav, 0.0) * 0.2, 0.26 + max(cav, 0.0) * 0.15, slope + (dR - 0.5) * 0.08));
  col = mix(col, snowC, snowW);

  // broad ridge/valley light variation (sun-bleached ridges, darker gullies)
  col *= clamp(1.0 - cav * 0.3, 0.7, 1.2);
  diffuseColor.rgb = col;

  // ---- normal
  vec3 nGround = tPert(gN, mix(nS, nV, max(vegW, forest) * 0.8), X, Z, 1.0);
  vec3 nW = normalize(mix(nGround, nRockW, rockW));
  nW = normalize(mix(nW, tPert(gN, nD, X, Z, 0.7), sandW * (1.0 - wetW * 0.7)));
  nW = normalize(mix(nW, tPert(gN, nS * 0.25, X, Z, 1.0), max(snowW, urban * 0.7)));
  vec3 tNW = normalize(mix(gN, nW, det));

  // ---- roughness
  float tRough = mix(0.93, 0.82, rockW);
  tRough = mix(tRough, 0.97, vegW);
  tRough = mix(tRough, fRough, agri);
  tRough = mix(tRough, 0.98, forest);
  tRough = mix(tRough, uRough, urban);
  tRough = mix(tRough, 0.9, sandW);
  tRough = mix(tRough, 0.3, wetW);
  tRough = mix(tRough, 0.6, snowW);
  float tSpecK = mix(0.22, 1.0, max(wetW, snowW * 0.6));
`;
