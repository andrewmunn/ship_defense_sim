/**
 * World scale. The planet is shrunk ~6.4x versus Earth ("rule of cool", like KSP):
 * horizons are close enough that over-the-horizon effects are obvious and sea-skimmers
 * pop up over the horizon at ~10–15 km instead of ~25–35 km, while weapons keep real-ish speeds.
 */
export const R_PLANET = 1_000_000; // m
export const GRAVITY = 9.81; // m/s^2 at sea level
export const SPEED_OF_SOUND = 343; // m/s
/** Standard 4/3-earth radar refraction factor. */
export const K_REFRACTION = 4 / 3;
export const RHO0 = 1.225; // kg/m^3 sea level air density
export const SCALE_HEIGHT = 8500; // m
export const SIM_DT = 1 / 120; // fixed physics step (sim seconds)
export const DEG = Math.PI / 180;
export const KNOTS = 0.514444; // m/s per knot
export const NM = 1852; // m per nautical mile
