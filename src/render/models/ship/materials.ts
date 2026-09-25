import * as THREE from 'three';
import { nameTexture, hullTextures, paintTextures, nonskidTextures, deckAtlas, arrayTextures, hullNumberTexture, draftTexture, netTexture, sootTexture } from './textures';

/** Shared material cache for the Vanguard-class model (created once, reused by every ship instance). */
let _mats: Record<string, THREE.Material> | null = null;

export function shipMaterials(): Record<string, THREE.Material> {
  if (_mats) return _mats;
  const hull = hullTextures();
  const paint = paintTextures(false);
  const fine = paintTextures(true);
  const ns = nonskidTextures();
  const arr = arrayTextures();

  const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);

  const deck = std({
    map: deckAtlas(),
    normalMap: ns.normalMap,
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughnessMap: ns.roughnessMap,
    roughness: 1.0,
    metalness: 0.0,
  });
  deck.map!.channel = 1; // unique atlas on uv1; tiled non-skid on uv0

  _mats = {
    hull: std({ map: hull.map, roughnessMap: hull.roughnessMap, normalMap: hull.normalMap, normalScale: new THREE.Vector2(0.7, 0.7), roughness: 1, metalness: 0.0 }),
    paint: std({ map: paint.map, roughnessMap: paint.roughnessMap, normalMap: paint.normalMap, normalScale: new THREE.Vector2(0.55, 0.55), roughness: 1, metalness: 0.0 }),
    paintFine: std({ map: fine.map, roughnessMap: fine.roughnessMap, normalMap: fine.normalMap, normalScale: new THREE.Vector2(0.4, 0.4), roughness: 0.95, metalness: 0.0 }),
    paintDark: std({ color: 0x4d5357, roughness: 0.75, metalness: 0.0 }),
    deck,
    deckPlain: std({ color: 0x4a4d4f, normalMap: ns.normalMap, roughnessMap: ns.roughnessMap, roughness: 1, metalness: 0 }),
    antifoul: std({ color: 0x62302a, roughness: 0.8, metalness: 0.0, normalMap: fine.normalMap, normalScale: new THREE.Vector2(0.3, 0.3) }),
    dome: std({ color: 0x1e1f21, roughness: 0.6, metalness: 0.0 }),
    bronze: std({ color: 0x8c6b3f, roughness: 0.38, metalness: 1.0, side: THREE.DoubleSide }),
    steel: std({ color: 0x6d6f70, roughness: 0.45, metalness: 0.85 }),
    darkSteel: std({ color: 0x2c2e30, roughness: 0.55, metalness: 0.6 }),
    black: std({ color: 0x141516, roughness: 0.8, metalness: 0.0 }),
    soot: std({ map: sootTexture(), roughness: 0.9, metalness: 0.0 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x1b2426, roughness: 0.05, metalness: 0.0, clearcoat: 0.6, clearcoatRoughness: 0.05 }),
    white: std({ color: 0xd6d7d2, roughness: 0.55, metalness: 0.0 }),
    radome: std({ color: 0xdcdcd5, roughness: 0.5, metalness: 0.0 }),
    rubber: std({ color: 0x3f4448, roughness: 0.8, metalness: 0.0 }),
    orange: std({ color: 0xd85a1a, roughness: 0.6, metalness: 0.0 }),
    array: std({ map: arr.map, normalMap: arr.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.85, metalness: 0.0 }),
    wire: std({ color: 0x6a7073, roughness: 0.55, metalness: 0.3 }),
    red: std({ color: 0x8a1c14, roughness: 0.6, metalness: 0.0 }),
    lamp: std({ color: 0xffffff, emissive: 0xfff2d0, emissiveIntensity: 0.4, roughness: 0.3 }),
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
    interior: std({ color: 0x5c6266, roughness: 0.85, metalness: 0 }),
    helo: std({ color: 0x5f666a, roughness: 0.65, metalness: 0.05 }),
    heloDark: std({ color: 0x3a3e42, roughness: 0.55, metalness: 0.2 }),
  };
  // AO variants (vertex-colour contact darkening) for static merged geometry
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
export const ENV_INTENSITY = 0.25;
