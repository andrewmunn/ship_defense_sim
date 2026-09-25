/** Deterministic value noise / fbm in JS (used for terrain on CPU). */
function hash2(ix: number, iy: number, seed: number) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function vnoise2(x: number, y: number, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
export function fbm2(x: number, y: number, oct = 5, seed = 0) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise2(x * f, y * f, seed + i * 17);
    n += a;
    a *= 0.5;
    f *= 2.03;
  }
  return s / n;
}
export function ridged2(x: number, y: number, oct = 6, seed = 0) {
  let s = 0, a = 0.5, f = 1, n = 0, w = 1;
  for (let i = 0; i < oct; i++) {
    let v = 1 - Math.abs(vnoise2(x * f, y * f, seed + i * 31) * 2 - 1);
    v = v * v * w;
    w = Math.min(1, v * 2);
    s += a * v;
    n += a;
    a *= 0.5;
    f *= 2.1;
  }
  return s / n;
}
