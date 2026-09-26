import * as THREE from 'three';
import { rng } from './geom';
import { canvas, HAZE_RGB } from './textures';
import { LAYOUT as L, deckY } from './hulldef';

/**
 * Unique weathering atlas for the static painted superstructure (paintAO / paintFineAO, sampled on uv1).
 *
 * Every triangle is projected by its face normal into one of five regions of a 2048² atlas:
 *   P (normal +X, port side)  rows    0..511   u = z, v = y
 *   S (normal -X, stbd side)  rows  512..1023  u = z, v = y
 *   F (normal +Z, fore faces) rows 1024..1535  cols 0..1023     u = x, v = y
 *   A (normal -Z, aft faces)  rows 1024..1535  cols 1024..2047  u = x, v = y
 *   T (roofs / undersides)    rows 1536..2047  u = z, v = x
 * ~5 cm/texel. z wraps every ZL metres (bow fittings reuse the aft end of the atlas).
 * The tiled detail normal/roughness maps stay on uv0, so close-up detail is unaffected.
 *
 * Streak sources (fittings, doors, drip edges, scuppers) are registered while the ship is built,
 * then the atlas is painted once (rust streaks run *down* from each source on the face it sits on).
 */
export const WX_S = 2048;
const Z0 = -60.5, ZL = 104, Y0 = 3.5, YL = 26.5, X0 = -10.5, XW = 21;

export const enum Region { P = 0, S = 1, F = 2, A = 3, T = 4 }

export function regionOf(nx: number, ny: number, nz: number): Region {
  if (Math.abs(ny) > 0.72) return Region.T;
  if (Math.abs(nx) >= Math.abs(nz)) return nx >= 0 ? Region.P : Region.S;
  return nz >= 0 ? Region.F : Region.A;
}
const wrapK = (z: number) => Math.floor((z - Z0) / ZL);

/** Atlas pixel coordinates (canvas space, y down) for a point in a region; wrap k selects the z period. */
export function atlasPx(r: Region, x: number, y: number, z: number, k = wrapK(z)): [number, number] {
  const zw = z - k * ZL;
  const S = WX_S;
  const cl = (v: number, a: number, b: number) => Math.min(b - 2, Math.max(a + 2, v));
  const zy = () => [((zw - Z0) / ZL) * S, ((Y0 + YL - y) / YL) * 512] as const;
  switch (r) {
    case Region.P: { const [px, py] = zy(); return [cl(px, 0, S), cl(py, 0, 512)]; }
    case Region.S: { const [px, py] = zy(); return [cl(px, 0, S), cl(py, 0, 512) + 512]; }
    case Region.F: return [cl(((x - X0) / XW) * 1024, 0, 1024), cl(((Y0 + YL - y) / YL) * 512, 0, 512) + 1024];
    case Region.A: return [cl(((x - X0) / XW) * 1024, 0, 1024) + 1024, cl(((Y0 + YL - y) / YL) * 512, 0, 512) + 1024];
    default: return [cl(((zw - Z0) / ZL) * S, 0, S), cl(((x - X0) / XW) * 512, 0, 512) + 1536];
  }
}
/** Pixels per metre (both axes, approximately). */
export const WX_PPM = WX_S / ZL;

/**
 * Add a `uv1` attribute projecting each triangle into the atlas. Vertices shared by triangles that land in
 * different regions (or z periods) are duplicated so no triangle straddles two regions.
 */
