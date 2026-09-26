import { Terrain } from '../../sim/terrain';
import { R_PLANET } from '../../core/constants';
import { fbm2 } from '../../core/noise';

/**
 * CPU terrain chunk generation. Runs inside Web Workers (see worker.ts) and, as a fallback,
 * on the main thread. Pure math — no three.js imports so the worker bundle stays small.
 *
 * Chunk space: the quadtree lives in coast-aligned coordinates
 *   a = along-coast (m), c = across (m, from the origin toward inland).
 * World: x = a*(-cz) + c*cx, z = a*cx + c*cz  (cx,cz = unit coast normal, see Terrain).
 * A vertex at (x,z) sits at the sphere surface point above (x,z), displaced by h along the local up —
 * identical to geo.setAltitude(), which the sim uses to place launchers.
 */

export interface GenParams {
  bearing: number;
  distance: number;
  /** Region extent in chunk space. Land fades into the sea near the region edges. */
  a0: number;
  a1: number;
  c0: number;
  c1: number;
  /** Macro texture read back from the GPU (RGBA8, macroSize²) for CPU land use. */
  macro?: Uint8Array | null;
  macroSize?: number;
  /** Town discs [x, z, radius, size]. */
  towns?: number[][];
}

export interface ChunkJob {
  id: number;
  a0: number;
  c0: number;
  size: number;
  n: number;
  /** Also compute large-scale sun-horizon angles (8 azimuths). */
  horizon: boolean;
}

export interface ChunkResult {
  id: number;
  /** Positions relative to `origin` (grid (n+1)^2 then 4*(n+1) skirt vertices). */
  pos: Float32Array;
  nrm: Float32Array;
  /** uvx, uvz (world x/z minus a multiple of UV_PERIOD), h (m), cavity (-1..1). */
  tex: Float32Array;
  /**
   * Per-vertex bytes (stride EXT_STRIDE): [0..7] horizon elevation (sin) for 8 azimuths, 0..255 → 0..HOR_MAX_SIN;
   * [8] urban (town) weight; [9..11] spare.
   */
  ext: Uint8Array;
  origin: [number, number, number];
  hMin: number;
  hMax: number;
  /** Estimated max geometric error of this chunk vs. the true surface (m). */
  err: number;
  ms: number;
}

/** UV attribute period (m): every detail texture tile size must divide this. */
export const UV_PERIOD = 1024;
/** Heights below this are clamped (hidden under the opaque ocean anyway). */
export const MIN_RENDER_H = -12;
/** Horizon azimuth count (fixed; shader interpolates). */
export const HOR_DIRS = 8;
export const EXT_STRIDE = 12;
export const HOR_MAX_SIN = 0.5;

