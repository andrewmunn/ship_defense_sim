import * as THREE from 'three';
import { rng } from './geom';
import { LOA, Z_BOW, Z_STERN, deckY, hbDeck } from './hulldef';
import { HULL_G0, HULL_G1 } from './hull';

/**
 * Procedural texture generation (canvas + Sobel normal maps). All results cached at module level.
 */

type Ctx = CanvasRenderingContext2D;

export function canvas(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  return [c, ctx];
}

/** Low-res random noise canvas (smoothly upscaled when drawn). */
function noiseCanvas(w: number, h: number, seed: number, lo = 0, hi = 255) {
  const [c, ctx] = canvas(w, h);
  const img = ctx.createImageData(w, h);
  const r = rng(seed);
  for (let i = 0; i < w * h; i++) {
    const v = lo + (hi - lo) * r();
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Draw fractal noise onto ctx using stretched low-res noise layers. */
function fractal(ctx: Ctx, w: number, h: number, seed: number, alpha: number, op: GlobalCompositeOperation = 'overlay', base = 8, octaves = 4, aspect = 1, tile = false) {
  ctx.save();
  ctx.globalCompositeOperation = op;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  for (let o = 0; o < octaves; o++) {
    const nw = Math.max(2, Math.round(base * Math.pow(2, o) * aspect));
    const nh = Math.max(2, Math.round(base * Math.pow(2, o)));
    const n = noiseCanvas(nw, nh, seed + o * 101);
    ctx.globalAlpha = alpha / Math.pow(1.6, o);
    if (tile) {
      // draw with 1-cell padding wrap for tileability
      const [pc, pctx] = canvas(nw + 2, nh + 2);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) pctx.drawImage(n, 1 + dx * nw, 1 + dy * nh);
      const sx = w / nw, sy = h / nh;
      ctx.drawImage(pc, -sx, -sy, w + 2 * sx, h + 2 * sy);
    } else ctx.drawImage(n, 0, 0, w, h);
  }
  ctx.restore();
}

/** Height (grayscale canvas, R channel) -> normal map DataTexture. */
function heightToNormal(src: HTMLCanvasElement, strength: number, wrap: boolean): THREE.DataTexture {
  const w = src.width, h = src.height;
  const d = src.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const hgt = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) hgt[i] = d[i * 4] / 255;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ym = wrap ? (y - 1 + h) % h : Math.max(0, y - 1);
    const yp = wrap ? (y + 1) % h : Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const xm = wrap ? (x - 1 + w) % w : Math.max(0, x - 1);
      const xp = wrap ? (x + 1) % w : Math.min(w - 1, x + 1);
      const tl = hgt[ym * w + xm], t = hgt[ym * w + x], tr = hgt[ym * w + xp];
      const l = hgt[y * w + xm], r = hgt[y * w + xp];
      const bl = hgt[yp * w + xm], b = hgt[yp * w + x], br = hgt[yp * w + xp];
      const dx = (tr + 2 * r + br - tl - 2 * l - bl) * strength;
      const dy = (bl + 2 * b + br - tl - 2 * t - tr) * strength;
      // canvas y goes down; texture v goes up (flipY) -> green = +dy
      let nx = -dx, ny = dy, nz = 1;
      const L = Math.hypot(nx, ny, nz);
      nx /= L; ny /= L; nz /= L;
      const k = (y * w + x) * 4;
      out[k] = (nx * 0.5 + 0.5) * 255;
      out[k + 1] = (ny * 0.5 + 0.5) * 255;
      out[k + 2] = (nz * 0.5 + 0.5) * 255;
      out[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
  tex.flipY = false;
  // DataTexture rows start at v=0: flip the rows so it matches CanvasTexture (flipY=true)
  const row = w * 4;
  const tmp = new Uint8Array(row);
  for (let y = 0; y < h / 2; y++) {
    const a = y * row, b = (h - 1 - y) * row;
    tmp.set(out.subarray(a, a + row));
    out.copyWithin(a, b, b + row);
    out.set(tmp, b);
  }
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function canvasTex(c: HTMLCanvasElement, srgb: boolean, wrap: boolean) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

export interface PBRSet {
  map: THREE.Texture;
  roughnessMap?: THREE.Texture;
  normalMap?: THREE.Texture;
}

// ------------------------------------------------------------------ colors
export const HAZE = '#787d7e';
export const HAZE_RGB = [120, 125, 126];
export const DECK = '#4a4d4f';

let _hull: PBRSet | null = null;
/** Unique hull side texture. u: 0 = bow .. 1 = stern; v: girth from WL (HULL_G0..HULL_G1). */
export function hullTextures(): PBRSet {
  if (_hull) return _hull;
  const W = 4096, H = 1024;
  const pxm = W / LOA; // px per meter along length
  const X = (z: number) => ((Z_BOW - z) / LOA) * W;
  const Y = (g: number) => (1 - (g - HULL_G0) / (HULL_G1 - HULL_G0)) * H;
  const pym = H / (HULL_G1 - HULL_G0);
  const r = rng(1234);

  const [c, ctx] = canvas(W, H);
  const [rc, rctx] = canvas(W, H); // roughness
  const [hc, hctx] = canvas(W, H); // height

  // ---- base colors
  ctx.fillStyle = HAZE;
  ctx.fillRect(0, 0, W, H);
  fractal(ctx, W, H, 11, 0.012, 'overlay', 6, 4, 4);
  // plate-to-plate tone variation, aligned with the strake/butt weld grid below (low contrast)
  const strakesC = [-13.5, -10.8, -8.1, -5.6, -3.4, -1.4, 1.2, 3.3, 5.4, 7.6, 9.9];
  for (let s = 0; s < strakesC.length + 1; s++) {
    const g0 = s === 0 ? HULL_G0 : strakesC[s - 1];
    const g1 = s === strakesC.length ? HULL_G1 : strakesC[s];
    if (g1 < 0.8) continue;
    const off = (s % 3) * 2.1;
    for (let z = Z_STERN + off - 6.1; z < Z_BOW; z += 6.1 + (s % 2) * 0.4) {
      const touch = r() < 0.06;
      const d = touch ? (r() - 0.4) * 14 : (r() - 0.5) * 6;
      ctx.fillStyle = d > 0 ? `rgba(255,255,250,${d / 255})` : `rgba(20,22,24,${-d / 180})`;
      ctx.fillRect(X(z + 6.1 + (s % 2) * 0.4), Y(g1), X(z) - X(z + 6.1 + (s % 2) * 0.4), Y(Math.max(g0, 0.8)) - Y(g1));
    }
  }
  // sun-fade drift, very soft
  for (let i = 0; i < 60; i++) {
    const x = r() * W, y = Y(1 + r() * 10), rad = (4 + r() * 12) * pxm;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, r() < 0.5 ? 'rgba(235,238,235,0.03)' : 'rgba(30,34,36,0.035)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.save(); ctx.translate(x, y); ctx.scale(1, 0.35); ctx.translate(-x, -y);
    ctx.fillRect(x - rad, y - rad, 2 * rad, 2 * rad);
    ctx.restore();
  }
  // waterline grime: darkens toward the boot-top, streaky (spray + scum), heavier forward and aft
  for (let x = 0; x < W; x += 2) {
    const z = Z_BOW - (x / W) * LOA;
    const heavy = 1 + 0.5 * Math.max(0, (z - 30) / 40) + 0.4 * Math.max(0, (-z - 50) / 25);
    const top = 1.6 + r() * 1.6 * heavy;
    const g = ctx.createLinearGradient(0, Y(top), 0, Y(0.8));
    const a = (0.1 + r() * 0.1) * heavy;
    g.addColorStop(0, 'rgba(62,64,52,0)');
    g.addColorStop(0.7, `rgba(62,64,52,${a * 0.6})`);
    g.addColorStop(1, `rgba(55,56,44,${a})`);
    ctx.fillStyle = g;
    ctx.fillRect(x, Y(top), 2, Y(0.8) - Y(top));
  }
  // thin brown scum line right above the boot-top
  ctx.fillStyle = 'rgba(85,72,52,0.35)';
  ctx.fillRect(0, Y(0.95), W, Y(0.8) - Y(0.95));
  // salt: whitish horizontal smears in the spray zone and dried drips under the deck edge
  for (let i = 0; i < 420; i++) {
    const z = Z_STERN + r() * LOA;
    const fwd = Math.max(0, (z + 10) / 80);
    if (r() > 0.35 + fwd) continue;
    const x = X(z), y = Y(1.2 + r() * (2.5 + fwd * 4));
    const w = (0.5 + r() * 3.5) * pxm, h = (0.08 + r() * 0.35) * pym;
    const g = ctx.createRadialGradient(x, y, 0, x, y, w / 2);
    g.addColorStop(0, `rgba(222,224,216,${0.05 + r() * 0.08})`);
    g.addColorStop(1, 'rgba(222,224,216,0)');
    ctx.fillStyle = g;
    ctx.save(); ctx.translate(x, y); ctx.scale(1, h / w); ctx.translate(-x, -y);
    ctx.fillRect(x - w / 2, y - w / 2, w, w);
    ctx.restore();
  }

  // waterline dirt band above boot-top
  let gr = ctx.createLinearGradient(0, Y(1.8), 0, Y(0.5));
  gr.addColorStop(0, 'rgba(70,72,65,0)');
  gr.addColorStop(1, 'rgba(70,72,65,0.1)');
  ctx.fillStyle = gr;
  ctx.fillRect(0, Y(1.8), W, Y(0.5) - Y(1.8));

  // boot-topping (black) and antifouling (dark red)
  const BT_TOP = 0.8, BT_BOT = -0.6;
  ctx.fillStyle = '#1e1f21';
  ctx.fillRect(0, Y(BT_TOP), W, Y(BT_BOT) - Y(BT_TOP));
  ctx.fillStyle = '#6b2e2a';
  ctx.fillRect(0, Y(BT_BOT), W, H - Y(BT_BOT));
  fractal(ctx, W, Math.ceil(H - Y(BT_BOT)), 23, 0.08, 'overlay', 6, 4, 4);
  // fouling slime on red near WL
  gr = ctx.createLinearGradient(0, Y(BT_BOT), 0, Y(-1.6));
  gr.addColorStop(0, 'rgba(120,70,60,0.18)');
  gr.addColorStop(1, 'rgba(120,70,60,0)');
  ctx.fillStyle = gr;
  ctx.fillRect(0, Y(BT_BOT), W, Y(-3) - Y(BT_BOT));
  // prairie-masker belts (subtle lighter bands below WL)
  for (const z of [6, -20]) {
    ctx.fillStyle = 'rgba(120,70,60,0.35)';
    ctx.fillRect(X(z), Y(-1.2), 0.35 * pxm, H);
  }

  // ---- roughness
  rctx.fillStyle = 'rgb(160,160,160)';
  rctx.fillRect(0, 0, W, H);
  fractal(rctx, W, H, 31, 0.05, 'overlay', 8, 3, 4);
  fractal(rctx, W, H, 32, 0.08, 'overlay', 128, 2, 4);
  rctx.fillStyle = 'rgb(128,128,128)';
  rctx.fillRect(0, Y(BT_TOP), W, Y(BT_BOT) - Y(BT_TOP));
  rctx.fillStyle = 'rgb(200,200,200)';
  rctx.fillRect(0, Y(BT_BOT), W, H - Y(BT_BOT));

  // ---- height: plating, welds, frame dishing
  hctx.fillStyle = 'rgb(128,128,128)';
  hctx.fillRect(0, 0, W, H);
  // hungry-horse dishing between frames (frame spacing ~1.22 m)
  {
    const fw = 1.22 * pxm;
    const [pc, pctx] = canvas(Math.max(2, Math.round(fw)), 4);
    const pg = pctx.createLinearGradient(0, 0, pc.width, 0);
    pg.addColorStop(0, 'rgb(150,150,150)');
    pg.addColorStop(0.5, 'rgb(110,110,110)');
    pg.addColorStop(1, 'rgb(150,150,150)');
    pctx.fillStyle = pg;
    pctx.fillRect(0, 0, pc.width, 4);
    hctx.globalAlpha = 0.35;
    hctx.fillStyle = hctx.createPattern(pc, 'repeat')!;
    hctx.fillRect(0, 0, W, H);
    hctx.globalAlpha = 1;
  }
  fractal(hctx, W, H, 41, 0.05, 'overlay', 16, 3, 4);
  // strakes (horizontal welds) and butts (vertical welds)
  const strakes = [-13.5, -10.8, -8.1, -5.6, -3.4, -1.4, 1.2, 3.3, 5.4, 7.6, 9.9];
  const weld = (x0: number, y0: number, x1: number, y1: number) => {
    hctx.strokeStyle = 'rgb(200,200,200)';
    hctx.lineWidth = 2;
    hctx.beginPath(); hctx.moveTo(x0, y0); hctx.lineTo(x1, y1); hctx.stroke();
    hctx.strokeStyle = 'rgb(95,95,95)';
    hctx.lineWidth = 1;
    hctx.beginPath(); hctx.moveTo(x0 + (y0 === y1 ? 0 : 2), y0 + (y0 === y1 ? 2 : 0)); hctx.lineTo(x1 + (y0 === y1 ? 0 : 2), y1 + (y0 === y1 ? 2 : 0)); hctx.stroke();
    // albedo: faint seam line
    ctx.strokeStyle = 'rgba(40,40,40,0.05)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  };
  for (const g of strakes) weld(0, Y(g), W, Y(g));
  for (let s = 0; s < strakes.length + 1; s++) {
    const g0 = s === 0 ? HULL_G0 : strakes[s - 1];
    const g1 = s === strakes.length ? HULL_G1 : strakes[s];
    const off = (s % 3) * 2.1;
    for (let z = Z_STERN + off; z < Z_BOW; z += 6.1 + (s % 2) * 0.4) weld(X(z), Y(g1), X(z), Y(g0));
  }

  // ---- streaks: scuppers along deck edge, overboard discharges, hawse pipe
  const streak = (x: number, g0: number, len: number, wpx: number, col: string, a: number) => {
    const y0 = Y(g0), y1 = Y(g0 - len);
    const sg = ctx.createLinearGradient(0, y0, 0, y1);
    sg.addColorStop(0, col.replace('A', String(a)));
    sg.addColorStop(0.3, col.replace('A', String(a * 0.7)));
    sg.addColorStop(1, col.replace('A', '0'));
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.moveTo(x - wpx / 2, y0);
    ctx.lineTo(x + wpx / 2, y0);
    ctx.lineTo(x + wpx * 0.9, y1);
    ctx.lineTo(x - wpx * 0.9, y1);
    ctx.fill();
    rctx.fillStyle = `rgba(215,215,215,${a * 0.6})`;
    rctx.fillRect(x - wpx / 2, y0, wpx, (y1 - y0) * 0.6);
  };
  // scuppers
  for (let z = Z_STERN + 6; z < 60; z += 4 + r() * 13) {
    const gd = deckY(z) - 0.35;
    const x = X(z);
    ctx.fillStyle = 'rgba(25,25,25,0.85)';
    ctx.fillRect(x - 2, Y(gd) - 2, 4 + r() * 3, 4);
    if (r() < 0.65) streak(x + (r() - 0.5) * 3, gd - 0.1, 0.4 + r() * 2.2, 2 + r() * 4, 'rgba(100,64,40,A)', 0.2 + r() * 0.25);
    for (let k = 0; k < 2; k++) if (r() < 0.6) streak(x + (r() - 0.5) * 12, gd - 0.1, 0.3 + r() * 1.8, 1 + r() * 2, 'rgba(60,50,42,A)', 0.12 + r() * 0.2);
  }
  // overboard discharges
  for (let i = 0; i < 7; i++) {
    const z = -60 + r() * 110, g = 1.8 + r() * 3.5;
    const x = X(z);
    ctx.fillStyle = 'rgba(30,30,30,0.9)';
    ctx.beginPath(); ctx.arc(x, Y(g), 0.09 * pxm, 0, Math.PI * 2); ctx.fill();
    streak(x, g - 0.1, 0.6 + r() * 1.2, 3 + r() * 4, 'rgba(95,70,50,A)', 0.2 + r() * 0.2);
  }
  // general thin rust/grime streaks
  for (let i = 0; i < 300; i++) {
    const z = Z_STERN + r() * LOA;
    const gd = Math.min(deckY(z), 11) - r() * 5;
    const rust = r() < 0.4;
    streak(X(z), gd, 0.3 + r() * 2.5, 0.8 + r() * 2.0, rust ? 'rgba(110,65,35,A)' : 'rgba(50,52,50,A)', 0.06 + r() * 0.14);
  }
  // long directional drips from the deck edge (run-off), fine and faint
  for (let z = Z_STERN + 1; z < 72; z += 0.35 + r() * 0.8) {
    const gd = deckY(z) - 0.12;
    streak(X(z), gd, 0.6 + r() * 3.5, 0.8 + r() * 1.5, r() < 0.3 ? 'rgba(110,68,40,A)' : 'rgba(58,60,58,A)', 0.04 + r() * 0.09);
  }
  // hawse pipe rust (heavy)
  for (let k = 0; k < 14; k++) streak(X(63.6) + (r() - 0.5) * 1.1 * pxm, 5.8, 1.0 + r() * 4.0, 1.5 + r() * 4, 'rgba(92,60,40,A)', 0.07 + r() * 0.13);
  // bow wave wear near stem at waterline (scuffed paint)
  gr = ctx.createLinearGradient(X(Z_BOW), 0, X(40), 0);
  gr.addColorStop(0, 'rgba(90,70,60,0.35)');
  gr.addColorStop(1, 'rgba(90,70,60,0)');
  ctx.fillStyle = gr;
  ctx.fillRect(X(Z_BOW), Y(2.2), X(40) - X(Z_BOW), Y(0.55) - Y(2.2));
  // deck edge line: darker gutter
  ctx.strokeStyle = 'rgba(30,32,34,0.5)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let z = Z_STERN; z <= 60; z += 1) {
    const x = X(z), y = Y(deckY(z) - 0.05);
    if (z === Z_STERN) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  const map = canvasTex(c, true, false);
  const roughnessMap = canvasTex(rc, false, false);
  const normalMap = heightToNormal(hc, 1.5, false);
  normalMap.wrapS = normalMap.wrapT = THREE.ClampToEdgeWrapping;
  _hull = { map, roughnessMap, normalMap };
  return _hull;
}

let _paint: PBRSet | null = null;
let _paintFine: PBRSet | null = null;
/**
 * Tiled haze-gray paint (8 m tile, box-projected uv0). Clean, low-contrast: the positional weathering lives in
 * the unique weather atlas (weather.ts) for static geometry. The structural version carries the weld grid
 * (rows every 2 m, butts every 8/3 m, alternate rows staggered) plus faint plate dishing; the fine version
 * (fittings) only has orange-peel.
 */
export function paintTextures(fine = false): PBRSet {
  if (!fine && _paint) return _paint;
  if (fine && _paintFine) return _paintFine;
  const S = 1024;
  const ppm = S / 8;
  const r = rng(fine ? 77 : 55);
  const [c, ctx] = canvas(S, S);
  const [rc, rctx] = canvas(S, S);
  const [hc, hctx] = canvas(S, S);
  ctx.fillStyle = HAZE;
  ctx.fillRect(0, 0, S, S);
  fractal(ctx, S, S, fine ? 5 : 7, 0.012, 'overlay', 8, 4, 1, true);
  const wrapRect = (cx: Ctx, x: number, y: number, w: number, h: number) => {
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) cx.fillRect(x + dx, y + dy, w, h);
  };
  // roughness: satin paint ~0.62 with faint low-frequency variation and fine speckle
  rctx.fillStyle = 'rgb(158,158,158)';
  rctx.fillRect(0, 0, S, S);
  fractal(rctx, S, S, 13, 0.06, 'overlay', 4, 3, 1, true);
  fractal(rctx, S, S, 14, 0.08, 'overlay', 64, 2, 1, true);
  // height
  hctx.fillStyle = 'rgb(128,128,128)';
  hctx.fillRect(0, 0, S, S);
  // orange peel
  fractal(hctx, S, S, 15, fine ? 0.05 : 0.04, 'overlay', 128, 2, 1, true);
  if (!fine) {
    const W = 8 / 3;
    for (let k = 0; k < 4; k++) {
      // world row y in [2k, 2k+2] -> canvas rows p0..p1 (canvas y down, texture flipY)
      const p0 = S * (1 - (2 * k + 2) / 8), p1 = S * (1 - (2 * k) / 8);
      const st = (k % 2) * (W / 2);
      // plate dishing between stiffeners (vertical frames every ~0.67 m): very soft
      for (let x = 0; x < S; x += (W / 4) * ppm) {
        const g = hctx.createLinearGradient(x, 0, x + (W / 4) * ppm, 0);
        g.addColorStop(0, 'rgba(150,150,150,0.25)');
        g.addColorStop(0.5, 'rgba(110,110,110,0.25)');
        g.addColorStop(1, 'rgba(150,150,150,0.25)');
        hctx.fillStyle = g;
        hctx.fillRect(x, p0, (W / 4) * ppm, p1 - p0);
      }
      // horizontal weld bead at the bottom of the row + vertical butts
      hctx.fillStyle = 'rgb(178,178,178)';
      wrapRect(hctx, 0, p1 - 1.5, S, 3);
      hctx.fillStyle = 'rgb(150,150,150)';
      wrapRect(hctx, 0, p1 - 2.5, S, 1);
      for (let j = 0; j < 3; j++) {
        const x = (j * W + st) * ppm;
        hctx.fillStyle = 'rgb(178,178,178)';
        wrapRect(hctx, x - 1.5, p0, 3, p1 - p0);
        // albedo: the faintest seam line (paint pooling)
        ctx.fillStyle = 'rgba(40,42,44,0.07)';
        wrapRect(ctx, x - 1, p0, 2, p1 - p0);
      }
      ctx.fillStyle = 'rgba(40,42,44,0.07)';
      wrapRect(ctx, 0, p1 - 1, S, 2);
      // weld seams are slightly rougher
      rctx.fillStyle = 'rgba(190,190,190,0.6)';
      wrapRect(rctx, 0, p1 - 2, S, 4);
      for (let j = 0; j < 3; j++) wrapRect(rctx, (j * W + st) * ppm - 2, p0, 4, p1 - p0);
    }
  }
  // a few faint vertical grime streaks so non-atlas parts are not sterile
  for (let i = 0; i < (fine ? 30 : 20); i++) {
    const x = r() * S, y = r() * S, len = 30 + r() * 160, w = 1 + r() * 2;
    const a = 0.02 + r() * 0.04;
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) {
      const g = ctx.createLinearGradient(0, y + dy, 0, y + dy + len);
      g.addColorStop(0, `rgba(60,62,62,${a})`);
      g.addColorStop(1, 'rgba(60,62,62,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x + dx, y + dy, w, len);
    }
  }
  const set: PBRSet = {
    map: canvasTex(c, true, true),
    roughnessMap: canvasTex(rc, false, true),
    normalMap: heightToNormal(hc, fine ? 1.0 : 1.6, true),
  };
  set.normalMap!.wrapS = set.normalMap!.wrapT = THREE.RepeatWrapping;
  if (fine) _paintFine = set;
  else _paint = set;
  return set;
}

let _nonskid: { normalMap: THREE.Texture; roughnessMap: THREE.Texture } | null = null;
/** Tiled non-skid (3 m tile): grit normal + roughness. */
export function nonskidTextures() {
  if (_nonskid) return _nonskid;
  const S = 512;
  const [hc, hctx] = canvas(S, S);
  const img = hctx.createImageData(S, S);
  const r = rng(99);
  for (let i = 0; i < S * S; i++) {
    const v = 110 + r() * 40;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  hctx.putImageData(img, 0, 0);
  fractal(hctx, S, S, 3, 0.25, 'overlay', 8, 3, 1, true);
  const [rc, rctx] = canvas(S, S);
  rctx.fillStyle = 'rgb(225,225,225)';
  rctx.fillRect(0, 0, S, S);
  fractal(rctx, S, S, 4, 0.35, 'overlay', 4, 4, 1, true);
  _nonskid = { normalMap: heightToNormal(hc, 0.9, true), roughnessMap: canvasTex(rc, false, true) };
  _nonskid.normalMap.wrapS = _nonskid.normalMap.wrapT = THREE.RepeatWrapping;
  return _nonskid;
}

let _deckAtlas: THREE.Texture | null = null;
/** Unique deck color atlas: u=(x+10.1)/20.2, v=(z-Z_STERN)/LOA. Flight-deck markings, wear, stains. */
export function deckAtlas() {
  if (_deckAtlas) return _deckAtlas;
  const W = 512, H = 4096;
  const pxm = W / 20.2, pzm = H / LOA;
  const X = (x: number) => ((x + 10.1) / 20.2) * W;
  const Y = (z: number) => (1 - (z - Z_STERN) / LOA) * H;
  const r = rng(4321);
  const [c, ctx] = canvas(W, H);
  ctx.fillStyle = DECK;
  ctx.fillRect(0, 0, W, H);
  fractal(ctx, W, H, 61, 0.08, 'overlay', 4, 5, 0.125);
  // worn/scuffed lighter patches
  for (let i = 0; i < 900; i++) {
    const z = Z_STERN + r() * LOA, x = (r() - 0.5) * 18;
    ctx.fillStyle = `rgba(${90 + r() * 30},${92 + r() * 30},${95 + r() * 30},${0.02 + r() * 0.05})`;
    ctx.beginPath();
    ctx.ellipse(X(x), Y(z), (0.1 + r() * 0.5) * pxm, (0.3 + r() * 2.5) * pzm, (r() - 0.5) * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  // dark stains
  for (let i = 0; i < 160; i++) {
    const z = Z_STERN + r() * LOA, x = (r() - 0.5) * 18;
    ctx.fillStyle = `rgba(20,20,18,${0.04 + r() * 0.08})`;
    ctx.beginPath();
    ctx.ellipse(X(x), Y(z), (0.1 + r() * 0.5) * pxm, (0.1 + r() * 0.6) * pzm, r() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // rust near deck edges
  for (let i = 0; i < 260; i++) {
    const z = Z_STERN + r() * LOA;
    const hb = hbDeck(z);
    const x = (r() < 0.5 ? -1 : 1) * (hb - r() * 0.6);
    ctx.fillStyle = `rgba(110,62,32,${0.1 + r() * 0.25})`;
    ctx.fillRect(X(x) - 2, Y(z), 3 + r() * 5, (0.1 + r() * 0.6) * pzm);
  }
  // foc'sle: bare-steel chain run from hawse to windlass
  for (const s of [1, -1]) {
    ctx.strokeStyle = 'rgba(95,85,75,0.55)';
    ctx.lineWidth = 0.7 * pxm;
    ctx.beginPath();
    ctx.moveTo(X(s * 5.6), Y(64.2));
    ctx.lineTo(X(s * 1.1), Y(59.4));
    ctx.stroke();
  }
  // ---- flight deck (z from Z_STERN to hangar face)
  const fz0 = Z_STERN, fz1 = -56.4;
  ctx.fillStyle = 'rgba(28,30,32,0.55)';
  ctx.fillRect(X(-8.9), Y(fz1), X(8.9) - X(-8.9), Y(fz0) - Y(fz1));
  fractal(ctx, W, H, 71, 0.08, 'overlay', 8, 3, 0.125);
  const white = 'rgba(225,225,220,0.92)';
  const yellow = 'rgba(215,180,40,0.9)';
  ctx.strokeStyle = white;
  // deck-edge lines
  ctx.lineWidth = 0.15 * pxm;
  for (const s of [1, -1]) {
    ctx.beginPath();
    for (let z = fz0 + 0.3; z <= fz1; z += 0.5) {
      const x = s * (hbDeck(z) - 0.45);
      if (z === fz0 + 0.3) ctx.moveTo(X(x), Y(z)); else ctx.lineTo(X(x), Y(z));
    }
    ctx.stroke();
  }
  // lineup line along centerline (white) + RAST track (steel strip)
  ctx.fillStyle = 'rgba(70,72,74,1)';
  ctx.fillRect(X(-0.35), Y(fz1 - 0.2), 0.7 * pxm, Y(fz0 + 3.0) - Y(fz1 - 0.2));
  ctx.fillStyle = 'rgba(40,40,40,1)';
  ctx.fillRect(X(-0.08), Y(fz1 - 0.2), 0.16 * pxm, Y(fz0 + 3.0) - Y(fz1 - 0.2));
  ctx.fillStyle = white;
  ctx.fillRect(X(-0.55), Y(fz1 - 0.1), 0.12 * pxm, Y(fz0 + 0.8) - Y(fz1 - 0.1));
  ctx.fillRect(X(0.43), Y(fz1 - 0.1), 0.12 * pxm, Y(fz0 + 0.8) - Y(fz1 - 0.1));
  // touchdown circle
  const cz = -68.2;
  ctx.lineWidth = 0.18 * pzm;
  ctx.beginPath();
  ctx.ellipse(X(0), Y(cz), 2.6 * pxm, 2.6 * pzm, 0, 0, Math.PI * 2);
  ctx.stroke();
  // athwartships lines (shoulder / hangar clear)
  ctx.fillStyle = white;
  ctx.fillRect(X(-7.5), Y(cz) - 0.08 * pzm, 15 * pxm, 0.16 * pzm);
  ctx.fillStyle = yellow;
  ctx.fillRect(X(-8.5), Y(fz1 - 2.2), 17 * pxm, 0.15 * pzm);
  // wave-off / hazard hatching near hangar face
  for (let x = -8.4; x < 8.4; x += 1.2) {
    ctx.fillStyle = 'rgba(215,180,40,0.6)';
    ctx.fillRect(X(x), Y(fz1 - 0.5), 0.6 * pxm, 0.3 * pzm);
  }
  // tie-down pattern (small dark dots)
  ctx.fillStyle = 'rgba(15,15,15,0.8)';
  for (let z = fz0 + 1.5; z < fz1 - 1; z += 1.25)
    for (let x = -7.5; x <= 7.5; x += 1.25) {
      if (Math.abs(x) < 0.7) continue;
      ctx.beginPath(); ctx.arc(X(x), Y(z), 1.6, 0, Math.PI * 2); ctx.fill();
    }
  // tire marks
  for (let i = 0; i < 40; i++) {
    ctx.strokeStyle = `rgba(15,15,15,${0.05 + r() * 0.1})`;
    ctx.lineWidth = 0.3 * pxm;
    const x = (r() - 0.5) * 6, z = cz + (r() - 0.5) * 6;
    ctx.beginPath(); ctx.moveTo(X(x), Y(z)); ctx.lineTo(X(x + (r() - 0.5)), Y(z + 1 + r() * 3)); ctx.stroke();
  }
  _deckAtlas = canvasTex(c, true, false);
  return _deckAtlas;
}

let _array: PBRSet | null = null;
/** Sentinel phased-array face (octagon, planar UV 0..1): sub-array tile grid, element bumps, glossier coating. */
export function arrayTextures(): PBRSet {
  if (_array) return _array;
  const S = 1024;
  const r = rng(808);
  const [c, ctx] = canvas(S, S);
  const [hc, hctx] = canvas(S, S);
  const [rc, rctx] = canvas(S, S);
  ctx.fillStyle = '#687074';
  ctx.fillRect(0, 0, S, S);
  hctx.fillStyle = 'rgb(128,128,128)';
  hctx.fillRect(0, 0, S, S);
  rctx.fillStyle = 'rgb(105,105,105)';
  rctx.fillRect(0, 0, S, S);
  const n = 12; // ~0.3 m sub-array tiles
  const tp = S / n;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const d = (r() - 0.5) * 7;
      ctx.fillStyle = d > 0 ? `rgba(255,255,255,${d / 255})` : `rgba(0,0,0,${-d / 200})`;
      ctx.fillRect(i * tp, j * tp, tp, tp);
      // element bumps: 6x6 per tile
      hctx.fillStyle = 'rgb(146,146,146)';
      for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) {
        hctx.beginPath();
        hctx.arc(i * tp + (a + 0.5) * (tp / 6), j * tp + (b + 0.5) * (tp / 6), tp / 20, 0, Math.PI * 2);
        hctx.fill();
      }
    }
  // grooves between tiles
  for (let i = 0; i <= n; i++) {
    const p = i * tp;
    ctx.fillStyle = 'rgba(28,32,34,0.3)';
    ctx.fillRect(p - 2, 0, 4, S);
    ctx.fillRect(0, p - 2, S, 4);
    hctx.fillStyle = 'rgb(84,84,84)';
    hctx.fillRect(p - 3, 0, 6, S);
    hctx.fillRect(0, p - 3, S, 6);
    rctx.fillStyle = 'rgb(170,170,170)';
    rctx.fillRect(p - 3, 0, 6, S);
    rctx.fillRect(0, p - 3, S, 6);
  }
  // quadrant (sub-array module) seams, stronger
  for (const p of [S / 3, (2 * S) / 3]) {
    ctx.fillStyle = 'rgba(20,24,26,0.4)';
    ctx.fillRect(p - 3, 0, 6, S);
    ctx.fillRect(0, p - 3, S, 6);
  }
  fractal(ctx, S, S, 81, 0.03, 'overlay', 4, 3);
  // faint salt / grime streaks
  for (let i = 0; i < 50; i++) {
    const x = r() * S, y = r() * S * 0.6, len = 60 + r() * 300;
    const g = ctx.createLinearGradient(0, y, 0, y + len);
    g.addColorStop(0, `rgba(${r() < 0.3 ? '105,62,35' : r() < 0.5 ? '210,212,205' : '40,42,44'},${0.05 + r() * 0.1})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, 1 + r() * 3, len);
  }
  _array = { map: canvasTex(c, true, false), normalMap: heightToNormal(hc, 2.2, false), roughnessMap: canvasTex(rc, false, false) };
  return _array;
}

let _radome: PBRSet | null = null;
/** Radome shell (cylindrical/spherical uv: u around, v along): off-white with gore seams, satin sheen. */
export function radomeTextures(): PBRSet {
  if (_radome) return _radome;
  const W = 512, H = 256;
  const r = rng(313);
  const [c, ctx] = canvas(W, H);
  const [hc, hctx] = canvas(W, H);
  ctx.fillStyle = '#d9dad3';
  ctx.fillRect(0, 0, W, H);
  fractal(ctx, W, H, 314, 0.02, 'overlay', 4, 3, 2, true);
  hctx.fillStyle = 'rgb(128,128,128)';
  hctx.fillRect(0, 0, W, H);
  const gores = 12;
  for (let i = 0; i < gores; i++) {
    const x = (i / gores) * W;
    const d = (r() - 0.5) * 6;
    ctx.fillStyle = d > 0 ? `rgba(255,255,255,${d / 255})` : `rgba(0,0,0,${-d / 255})`;
    ctx.fillRect(x, 0, W / gores, H);
    ctx.fillStyle = 'rgba(90,92,88,0.18)';
    ctx.fillRect(x - 1, 0, 2, H);
    hctx.fillStyle = 'rgb(160,160,160)';
    hctx.fillRect(x - 1.5, 0, 3, H);
  }
  for (const v of [0.34, 0.67]) {
    ctx.fillStyle = 'rgba(90,92,88,0.15)';
    ctx.fillRect(0, v * H - 1, W, 2);
    hctx.fillStyle = 'rgb(160,160,160)';
    hctx.fillRect(0, v * H - 1.5, W, 3);
  }
  // grime collecting low on the shell
  const g = ctx.createLinearGradient(0, H * 0.55, 0, H);
  g.addColorStop(0, 'rgba(80,80,70,0)');
  g.addColorStop(1, 'rgba(80,80,70,0.12)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  _radome = { map: canvasTex(c, true, true), normalMap: heightToNormal(hc, 1.2, true) };
  _radome.normalMap!.wrapS = _radome.normalMap!.wrapT = THREE.RepeatWrapping;
  return _radome;
}

let _flag: THREE.Texture | null = null;
/** Fictional naval ensign: navy field, white chevron and star (not any real nation's flag). */
export function flagTexture() {
  if (_flag) return _flag;
  const [c, ctx] = canvas(256, 160);
  ctx.fillStyle = '#1b2a4a';
  ctx.fillRect(0, 0, 256, 160);
  ctx.fillStyle = '#e8e8e2';
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(40, 0); ctx.lineTo(128, 80); ctx.lineTo(40, 160); ctx.lineTo(0, 160); ctx.lineTo(88, 80); ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#b8342a';
  ctx.fillRect(150, 66, 106, 28);
  ctx.fillStyle = '#e8e8e2';
  const star = (cx: number, cy: number, R: number) => {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? R * 0.42 : R;
      ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    ctx.fill();
  };
  star(200, 36, 18);
  _flag = canvasTex(c, true, false);
  return _flag;
}

let _num: THREE.Texture | null = null;
/** Hull number decal "01" (white w/ black shadow), alpha. */
export function hullNumberTexture() {
  if (_num) return _num;
  const [c, ctx] = canvas(1024, 512);
  ctx.clearRect(0, 0, 1024, 512);
  ctx.font = 'bold 430px Helvetica, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // block-shadow
  ctx.fillStyle = 'rgba(15,15,15,0.95)';
  for (let k = 1; k <= 16; k++) ctx.fillText('01', 512 + k * 0.7, 262 + k * 0.9);
  ctx.fillStyle = 'rgba(236,236,232,1)';
  ctx.fillText('01', 512, 262);
  // weathering: knock back alpha with noise
  ctx.globalCompositeOperation = 'destination-out';
  const r = rng(5);
  for (let i = 0; i < 700; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.1 + r() * 0.35})`;
    ctx.fillRect(r() * 1024, r() * 512, 1 + r() * 6, 1 + r() * 12);
  }
  ctx.globalCompositeOperation = 'source-over';
  _num = canvasTex(c, true, false);
  return _num;
}

let _draft: THREE.Texture | null = null;
/** Draft marks column: numerals every 2 ft (0.61 m) from `startFt`. Texture covers 6 m tall x 0.75 m wide. */
export function draftTexture() {
  if (_draft) return _draft;
  const [c, ctx] = canvas(128, 1024);
  ctx.clearRect(0, 0, 128, 1024);
  ctx.fillStyle = 'rgba(235,235,230,0.95)';
  ctx.font = 'bold 30px Arial, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  // generic column: marks every 0.6096 m over 6 m => 1024 px / 6 m
  const ppm = 1024 / 6;
  for (let i = 0; i < 10; i++) {
    const y = 1024 - i * 0.6096 * ppm;
    ctx.fillText(String(20 + i * 2), 8, y);
  }
  _draft = canvasTex(c, true, false);
  return _draft;
}

let _net: THREE.Texture | null = null;
export function netTexture() {
  if (_net) return _net;
  const [c, ctx] = canvas(128, 128);
  ctx.clearRect(0, 0, 128, 128);
  ctx.strokeStyle = 'rgba(40,42,40,1)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(128, 128);
  ctx.moveTo(128, 0); ctx.lineTo(0, 128);
  ctx.stroke();
  _net = canvasTex(c, true, true);
  return _net;
}

let _soot: THREE.Texture | null = null;
/**
 * Stack-cap soot. u = around the funnel (0.5 = aft side, 0/1 = forward), v = 0 at the base of the cap, 1 at the top.
 * Dark exhaust-stained top edge, streaky soot running down, heavier on the aft (lee) side.
 */
export function sootTexture() {
  if (_soot) return _soot;
  const W = 512, H = 256;
  const [c, ctx] = canvas(W, H);
  const r = rng(515);
  ctx.fillStyle = HAZE;
  ctx.fillRect(0, 0, W, H);
  // v=1 (top) is canvas row 0
  for (let x = 0; x < W; x += 2) {
    const u = x / W;
    const aft = Math.pow(Math.max(0, Math.cos((u - 0.5) * Math.PI * 2) * 0.5 + 0.5), 1.5); // 1 at aft side
    const reach = H * (0.3 + 0.5 * aft) * (0.85 + r() * 0.3);
    const a = (0.4 + 0.35 * aft) * (0.9 + r() * 0.15);
    const g = ctx.createLinearGradient(0, 0, 0, reach);
    g.addColorStop(0, `rgba(26,26,25,${Math.min(1, a + 0.2)})`);
    g.addColorStop(0.18, `rgba(30,30,29,${a})`);
    g.addColorStop(0.55, `rgba(40,40,38,${a * 0.45})`);
    g.addColorStop(1, 'rgba(45,45,43,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, 2, reach);
  }
  // soften the column structure into streaks
  {
    const [c2, ctx2] = canvas(W, H);
    ctx2.filter = 'blur(3px)';
    for (const dx of [-W, 0, W]) ctx2.drawImage(c, dx, 0);
    ctx.drawImage(c2, 0, 0);
  }
  // sharp heat-discoloured band at the very top
  ctx.fillStyle = 'rgba(22,21,20,0.9)';
  ctx.fillRect(0, 0, W, H * 0.06);
  fractal(ctx, W, H, 91, 0.05, 'overlay', 8, 3, 2, true);
  _soot = canvasTex(c, true, true);
  _soot.wrapT = THREE.ClampToEdgeWrapping;
  return _soot;
}

let _name: THREE.Texture | null = null;
/** Transom name "VANGUARD" (white w/ black shading), alpha. */
export function nameTexture() {
  if (_name) return _name;
  const [c, ctx] = canvas(2048, 256);
  ctx.clearRect(0, 0, 2048, 256);
  ctx.font = 'bold 190px "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(15,15,15,0.95)';
  for (let k = 1; k <= 9; k++) ctx.fillText('VANGUARD', 1024 + k * 0.9, 132 + k * 0.6);
  ctx.fillStyle = 'rgba(232,232,228,1)';
  ctx.fillText('VANGUARD', 1024, 132);
  _name = canvasTex(c, true, false);
  return _name;
}
