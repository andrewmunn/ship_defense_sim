/**
 * World scale ("rule of cool", like KSP). Engagement numbers throughout the sim are authored at
 * real-ish magnitudes and wrapped in L() / V() / T(), which compress the fight by WORLD_SCALE:
 *
 *  - lengths ×S   (weapon ranges, coast distance, cruise altitudes, radar power, planet radius)
 *  - speeds  ×√S  and durations ×√S, accelerations unchanged (Froude scaling: gravity stays
 *    9.81, so ballistic arcs, turn circles and gun trajectories keep their shape at 1/S size)
 *
 * Object-sized things are NOT scaled: the ship, missiles, skim heights, warhead radii, the
 * coastal landscape itself. Changing WORLD_SCALE retunes the whole engagement consistently.
 */
export const WORLD_SCALE = 0.5;
const SQ = Math.sqrt(WORLD_SCALE);
/** Engagement-scale length (m, authored at full scale). */
export const L = (m: number) => m * WORLD_SCALE;
/** Engagement-scale speed (m/s, authored at full scale). */
export const V = (ms: number) => ms * SQ;
/** Engagement-scale duration (s, authored at full scale). */
export const T = (s: number) => s * SQ;
/** Drag constants (1/m) scale inversely with length so deceleration keeps pace with the speeds. */
export const DRAG = (k: number) => k / WORLD_SCALE;

/** Planet radius: ~1/13 of Earth at WORLD_SCALE 0.5, so the horizon is a gameplay feature. */
export const R_PLANET = L(1_000_000); // m
export const GRAVITY = 9.81; // m/s^2 at sea level
/** Scaled with the speeds so Mach numbers (HUD, supersonic behaviour) read as authored. */
export const SPEED_OF_SOUND = V(343); // m/s
/** Standard 4/3-earth radar refraction factor. */
export const K_REFRACTION = 4 / 3;
export const RHO0 = 1.225; // kg/m^3 sea level air density
export const SCALE_HEIGHT = L(8500); // m (scaled with the cruise altitudes)

/** Gravitational acceleration (m/s^2) at an altitude: inverse-square falloff from the planet centre. */
export function gravityAt(alt: number) {
  const r = R_PLANET / (R_PLANET + Math.max(alt, -R_PLANET * 0.5));
  return GRAVITY * r * r;
}
/** Air density relative to sea level (isothermal exponential atmosphere, so pressure falls off the same way). */
export function densityRatio(alt: number) {
  return Math.exp(-Math.max(alt, 0) / SCALE_HEIGHT);
}
export const SIM_DT = 1 / 120; // fixed physics step (sim seconds)
export const DEG = Math.PI / 180;
export const KNOTS = 0.514444; // m/s per knot
export const NM = 1852; // m per nautical mile