const R = R_PLANET;

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class ChunkGenerator {
  terrain: Terrain;
  cx: number;
  cz: number;
  constructor(public p: GenParams) {
    this.terrain = new Terrain(p.bearing, p.distance);
    this.cx = this.terrain.cx;
    this.cz = this.terrain.cz;
  }

  toX(a: number, c: number) {
    return a * -this.cz + c * this.cx;
  }
  toZ(a: number, c: number) {
    return a * this.cx + c * this.cz;
  }

  /** Render height at chunk-space (a,c): Terrain.height() plus a fade to sea at the region border. */
  heightAC(a: number, c: number) {
    const x = this.toX(a, c), z = this.toZ(a, c);
    const h = this.terrain.height(x, z);
    const p = this.p;
    const edge = Math.min(a - p.a0, p.a1 - a, p.c1 - c);
    if (edge > 42000) return h;
    const wig = (fbm2(a / 16000, c / 16000, 3, 91) - 0.5) * 22000;
    const f = smoothstep(11000, 30000, edge + wig);
    return h * f + -60 * (1 - f);
  }

  gen(job: ChunkJob): ChunkResult {
    const t0 = performance.now();
    const { n, size } = job;
    const h = size / n;
    const G = n + 3; // with 1-sample border
    const H = new Float64Array(G * G);
    for (let j = 0; j < G; j++) {
      const c = job.c0 + (j - 1) * h;
      // underwater detail is invisible (opaque ocean): clamp so it neither drives LOD nor normals
      for (let i = 0; i < G; i++) H[j * G + i] = Math.max(this.heightAC(job.a0 + (i - 1) * h, c), MIN_RENDER_H);
    }
    const nv = (n + 1) * (n + 1);
    const ns = 4 * (n + 1);
    const pos = new Float32Array((nv + ns) * 3);
    const nrm = new Float32Array((nv + ns) * 3);
    const tex = new Float32Array((nv + ns) * 4);
    const ext = new Uint8Array((nv + ns) * EXT_STRIDE);

    const cx = this.cx, cz = this.cz;
    const Tx = -cz, Tz = cx; // along
    const Nx = cx, Nz = cz; // across
    const am = job.a0 + size / 2, cm = job.c0 + size / 2;
    const ox = this.toX(am, cm), oz = this.toZ(am, cm);
    const oy = surfaceY(ox, oz);
    const uox = Math.floor(ox / UV_PERIOD) * UV_PERIOD, uoz = Math.floor(oz / UV_PERIOD) * UV_PERIOD;

    // cavity scales (fixed world scale where possible so LOD switches don't pop)
    const D1 = Math.max(90, 1.5 * h), D2 = Math.max(600, 1.5 * h);
    let hMin = Infinity, hMax = -Infinity, err = 0;

    for (let j = 0; j <= n; j++) {
      const c = job.c0 + j * h;
      for (let i = 0; i <= n; i++) {
        const a = job.a0 + i * h;
        const k = j * (n + 1) + i;
        const hb = H[(j + 1) * G + i + 1];
        if (hb < hMin) hMin = hb;
        if (hb > hMax) hMax = hb;
        // error vs. the parent's (2h) interpolation
        const io = i & 1, jo = j & 1;
        if (io || jo) {
          let ip: number;
          const g = (di: number, dj: number) => H[(j + 1 + dj) * G + i + 1 + di];
          if (io && !jo) ip = (g(-1, 0) + g(1, 0)) * 0.5;
          else if (!io && jo) ip = (g(0, -1) + g(0, 1)) * 0.5;
          else ip = (g(-1, -1) + g(1, 1) + g(-1, 1) + g(1, -1)) * 0.25;
          const e = Math.abs(hb - ip);
          if (e > err) err = e;
        }
        const x = a * Tx + c * Nx, z = a * Tz + c * Nz;
        const by = surfaceY(x, z);
        const ux = x / R, uy = (by + R) / R, uz = z / R;
        const hv = Math.max(hb, MIN_RENDER_H);
        pos[k * 3] = x + ux * hv - ox;
        pos[k * 3 + 1] = by + uy * hv - oy;
        pos[k * 3 + 2] = z + uz * hv - oz;
        // normal
        const dha = (H[(j + 1) * G + i + 2] - H[(j + 1) * G + i]) / (2 * h);
        const dhc = (H[(j + 2) * G + i + 1] - H[j * G + i + 1]) / (2 * h);
        // tangents projected onto the local tangent plane
        const td = Tx * ux + Tz * uz, nd = Nx * ux + Nz * uz;
        const tax = Tx - ux * td, tay = -uy * td, taz = Tz - uz * td;
        const tcx = Nx - ux * nd, tcy = -uy * nd, tcz = Nz - uz * nd;
        let nx = ux - dha * tax - dhc * tcx;
        let ny = uy - dha * tay - dhc * tcy;
        let nz = uz - dha * taz - dhc * tcz;
        const L = Math.hypot(nx, ny, nz);
        nrm[k * 3] = nx / L;
        nrm[k * 3 + 1] = ny / L;
        nrm[k * 3 + 2] = nz / L;
        // cavity (positive = valley / concave)
        const c1 = (this.heightAC(a + D1, c) + this.heightAC(a - D1, c) + this.heightAC(a, c + D1) + this.heightAC(a, c - D1)) * 0.25 - hb;
        const c2 = (this.heightAC(a + D2 * 0.7071, c + D2 * 0.7071) + this.heightAC(a - D2 * 0.7071, c - D2 * 0.7071) + this.heightAC(a - D2 * 0.7071, c + D2 * 0.7071) + this.heightAC(a + D2 * 0.7071, c - D2 * 0.7071)) * 0.25 - hb;
        const cav = Math.tanh((c1 / D1) * 5 + (c2 / D2) * 5);
        tex[k * 4] = x - uox;
        tex[k * 4 + 1] = z - uoz;
        tex[k * 4 + 2] = hb;
        tex[k * 4 + 3] = cav;
      }
    }
    if (job.horizon) this.horizons(job, H, G, ext);
    this.urban(job, ext);

    // Error of THIS chunk ≈ half the error of the parent at the same points (fractal terrain),
    // with a floor for chunks that straddle the coastline (keeps the shore shape crisp).
    let e = err * 0.6;
    // Discontinuities in the height function (e.g. offshore islands cut off at the coast line) never
    // converge under refinement: cap the error so they stop at ~2 px triangles instead of max depth.
    e = Math.min(e, h * 0.5);
    if (hMin < 8 && hMax > -6) e = Math.max(e, h * 0.08);
    // Islands can hide between coarse samples: potential-land nodes near the coast get a floor.
    const sNear = job.c0 + size - this.p.distance; // max nominal inland distance of this node
    if (hMax < -3 && sNear > -24000 && h > 20) e = Math.max(e, h * 0.1);

    // skirts: edge vertices duplicated and dropped along the local up
    const skirt = Math.max(3, h * 1.2, e * 3);
    let s = nv;
    const edge = (i: number, j: number) => {
      const k = j * (n + 1) + i;
      const x = pos[k * 3] + ox, y = pos[k * 3 + 1] + oy, z = pos[k * 3 + 2] + oz;
      const L = Math.hypot(x, y + R, z);
      pos[s * 3] = pos[k * 3] - (x / L) * skirt;
      pos[s * 3 + 1] = pos[k * 3 + 1] - ((y + R) / L) * skirt;
      pos[s * 3 + 2] = pos[k * 3 + 2] - (z / L) * skirt;
      for (let q = 0; q < 3; q++) nrm[s * 3 + q] = nrm[k * 3 + q];
      for (let q = 0; q < 4; q++) tex[s * 4 + q] = tex[k * 4 + q];
      for (let q = 0; q < EXT_STRIDE; q++) ext[s * EXT_STRIDE + q] = ext[k * EXT_STRIDE + q];
      s++;
    };
    for (let i = 0; i <= n; i++) edge(i, 0);
    for (let i = 0; i <= n; i++) edge(i, n);
    for (let j = 0; j <= n; j++) edge(0, j);
    for (let j = 0; j <= n; j++) edge(n, j);

    return { id: job.id, pos, nrm, tex, ext, origin: [ox, oy, oz], hMin, hMax, err: e, ms: performance.now() - t0 };
  }

  /** Per-vertex town weight (radial falloff, the shader adds edge noise and the street pattern). */
  private urban(job: ChunkJob, out: Uint8Array) {
    const towns = this.p.towns;
    if (!towns || !towns.length) return;
    const n = job.n, h = job.size / n;
    // cull towns against the chunk
    const x0 = this.toX(job.a0 + job.size / 2, job.c0 + job.size / 2), z0 = this.toZ(job.a0 + job.size / 2, job.c0 + job.size / 2);
    const rad = job.size * 0.7072;
    const near = towns.filter((t) => Math.hypot(t[0] - x0, t[1] - z0) < t[2] + rad);
    if (!near.length) return;
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) {
        const a = job.a0 + i * h, c = job.c0 + j * h;
        const x = this.toX(a, c), z = this.toZ(a, c);
        let u = 0;
        for (const t of near) {
          const dx = x - t[0], dz = z - t[1];
          let d = Math.hypot(dx, dz);
          if (d > t[2] * 1.6) continue;
          // irregular outline: lobes + elongation along the coast
          const th = Math.atan2(dz, dx);
          const ph = t[0] * 0.0013 + t[1] * 0.0007;
          const along = Math.abs(dx * -this.cz + dz * this.cx) / Math.max(d, 1);
          d /= (1 + 0.35 * Math.sin(3 * th + ph) + 0.2 * Math.sin(5 * th + ph * 2.3) + 0.12 * Math.sin(8 * th + ph * 4.1)) * (0.8 + 0.45 * along);
          if (d < t[2]) u = Math.max(u, 1 - smoothstep(t[2] * 0.1, t[2], d));
        }
        out[(j * (n + 1) + i) * EXT_STRIDE + 8] = Math.round(u * 255);
      }
  }

  /**
   * Large-scale terrain self-shadowing: for each vertex, the max elevation angle (sin) of the terrain
   * horizon in 8 azimuths (computed on a coarse sub-grid and bilinearly upsampled). Planet curvature
   * lowers distant terrain by d²/2R.
   */
  private horizons(job: ChunkJob, H: Float64Array, G: number, out: Uint8Array) {
    const n = job.n;
    const h = job.size / n;
    const step = n >= 32 ? 4 : n >= 16 ? 2 : 1;
    const m = n / step;
    const coarse = new Float32Array((m + 1) * (m + 1) * HOR_DIRS);
    // march distances (m): exponential
    const dists: number[] = [];
    for (let d = Math.max(40, h * 1.5); d < 30000; d *= 1.32) dists.push(d);
    const cosA: number[] = [], sinA: number[] = [];
    for (let q = 0; q < HOR_DIRS; q++) {
      const ang = (q / HOR_DIRS) * Math.PI * 2;
      cosA.push(Math.cos(ang));
      sinA.push(Math.sin(ang));
    }
    for (let jj = 0; jj <= m; jj++) {
      for (let ii = 0; ii <= m; ii++) {
        const i = ii * step, j = jj * step;
        const a = job.a0 + i * h, c = job.c0 + j * h;
        const h0 = Math.max(H[(j + 1) * G + i + 1], 0) + 1.5;
        for (let q = 0; q < HOR_DIRS; q++) {
          let best = 0;
          for (const d of dists) {
            // azimuth measured in world x/z: dir = (cos, sin) in (x, z) → convert to (a, c)
            const dx = cosA[q], dz = sinA[q];
            const da = dx * -this.cz + dz * this.cx;
            const dc = dx * this.cx + dz * this.cz;
            const ht = this.heightAC(a + da * d, c + dc * d) - (d * d) / (2 * R);
            const sn = (ht - h0) / Math.hypot(d, ht - h0);
            if (sn > best) best = sn;
            // early out: even a 4800 m peak can't beat the current angle further out
            if ((4800 - h0) / d < best) break;
          }
          coarse[(jj * (m + 1) + ii) * HOR_DIRS + q] = best;
        }
      }
    }
    const put = (k: number, i: number, j: number) => {
      const fi = i / step, fj = j / step;
      const i0 = Math.min(Math.floor(fi), m - 1), j0 = Math.min(Math.floor(fj), m - 1);
      const tx = fi - i0, ty = fj - j0;
      for (let q = 0; q < HOR_DIRS; q++) {
        const v00 = coarse[(j0 * (m + 1) + i0) * HOR_DIRS + q], v10 = coarse[(j0 * (m + 1) + i0 + 1) * HOR_DIRS + q];
        const v01 = coarse[((j0 + 1) * (m + 1) + i0) * HOR_DIRS + q], v11 = coarse[((j0 + 1) * (m + 1) + i0 + 1) * HOR_DIRS + q];
        const v = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
        out[k * EXT_STRIDE + q] = Math.min(255, Math.round((v / HOR_MAX_SIN) * 255));
      }
    };
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) put(j * (n + 1) + i, i, j);
  }
}

