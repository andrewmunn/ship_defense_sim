import * as THREE from 'three';
import { ENV_INTENSITY } from '../ship/materials';
import { camoTextures, grimeTextures, rubberTextures, canisterTextures, decalTexture, DUST_RGB } from './textures';

/**
 * Shared TEL materials (module-level cache; every TEL instance reuses them).
 *
 * Several materials get a small shader patch that blends in dust/mud toward the ground
 * (object-space height, so it follows the vehicle wherever it is placed) and darkens
 * downward-facing surfaces. The patch chains to Material.prototype.onBeforeCompile so the
 * game's global atmosphere/fog hook keeps working.
 */

export type TelMats = Record<string, THREE.Material>;

const DUST_COL = new THREE.Color().setRGB(DUST_RGB[0] / 255, DUST_RGB[1] / 255, DUST_RGB[2] / 255, THREE.SRGBColorSpace);

const NOISE_GLSL = /* glsl */ `
float telHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float telNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(telHash(i + vec3(0,0,0)), telHash(i + vec3(1,0,0)), f.x), mix(telHash(i + vec3(0,1,0)), telHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(telHash(i + vec3(0,0,1)), telHash(i + vec3(1,0,1)), f.x), mix(telHash(i + vec3(0,1,1)), telHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
`;

/**
 * dust: x = height where dust is full, y = height where it fades out, z = max amount, w = underside darkening.
 * yOffset: added to object-space y (for meshes whose origin is not at ground level).
 */
