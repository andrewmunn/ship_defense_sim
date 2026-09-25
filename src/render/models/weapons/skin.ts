import * as THREE from 'three';
import { canvas } from '../ship/textures';
import { rng } from '../ship/geom';

/**
 * Procedural missile "skin" textures, wrapped cylindrically: u = around the body, v = along it
 * (v=0 at the tail, v=1 at the nose). Produces albedo, roughness and normal maps.
 */
export interface SkinOpts {
  seed: number;
  length: number;
  base: string;
  /** Nose section (radome) from this v to 1. */
  radomeV?: number;
  radome?: string;
  /** Ring seams (v). */
  seams?: number[];
  /** Colored bands [v0, v1, color]. */
  bands?: [number, number, string][];
  /** Stencil blocks [v, u, lines]. */
  stencils?: [number, number, number][];
  /** Longitudinal seam positions (u). */
  longSeams?: number[];
  /** Soot toward the tail (0..1). */
  soot?: number;
  grime?: number;
  /** Camouflage blotches [color, coverage]. */
  camo?: [string, number][];
  roughness?: number;
}

const W = 512, H = 1024;

function heightToNormal(src: Float32Array, w: number, h: number, strength: number) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ym = Math.max(0, y - 1), yp = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const xm = (x - 1 + w) % w, xp = (x + 1) % w;
      const dx = (src[y * w + xp] - src[y * w + xm]) * strength;
      const dy = (src[yp * w + x] - src[ym * w + x]) * strength;
      let nx = -dx, ny = dy, nz = 1;
      const L = Math.hypot(nx, ny, nz);
      nx /= L; ny /= L; nz /= L;
      // canvas row 0 = top = v=1 (flipY): write rows reversed so the DataTexture matches
      const k = ((h - 1 - y) * w + x) * 4;
      out[k] = (nx * 0.5 + 0.5) * 255;
      out[k + 1] = (ny * 0.5 + 0.5) * 255;
      out[k + 2] = (nz * 0.5 + 0.5) * 255;
      out[k + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

export function makeSkin(o: SkinOpts) {
  const r = rng(o.seed);
  const [c, ctx] = canvas(W, H);
  const [rc, rctx] = canvas(W, H);
  const hgt = new Float32Array(W * H).fill(0.5);
  const vy = (v: number) => (1 - v) * H; // canvas y for v
  ctx.fillStyle = o.base;
  ctx.fillRect(0, 0, W, H);
  const rough = o.roughness ?? 0.45;
  rctx.fillStyle = `rgb(${Math.round(rough * 255)},${Math.round(rough * 255)},${Math.round(rough * 255)})`;
  rctx.fillRect(0, 0, W, H);

  // subtle paint mottling
  for (let i = 0; i < 900; i++) {
    const x = r() * W, y = r() * H, s = 4 + r() * 30;
    ctx.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,255,255'},${0.012 + r() * 0.02})`;
    ctx.beginPath();
    ctx.ellipse(x, y, s, s * (0.5 + r()), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // camo
  if (o.camo) {
    for (const [col, cov] of o.camo) {
      ctx.fillStyle = col;
      const n = Math.round(cov * 60);
      for (let i = 0; i < n; i++) {
        const x = r() * W, y = r() * H;
        ctx.beginPath();
        const pts = 7;
        for (let k = 0; k <= pts; k++) {
          const a = (k / pts) * Math.PI * 2;
          const rr = (30 + r() * 60) * (0.6 + 0.4 * Math.sin(a * 3 + i));
          const px = x + Math.cos(a) * rr * 1.3, py = y + Math.sin(a) * rr * 2.2;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.fill();
        // wrap horizontally
        ctx.save();
        ctx.translate(x > W / 2 ? -W : W, 0);
        ctx.fill();
        ctx.restore();
      }
    }
  }
  // bands
  for (const [v0, v1, col] of o.bands ?? []) {
    ctx.fillStyle = col;
    ctx.fillRect(0, vy(v1), W, vy(v0) - vy(v1));
  }
  // radome
  if (o.radomeV !== undefined) {
    ctx.fillStyle = o.radome ?? '#2a2b2c';
    ctx.fillRect(0, 0, W, vy(o.radomeV));
    rctx.fillStyle = 'rgb(140,140,140)';
    rctx.fillRect(0, 0, W, vy(o.radomeV));
    // rain erosion at the very tip
    const g = ctx.createLinearGradient(0, 0, 0, vy(o.radomeV));
    g.addColorStop(0, 'rgba(200,200,200,0.35)');
    g.addColorStop(0.25, 'rgba(200,200,200,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, vy(o.radomeV));
  }
  // seams (recessed rings) + rivets
  const setH = (x: number, y: number, v: number) => {
    const xi = ((Math.round(x) % W) + W) % W, yi = Math.round(y);
    if (yi >= 0 && yi < H) hgt[yi * W + xi] = v;
  };
  for (const v of o.seams ?? []) {
    const y = vy(v);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, y - 1, W, 2);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(0, y + 1, W, 1);
    for (let x = 0; x < W; x++) { setH(x, y - 1, 0.25); setH(x, y, 0.2); setH(x, y + 1, 0.3); }
    for (const dy of [-5, 5]) {
      for (let x = 2; x < W; x += 9) {
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(x, y + dy, 2, 2);
        setH(x, y + dy, 0.7);
        setH(x + 1, y + dy, 0.65);
      }
    }
  }
  for (const u of o.longSeams ?? []) {
    const x = u * W;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(x, 0, 1.5, H);
    for (let y = 0; y < H; y++) setH(x, y, 0.3);
  }
  // access panels
  for (let i = 0; i < 10; i++) {
    const x = r() * W, y = H * (0.15 + r() * 0.7), w = 18 + r() * 40, h = 20 + r() * 60;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(x, y, w, h);
    for (let k = 0; k < w; k++) { setH(x + k, y, 0.32); setH(x + k, y + h, 0.32); }
    for (let k = 0; k < h; k++) { setH(x, y + k, 0.32); setH(x + w, y + k, 0.32); }
    for (const [fx, fy] of [[x + 3, y + 3], [x + w - 3, y + 3], [x + 3, y + h - 3], [x + w - 3, y + h - 3]]) {
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(fx - 1, fy - 1, 2, 2);
      setH(fx, fy, 0.35);
    }
  }
  // stencils: blocks of small glyph strokes (unreadable at game distances, reads as markings)
  ctx.save();
  for (const [v, u, lines] of o.stencils ?? []) {
    const x0 = u * W, y0 = vy(v);
    ctx.fillStyle = 'rgba(20,20,20,0.75)';
    for (let l = 0; l < lines; l++) {
      let x = x0;
      const n = 6 + Math.floor(r() * 14);
      for (let k = 0; k < n; k++) {
        if (r() < 0.15) { x += 5; continue; }
        const gw = 3 + r() * 2;
        ctx.fillRect(x, y0 + l * 9, gw, 6);
        x += gw + 1.6;
      }
    }
  }
  ctx.restore();
  // grime streaks along the flow (toward the tail = down the canvas)
  const grime = o.grime ?? 0.5;
  for (let i = 0; i < 160 * grime; i++) {
    const x = r() * W, y = r() * H, l = 30 + r() * 200;
    const g = ctx.createLinearGradient(0, y, 0, y + l);
    g.addColorStop(0, 'rgba(40,35,30,0)');
    g.addColorStop(0.3, `rgba(40,35,30,${0.04 + r() * 0.06})`);
    g.addColorStop(1, 'rgba(40,35,30,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, 1 + r() * 3, l);
  }
  // soot near the tail
  const soot = o.soot ?? 0.5;
  if (soot > 0) {
    const g = ctx.createLinearGradient(0, H, 0, H * 0.82);
    g.addColorStop(0, `rgba(15,12,10,${0.8 * soot})`);
    g.addColorStop(1, 'rgba(15,12,10,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, H * 0.82, W, H * 0.18);
    const rg = rctx.createLinearGradient(0, H, 0, H * 0.85);
    rg.addColorStop(0, 'rgba(230,230,230,0.8)');
    rg.addColorStop(1, 'rgba(230,230,230,0)');
    rctx.fillStyle = rg;
    rctx.fillRect(0, H * 0.85, W, H * 0.15);
  }
  // edge wear near seams
  for (let i = 0; i < 400; i++) {
    const v = (o.seams ?? [0.5])[Math.floor(r() * (o.seams?.length ?? 1))] ?? 0.5;
    const x = r() * W, y = vy(v) + (r() - 0.5) * 12;
    ctx.fillStyle = `rgba(160,160,160,${0.1 + r() * 0.2})`;
    ctx.fillRect(x, y, 1 + r() * 3, 1);
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.anisotropy = 8;
  const roughnessMap = new THREE.CanvasTexture(rc);
  roughnessMap.wrapS = THREE.RepeatWrapping;
  const normalMap = heightToNormal(hgt, W, H, 3.0);
  return { map, roughnessMap, normalMap };
}

/** Generic tileable painted-metal texture set (fins, TEL parts). */
export function paintSet(seed: number, base: string, opts: { camo?: [string, number][]; grime?: number; roughness?: number; panel?: number } = {}) {
  return makeSkin({ seed, length: 1, base, camo: opts.camo, grime: opts.grime ?? 0.6, soot: 0, roughness: opts.roughness ?? 0.6, seams: [], longSeams: [] });
}