export function assignWeatherUV(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = g.attributes.position;
  const index = g.index!;
  const ix = index.array;
  const nTri = ix.length / 3;
  const nV = pos.count;
  const keyOf = new Int32Array(nV).fill(-1);
  const clones = new Map<number, number>(); // (v * 64 + key) -> new vertex
  const extra: number[] = []; // source vertex for each appended vertex
  const extraKey: number[] = [];
  const newIdx = new Uint32Array(ix.length);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t < nTri; t++) {
    const i0 = ix[t * 3], i1 = ix[t * 3 + 1], i2 = ix[t * 3 + 2];
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
    const r = regionOf(n.x, n.y, n.z);
    const k = wrapK((a.z + b.z + c.z) / 3);
    const key = r * 8 + (k + 4);
    for (let j = 0; j < 3; j++) {
      const v = ix[t * 3 + j];
      if (keyOf[v] === -1 || keyOf[v] === key) { keyOf[v] = key; newIdx[t * 3 + j] = v; continue; }
      const ck = v * 64 + key;
      let nv = clones.get(ck);
      if (nv === undefined) {
        nv = nV + extra.length;
        extra.push(v);
        extraKey.push(key);
        clones.set(ck, nv);
      }
      newIdx[t * 3 + j] = nv;
    }
  }
  const total = nV + extra.length;
  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(g.attributes)) {
    const src = g.attributes[name] as THREE.BufferAttribute;
    const is = src.itemSize;
    const arr = new Float32Array(total * is);
    arr.set((src.array as Float32Array).subarray(0, nV * is));
    for (let e = 0; e < extra.length; e++) for (let q = 0; q < is; q++) arr[(nV + e) * is + q] = src.array[extra[e] * is + q];
    out.setAttribute(name, new THREE.BufferAttribute(arr, is));
  }
  const uv1 = new Float32Array(total * 2);
  const p = out.attributes.position;
  for (let v = 0; v < total; v++) {
    const key = v < nV ? keyOf[v] : extraKey[v - nV];
    if (key < 0) continue;
    const r = Math.floor(key / 8) as Region, k = (key % 8) - 4;
    const [px, py] = atlasPx(r, p.getX(v), p.getY(v), p.getZ(v), k);
    uv1[v * 2] = px / WX_S;
    uv1[v * 2 + 1] = 1 - py / WX_S;
  }
  out.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  out.setIndex(new THREE.BufferAttribute(total > 65535 ? newIdx : new Uint16Array(newIdx), 1));
  return out;
}

// ------------------------------------------------------------------ streak sources
export type WxKind = 'rust' | 'grime' | 'drip' | 'soot' | 'salt';
interface WxSrc { p: THREE.Vector3; n: THREE.Vector3; kind: WxKind; w: number; len: number; a: number; p1?: THREE.Vector3 }
export const WX: { src: WxSrc[] } = { src: [] };
const _v = new THREE.Vector3();

/** Register a streak source at local (lx, ly) of a face frame (Z = outward normal). */
export function wxMark(fm: THREE.Matrix4, lx: number, ly: number, kind: WxKind, len = 0.8, w = 0.06, a = 0.3) {
  const p = new THREE.Vector3(lx, ly, 0).applyMatrix4(fm);
  const n = _v.setFromMatrixColumn(fm, 2).clone().normalize();
  WX.src.push({ p, n, kind, w, len, a });
}
/** Register a line source (e.g. a drip edge) between two local x positions at local y. */
export function wxLine(fm: THREE.Matrix4, x0: number, x1: number, ly: number, kind: WxKind, len = 1.0, a = 0.15) {
  const p = new THREE.Vector3(x0, ly, 0).applyMatrix4(fm);
  const p1 = new THREE.Vector3(x1, ly, 0).applyMatrix4(fm);
  const n = _v.setFromMatrixColumn(fm, 2).clone().normalize();
  WX.src.push({ p, p1, n, kind, w: 0, len, a });
}
export function wxPoint(p: THREE.Vector3 | [number, number, number], n: THREE.Vector3 | [number, number, number], kind: WxKind, len = 0.8, w = 0.06, a = 0.3) {
  WX.src.push({ p: Array.isArray(p) ? new THREE.Vector3(...p) : p.clone(), n: Array.isArray(n) ? new THREE.Vector3(...n) : n.clone(), kind, w, len, a });
}

// ------------------------------------------------------------------ atlas painting
type Ctx = CanvasRenderingContext2D;
const RUST = [104, 60, 34];
const GRIME = [52, 54, 52];
const SOOT = [30, 30, 30];

