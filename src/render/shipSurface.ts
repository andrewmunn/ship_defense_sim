import * as THREE from 'three';

/**
 * Ship-local spatial hash over the static hull triangles. Blast scorches need "nearest outer surface"
 * raycasts around a hit point; brute force over the full ~300k-triangle model costs >150 ms per
 * hit. With the hash, a probe only touches the triangles in the few cells it crosses.
 */
export class ShipSurface {
  private tris: Float32Array; // 9 floats per triangle, ship-local
  private cells = new Map<number, number[]>();
  private stamp: Uint32Array;
  private query = 0;

  constructor(meshes: THREE.Mesh[], private cell = 4) {
    let n = 0;
    for (const m of meshes) n += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
    this.tris = new Float32Array(n * 9);
    this.stamp = new Uint32Array(n);
    const v = new THREE.Vector3();
    let t = 0;
    for (const m of meshes) {
      const pos = m.geometry.attributes.position;
      const idx = m.geometry.index;
      const cnt = idx ? idx.count : pos.count;
      for (let i = 0; i < cnt; i += 3, t++) {
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (let k = 0; k < 3; k++) {
          v.fromBufferAttribute(pos, idx ? idx.getX(i + k) : i + k).applyMatrix4(m.matrixWorld);
          this.tris[t * 9 + k * 3] = v.x;
          this.tris[t * 9 + k * 3 + 1] = v.y;
          this.tris[t * 9 + k * 3 + 2] = v.z;
          x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); z0 = Math.min(z0, v.z);
          x1 = Math.max(x1, v.x); y1 = Math.max(y1, v.y); z1 = Math.max(z1, v.z);
        }
        this.forCells(x0, y0, z0, x1, y1, z1, (key) => {
          let c = this.cells.get(key);
          if (!c) this.cells.set(key, (c = []));
          c.push(t);
        });
      }
    }
  }

  private forCells(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, f: (key: number) => void) {
    const c = this.cell;
    const ax = Math.floor(x0 / c), ay = Math.floor(y0 / c), az = Math.floor(z0 / c);
    const bx = Math.floor(x1 / c), by = Math.floor(y1 / c), bz = Math.floor(z1 / c);
    for (let x = ax; x <= bx; x++) for (let y = ay; y <= by; y++) for (let z = az; z <= bz; z++) f(((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512));
  }

  /**
   * Nearest hit of a ray against the hull triangles (Möller–Trumbore), only testing the cells the
   * segment's bounding box overlaps — cheap for the short axis-aligned probes the scorch code uses.
   */
  raycast(o: THREE.Vector3, d: THREE.Vector3, far: number): { point: THREE.Vector3; normal: THREE.Vector3; dist: number } | null {
    const q = ++this.query;
    const T = this.tris;
    let best = far, bi = -1;
    const ex = o.x + d.x * far, ey = o.y + d.y * far, ez = o.z + d.z * far;
    this.forCells(Math.min(o.x, ex), Math.min(o.y, ey), Math.min(o.z, ez), Math.max(o.x, ex), Math.max(o.y, ey), Math.max(o.z, ez), (key) => {
      const c = this.cells.get(key);
      if (!c) return;
      for (const t of c) {
        if (this.stamp[t] === q) continue;
        this.stamp[t] = q;
        const i = t * 9;
        const e1x = T[i + 3] - T[i], e1y = T[i + 4] - T[i + 1], e1z = T[i + 5] - T[i + 2];
        const e2x = T[i + 6] - T[i], e2y = T[i + 7] - T[i + 1], e2z = T[i + 8] - T[i + 2];
        const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-9) continue;
        const inv = 1 / det;
        const sx = o.x - T[i], sy = o.y - T[i + 1], sz = o.z - T[i + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (d.x * qx + d.y * qy + d.z * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (dist > 0 && dist < best) { best = dist; bi = t; }
      }
    });
    if (bi < 0) return null;
    const i = bi * 9;
    const a = new THREE.Vector3(T[i], T[i + 1], T[i + 2]);
    const normal = new THREE.Vector3(T[i + 3], T[i + 4], T[i + 5]).sub(a).cross(new THREE.Vector3(T[i + 6], T[i + 7], T[i + 8]).sub(a)).normalize();
    return { point: o.clone().addScaledVector(d, best), normal, dist: best };
  }
}
