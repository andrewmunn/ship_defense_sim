import { fbm2, ridged2 } from '../core/noise';

/**
 * Coastal landmass. Defined over world XZ (which approximates surface coordinates near the origin).
 * The coast runs perpendicular to `bearing` at `distance` from the origin.
 */
export class Terrain {
  cx = 0;
  cz = -1;
  constructor(public bearing = (40 * Math.PI) / 180, public distance = 45000) {
    this.set(bearing, distance);
  }
  set(bearing: number, distance: number) {
    this.bearing = bearing;
    this.distance = distance;
    this.cx = Math.sin(bearing);
    this.cz = -Math.cos(bearing);
  }
  /** Signed inland distance (m): >0 on land (before height shaping). */
  inland(x: number, z: number) {
    const along = x * -this.cz + z * this.cx;
    const s = x * this.cx + z * this.cz - this.distance;
    const wig = (fbm2(along / 22000, 3.1, 4, 5) - 0.5) * 14000 + (fbm2(along / 4000, 7.7, 3, 9) - 0.5) * 2200;
    return s + wig;
  }
  /** Height above sea level (m); negative = seabed (not rendered). */
  height(x: number, z: number) {
    const s = this.inland(x, z);
    if (s < -3000) return -50;
    const along = x * -this.cz + z * this.cx;
    const u = along / 1000, v = s / 1000;
    const beach = Math.min(1, Math.max(0, s / 600));
    const hills = fbm2(u / 6, v / 6, 5, 21) * 260 * smooth(0, 4000, s);
    const mtnMask = smooth(5000, 26000, s) * (0.55 + 0.75 * fbm2(u / 30, v / 30, 3, 40));
    const mtn = ridged2(u / 14, v / 14, 6, 33) * 2600 * mtnMask;
    let h = beach * 6 + hills + mtn + (s < 0 ? s * 0.02 : 0);
    // islands offshore
    if (s < 0) {
      const isl = fbm2(u / 3.5, v / 3.5, 4, 77);
      const ih = (isl - 0.72) * 1400 * smooth(-3000, -600, s);
      h = Math.max(h, ih);
    }
    return h;
  }
}
function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
