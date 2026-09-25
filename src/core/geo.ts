import * as THREE from 'three';
import { R_PLANET, K_REFRACTION } from './constants';

/**
 * World frame: origin at the reference point on the sea surface (the ship's start position),
 * planet center at (0, -R, 0). Map convention: +X = east, -Z = north, +Y = up (at the origin).
 * Bearing θ (clockwise from north) ↔ horizontal direction (sin θ, 0, -cos θ).
 * All simulation math is done in JS doubles.
 */
export const CENTER = new THREE.Vector3(0, -R_PLANET, 0);

const _v = new THREE.Vector3();

export function upAt(p: THREE.Vector3, out = new THREE.Vector3()) {
  return out.copy(p).sub(CENTER).normalize();
}

export function altitude(p: THREE.Vector3) {
  const dx = p.x, dy = p.y + R_PLANET, dz = p.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - R_PLANET;
}

/** Height (y) of the sphere surface above (x, z), precise for |x|,|z| << R. */
export function surfaceY(x: number, z: number) {
  const d2 = x * x + z * z;
  return -d2 / (R_PLANET + Math.sqrt(Math.max(R_PLANET * R_PLANET - d2, 0)));
}

/** Put point p at altitude h along its radial. */
export function setAltitude(p: THREE.Vector3, h: number) {
  _v.copy(p).sub(CENTER);
  const len = _v.length();
  return p.copy(CENTER).addScaledVector(_v, (R_PLANET + h) / len);
}

/** East / North / Up unit vectors at point p. */
export function enuAt(p: THREE.Vector3, e = new THREE.Vector3(), n = new THREE.Vector3(), u = new THREE.Vector3()) {
  upAt(p, u);
  // Global "north pole" axis: the planet axis is chosen so that at the origin north = -Z.
  // Use a pole direction P = (0,0,-1) rotated... simpler: north = projection of -Z onto tangent plane.
  n.set(0, 0, -1).addScaledVector(u, u.z).normalize(); // -Z minus its radial component
  e.crossVectors(n, u).normalize();
  return { e, n, u };
}

/** Horizontal unit direction for a bearing (radians) at point p. */
export function bearingDir(p: THREE.Vector3, bearing: number, out = new THREE.Vector3()) {
  const { e, n } = enuAt(p, _e, _n, _u);
  return out.copy(n).multiplyScalar(Math.cos(bearing)).addScaledVector(e, Math.sin(bearing)).normalize();
}
const _e = new THREE.Vector3(), _n = new THREE.Vector3(), _u = new THREE.Vector3();

/** Bearing (radians, 0..2π) from a to b in a's local frame. */
export function bearingTo(a: THREE.Vector3, b: THREE.Vector3) {
  const { e, n } = enuAt(a, _e, _n, _u);
  _v.copy(b).sub(a);
  let brg = Math.atan2(_v.dot(e), _v.dot(n));
  if (brg < 0) brg += Math.PI * 2;
  return brg;
}

/** Great-circle surface distance between two points (ignoring altitude). */
export function surfaceDistance(a: THREE.Vector3, b: THREE.Vector3) {
  const ua = upAt(a, _e), ub = upAt(b, _n);
  return Math.acos(THREE.MathUtils.clamp(ua.dot(ub), -1, 1)) * R_PLANET;
}

/** Point on the sphere at a given great-circle distance & bearing from origin point p (altitude 0). */
export function destination(p: THREE.Vector3, bearing: number, dist: number, out = new THREE.Vector3()) {
  const u = upAt(p, _u).clone();
  const d = bearingDir(p, bearing, _v).clone();
  const ang = dist / R_PLANET;
  const dir = u.multiplyScalar(Math.cos(ang)).addScaledVector(d, Math.sin(ang));
  return out.copy(CENTER).addScaledVector(dir, R_PLANET);
}

/** Geometric horizon distance for a height, with optional refraction factor. */
export function horizonDist(h: number, k = 1) {
  return Math.sqrt(2 * R_PLANET * k * Math.max(h, 0));
}

/**
 * Radar/optical line-of-sight between two points over a smooth sphere with effective radius k·R.
 * Returns true if the straight line between a and b stays above the (effective) surface.
 */
export function hasLineOfSight(a: THREE.Vector3, b: THREE.Vector3, k = K_REFRACTION, marginM = 0) {
  const ha = Math.max(altitude(a), 0.5), hb = Math.max(altitude(b), 0.5);
  const d = surfaceDistance(a, b);
  return d <= horizonDist(ha, k) + horizonDist(hb, k) - marginM;
}
