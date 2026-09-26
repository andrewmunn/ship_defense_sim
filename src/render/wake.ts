import * as THREE from 'three';
import type { Ship } from '../sim/entities';
import type { Ocean } from './ocean';
import type { Particles } from './particles';
import { PT } from './particles';
import { upAt, altitude } from '../core/geo';
import { rng } from '../core/rng';
import { hbWL, Z_STEM_WL, Z_STERN } from './models/ship/hulldef';

const SIZE = 1024;
const SPAN = 1800; // meters covered by the foam map
const NSIZE = 512;
const NSPAN = 220; // near-hull high-res map (m)
const KELVIN = Math.tan((19.47 * Math.PI) / 180);

interface Crumb {
  x: number;
  z: number;
  /** unit heading in xz */
  hx: number;
  hz: number;
  t: number;
  speed: number;
  /** stable per-crumb randomness (width/alpha breakup) */
  r1: number;
  r2: number;
}

/**
 * Ship wake: a CPU-painted foam map (turbulent centreline wake, Kelvin arms, bow-wave foam,
 * explosion foam patches) sampled by the ocean shader, plus bow-spray particles.
 */
export class Wake {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  private crumbs: Crumb[] = [];
  private cx = 0;
  private cz = 0;
  private acc = 0;
  private sprayAcc = 0;

  // high-resolution near-hull foam (contact line, bow wave, stern churn)
  private nCanvas: HTMLCanvasElement;
  private nCtx: CanvasRenderingContext2D;
  nTex: THREE.CanvasTexture;
  private ncx = 0;
  private ncz = 0;
  private wlPoly: [number, number][] = [];

  constructor(private ocean: Ocean) {
    this.nCanvas = document.createElement('canvas');
    this.nCanvas.width = this.nCanvas.height = NSIZE;
    this.nCtx = this.nCanvas.getContext('2d')!;
    this.nTex = new THREE.CanvasTexture(this.nCanvas);
    this.nTex.flipY = false;
    this.nTex.colorSpace = THREE.NoColorSpace;
    this.nTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.nTex.generateMipmaps = true;
    // waterline polygon (ship-local x,z), port side stern→bow then starboard bow→stern
    const side: [number, number][] = [];
    for (let z = Z_STERN + 0.5; z <= Z_STEM_WL; z += 2) side.push([hbWL(z), z]);
    side.push([0, Z_STEM_WL + 0.6]);
    this.wlPoly = [...side, ...side.slice(0, -1).reverse().map(([x, z]) => [-x, z] as [number, number])];
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = SIZE;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.flipY = false;
    this.tex.colorSpace = THREE.NoColorSpace;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = true;
    const u = ocean.material.uniforms;
    u.uFoamMap.value = this.tex;
    u.uFoamMapOn.value = 1;
    u.uFoamMap2.value = this.nTex;
  }