/** (method body lives on the prototype below) */
export function surfaceY(x: number, z: number) {
  const d2 = x * x + z * z;
  return -d2 / (R + Math.sqrt(Math.max(R * R - d2, 0)));
}

// ------------------------------------------------------------------ land use (CPU mirror of the shader)

const f32 = Math.fround;
const K1031 = f32(0.1031);
const K3333 = f32(33.33);
function fr32(x: number) {
  return f32(x - Math.floor(x));
}
/** Float32 port of the shader's tH21 hash (material.ts) so fields/orchards line up with the ground. */
export function tH21(px: number, py: number) {
  px = f32(px);
  py = f32(py);
  let x = fr32(f32(px * K1031)), y = fr32(f32(py * K1031)), z = fr32(f32(px * K1031));
  const d = f32(f32(f32(x * f32(y + K3333)) + f32(y * f32(z + K3333))) + f32(z * f32(x + K3333)));
  x = f32(x + d);
  y = f32(y + d);
  z = f32(z + d);
  return fr32(f32(f32(x + y) * z));
}

export interface LandUseSample {
  agri: number;
  /** -1 none, 0 stubble, 1 ploughed, 2 green crop, 3 olive grove, 4 fallow */
  field: number;
  vegCov: number;
  grassMix: number;
  urban: number;
  forest: number;
}

