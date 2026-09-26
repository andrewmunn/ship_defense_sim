import * as THREE from 'three';
import { nameTexture, hullTextures, paintTextures, nonskidTextures, deckAtlas, arrayTextures, hullNumberTexture, draftTexture, netTexture, sootTexture, radomeTextures, flagTexture } from './textures';

/** Shared material cache for the Vanguard-class model (created once, reused by every ship instance). */
let _mats: Record<string, THREE.Material> | null = null;

export function shipMaterials(): Record<string, THREE.Material> {
  if (_mats) return _mats;
  const hull = hullTextures();
  const paint = paintTextures(false);
  const fine = paintTextures(true);
  const ns = nonskidTextures();
  const arr = arrayTextures();
  const rad = radomeTextures();

  const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);

  const deck = std({
    map: deckAtlas(),
    normalMap: ns.normalMap,
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughnessMap: ns.roughnessMap,
    roughness: 0.95,
    metalness: 0.0,
    envMapIntensity: 0.4,
  });
  deck.map!.channel = 1; // unique atlas on uv1; tiled non-skid on uv0

  // Satin haze-gray paint: roughness comes from the maps (~0.62), env reflection ~0.55 for a grazing-angle sheen.
  const PAINT_ENV = 0.55;
  _mats = {
    hull: std({ map: hull.map, roughnessMap: hull.roughnessMap, normalMap: hull.normalMap, normalScale: new THREE.Vector2(0.7, 0.7), roughness: 1, metalness: 0.0, envMapIntensity: PAINT_ENV }),
    paint: std({ map: paint.map, roughnessMap: paint.roughnessMap, normalMap: paint.normalMap, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 1, metalness: 0.0, envMapIntensity: PAINT_ENV }),
    paintFine: std({ map: fine.map, roughnessMap: fine.roughnessMap, normalMap: fine.normalMap, normalScale: new THREE.Vector2(0.4, 0.4), roughness: 1, metalness: 0.0, envMapIntensity: PAINT_ENV }),
    paintDark: std({ color: 0x4d5357, roughness: 0.6, metalness: 0.0, envMapIntensity: 0.5 }),
    deck,
    deckPlain: std({ color: 0x4a4d4f, normalMap: ns.normalMap, roughnessMap: ns.roughnessMap, roughness: 0.95, metalness: 0, envMapIntensity: 0.4 }),
    antifoul: std({ color: 0x62302a, roughness: 0.8, metalness: 0.0, normalMap: fine.normalMap, normalScale: new THREE.Vector2(0.3, 0.3) }),
    dome: std({ color: 0x1e1f21, roughness: 0.6, metalness: 0.0 }),
    bronze: std({ color: 0x8c6b3f, roughness: 0.38, metalness: 1.0, side: THREE.DoubleSide, envMapIntensity: 0.8 }),
    steel: std({ color: 0x6d6f70, roughness: 0.42, metalness: 0.85, envMapIntensity: 0.7 }),
    darkSteel: std({ color: 0x2e3032, roughness: 0.5, metalness: 0.6, envMapIntensity: 0.6 }),
    black: std({ color: 0x141516, roughness: 0.8, metalness: 0.0 }),
    charcoal: std({ color: 0x2b2a28, roughness: 0.9, metalness: 0.1, normalMap: fine.normalMap, normalScale: new THREE.Vector2(0.6, 0.6) }),
    soot: std({ map: sootTexture(), normalMap: fine.normalMap, normalScale: new THREE.Vector2(0.4, 0.4), roughness: 0.85, metalness: 0.0, envMapIntensity: 0.4 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x1b2426, roughness: 0.05, metalness: 0.0, clearcoat: 0.6, clearcoatRoughness: 0.05, envMapIntensity: 0.9 }),
    // bridge windows: tinted, partly see-through to the lit interior, strong sky reflection
    glassBridge: new THREE.MeshPhysicalMaterial({ color: 0x2c3c40, roughness: 0.03, metalness: 0.0, transparent: true, opacity: 0.62, envMapIntensity: 1.2, depthWrite: false }),
    white: std({ color: 0xd6d7d2, roughness: 0.5, metalness: 0.0, envMapIntensity: 0.55 }),
    radome: std({ map: rad.map, normalMap: rad.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.38, metalness: 0.0, envMapIntensity: 0.65 }),
    rubber: std({ color: 0x3f4448, roughness: 0.8, metalness: 0.0 }),
    orange: std({ color: 0xd85a1a, roughness: 0.6, metalness: 0.0 }),
    array: std({ map: arr.map, normalMap: arr.normalMap, roughnessMap: arr.roughnessMap, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 1, metalness: 0.0, envMapIntensity: 0.75 }),
    wire: std({ color: 0x6a7073, roughness: 0.55, metalness: 0.3 }),
    red: std({ color: 0x8a1c14, roughness: 0.55, metalness: 0.0, envMapIntensity: 0.5 }),
    lamp: std({ color: 0xffffff, emissive: 0xfff2d0, emissiveIntensity: 0.4, roughness: 0.3 }),
    flag: std({ map: flagTexture(), side: THREE.DoubleSide, roughness: 0.85, metalness: 0 }),
    // crew figures: vertex-coloured (coveralls, jerseys, skin), one draw call
    crew: std({ color: 0xffffff, vertexColors: true, roughness: 0.85, metalness: 0 }),
    decalNumber: std({
      map: hullNumberTexture(), transparent: true, alphaTest: 0.05, roughness: 0.6, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthWrite: false,
    }),
    decalDraft: std({
      map: draftTexture(), transparent: true, alphaTest: 0.05, roughness: 0.6, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthWrite: false,
    }),
    decalName: std({
      map: nameTexture(), transparent: true, alphaTest: 0.05, roughness: 0.6, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthWrite: false,
    }),
    net: std({ map: netTexture(), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.8, metalness: 0.2 }),
    vlsHatch: std({ color: 0x4a4d50, normalMap: ns.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.85, metalness: 0 }),
    screen: std({ color: 0x0a1418, emissive: 0x2a6f8a, emissiveIntensity: 0.6, roughness: 0.2 }),
    interior: std({ color: 0x6a7276, emissive: 0x2a3034, emissiveIntensity: 0.35, roughness: 0.85, metalness: 0 }),
    helo: std({ color: 0x5f666a, roughness: 0.65, metalness: 0.05 }),
    heloDark: std({ color: 0x3a3e42, roughness: 0.55, metalness: 0.2 }),
  };
  // AO variants (vertex-colour contact darkening) for static merged geometry
  // (the static, merged ship geometry): vertex-colour contact darkening + unique weathering atlas on uv1
  // (the atlas map is attached by vanguard.ts once the streak sources are known).
  for (const k of ['paint', 'paintFine']) {
    const m = (_mats[k] as THREE.MeshStandardMaterial).clone();
    m.vertexColors = true;
    _mats[k + 'AO'] = m;
  }
  for (const m of Object.values(_mats)) {
    const sm = m as THREE.MeshStandardMaterial;
    if (sm.envMapIntensity === 1) sm.envMapIntensity = ENV_INTENSITY;
  }
  return _mats;
}
/** The viewer/game sky PMREM is very bright; ship paint is calibrated with this env intensity. */
export const ENV_INTENSITY = 0.4;