function vStreak(ctx: Ctx, x: number, y: number, len: number, w: number, rgb: number[], a: number, r: () => number) {
  // tapered streak running down (+y); slight wobble, strongest at the top
  const g = ctx.createLinearGradient(0, y, 0, y + len);
  g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`);
  g.addColorStop(0.25, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a * 0.6})`);
  g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
  ctx.fillStyle = g;
  const wob = (r() - 0.5) * w * 0.8;
  ctx.beginPath();
  ctx.moveTo(x - w / 2, y);
  ctx.lineTo(x + w / 2, y);
  ctx.quadraticCurveTo(x + w * 0.4 + wob, y + len * 0.5, x + w * 0.15 + wob, y + len);
  ctx.lineTo(x - w * 0.15 + wob, y + len);
  ctx.quadraticCurveTo(x - w * 0.4 + wob, y + len * 0.5, x - w / 2, y);
  ctx.fill();
}

/** Floors whose walls get grime just above them (y levels, plus the sheer line for main-deck walls). */
const LEVELS = [L.lvl01, L.lvl02, L.lvl03, L.bridgeRoof, L.lvl05, L.hangarRoof, 8.75, 14.0];

let _atlas: THREE.CanvasTexture | null = null;
export function weatherAtlas(): THREE.CanvasTexture {
  if (_atlas) return _atlas;
  const S = WX_S;
  const [c, ctx] = canvas(S, S);
  const r = rng(9090);
  const [hr, hg, hb] = HAZE_RGB;
  ctx.fillStyle = `rgb(${hr},${hg},${hb})`;
  ctx.fillRect(0, 0, S, S);
  const ppm = WX_PPM;

  // ---- plate-to-plate variation, aligned with the tiled weld grid of the paint normal map
  //      (rows every 2 m, butts every 8/3 m, alternate rows staggered by 4/3 m)
  const plates = (reg: Region, amp: number) => {
    const vert = reg !== Region.T;
    const rMin = vert ? 2 * Math.floor(Y0 / 2) : 2 * Math.floor(Z0 / 2);
    const rMax = vert ? Y0 + YL : Z0 + ZL;
    const cMin = vert && (reg === Region.F || reg === Region.A) ? X0 : vert ? Z0 : X0;
    const cMax = cMin === X0 ? X0 + XW : Z0 + ZL;
    const W = 8 / 3;
    for (let row = rMin; row < rMax; row += 2) {
      const k = Math.round(row / 2);
      const st = (((k % 2) + 2) % 2) * (W / 2);
      for (let col = Math.floor((cMin - st) / W) * W + st; col < cMax; col += W) {
        const d = r() < 0.05 ? (r() - 0.4) * amp * 2.4 : (r() - 0.5) * amp;
        const pt = (rc: number, cc: number) => vert
          ? atlasPx(reg, reg === Region.F || reg === Region.A ? cc : 0, rc, reg === Region.F || reg === Region.A ? 0 : cc, 0)
          : atlasPx(reg, cc, 0, rc, 0);
        const [xa, ya] = pt(row, col), [xb, yb] = pt(row + 2, col + W);
        ctx.fillStyle = d > 0 ? `rgba(255,255,250,${Math.abs(d) / 255})` : `rgba(20,22,24,${Math.abs(d) / 180})`;
        ctx.fillRect(Math.min(xa, xb), Math.min(ya, yb), Math.abs(xb - xa), Math.abs(yb - ya));
      }
    }
  };
  plates(Region.P, 7);
  plates(Region.S, 7);
  plates(Region.F, 7);
  plates(Region.A, 7);
  plates(Region.T, 5);
  // soft large-scale tonal drift (sun-fade / repaint), very low contrast
  for (let i = 0; i < 90; i++) {
    const x = r() * S, y = r() * S, rad = (3 + r() * 10) * ppm;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const light = r() < 0.5;
    g.addColorStop(0, light ? 'rgba(235,238,235,0.035)' : 'rgba(30,34,36,0.04)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, 2 * rad, 2 * rad);
  }

  // ---- vertical regions (P, S, F, A): grime above floors, darkening toward the bottom of each wall, drip streaks
  const vRegions: Region[] = [Region.P, Region.S, Region.F, Region.A];
  for (const reg of vRegions) {
    const [rx0, ry0] = reg === Region.A ? [1024, 1024] : reg === Region.F ? [0, 1024] : [0, reg === Region.P ? 0 : 512];
    const rw = reg === Region.F || reg === Region.A ? 1024 : S;
    ctx.save();
    ctx.beginPath(); ctx.rect(rx0, ry0, rw, 512); ctx.clip();
    const floorsAt = (px: number): number[] => {
      const out = [...LEVELS];
      if (reg === Region.P || reg === Region.S) {
        const z = Z0 + (px / S) * ZL;
        out.push(deckY(z), deckY(z + ZL));
      } else out.push(deckY(30), deckY(0), deckY(-30), 4.7);
      return out;
    };
    // grime band above each floor (column-wise, with streaky variation)
    for (let px = rx0; px < rx0 + rw; px += 3) {
      for (const fy of floorsAt(px - rx0)) {
        const yp = ry0 + ((Y0 + YL - fy) / YL) * 512;
        if (yp < ry0 || yp > ry0 + 512) continue;
        const hgt = (0.5 + r() * 1.3) * ppm;
        const a = 0.05 + r() * 0.07;
        const g = ctx.createLinearGradient(0, yp, 0, yp - hgt);
        g.addColorStop(0, `rgba(58,56,48,${a})`);
        g.addColorStop(1, 'rgba(58,56,48,0)');
        ctx.fillStyle = g;
        ctx.fillRect(px, yp - hgt, 3, hgt);
      }
    }
    // faint grime drips down from each level's top edge (roof run-off)
    for (const fy of [...LEVELS, 6.4]) {
      const yp = ry0 + ((Y0 + YL - fy) / YL) * 512;
      const n = Math.round(rw / 9);
      for (let i = 0; i < n; i++) {
        const x = rx0 + r() * rw;
        vStreak(ctx, x, yp + 1, (0.3 + r() * 1.6) * ppm, 1 + r() * 2.5, r() < 0.15 ? RUST : GRIME, 0.04 + r() * 0.08, r);
      }
    }
    // salt: whitish mist deposits low on fore faces and on the sides forward
    if (reg === Region.F || reg === Region.P || reg === Region.S) {
      for (let i = 0; i < (reg === Region.F ? 60 : 90); i++) {
        const x = rx0 + r() * rw;
        const y = ry0 + ((Y0 + YL - (6 + r() * 5)) / YL) * 512;
        const rad = (0.4 + r() * 1.5) * ppm;
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, 'rgba(225,228,222,0.06)');
        g.addColorStop(1, 'rgba(225,228,222,0)');
        ctx.fillStyle = g;
        ctx.save(); ctx.translate(x, y); ctx.scale(1.8, 0.6); ctx.translate(-x, -y);
        ctx.fillRect(x - rad, y - rad, 2 * rad, 2 * rad);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  // ---- soot from the funnels (on the stack sides near the top, drifting aft; aft faces high up)
  for (const [zc, yCap] of [[L.fwdFunnelZ - 1.5, 21.9], [L.aftFunnelZ - 1.5, 20.6]]) {
    for (const reg of [Region.P, Region.S]) {
      const [x0, y0] = atlasPx(reg, 0, yCap + 0.2, zc + 4.5);
      const [x1] = atlasPx(reg, 0, yCap, zc - 5.5);
      const hgt = 3.2 * ppm;
      for (let px = x1; px < x0; px += 2) {
        const f = (px - x1) / (x0 - x1); // 0 aft .. 1 fwd
        const a = (0.1 + 0.22 * (1 - f)) * (0.6 + r() * 0.5);
        vStreak(ctx, px, y0, hgt * (0.5 + r() * 0.8) * (1.2 - f * 0.5), 2.5, SOOT, a, r);
      }
    }
  }
  {
    // aft-facing faces above ~15 m get a sooty film (funnel backs, tower2 aft faces)
    const [ax0, ay0] = atlasPx(Region.A, -10, 26, 0);
    const [ax1, ay1] = atlasPx(Region.A, 10, 14, 0);
    const g = ctx.createLinearGradient(0, ay0, 0, ay1);
    g.addColorStop(0, 'rgba(34,34,32,0.26)');
    g.addColorStop(1, 'rgba(34,34,32,0)');
    ctx.fillStyle = g;
    ctx.fillRect(ax0, ay0, ax1 - ax0, ay1 - ay0);
    for (let i = 0; i < 160; i++) vStreak(ctx, ax0 + r() * (ax1 - ax0), ay0 + r() * (ay1 - ay0) * 0.6, (0.5 + r() * 2.5) * ppm, 1.5 + r() * 3, SOOT, 0.05 + r() * 0.1, r);
  }
  // roofs: soot fall-out aft of the funnels, darker on the aft roofs; rust spots/stains
  for (const zf of [L.fwdFunnelZ - 3, L.aftFunnelZ - 3]) {
    const [tx0] = atlasPx(Region.T, 0, 0, zf - 16);
    const [tx1] = atlasPx(Region.T, 0, 0, zf + 2);
    for (let i = 0; i < 80; i++) {
      const x = tx0 + r() * (tx1 - tx0), y = 1536 + r() * 512;
      const rad = (0.5 + r() * 2.5) * ppm;
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, `rgba(30,30,30,${0.03 + r() * 0.05})`);
      g.addColorStop(1, 'rgba(30,30,30,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - rad, y - rad, 2 * rad, 2 * rad);
    }
  }
  for (let i = 0; i < 260; i++) {
    const x = r() * S, y = 1536 + r() * 512;
    ctx.fillStyle = r() < 0.5 ? `rgba(${RUST},${0.05 + r() * 0.12})` : `rgba(40,40,36,${0.04 + r() * 0.08})`;
    ctx.beginPath(); ctx.ellipse(x, y, 1 + r() * 5, 1 + r() * 4, r() * 3, 0, Math.PI * 2); ctx.fill();
  }

  // ---- registered sources
  for (const s of WX.src) {
    const reg = regionOf(s.n.x, s.n.y, s.n.z);
    if (s.p1) {
      // line source: many faint drips along the edge
      const [x0, y0] = atlasPx(reg, s.p.x, s.p.y, s.p.z);
      const [x1, y1] = atlasPx(reg, s.p1.x, s.p1.y, s.p1.z);
      const len = Math.hypot(x1 - x0, y1 - y0);
      const n = Math.round(len / (0.35 * ppm));
      for (let i = 0; i < n; i++) {
        const t = r();
        const kind = s.kind === 'drip' ? (r() < 0.25 ? RUST : GRIME) : s.kind === 'soot' ? SOOT : RUST;
        vStreak(ctx, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, s.len * ppm * (0.3 + r()), 1 + r() * 2.5, kind, s.a * (0.4 + r() * 0.8), r);
      }
      continue;
    }
    if (reg === Region.T) {
      // on a roof: stain ring around the fitting base
      const [x, y] = atlasPx(reg, s.p.x, s.p.y, s.p.z);
      const rad = Math.max(3, s.len * ppm * 0.5);
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, `rgba(${RUST},${s.a * 0.6})`);
      g.addColorStop(1, `rgba(${RUST},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - rad, y - rad, 2 * rad, 2 * rad);
      continue;
    }
    const [x, y] = atlasPx(reg, s.p.x, s.p.y, s.p.z);
    const col = s.kind === 'rust' ? RUST : s.kind === 'soot' ? SOOT : s.kind === 'salt' ? [220, 222, 216] : GRIME;
    const n = s.kind === 'rust' ? 1 + Math.floor(r() * 3) : 1;
    for (let k = 0; k < n; k++) {
      const ww = Math.max(1.2, s.w * ppm * (0.4 + r() * 0.8));
      vStreak(ctx, x + (r() - 0.5) * s.w * ppm, y, s.len * ppm * (0.5 + r() * 0.9), ww, col, s.a * (0.5 + r() * 0.7), r);
    }
    if (s.kind === 'rust') {
      ctx.fillStyle = `rgba(88,50,28,${s.a * 0.9})`;
      ctx.beginPath(); ctx.arc(x, y, Math.max(1, s.w * ppm * 0.4), 0, Math.PI * 2); ctx.fill();
    }
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.channel = 1;
  _atlas = t;
  return t;
}