/**
 * Mirrors the terrain shader's land-use masks (macro texture read back from the GPU), so the 3D
 * scatter agrees with the painted ground: no shrubs in ploughed fields, olive trees exactly on the
 * grove dots, shrub density following the scrub mask.
 */
export class LandUse {
  constructor(private macro: Uint8Array | null, private size: number, private towns: number[][]) {}

  /** Bilinear, repeat-wrapped sample of the macro texture (0..1) into out[0..3]. */
  macroAt(u: number, v: number, out: number[]) {
    const m = this.macro;
    if (!m) {
      out[0] = out[1] = out[2] = out[3] = 0.5;
      return out;
    }
    const S = this.size;
    const x = u * S - 0.5, y = v * S - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const tx = x - x0, ty = y - y0;
    const i0 = ((x0 % S) + S) % S, i1 = (i0 + 1) % S;
    const j0 = ((y0 % S) + S) % S, j1 = (j0 + 1) % S;
    for (let c = 0; c < 4; c++) {
      const a = m[(j0 * S + i0) * 4 + c], b = m[(j0 * S + i1) * 4 + c];
      const cc = m[(j1 * S + i0) * 4 + c], d = m[(j1 * S + i1) * 4 + c];
      out[c] = ((a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + d * tx) * ty) / 255;
    }
    return out;
  }