function addDust(m: THREE.MeshStandardMaterial, dust: [number, number, number, number], yOffset = 0) {
  const uDust = { value: new THREE.Vector4(...dust) };
  const uDustCol = { value: DUST_COL };
  const uDustOff = { value: yOffset };
  m.onBeforeCompile = function (shader, renderer) {
    const base = (THREE.Material.prototype as any).onBeforeCompile;
    if (base && base !== m.onBeforeCompile) base.call(this, shader, renderer);
    shader.uniforms.uTelDust = uDust;
    shader.uniforms.uTelDustCol = uDustCol;
    shader.uniforms.uTelDustOff = uDustOff;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTelPos;\nvarying vec3 vTelN;\nuniform float uTelDustOff;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTelPos = transformed + vec3(0.0, uTelDustOff, 0.0);\nvTelN = objectNormal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTelPos;\nvarying vec3 vTelN;\nuniform vec4 uTelDust;\nuniform vec3 uTelDustCol;\n' + NOISE_GLSL)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float telN1 = telNoise(vTelPos * vec3(2.3, 5.0, 2.3));
        float telN2 = telNoise(vTelPos * vec3(9.0, 14.0, 9.0));
        float telH = vTelPos.y + (telN1 - 0.5) * 0.55 + (telN2 - 0.5) * 0.18;
        float telDust = (1.0 - smoothstep(uTelDust.x, uTelDust.y, telH)) * uTelDust.z;
        // settled dust on up-facing surfaces too
        telDust = max(telDust, smoothstep(0.6, 0.95, vTelN.y) * smoothstep(0.45, 0.85, telN1) * uTelDust.z * 0.2);
        diffuseColor.rgb = mix(diffuseColor.rgb, uTelDustCol * (0.85 + 0.3 * telN2), telDust);
        diffuseColor.rgb *= mix(1.0, 1.0 - uTelDust.w, smoothstep(-0.2, -0.9, vTelN.y));`
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.97, telDust);');
  };
  m.customProgramCacheKey = () => 'tel-dust-v1';
  return m;
}

let _mats: TelMats | null = null;

export function telMaterials(): TelMats {
  if (_mats) return _mats;
  const camo = camoTextures();
  const grime = grimeTextures();
  const rub = rubberTextures();
  const can = canisterTextures();
  const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);
  const n = (s: number) => new THREE.Vector2(s, s);

  _mats = {
    // disruptive camo body paint (box-projected, tile = CAMO_TILE m)
    camo: addDust(std({ map: camo.map, roughnessMap: camo.roughnessMap, normalMap: camo.normalMap, normalScale: n(0.5), roughness: 1, metalness: 0 }), [0.25, 1.25, 0.55, 0.45]),
    // same paint on the rack (rack origin is on the hinge ~1.85 m above ground)
    camoRack: addDust(std({ map: camo.map, roughnessMap: camo.roughnessMap, normalMap: camo.normalMap, normalScale: n(0.5), roughness: 1, metalness: 0 }), [0.25, 1.25, 0.4, 0.4], 1.85),
    canister: addDust(std({ map: can.map, roughnessMap: can.roughnessMap, normalMap: can.normalMap, normalScale: n(0.45), roughness: 1, metalness: 0 }), [0.35, 1.7, 0.4, 0.3], 1.85),
    // chassis / running gear: dark olive-brown painted steel with grime
    chassis: addDust(std({ color: 0x4a4636, map: grime.map, roughnessMap: grime.roughnessMap, normalMap: grime.normalMap, normalScale: n(0.6), roughness: 1, metalness: 0.15 }), [0.2, 1.1, 0.6, 0.35]),
    chassisRack: addDust(std({ color: 0x4a4636, map: grime.map, roughnessMap: grime.roughnessMap, normalMap: grime.normalMap, normalScale: n(0.6), roughness: 1, metalness: 0.15 }), [0.3, 1.3, 0.5, 0.35], 1.85),
    // olive wheel paint
    wheel: addDust(std({ color: 0x5a5a3c, map: grime.map, roughnessMap: grime.roughnessMap, normalMap: grime.normalMap, normalScale: n(0.5), roughness: 1, metalness: 0.1 }), [0.1, 0.9, 0.25, 0.1], 0.7),
    rubber: std({ map: rub.map, roughnessMap: rub.roughnessMap, normalMap: rub.normalMap, normalScale: n(0.4), roughness: 1, metalness: 0 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x07090a, roughness: 0.1, metalness: 0.0, envMapIntensity: ENV_INTENSITY * 0.8 }),
    chrome: std({ color: 0xd4d7da, roughness: 0.14, metalness: 1.0 }),
    steel: std({ color: 0x6f6d66, roughness: 0.5, metalness: 0.8, map: grime.map }),
    darkSteel: std({ color: 0x2f2e2b, roughness: 0.6, metalness: 0.55, map: grime.map }),
    black: std({ color: 0x151514, roughness: 0.85, metalness: 0.0 }),
    rubberSeal: std({ color: 0x1a1a19, roughness: 0.9, metalness: 0.0 }),
    lamp: std({ color: 0xe8e8e0, emissive: 0xfff1d0, emissiveIntensity: 0.15, roughness: 0.15, metalness: 0.2 }),
    lampAmber: std({ color: 0xc07818, emissive: 0x6a3a08, emissiveIntensity: 0.3, roughness: 0.2 }),
    lampRed: std({ color: 0x8a1810, emissive: 0x3a0804, emissiveIntensity: 0.4, roughness: 0.2 }),
    cover: std({ color: 0x6b6a52, roughness: 0.85, metalness: 0, map: grime.map, normalMap: grime.normalMap, normalScale: n(0.4) }),
    deck: std({ color: 0x5e5846, roughness: 1, metalness: 0, map: grime.map, roughnessMap: grime.roughnessMap, normalMap: grime.normalMap, normalScale: n(0.8) }),
    // erector ram barrels (no height dust: their origin moves with the ram)
    ramPaint: std({ color: 0x4f4a38, map: grime.map, roughnessMap: grime.roughnessMap, normalMap: grime.normalMap, normalScale: n(0.5), roughness: 1, metalness: 0.15 }),
    net: std({ color: 0x55573a, roughness: 1, metalness: 0, map: grime.map, normalMap: grime.normalMap, normalScale: n(1.5) }),
    red: std({ color: 0x7c1a12, roughness: 0.5, metalness: 0 }),
    wood: std({ color: 0x6b5236, roughness: 0.9, metalness: 0 }),
    exhaust: std({ color: 0x3a3029, roughness: 0.85, metalness: 0.4, map: grime.map }),
    decal: std({
      map: decalTexture(), transparent: true, alphaTest: 0.05, roughness: 0.8, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthWrite: false,
    }),
  };
  for (const m of Object.values(_mats)) {
    const sm = m as THREE.MeshStandardMaterial;
    if (sm.envMapIntensity === 1) sm.envMapIntensity = ENV_INTENSITY;
  }
  return _mats;
}
