import * as THREE from 'three';
import { canvas } from '../ship/textures';
import { rng } from '../ship/geom';

/**
 * Procedural textures for the coastal-missile TEL: tileable 3-tone arid disruptive camo,
 * chassis grime paint, rubber, canister skin (non-tiling, with stencils) and a decal atlas.
 * Everything is cached at module level.
 */

// Arid Mediterranean 3-tone: sand base, olive-drab, dark earth.
export const CAMO_SAND: [number, number, number] = [146, 124, 86];
export const CAMO_OLIVE: [number, number, number] = [80, 83, 50];
export const CAMO_BROWN: [number, number, number] = [72, 54, 37];
export const DUST_RGB: [number, number, number] = [138, 120, 92];

// ------------------------------------------------------------------ periodic value noise

/** Value noise on a periodic lattice (period px cells in x, py in y). Returns sampler in [0,1]. */
function periodicNoise(seed: number, px: number, py: number) {
  const r = rng(seed);
  const lat = new Float32Array(px * py);
  for (let i = 0; i < lat.length; i++) lat[i] = r();
  const s = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = s(x - xi), fy = s(y - yi);
    const x0 = ((xi % px) + px) % px, y0 = ((yi % py) + py) % py;
    const x1 = (x0 + 1) % px, y1 = (y0 + 1) % py;
    const a = lat[y0 * px + x0], b = lat[y0 * px + x1], c = lat[y1 * px + x0], d = lat[y1 * px + x1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

/** Fractal periodic noise: (u,v) in [0,1) tile space; base = lattice cells per tile (x,y). */
function fbm(seed: number, bx: number, by: number, oct = 4, gain = 0.5) {
  const layers = Array.from({ length: oct }, (_, o) => periodicNoise(seed + o * 977, bx << o, by << o));
  let norm = 0;
  for (let o = 0; o < oct; o++) norm += Math.pow(gain, o);
  return (u: number, v: number) => {
    let s = 0;
    for (let o = 0; o < oct; o++) s += layers[o](u * (bx << o), v * (by << o)) * Math.pow(gain, o);
    return s / norm;
  };
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------------ texture helpers

function heightToNormal(hgt: Float32Array, w: number, h: number, strength: number, wrapX: boolean, wrapY: boolean) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ym = wrapY ? (y - 1 + h) % h : Math.max(0, y - 1);
    const yp = wrapY ? (y + 1) % h : Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const xm = wrapX ? (x - 1 + w) % w : Math.max(0, x - 1);
      const xp = wrapX ? (x + 1) % w : Math.min(w - 1, x + 1);
      const dx = (hgt[y * w + xp] - hgt[y * w + xm]) * strength;
      const dy = (hgt[yp * w + x] - hgt[ym * w + x]) * strength;
      let nx = -dx, ny = dy, nz = 1;
      const L = Math.hypot(nx, ny, nz);
      nx /= L; ny /= L; nz /= L;
      // hgt row 0 = canvas top = v=1 -> write reversed so DataTexture (row 0 = v=0) matches CanvasTexture
      const k = ((h - 1 - y) * w + x) * 4;
      out[k] = (nx * 0.5 + 0.5) * 255;
      out[k + 1] = (ny * 0.5 + 0.5) * 255;
      out[k + 2] = (nz * 0.5 + 0.5) * 255;
      out[k + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
  t.wrapS = wrapX ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.wrapT = wrapY ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

function tex(c: HTMLCanvasElement, srgb: boolean, wrapX = true, wrapY = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = wrapX ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.wrapT = wrapY ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

export interface TexSet {
  map: THREE.Texture;
  roughnessMap: THREE.Texture;
  normalMap: THREE.Texture;
}

/**
 * Paint a camo + wear pass into RGBA/rough/height buffers.
 * camoAt(x,y) -> [olive weight, brown weight] (already antialiased 0..1).
 */
function paintPass(
  w: number,
  h: number,
  seed: number,
  camoAt: (x: number, y: number) => [number, number],
  opts: { wrapX: boolean; wrapY: boolean; baseRough: number; chips: number; grain: number }
) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  const rough = new Uint8ClampedArray(w * h * 4);
  const hgt = new Float32Array(w * h);
  const r = rng(seed);
  // fine mottle noise (periodic in both axes so tiles stay seamless)
  const mott = fbm(seed + 7, 16, Math.max(2, Math.round((16 * h) / w)), 4, 0.55);
  const grain = fbm(seed + 13, 128, Math.max(2, Math.round((128 * h) / w)), 2, 0.6);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = x / w, v = y / h;
      const [o, b] = camoAt(x, y);
      let cr = CAMO_SAND[0], cg = CAMO_SAND[1], cb = CAMO_SAND[2];
      cr += (CAMO_OLIVE[0] - cr) * o; cg += (CAMO_OLIVE[1] - cg) * o; cb += (CAMO_OLIVE[2] - cb) * o;
      cr += (CAMO_BROWN[0] - cr) * b; cg += (CAMO_BROWN[1] - cg) * b; cb += (CAMO_BROWN[2] - cb) * b;
      const mo = mott(u, v), gr = grain(u, v);
      const m = (mo - 0.5) * 0.16 + (gr - 0.5) * 0.06 * opts.grain;
      const k = (y * w + x) * 4;
      rgba[k] = cr * (1 + m); rgba[k + 1] = cg * (1 + m); rgba[k + 2] = cb * (1 + m); rgba[k + 3] = 255;
      const ro = opts.baseRough + (0.5 - mo) * 0.18 + (gr - 0.5) * 0.08;
      rough[k] = rough[k + 1] = rough[k + 2] = ro * 255; rough[k + 3] = 255;
      hgt[y * w + x] = gr * 0.25 * opts.grain + mo * 0.1;
    }
  // chips / scratches exposing dark primer and bare metal
  const stamp = (cx: number, cy: number, rad: number, col: [number, number, number], rv: number, hv: number, a: number) => {
    for (let dy = -rad; dy <= rad; dy++)
      for (let dx = -rad; dx <= rad; dx++) {
        const d = Math.hypot(dx, dy) / rad;
        if (d > 1) continue;
        let px = Math.round(cx + dx), py = Math.round(cy + dy);
        if (opts.wrapX) px = ((px % w) + w) % w; else if (px < 0 || px >= w) continue;
        if (opts.wrapY) py = ((py % h) + h) % h; else if (py < 0 || py >= h) continue;
        const k = (py * w + px) * 4;
        const t = a * (1 - d * d);
        rgba[k] += (col[0] - rgba[k]) * t; rgba[k + 1] += (col[1] - rgba[k + 1]) * t; rgba[k + 2] += (col[2] - rgba[k + 2]) * t;
        rough[k] = rough[k + 1] = rough[k + 2] = rough[k] + (rv * 255 - rough[k]) * t;
        hgt[py * w + px] = Math.min(hgt[py * w + px], hv);
      }
  };
  for (let i = 0; i < opts.chips; i++) {
    const x = r() * w, y = r() * h;
    const n = 1 + Math.floor(r() * 5);
    for (let j = 0; j < n; j++) stamp(x + (r() - 0.5) * 8, y + (r() - 0.5) * 8, 0.8 + r() * 1.6, r() < 0.8 ? [48, 44, 36] : [96, 92, 84], 0.5, -0.1, 0.7);
  }
  // dust speckle / dried mud splatter
  for (let i = 0; i < opts.chips * 3; i++) {
    const x = r() * w, y = r() * h;
    stamp(x, y, 0.8 + r() * 1.8, DUST_RGB, 0.95, 0.35, 0.35 + r() * 0.3);
  }
  return { rgba, rough, hgt };
}

function toCanvas(buf: Uint8ClampedArray, w: number, h: number) {
  const [c, ctx] = canvas(w, h);
  const img = ctx.createImageData(w, h);
  img.data.set(buf);
  ctx.putImageData(img, 0, 0);
  return [c, ctx] as const;
}

// ------------------------------------------------------------------ tileable camo (body)

/** Tile covers CAMO_TILE meters in each direction (use uvScale = 1 / CAMO_TILE). */
export const CAMO_TILE = 7;
let _camo: TexSet | null = null;
export function camoTextures(): TexSet {
  if (_camo) return _camo;
  const S = 1024;
  // Blotch fields: base lattice 4x4 cells per 7 m tile -> ~1.2-2 m blotches, with fbm edges.
  const fo = fbm(9101, 4, 4, 5, 0.5);
  const fb = fbm(5303, 4, 4, 5, 0.52);
  const aa = 0.012;
  const camoAt = (x: number, y: number): [number, number] => {
    const u = x / S, v = y / S;
    // slight horizontal elongation like painted disruptive schemes
    const o = smoothstep(0.53 - aa, 0.53 + aa, fo(u, v));
    const b = smoothstep(0.575 - aa, 0.575 + aa, fb(u + 0.13, v));
    return [o, b];
  };
  const { rgba, rough, hgt } = paintPass(S, S, 4242, camoAt, { wrapX: true, wrapY: true, baseRough: 0.82, chips: 140, grain: 1 });
  const [c] = toCanvas(rgba, S, S);
  const [rc] = toCanvas(rough, S, S);
  _camo = { map: tex(c, true), roughnessMap: tex(rc, false), normalMap: heightToNormal(hgt, S, S, 2.2, true, true) };
  return _camo;
}

// ------------------------------------------------------------------ chassis / grime paint (tileable)

let _grime: TexSet | null = null;
/** Neutral grime/wear set (white-ish albedo modulated by material color). Tile = 3 m. */
export function grimeTextures(): TexSet {
  if (_grime) return _grime;
  const S = 512;
  const r = rng(777);
  const f = fbm(31, 6, 6, 5, 0.55);
  const g2 = fbm(57, 48, 48, 2, 0.6);
  const rgba = new Uint8ClampedArray(S * S * 4);
  const rough = new Uint8ClampedArray(S * S * 4);
  const hgt = new Float32Array(S * S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const n = f(u, v), g = g2(u, v);
      const k = (y * S + x) * 4;
      const l = 205 + (n - 0.5) * 70 + (g - 0.5) * 25;
      // grime tints toward brown
      const dirt = smoothstep(0.52, 0.72, n);
      rgba[k] = l + dirt * 10; rgba[k + 1] = l - dirt * 5; rgba[k + 2] = l - dirt * 25; rgba[k + 3] = 255;
      rough[k] = rough[k + 1] = rough[k + 2] = (0.68 + dirt * 0.25 + (g - 0.5) * 0.1) * 255; rough[k + 3] = 255;
      hgt[y * S + x] = g * 0.3 + n * 0.15;
    }
  for (let i = 0; i < 300; i++) {
    const x = Math.floor(r() * S), y = Math.floor(r() * S);
    const len = 3 + r() * 14;
    for (let j = 0; j < len; j++) {
      const px = (x + j) % S, py = (y + Math.round(j * (r() - 0.5) * 0.4) + S) % S;
      const k = (py * S + px) * 4;
      rgba[k] = rgba[k + 1] = rgba[k + 2] = 150;
      hgt[py * S + px] -= 0.1;
    }
  }
  const [c] = toCanvas(rgba, S, S);
  const [rc] = toCanvas(rough, S, S);
  _grime = { map: tex(c, true), roughnessMap: tex(rc, false), normalMap: heightToNormal(hgt, S, S, 2.0, true, true) };
  return _grime;
}

// ------------------------------------------------------------------ rubber

let _rubber: TexSet | null = null;
export function rubberTextures(): TexSet {
  if (_rubber) return _rubber;
  const S = 256;
  const f = fbm(99, 16, 16, 3, 0.55);
  const g2 = fbm(123, 64, 64, 2, 0.6);
  const rgba = new Uint8ClampedArray(S * S * 4);
  const rough = new Uint8ClampedArray(S * S * 4);
  const hgt = new Float32Array(S * S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const n = f(u, v), g = g2(u, v);
      const k = (y * S + x) * 4;
      const dust = 0.1 + smoothstep(0.5, 0.8, n) * 0.12;
      const base = [33, 32, 30];
      rgba[k] = base[0] + (DUST_RGB[0] - base[0]) * dust;
      rgba[k + 1] = base[1] + (DUST_RGB[1] - base[1]) * dust;
      rgba[k + 2] = base[2] + (DUST_RGB[2] - base[2]) * dust;
      rgba[k + 3] = 255;
      rough[k] = rough[k + 1] = rough[k + 2] = (0.9 + dust * 0.08 + (g - 0.5) * 0.06) * 255; rough[k + 3] = 255;
      hgt[y * S + x] = g * 0.5;
    }
  const [c] = toCanvas(rgba, S, S);
  const [rc] = toCanvas(rough, S, S);
  _rubber = { map: tex(c, true), roughnessMap: tex(rc, false), normalMap: heightToNormal(hgt, S, S, 3.0, true, true) };
  return _rubber;
}

// ------------------------------------------------------------------ canister skin (unique, non tiling along length)

/**
 * Canister texture atlas: two canisters side by side (u 0..0.5 = canister A, 0.5..1 = canister B) so the
 * pair does not look copy-pasted. Within each half: u around (0 = bottom, seam hidden underneath, top at
 * the middle of the half), v along (0 = rear/hinge end, 1 = muzzle).
 */
export const CAN_CIRC = 2 * Math.PI * 0.42;
export const CAN_LEN = 8.6;
let _can: TexSet | null = null;
export function canisterTextures(): TexSet {
  if (_can) return _can;
  const W = 512, TW = 1024, H = 2048;
  // camo lattice: 2 cells around each canister (~1.3 m) and 6 along (~1.4 m)
  const fo = fbm(6161, 4, 6, 5, 0.52);
  const fb = fbm(8383, 4, 6, 5, 0.52);
  const aa = 0.012;
  const camoAt = (x: number, y: number): [number, number] => {
    const u = x / TW, v = y / H;
    return [smoothstep(0.53 - aa, 0.53 + aa, fo(u, v)), smoothstep(0.575 - aa, 0.575 + aa, fb(u, v))];
  };
  const { rgba, rough, hgt } = paintPass(TW, H, 1717, camoAt, { wrapX: true, wrapY: false, baseRough: 0.8, chips: 200, grain: 1 });
  const [c, ctx] = toCanvas(rgba, TW, H);
  const [rc, rctx] = toCanvas(rough, TW, H);
  const r = rng(2024);
  const py = (v: number) => (1 - v) * H; // canvas y for v
  const pym = H / CAN_LEN;
  for (const ox of [0, W]) {
    ctx.save();
    ctx.translate(ox, 0);
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();
    rctx.save();
    rctx.translate(ox, 0);
    const setH = (x: number, y: number, v: number) => {
      const xi = Math.min(W - 1, Math.max(0, Math.round(x))) + ox, yi = Math.round(y);
      if (yi >= 0 && yi < H) hgt[yi * TW + xi] = v;
    };
    // longitudinal weld seams
    for (const u of [0.25, 0.75]) {
      const x = u * W;
      ctx.fillStyle = 'rgba(30,26,20,0.35)';
      ctx.fillRect(x, 0, 1.5, H);
      for (let y = 0; y < H; y++) { setH(x, y, 0.6); setH(x + 1, y, 0.55); }
    }
    const glyphRow = (x0: number, y0: number, n: number, gh: number, col: string) => {
      ctx.fillStyle = col;
      let x = x0;
      for (let k = 0; k < n; k++) {
        if (r() < 0.14) { x += gh * 0.6; continue; }
        const gw = gh * (0.45 + r() * 0.25);
        // stencil glyph: two bars with a stencil bridge
        ctx.fillRect(x, y0, gw, gh * 0.45);
        ctx.fillRect(x, y0 + gh * 0.55, gw, gh * 0.45);
        x += gw + gh * 0.22;
      }
    };
    // stencils run along the canister length on the upper flanks
    const stencilBlock = (u: number, v: number, lines: number, gh: number, col: string) => {
      ctx.save();
      ctx.translate(u * W, py(v));
      ctx.rotate(-Math.PI / 2);
      for (let l = 0; l < lines; l++) glyphRow(0, l * gh * 1.6, 8 + Math.floor(r() * 10), gh, col);
      ctx.restore();
    };
    for (const u of [0.34, 0.66]) {
      stencilBlock(u, 0.62, 2, 0.06 * pym, 'rgba(238,232,215,0.85)');
      stencilBlock(u - 0.02, 0.2, 3, 0.05 * pym, 'rgba(25,22,18,0.8)');
      stencilBlock(u + 0.04, 0.86, 1, 0.07 * pym, 'rgba(25,22,18,0.8)');
    }
    // red/yellow ordnance bands near the muzzle
    ctx.fillStyle = 'rgba(150,40,28,0.85)';
    ctx.fillRect(0, py(0.955), W, 0.06 * pym);
    ctx.fillStyle = 'rgba(190,150,40,0.8)';
    ctx.fillRect(0, py(0.94), W, 0.03 * pym);
    // "this side up" arrows on the top
    ctx.fillStyle = 'rgba(235,228,210,0.8)';
    for (const v of [0.28, 0.72]) {
      const x = 0.5 * W, y = py(v);
      ctx.beginPath();
      ctx.moveTo(x - 10, y + 10); ctx.lineTo(x + 10, y + 10); ctx.lineTo(x, y - 12); ctx.closePath();
      ctx.fill();
    }
    // grime streaks running down the flanks (toward u=0 / u=1 = bottom)
    for (let i = 0; i < 260; i++) {
      const side = r() < 0.5 ? 0.25 + r() * 0.2 : 0.55 + r() * 0.2;
      const x0 = side * W, y = r() * H;
      const len = (20 + r() * 80) * (side < 0.5 ? -1 : 1);
      const g = ctx.createLinearGradient(x0, 0, x0 + len, 0);
      g.addColorStop(0, 'rgba(45,38,30,0)');
      g.addColorStop(0.4, `rgba(45,38,30,${0.05 + r() * 0.08})`);
      g.addColorStop(1, 'rgba(45,38,30,0)');
      ctx.fillStyle = g;
      ctx.fillRect(Math.min(x0, x0 + len), y, Math.abs(len), 1 + r() * 2.5);
    }
    // dust on the underside, soot at the rear (hinge) end
    const gb = ctx.createLinearGradient(0, 0, 0.22 * W, 0);
    gb.addColorStop(0, `rgba(${DUST_RGB.join(',')},0.5)`);
    gb.addColorStop(1, `rgba(${DUST_RGB.join(',')},0)`);
    ctx.fillStyle = gb;
    ctx.fillRect(0, 0, 0.22 * W, H);
    const gb2 = ctx.createLinearGradient(W, 0, 0.78 * W, 0);
    gb2.addColorStop(0, `rgba(${DUST_RGB.join(',')},0.5)`);
    gb2.addColorStop(1, `rgba(${DUST_RGB.join(',')},0)`);
    ctx.fillStyle = gb2;
    ctx.fillRect(0.78 * W, 0, 0.22 * W, H);
    const gs = ctx.createLinearGradient(0, H, 0, H - 0.5 * pym);
    gs.addColorStop(0, 'rgba(25,20,16,0.55)');
    gs.addColorStop(1, 'rgba(25,20,16,0)');
    ctx.fillStyle = gs;
    ctx.fillRect(0, H - 0.5 * pym, W, 0.5 * pym);
    rctx.fillStyle = 'rgba(240,240,240,0.35)';
    rctx.fillRect(0, 0, 0.18 * W, H);
    rctx.fillRect(0.82 * W, 0, 0.18 * W, H);
    ctx.restore();
    rctx.restore();
  }
  _can = { map: tex(c, true, true, false), roughnessMap: tex(rc, false, true, false), normalMap: heightToNormal(hgt, TW, H, 2.2, true, false) };
  return _can;
}

// ------------------------------------------------------------------ decal atlas

/** 1024x512 transparent atlas. Regions (u0,v0,u1,v1) exported in DECAL_UV. */
export const DECAL_UV = {
  number: [0, 0.5, 0.5, 1] as const, // "412" tactical number (white stencil)
  plate: [0.5, 0.75, 1, 1] as const, // military license plate
  hazard: [0.5, 0.5, 1, 0.75] as const, // red/white stripe
  text: [0, 0, 0.5, 0.5] as const, // small stencil text block (dark)
  jack: [0.5, 0, 0.75, 0.5] as const, // yellow/black jack warning
  arrow: [0.75, 0, 1, 0.5] as const, // white chevron
};
let _decal: THREE.Texture | null = null;
export function decalTexture(): THREE.Texture {
  if (_decal) return _decal;
  const W = 1024, H = 512;
  const [c, ctx] = canvas(W, H);
  ctx.clearRect(0, 0, W, H);
  const r = rng(55);
  // number: stencil font
  ctx.fillStyle = 'rgba(232,228,214,0.92)';
  ctx.font = 'bold 190px "Arial Narrow", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('412', 256, 128);
  // stencil bridges
  ctx.fillStyle = 'rgba(0,0,0,1)';
  ctx.globalCompositeOperation = 'destination-out';
  for (let x = 120; x < 400; x += 11) if (r() < 0.25) ctx.fillRect(x, 60, 3, 140);
  ctx.fillRect(100, 124, 320, 6);
  ctx.globalCompositeOperation = 'source-over';
  // plate
  ctx.fillStyle = '#141414';
  ctx.fillRect(520, 8, 488, 112);
  ctx.strokeStyle = '#d9d6cc';
  ctx.lineWidth = 5;
  ctx.strokeRect(528, 16, 472, 96);
  ctx.fillStyle = '#e2dfd4';
  ctx.font = 'bold 70px "Arial Narrow", Arial, sans-serif';
  ctx.fillText('47-18 KA', 764, 66);
  // hazard stripes
  ctx.save();
  ctx.beginPath();
  ctx.rect(512, 128, 512, 128);
  ctx.clip();
  ctx.fillStyle = '#b8b2a4';
  ctx.fillRect(512, 128, 512, 128);
  ctx.fillStyle = '#8e231a';
  for (let x = 400; x < 1100; x += 80) {
    ctx.beginPath();
    ctx.moveTo(x, 256); ctx.lineTo(x + 40, 256); ctx.lineTo(x + 168, 128); ctx.lineTo(x + 128, 128); ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  // text block
  ctx.fillStyle = 'rgba(28,26,22,0.85)';
  for (let l = 0; l < 7; l++) {
    let x = 20;
    const y = 290 + l * 30;
    const n = 10 + Math.floor(r() * 16);
    for (let k = 0; k < n && x < 490; k++) {
      if (r() < 0.15) { x += 12; continue; }
      const gw = 9 + r() * 6;
      ctx.fillRect(x, y, gw, 9);
      ctx.fillRect(x, y + 11, gw, 9);
      x += gw + 4;
    }
  }
  // jack warning
  ctx.save();
  ctx.beginPath();
  ctx.rect(512, 256, 256, 256);
  ctx.clip();
  ctx.fillStyle = '#c9a228';
  ctx.fillRect(512, 256, 256, 256);
  ctx.fillStyle = '#1a1a1a';
  for (let x = 380; x < 800; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 512); ctx.lineTo(x + 32, 512); ctx.lineTo(x + 288, 256); ctx.lineTo(x + 256, 256); ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  // chevron
  ctx.fillStyle = 'rgba(232,228,214,0.9)';
  ctx.beginPath();
  ctx.moveTo(800, 470); ctx.lineTo(896, 300); ctx.lineTo(992, 470); ctx.lineTo(950, 470); ctx.lineTo(896, 375); ctx.lineTo(842, 470);
  ctx.closePath();
  ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  _decal = t;
  return t;
}