  private M1 = [0, 0, 0, 0];
  private M2 = [0, 0, 0, 0];
  private M3 = [0, 0, 0, 0];
  private M4 = [0, 0, 0, 0];

  sample(x: number, z: number, alt: number, slope: number, cav: number): LandUseSample {
    const M1 = this.macroAt(x / 23040, z / 23040, this.M1);
    const M2 = this.macroAt(x / 3170 + 0.5, z / 3170 + 0.5, this.M2);
    const M3 = this.macroAt(x / 512 + 0.25, z / 512 + 0.25, this.M3);
    const M4 = this.macroAt(x / 128 + 0.6, z / 128 + 0.6, this.M4);
    const flatL = 1 - smoothstep(0.02, 0.07, slope);
    const lowland = (1 - smoothstep(150, 420, alt)) * smoothstep(4, 12, alt);
    const agri = flatL * lowland * smoothstep(0.5, 0.62, M2[0] * 0.55 + M1[3] * 0.45 + (M3[3] - 0.5) * 0.3);
    const field = agri > 0.5 ? this.fieldType(x, z) : -1;
    let vegCov = Math.min(1, Math.max(0, 0.2 + cav * 1.2 + (M2[2] - 0.5) * 1.4 + (M1[2] - 0.5) * 1.0 + (M3[0] - 0.5) * 0.8));
    vegCov *= (1 - smoothstep(900, 1500, alt)) * smoothstep(3, 10, alt) * (1 - smoothstep(0.24, 0.45, slope)) * (1 - agri * 0.85);
    const grassMix =
      Math.min(1, Math.max(0, 0.5 + (M2[3] - 0.5) * 1.6 + (M3[1] - 0.5) * 1.2 + cav * 0.6)) * (1 - smoothstep(0.14, 0.32, slope)) * (1 - smoothstep(1000, 1700, alt));
    let urban = 0;
    for (const t of this.towns) {
      const dx = x - t[0], dz = z - t[1];
      const d2 = dx * dx + dz * dz;
      if (d2 > t[2] * t[2]) continue;
      urban = Math.max(urban, 1 - smoothstep(t[2] * 0.15, t[2], Math.sqrt(d2) * (0.8 + 0.4 * M4[2])));
    }
    urban *= (1 - smoothstep(0.08, 0.2, slope)) * smoothstep(1.5, 4, alt);
    let forest =
      smoothstep(0.5, 0.68, M1[2] * 0.45 + M2[1] * 0.45 + cav * 0.9 + (M3[1] - 0.5) * 0.25) * smoothstep(180, 420, alt) * (1 - smoothstep(1250, 1650, alt + (M2[3] - 0.5) * 300));
    forest = Math.max(forest, smoothstep(0.56, 0.7, M2[2] * 0.6 + M3[1] * 0.5) * smoothstep(2.5, 5, alt) * (1 - smoothstep(18, 40, alt)));
    forest *= (1 - smoothstep(0.32, 0.5, slope)) * (1 - agri);
    return { agri, field, vegCov, grassMix, urban, forest };
  }

