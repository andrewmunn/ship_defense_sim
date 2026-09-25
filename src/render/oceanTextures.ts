import * as THREE from 'three';
import { Rng } from '../core/rng';

/** Tileable detail wave normal map (RG = normal xz, B = height, A = 1). */
export function makeDetailNormalTexture(size = 256, waves = 180) {
  const rng = new Rng(9001);
  const kx: number[] = [], kz: number[] = [], amp: number[] = [], ph: number[] = [];
  for (let i = 0; i < waves; i++) {
    let x = 0, z = 0;
    while (x === 0 && z === 0) {
      const r = Math.round(Math.pow(rng.next(), 1.6) * 28) + 1;
      const a = rng.range(0, Math.PI * 2);
      x = Math.round(Math.cos(a) * r);
      z = Math.round(Math.sin(a) * r);
    }
    kx.push(x); kz.push(z);
    const kl = Math.hypot(x, z);
    amp.push(Math.pow(kl, -1.7) * (0.6 + 0.8 * rng.next()));
    ph.push(rng.range(0, Math.PI * 2));
  }
  const data = new Uint8Array(size * size * 4);
  const hx = new Float32Array(size * size), hz = new Float32Array(size * size), hh = new Float32Array(size * size);
  let maxS = 0, maxH = 0;
  const TAU = Math.PI * 2;
  // separable-ish precompute of cos tables per wave would be faster; brute force is fine at 256².
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size, v = j / size;
      let dx = 0, dz = 0, h = 0;
      for (let w = 0; w < waves; w++) {
        const th = TAU * (kx[w] * u + kz[w] * v) + ph[w];
        const c = Math.cos(th), s = Math.sin(th);
        h += amp[w] * s;
        dx += amp[w] * kx[w] * c;
        dz += amp[w] * kz[w] * c;
      }
      const o = j * size + i;
      hx[o] = dx; hz[o] = dz; hh[o] = h;
      maxS = Math.max(maxS, Math.abs(dx), Math.abs(dz));
      maxH = Math.max(maxH, Math.abs(h));
    }
  }
  for (let o = 0; o < size * size; o++) {
    data[o * 4] = Math.round((hx[o] / maxS * 0.5 + 0.5) * 255);
    data[o * 4 + 1] = Math.round((hz[o] / maxS * 0.5 + 0.5) * 255);
    data[o * 4 + 2] = Math.round((hh[o] / maxH * 0.5 + 0.5) * 255);
    data[o * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  tex.userData.slopeScale = maxS; // slope units per tile
  return tex;
}

/** Tileable foam texture: bubbly cellular pattern + streaks. R = foam density. */
export function makeFoamTexture(size = 256) {
  const rng = new Rng(77);
  const pts: [number, number][] = [];
  const N = 90;
  for (let i = 0; i < N; i++) pts.push([rng.next(), rng.next()]);
  const data = new Uint8Array(size * size * 4);
  // value noise lattice for modulation
  const L = 16;
  const lat = new Float32Array(L * L).map(() => rng.next());
  const vn = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const a = lat[((yi % L + L) % L) * L + ((xi % L + L) % L)];
    const b = lat[((yi % L + L) % L) * L + (((xi + 1) % L + L) % L)];
    const c = lat[(((yi + 1) % L + L) % L) * L + ((xi % L + L) % L)];
    const d = lat[(((yi + 1) % L + L) % L) * L + (((xi + 1) % L + L) % L)];
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size, v = j / size;
      let d1 = 9, d2 = 9;
      for (const p of pts) {
        let dx = Math.abs(u - p[0]); dx = Math.min(dx, 1 - dx);
        let dy = Math.abs(v - p[1]); dy = Math.min(dy, 1 - dy);
        const d = dx * dx + dy * dy;
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
      }
      const edge = Math.sqrt(d2) - Math.sqrt(d1); // small near cell borders
      const cell = Math.exp(-edge * 60);
      const n = vn(u * L, v * L) * 0.6 + vn(u * L * 2, v * L * 2) * 0.4;
      const f = Math.min(1, cell * 0.8 + n * 0.55);
      const o = (j * size + i) * 4;
      data[o] = data[o + 1] = data[o + 2] = Math.round(f * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}