  private drawNear(ship: Ship, t: number) {
    const c = this.nCtx;
    this.ncx = ship.pos.x;
    this.ncz = ship.pos.z;
    const k = NSIZE / NSPAN;
    const X = (x: number) => (x - (this.ncx - NSPAN / 2)) * k, Z = (z: number) => (z - (this.ncz - NSPAN / 2)) * k;
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = '#000';
    c.fillRect(0, 0, NSIZE, NSIZE);
    c.globalCompositeOperation = 'lighter';
    // ship-local → world xz (flat approx near the ship)
    const q = ship.quat;
    const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(q), az = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const W = (lx: number, lz: number): [number, number] => [ship.pos.x + ax.x * lx + az.x * lz, ship.pos.z + ax.z * lx + az.z * lz];
    const sp = Math.min(1, ship.speed / 14);
    // contact line: turbulent white hugging the waterline, stronger forward & aft
    c.lineJoin = 'round';
    for (const [w, a] of [[2.6, 0.35 + 0.3 * sp], [1.2, 0.5 + 0.3 * sp]] as [number, number][]) {
      c.strokeStyle = `rgba(255,0,0,${a})`;
      c.lineWidth = w * k;
      c.beginPath();
      this.wlPoly.forEach(([x, z], i) => {
        const jitter = 0.4 * Math.sin(z * 0.7 + t * 3.1) + 0.3 * Math.sin(z * 1.9 - t * 2.3);
        const [wx, wz] = W(x + Math.sign(x) * (w * 0.4 + jitter), z);
        if (i === 0) c.moveTo(X(wx), Z(wz));
        else c.lineTo(X(wx), Z(wz));
      });
      c.closePath();
      c.stroke();
    }
    if (ship.speed > 1.5) {
      // bow wave: two crests peeling off the stem, spreading ~20° and breaking
      for (const s of [1, -1]) {
        for (let i = 0; i < 3; i++) {
          c.strokeStyle = `rgba(255,0,0,${(0.55 - i * 0.15) * sp})`;
          c.lineWidth = (2.2 - i * 0.5) * k;
          c.beginPath();
          for (let j = 0; j <= 16; j++) {
            const z = Z_STEM_WL - 2 - j * 4 - i * 6;
            const x = s * (hbWL(Math.max(z, Z_STERN)) + 1 + j * 0.9 * sp + i * 2 + Math.sin(j * 1.3 + t * 2 + i) * 0.5);
            const [wx, wz] = W(x, z);
            if (j === 0) c.moveTo(X(wx), Z(wz));
            else c.lineTo(X(wx), Z(wz));
          }
          c.stroke();
        }
      }
      // stern churn: propeller wash boiling up behind the transom
      const [sx, sz] = W(0, Z_STERN - 18);
      const g = c.createRadialGradient(X(sx), Z(sz), 0, X(sx), Z(sz), 28 * k);
      g.addColorStop(0, `rgba(255,0,0,${0.85 * sp})`);
      g.addColorStop(0.6, `rgba(255,0,0,${0.45 * sp})`);
      g.addColorStop(1, 'rgba(255,0,0,0)');
      c.fillStyle = g;
      c.save();
      c.translate(X(sx), Z(sz));
      c.rotate(Math.atan2(az.z, az.x));
      c.scale(1.6, 0.55);
      c.translate(-X(sx), -Z(sz));
      c.beginPath();
      c.arc(X(sx), Z(sz), 28 * k, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
    this.nTex.needsUpdate = true;
  }

  reset() {
    this.crumbs = [];
  }

  private px(x: number) {
    return ((x - (this.cx - SPAN / 2)) / SPAN) * SIZE;
  }
  private pz(z: number) {
    return ((z - (this.cz - SPAN / 2)) / SPAN) * SIZE;
  }

  update(ship: Ship, t: number, dtSim: number, bursts: { pos: THREE.Vector3; r: number; t: number }[], particles: Particles, camPos: THREE.Vector3) {
    const fwd = ship.forward(new THREE.Vector3());
    const hx = fwd.x, hz = fwd.z;
    const hl = Math.hypot(hx, hz) || 1;
    // breadcrumbs of the ship track
    const last = this.crumbs[this.crumbs.length - 1];
    if (!last || Math.hypot(ship.pos.x - last.x, ship.pos.z - last.z) > 3 || t - last.t > 2) {
      this.crumbs.push({ x: ship.pos.x, z: ship.pos.z, hx: hx / hl, hz: hz / hl, t, speed: ship.speed, r1: rng.next(), r2: rng.next() });
    }
    while (this.crumbs.length && t - this.crumbs[0].t > 150) this.crumbs.shift();

    // bow spray / stem wave particles
    if (dtSim > 0 && ship.speed > 2 && !ship.sinking) {
      this.sprayAcc += dtSim * ship.speed * 0.6 * (1 + Math.max(0, -ship.pitchVel) * 20);
      upAt(ship.pos, _u);
      while (this.sprayAcc > 1) {
        this.sprayAcc -= 1;
        const side = rng.chance(0.5) ? 1 : -1;
        const along = 50 + rng.next() * 14;
        const p = new THREE.Vector3(side * (3 + (66 - along) * 0.35), 0.6, along).applyQuaternion(ship.quat).add(ship.pos);
        const a = altitude(p);
        p.addScaledVector(_u, -a + 0.3);
        const out = new THREE.Vector3(side, 0, 0).applyQuaternion(ship.quat);
        this.addSpray(particles, p, out.multiplyScalar(3 + ship.speed * 0.3).add(ship.vel.clone().multiplyScalar(0.85)).addScaledVector(_u, 2 + rng.next() * 3), ship.speed);
      }
    }

    this.acc += dtSim;
    if (this.acc < 0.06 && dtSim > 0) return this.bindUniforms(camPos);
    this.acc = 0;
    // recentre map on the ship when it drifts
    if (Math.hypot(ship.pos.x - this.cx, ship.pos.z - this.cz) > SPAN * 0.15) {
      this.cx = ship.pos.x;
      this.cz = ship.pos.z;
    }
    const c = this.ctx;
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = '#000';
    c.fillRect(0, 0, SIZE, SIZE);
    c.globalCompositeOperation = 'lighter';
    const m = SIZE / SPAN;
    const B = ship.dims.beam;
    c.lineCap = 'round';
    // --- turbulent centreline wake (from the stern): r = foam, g = slick (calm, ripple-damped water)
    const cr = this.crumbs;
    const sternOff = -ship.dims.loa * 0.5;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = cr.length - 1; i > 0; i--) {
        const a = cr[i], b = cr[i - 1];
        const age = t - a.t;
        const sp = Math.min(1, a.speed / 6);
        let alpha: number, w: number, col: string;
        if (pass === 0) {
          // slick: wide, long-lived
          alpha = Math.exp(-age / 110) * sp * 0.8;
          w = (B * 0.9 + Math.sqrt(age) * 5.5) * m;
          col = '0,255,0';
        } else if (pass === 1) {
          alpha = Math.exp(-age / 22) * sp * 0.38;
          w = (B * 0.55 + Math.sqrt(age) * 2.2) * m;
          col = '255,0,0';
        } else {
          if (age > 12) break;
          alpha = (1 - age / 12) * sp * 0.45;
          w = (B * 0.35 + age * 0.4) * m;
          col = '255,0,0';
        }
        if (alpha < 0.01) break;
        if (pass > 0) {
          // turbulent breakup: width and density wander along the track
          alpha *= 0.55 + 0.9 * a.r1;
          w *= 0.75 + 0.5 * a.r2;
        }
        c.strokeStyle = `rgba(${col},${alpha.toFixed(3)})`;
        c.lineWidth = w;
        c.beginPath();
        c.moveTo(this.px(a.x + a.hx * sternOff), this.pz(a.z + a.hz * sternOff));
        c.lineTo(this.px(b.x + b.hx * sternOff), this.pz(b.z + b.hz * sternOff));
        c.stroke();
      }
    }
    // --- Kelvin arms from the bow: lateral offset grows with distance behind the bow
    const bowOff = ship.dims.loa * 0.43;
    let s = 0;
    for (let i = cr.length - 1; i > 0; i--) {
      const a = cr[i], b = cr[i - 1];
      const ds = Math.hypot(a.x - b.x, a.z - b.z);
      const s0 = s, s1 = s + ds;
      s = s1;
      if (s0 > 700) break;
      const f = Math.min(1, a.speed / 7) * Math.exp(-s0 / 260) * 0.8;
      // cusp-wave dashes: modulate along the arm
      const dash = 0.55 + 0.45 * Math.sin(s0 * 0.09);
      for (const side of [1, -1]) {
        const lx = -a.hz * side, lz = a.hx * side; // lateral unit
        const lx2 = -b.hz * side, lz2 = b.hx * side;
        const o0 = B * 0.5 + s0 * KELVIN, o1 = B * 0.5 + s1 * KELVIN;
        c.strokeStyle = `rgba(255,0,0,${(f * dash).toFixed(3)})`;
        c.lineWidth = (2.5 + s0 * 0.02) * m;
        c.beginPath();
        c.moveTo(this.px(a.x + a.hx * bowOff + lx * o0), this.pz(a.z + a.hz * bowOff + lz * o0));
        c.lineTo(this.px(b.x + b.hx * bowOff + lx2 * o1), this.pz(b.z + b.hz * bowOff + lz2 * o1));
        c.stroke();
      }
    }
    // --- hull-side foam (bow wave peeling along the sides; a thin contact line even when stopped)
    {
      const k = Math.max(0.3, Math.min(1, ship.speed / 12));
      const fx = hx / hl, fz = hz / hl;
      const lx = -fz, lz = fx;
      for (const side of [1, -1]) {
        const grad = c.createLinearGradient(this.px(ship.pos.x + fx * 62), this.pz(ship.pos.z + fz * 62), this.px(ship.pos.x - fx * 70), this.pz(ship.pos.z - fz * 70));
        grad.addColorStop(0, `rgba(255,0,0,${0.85 * k})`);
        grad.addColorStop(0.35, `rgba(255,0,0,${0.3 * k})`);
        grad.addColorStop(1, `rgba(255,0,0,${0.5 * k})`);
        c.strokeStyle = grad;
        c.lineWidth = 3.5 * m;
        c.beginPath();
        const pts = [[64, 0.8], [50, 5.5], [30, 8.4], [0, 9.3], [-40, 8.6], [-70, 7.2]];
        pts.forEach(([z, x], i) => {
          const wx = ship.pos.x + fx * z + lx * side * (x + 1.5), wz = ship.pos.z + fz * z + lz * side * (x + 1.5);
          if (i === 0) c.moveTo(this.px(wx), this.pz(wz));
          else c.lineTo(this.px(wx), this.pz(wz));
        });
        c.stroke();
      }
    }
    // --- explosion / splash foam patches
    for (const b of bursts) {
      const age = t - b.t;
      const r = (b.r + age * 1.5) * m;
      const a = Math.exp(-age / 14);
      const x = this.px(b.pos.x), z = this.pz(b.pos.z);
      if (x < -r || z < -r || x > SIZE + r || z > SIZE + r) continue;
      // expanding foam ring with a fading, churned centre
      const g = c.createRadialGradient(x, z, 0, x, z, r);
      const inner = Math.min(0.75, 0.2 + age * 0.05);
      g.addColorStop(0, `rgba(255,${Math.round(200 * a)},0,${(0.45 * a * (1 - inner)).toFixed(3)})`);
      g.addColorStop(inner, `rgba(255,${Math.round(160 * a)},0,${(0.3 * a).toFixed(3)})`);
      g.addColorStop(Math.min(0.95, inner + 0.15), `rgba(255,${Math.round(120 * a)},0,${(0.85 * a).toFixed(3)})`);
      g.addColorStop(1, 'rgba(255,0,0,0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(x, z, r, 0, Math.PI * 2);
      c.fill();
    }
    this.tex.needsUpdate = true;
    this.drawNear(ship, t);
    this.bindUniforms(camPos);
  }

  private addSpray(particles: Particles, p: THREE.Vector3, v: THREE.Vector3, speed: number) {
    particles.spawn({ pos: p, vel: v, life: 1.4 + rng.next(), size0: 0.6, size1: 2.5 + speed * 0.12, drag: 0.8, gravity: 9.8, color: [0.9, 0.93, 0.95], alpha: 0.45, type: PT.SPRAY });
  }

  private bindUniforms(camPos: THREE.Vector3) {
    const u = this.ocean.material.uniforms;
    (u.uFoamMapRect.value as THREE.Vector4).set(this.cx - SPAN / 2 - camPos.x, this.cz - SPAN / 2 - camPos.z, 1 / SPAN, 1 / SPAN);
    (u.uFoamMap2Rect.value as THREE.Vector4).set(this.ncx - NSPAN / 2 - camPos.x, this.ncz - NSPAN / 2 - camPos.z, 1 / NSPAN, 1 / NSPAN);
  }
}
const _u = new THREE.Vector3();