  /** Field system geometry (mirrors tFields). */
  fieldAt(x: number, z: number) {
    const cx = Math.floor(x / 2400), cz = Math.floor(z / 2400);
    const lx = x - (cx + 0.5) * 2400, lz = z - (cz + 0.5) * 2400;
    const ang = tH21(cx + 7.1, cz + 7.1) * 3.14159;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    let qx = ca * lx - sa * lz;
    const qy = sa * lx + ca * lz;
    let fx = 60 + 70 * tH21(cx + 1.3, cz + 1.3);
    const fy = 110 + 120 * tH21(cx + 2.9, cz + 2.9);
    const row = Math.floor(qy / fy);
    const rh = tH21(row, cx + cz * 17);
    fx *= 0.55 + 0.9 * rh;
    const off = rh * 3.7 * fx;
    qx += off;
    const idx = Math.floor(qx / fx), idy = Math.floor(qy / fy);
    const r = tH21(idx + cx * 31.7, idy + cz * 31.7);
    const r2 = tH21(idx * 1.7 + cx * 3.1 + 5, idy * 1.7 + cz * 3.1 + 5);
    const type = r < 0.2 ? 0 : r < 0.31 ? 1 : r < 0.37 ? 2 : r < 0.75 ? 3 : 4;
    return { type, r2, qx, qy, ca, sa, cx, cz, off, idx, idy };
  }
  fieldType(x: number, z: number) {
    return this.fieldAt(x, z).type;
  }
}

// ------------------------------------------------------------------ scatter (shrubs / rocks / grass / olive trees)

export interface ScatterJob {
  id: number;
  /** Tile in world x/z (axis aligned). */
  x0: number;
  z0: number;
  size: number;
  /** Candidate density (per m²). */
  density: number;
}
export interface ScatterResult {
  id: number;
  /** Per instance (SCATTER_STRIDE floats): x, y, z (relative to origin), scale, rotY, type, tint, spare. */
  data: Float32Array;
  count: number;
  origin: [number, number, number];
}

