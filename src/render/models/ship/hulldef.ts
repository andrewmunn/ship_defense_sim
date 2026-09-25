import { Curve1D, clamp } from './geom';

/**
 * Vanguard-class hull definition (meters, ship-local: +Z bow, +Y up, y=0 design waterline, origin midships).
 * LOA 155.3, beam 20.1 (deck, flared), WL beam ~18.0, hull draft 6.3, sonar dome 9.4.
 */
export const LOA = 155.3;
export const Z_BOW = LOA / 2; // 77.65 (stem head)
export const Z_STERN = -LOA / 2; // transom
export const Z_STEM_WL = 66.4; // stem at waterline
export const KEEL = -6.3;
export const DOME_BOTTOM = -9.4;
export const TRANSOM_BOTTOM = -0.55;

/** Main deck edge height (sheer line). */
const sheer = new Curve1D([
  [Z_STERN, 4.75],
  [-60, 5.1],
  [-40, 5.6],
  [-20, 6.05],
  [0, 6.5],
  [15, 6.85],
  [30, 7.35],
  [40, 7.8],
  [50, 8.45],
  [60, 9.25],
  [70, 10.05],
  [Z_BOW, 10.75],
]);
/** Main deck edge half-breadth. */
const hbDeckC = new Curve1D([
  [Z_STERN, 8.35],
  [-70, 8.95],
  [-60, 9.45],
  [-45, 9.9],
  [-30, 10.05],
  [20, 10.05],
  [30, 9.95],
  [40, 9.55],
  [50, 8.75],
  [58, 7.7],
  [65, 6.25],
  [70, 4.85],
  [74, 3.2],
  [76.5, 1.6],
  [Z_BOW, 0.0],
]);
/** Waterline half-breadth. */
const hbWLC = new Curve1D([
  [Z_STERN, 6.75],
  [-70, 7.35],
  [-60, 7.95],
  [-45, 8.6],
  [-30, 8.92],
  [-10, 9.0],
  [8, 9.0],
  [20, 8.75],
  [30, 8.05],
  [40, 6.85],
  [48, 5.4],
  [55, 3.75],
  [60, 2.35],
  [63.5, 1.2],
  [Z_STEM_WL, 0.0],
]);
/** Centerline bottom (keel / canoe body / forefoot). */
const keelC = new Curve1D([
  [Z_STERN, TRANSOM_BOTTOM],
  [-70, -1.05],
  [-62, -1.75],
  [-52, -2.9],
  [-40, -4.3],
  [-28, -5.5],
  [-15, -6.2],
  [-8, KEEL],
  [42, KEEL],
  [48, -6.05],
  [53, -5.45],
  [57, -4.6],
  [60.5, -3.4],
  [63.5, -1.95],
  [Z_STEM_WL, 0.0],
]);
/** Superellipse exponent of the underwater section (fullness). */
const pC = new Curve1D([
  [Z_STERN, 5.5],
  [-60, 4.2],
  [-40, 3.9],
  [-20, 4.3],
  [0, 4.6],
  [15, 4.1],
  [30, 3.0],
  [42, 2.3],
  [52, 1.9],
  [60, 1.7],
  [Z_STEM_WL, 1.6],
]);
/** Flare exponent above the waterline (1 = straight, >1 concave flare). */
const qC = new Curve1D([
  [Z_STERN, 1.0],
  [15, 1.0],
  [30, 1.12],
  [45, 1.35],
  [58, 1.6],
  [66, 1.8],
  [Z_BOW, 1.9],
]);
/** Deadrise (y rise per meter of half-breadth at the bottom). */
const drC = new Curve1D([
  [Z_STERN, 0.0],
  [-50, 0.03],
  [0, 0.06],
  [30, 0.12],
  [50, 0.2],
  [Z_STEM_WL, 0.25],
]);

export const deckY = (z: number) => sheer.at(z);
export const hbDeck = (z: number) => Math.max(0, hbDeckC.at(z));
export const hbWL = (z: number) => (z >= Z_STEM_WL ? 0 : Math.max(0, hbWLC.at(z)));
export const keelY = (z: number) => (z >= Z_STEM_WL ? stemY(z) : keelC.at(z));
export const secP = (z: number) => pC.at(z);
export const flareQ = (z: number) => qC.at(z);
export const deadrise = (z: number) => drC.at(z);

/** Stem profile: z of stem as function of height y (0..deck). */
export function stemZ(y: number) {
  const s = clamp(y / deckY(Z_BOW), 0, 1);
  return Z_STEM_WL + (Z_BOW - Z_STEM_WL) * (0.72 * s + 0.28 * s * s);
}
/** Inverse of stemZ (height of stem at given z > Z_STEM_WL). */
export function stemY(z: number) {
  if (z <= Z_STEM_WL) return 0;
  // solve 0.28 s^2 + 0.72 s - f = 0
  const f = clamp((z - Z_STEM_WL) / (Z_BOW - Z_STEM_WL), 0, 1);
  const s = (-0.72 + Math.sqrt(0.72 * 0.72 + 4 * 0.28 * f)) / (2 * 0.28);
  // deckY(Z_BOW) — use constant to avoid recursion drift
  return s * deckY(Z_BOW);
}

/** Camber of the main deck (crown height at centerline). */
export const CAMBER = 0.16;
/** Deck height at (x,z) including camber. */
export function deckAt(x: number, z: number) {
  const hb = Math.max(hbDeck(z), 0.01);
  const t = clamp(Math.abs(x) / hb, 0, 1);
  return deckY(z) + CAMBER * (1 - t * t);
}

/** Hull half-breadth above the waterline at (z, y), 0<=y<=deck. */
export function hullXAbove(z: number, y: number) {
  const y0 = Math.max(0, stemY(z));
  const yd = deckY(z);
  const t = clamp((y - y0) / Math.max(yd - y0, 1e-3), 0, 1);
  const w = hbWL(z), d = hbDeck(z);
  return w + (d - w) * Math.pow(t, flareQ(z));
}
/** Outward slope dx/dy of the hull side at (z,y) above the waterline. */
export function hullSlopeAbove(z: number, y: number) {
  const e = 0.05;
  return (hullXAbove(z, y + e) - hullXAbove(z, y - e)) / (2 * e);
}
/** Hull half-breadth below the waterline (approximate, ignores deadrise). */
export function hullXBelow(z: number, y: number) {
  const yb = keelY(z);
  if (y <= yb) return 0;
  const p = secP(z);
  const r = clamp(y / yb, 0, 1); // 1 at keel, 0 at WL
  return hbWL(z) * Math.pow(1 - Math.pow(r, p), 1 / p);
}
export function hullX(z: number, y: number) {
  return y >= 0 ? hullXAbove(z, y) : hullXBelow(z, y);
}

/** Positions (ship-local) of major fittings, shared between modules. */
export const LAYOUT = {
  gunZ: 47.2,
  vlsFwdZ: 38.6,
  ss01Front: 34.6, // 01-level deckhouse front
  bridgeFront: 29.2,
  fwdFunnelZ: 3.2, // center of base
  aftFunnelZ: -14.6,
  hangarAftZ: -56.4, // hangar doors / flight deck forward edge
  vlsAftZ: -30.2, // center of aft VLS
  lvl01: 9.9,
  lvl02: 12.55,
  lvl03: 15.2,
  bridgeRoof: 18.1,
  lvl05: 20.3,
  hangarRoof: 11.75,
};