function hash(i: number, j: number, s: number) {
  let h = (i * 374761393 + j * 668265263 + s * 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export const SCATTER_STRIDE = 8;
export const SCATTER_TYPES = 4; // 0 shrub, 1 rock, 2 grass tuft, 3 olive tree

/** Deterministic scatter for one tile. */
export function genScatter(gen: ChunkGenerator, lu: LandUse, job: ScatterJob): ScatterResult {
  const cell = 1 / Math.sqrt(job.density);
  const nc = Math.max(1, Math.floor(job.size / cell));
  const cs = job.size / nc;
  const out: number[] = [];
  const ox = job.x0 + job.size / 2, oz = job.z0 + job.size / 2;
  const oy = surfaceY(ox, oz);
  const T = gen.terrain;
  const gi = Math.round(job.x0 / cs), gj = Math.round(job.z0 / cs);
  const place = (x: number, z: number, hC: number, sink: number, scale: number, rot: number, type: number, tint: number) => {
    const y = surfaceY(x, z);
    const ux = x / R, uy = (y + R) / R, uz = z / R;
    const hh = hC - sink;
    out.push(x + ux * hh - ox, y + uy * hh - oy, z + uz * hh - oz, scale, rot, type, tint, 0);
  };
  const D1 = 90, D2 = 600 * 0.7071;
  for (let j = 0; j < nc; j++) {
    for (let i = 0; i < nc; i++) {
      const I = gi + i, J = gj + j;
      const r0 = hash(I, J, 1), r1 = hash(I, J, 2), r2 = hash(I, J, 3), r3 = hash(I, J, 4), r4 = hash(I, J, 5);
      const x = job.x0 + (i + r0) * cs, z = job.z0 + (j + r1) * cs;
      const hC = T.height(x, z);
      if (hC < 1.2) continue;
      const hx = T.height(x + 2, z), hz = T.height(x, z + 2);
      const g2 = ((hx - hC) ** 2 + (hz - hC) ** 2) / 4;
      const slope = 1 - 1 / Math.sqrt(1 + g2);
      // cavity (same stencil as the chunk generator at fine LOD)
      const c1 = (T.height(x + D1, z) + T.height(x - D1, z) + T.height(x, z + D1) + T.height(x, z - D1)) * 0.25 - hC;
      const c2 = (T.height(x + D2, z + D2) + T.height(x - D2, z - D2) + T.height(x - D2, z + D2) + T.height(x + D2, z - D2)) * 0.25 - hC;
      const cav = Math.tanh((c1 / 90) * 5 + (c2 / 600) * 5);
      const L = lu.sample(x, z, hC, slope, cav);
      if (L.urban > 0.3) continue;
      // forest: trees on a sparser sub-lattice (every other candidate), shrubs beneath
      if (L.forest > 0.25 && ((I + J) & 1) === 0 && r3 < L.forest * 0.55) {
        const coastal = hC < 45 ? 1 : 0;
        place(x, z, hC, 0.05, (coastal ? 1.05 : 0.8) + hash(I, J, 8) * 0.5, r4 * 6.283, 3, -(0.2 + hash(I, J, 9) * 0.8) - coastal);
        continue;
      }
      let pShrub = Math.min(0.8, L.vegCov * 1.5 + L.forest * 0.35);
      let pGrass = (0.25 + 0.7 * L.grassMix) * (1 - smoothstep(1200, 1700, hC));
      let pRock = 0.015 + smoothstep(0.08, 0.35, slope) * 0.2 + smoothstep(900, 1600, hC) * 0.05;
      if (L.field >= 0) {
        // inside a field system
        if (L.field === 1 || L.field === 2) pShrub = pGrass = pRock = 0;
        else if (L.field === 0) { pShrub = 0; pGrass = 0.35; pRock = 0.004; }
        else if (L.field === 3) { pShrub = 0; pGrass *= 0.4; pRock = 0.004; }
      }
      if (hC < 4) { pShrub *= 0.3; pGrass *= 0.5; }
      let type = -1;
      if (r2 < pRock) type = 1;
      else if (r2 < pRock + pShrub * (1 - pRock)) type = 0;
      else if (r3 < pGrass) type = 2;
      if (type < 0) continue;
      const rs = hash(I, J, 6);
      if (type === 0) place(x, z, hC, 0.08, 0.5 + rs * rs * 0.7, r4 * 6.283, 0, hash(I, J, 7));
      else if (type === 1) place(x, z, hC, 0.12 + rs * 0.15, 0.12 + rs * rs * rs * 0.9, r4 * 6.283, 1, hash(I, J, 7));
      else place(x + (r3 - 0.5) * cs * 0.5, z + (r4 - 0.5) * cs * 0.5, hC, 0.03, 0.45 + rs * 0.45, r4 * 6.283, 2, hash(I, J, 7));
    }
  }
  // Olive trees on the grove lattice (7 m, per-field offset r2) — enumerate lattice cells hit by a 1.2 m probe grid.
  const seen = new Set<string>();
  const step = 1.2;
  const n = Math.ceil(job.size / step);
  const tileCenterH = T.height(ox, oz);
  if (tileCenterH > 3 && tileCenterH < 460) {
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = job.x0 + (i + 0.5) * step, z = job.z0 + (j + 0.5) * step;
        const F = lu.fieldAt(x, z);
        if (F.type !== 3) continue;
        const kx = Math.floor(F.qx / 7 + F.r2), ky = Math.floor(F.qy / 7 + F.r2);
        const key = `${F.cx},${F.cz},${F.idx},${F.idy},${kx},${ky}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // tree centre in field space → world
        const qcx = (kx + 0.5 - F.r2) * 7 - F.off, qcy = (ky + 0.5 - F.r2) * 7;
        const lx = F.ca * qcx + F.sa * qcy, lz = -F.sa * qcx + F.ca * qcy;
        const wx = lx + (F.cx + 0.5) * 2400, wz = lz + (F.cz + 0.5) * 2400;
        if (wx < job.x0 || wx >= job.x0 + job.size || wz < job.z0 || wz >= job.z0 + job.size) continue;
        // the tree's own field must be the same grove (dots near edges belong to the neighbour)
        const F2 = lu.fieldAt(wx, wz);
        if (F2.type !== 3 || F2.idx !== F.idx || F2.idy !== F.idy) continue;
        const hC = T.height(wx, wz);
        const hx = T.height(wx + 2, wz), hz = T.height(wx, wz + 2);
        const slope = 1 - 1 / Math.sqrt(1 + ((hx - hC) ** 2 + (hz - hC) ** 2) / 4);
        const L = lu.sample(wx, wz, hC, slope, 0);
        if (L.agri < 0.5 || L.urban > 0.3) continue;
        const hr = hash(kx, ky, F.idx * 7 + F.idy);
        place(wx, wz, hC, 0.05, 0.85 + hr * 0.35, hash(kx, ky, 11) * 6.283, 3, hash(ky, kx, 12));
      }
  }
  return { id: job.id, data: new Float32Array(out), count: out.length / SCATTER_STRIDE, origin: [ox, oy, oz] };
}
