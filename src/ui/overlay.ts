import * as THREE from 'three';
import type { Game } from '../game/game';
import type { Entity } from '../sim/entities';
import type { Threat } from '../sim/threat';
import type { Interceptor } from '../sim/interceptor';
import { altitude, destination, horizonDist, hasLineOfSight } from '../core/geo';
import { K_REFRACTION } from '../core/constants';

export type LabelMode = 'all' | 'threats' | 'none';
const FONT0 = '700 11.5px "IBM Plex Mono", "SF Mono", ui-monospace, Menlo, monospace';
const FONT1 = '500 10.5px "IBM Plex Mono", "SF Mono", ui-monospace, Menlo, monospace';

const _v = new THREE.Vector3(), _c = new THREE.Vector3();

export const COLORS = {
  hostile: '#ff4b3e',
  hostileDim: 'rgba(255,90,70,0.45)',
  unknown: '#ffb347',
  friend: '#5ec8ff',
  own: '#7fd3ff',
  decoy: '#ffe066',
  neutral: '#b8c2c8',
  select: '#ffffff',
};

interface Proj {
  x: number;
  y: number;
  /** projected size of the object's radius in px */
  size: number;
  dist: number;
  on: boolean;
}

/**
 * Screen-space symbology: every entity gets a MIL-STD-2525-ish air/surface track symbol that fades in
 * as the object shrinks below ~20 px, so threats, interceptors and rounds stay legible at any zoom.
 */
export class Overlay {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  labelMode: LabelMode = 'all';
  showTruth = false;
  showHorizon = true;
  showEngagements = true;
  visible = true;
  private dpr = 1;
  private picks: { e: Entity; x: number; y: number }[] = [];
  private mouse = { x: -1, y: -1, down: false, sx: 0, sy: 0, moved: false };

  constructor(private game: Game) {
    const c = (this.canvas = document.createElement('canvas'));
    c.id = 'overlay';
    document.body.appendChild(c);
    this.ctx = c.getContext('2d')!;
    this.resize();
    addEventListener('resize', () => this.resize());
    const dom = game.R.renderer.domElement;
    dom.addEventListener('pointermove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      if (this.mouse.down && Math.hypot(e.clientX - this.mouse.sx, e.clientY - this.mouse.sy) > 4) this.mouse.moved = true;
    });
    dom.addEventListener('pointerleave', () => (this.mouse.x = this.mouse.y = -1));
    dom.addEventListener('pointerdown', (e) => {
      this.mouse.down = true;
      this.mouse.moved = false;
      this.mouse.sx = e.clientX;
      this.mouse.sy = e.clientY;
    });
    dom.addEventListener('pointerup', (e) => {
      const click = this.mouse.down && !this.mouse.moved && e.button === 0;
      this.mouse.down = false;
      if (!click) return;
      const p = this.pick(e.clientX, e.clientY);
      if (p) this.game.select(p, true);
    });
    dom.addEventListener('dblclick', (e) => {
      const p = this.pick(e.clientX, e.clientY);
      if (p) this.game.follow(p, Math.max(p.radius * 5, 10));
    });
  }

  private resize() {
    this.dpr = Math.min(devicePixelRatio, 2);
    this.canvas.width = innerWidth * this.dpr;
    this.canvas.height = innerHeight * this.dpr;
  }

  pick(x: number, y: number): Entity | null {
    let best: Entity | null = null, bd = 22;
    for (const p of this.picks) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) {
        bd = d;
        best = p.e;
      }
    }
    return best;
  }

  private project(p: THREE.Vector3, radius: number, out: Proj): Proj {
    const cam = this.game.camera;
    _c.copy(p).applyMatrix4(cam.matrixWorldInverse);
    out.dist = _c.length();
    if (_c.z > -0.1) {
      out.on = false;
      // still compute a direction for edge arrows
      _v.copy(p).project(cam);
      out.x = (-_v.x * 0.5 + 0.5) * innerWidth;
      out.y = (_v.y * 0.5 + 0.5) * innerHeight;
      out.size = 0;
      return out;
    }
    _v.copy(p).project(cam);
    out.x = (_v.x * 0.5 + 0.5) * innerWidth;
    out.y = (-_v.y * 0.5 + 0.5) * innerHeight;
    const pxPerM = (innerHeight * cam.projectionMatrix.elements[5] * 0.5) / Math.max(-_c.z, 0.1);
    out.size = radius * pxPerM;
    out.on = out.x > -40 && out.y > -40 && out.x < innerWidth + 40 && out.y < innerHeight + 40;
    return out;
  }

  draw() {
    const g = this.game, W = g.world, ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.picks = [];
    this.placed = [];
    if (!this.visible) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.lineJoin = 'round';
    ctx.font = '600 11px "SF Mono", ui-monospace, Menlo, monospace';
    const pr: Proj = { x: 0, y: 0, size: 0, dist: 0, on: false };
    const pv: Proj = { x: 0, y: 0, size: 0, dist: 0, on: false };
    const hover = this.mouse.x >= 0 ? this.pick(this.mouse.x, this.mouse.y) : null;
    g.hovered = hover;
    const sel = g.selected;
    const shipPos = W.ship.pos;

    // ---------------------------------------------------------- radar horizon vs a 5 m sea-skimmer, drawn on the sea
    if (this.showHorizon) this.horizonRing();

    // ---------------------------------------------------------- ship
    this.project(W.ship.pos, 80, pr);
    if (pr.on) {
      const a = fade(pr.size, 60, 20);
      if (a > 0.02 || sel === W.ship || hover === W.ship) {
        ctx.globalAlpha = Math.max(a, sel === W.ship || hover === W.ship ? 1 : 0);
        this.symFriendSurface(pr.x, pr.y, COLORS.own);
        this.label(pr.x, pr.y, ['DDV-01 VANGUARD', `${(W.ship.speed / 0.5144).toFixed(0)} kt  HULL ${Math.round(W.ship.hp)}%`], COLORS.own, 1);
      }
      this.picks.push({ e: W.ship, x: pr.x, y: pr.y });
    }
    ctx.globalAlpha = 1;

    // ---------------------------------------------------------- launchers (hostile land)
    for (const L of W.launchers) {
      this.project(L.pos, 12, pr);
      if (!pr.on) continue;
      const a = fade(pr.size, 26, 8) * (pr.dist < 250000 ? 1 : 0);
      if (a < 0.02 && sel !== L) continue;
      const los = hasLineOfSight(this.game.camera.position, L.pos, 1);
      ctx.globalAlpha = Math.max(a * (L.rounds > 0 || W.t - L.lastFire < 20 ? 0.9 : 0.4) * (los ? 1 : 0.4), sel === L ? 1 : 0);
      this.symHostileGround(pr.x, pr.y, COLORS.hostile);
      if (hover === L || sel === L || (this.labelMode === 'all' && pr.dist < 12000)) this.label(pr.x, pr.y, [L.name.toUpperCase()], COLORS.hostile, 0.8);
      this.picks.push({ e: L, x: pr.x, y: pr.y });
    }
    ctx.globalAlpha = 1;

    // ---------------------------------------------------------- decoys
    for (const d of W.decoys) {
      if (d.remove) continue;
      this.project(d.pos, d.decoyKind === 'chaff' ? d.radius : 2, pr);
      if (!pr.on) continue;
      const a = fade(pr.size, 40, 10) * 0.8;
      if (a < 0.02) continue;
      ctx.globalAlpha = a;
      ctx.strokeStyle = COLORS.decoy;
      ctx.lineWidth = 1.2;
      star(ctx, pr.x, pr.y, 5);

    }
    ctx.globalAlpha = 1;

    // ---------------------------------------------------------- interceptors
    for (const m of W.interceptors) {
      if (!m.alive) continue;
      this.project(m.pos, m.spec.length * 0.5, pr);
      const isSel = sel === m, isHov = hover === m;
      if (isSel || isHov) this.engagementLine(m);
      else if (this.showEngagements && m.target.alive) this.faintLink(m);
      if (!pr.on) continue;
      const a = fade(pr.size, 24, 7);
      this.picks.push({ e: m, x: pr.x, y: pr.y });
      if (a < 0.02 && !isSel && !isHov) continue;
      ctx.globalAlpha = Math.max(a * 0.95, isSel || isHov ? 1 : 0);
      this.project(_v.copy(m.pos).addScaledVector(m.vel, 1.5), 1, pv);
      this.leader(pr, pv, COLORS.friend, 26);
      this.symFriendAir(pr.x, pr.y, COLORS.friend);
      if (isSel || isHov) {
        const lines = [`${m.spec.short}`];
        if (isSel || isHov) lines.push(`→ TN ${m.track.tn}  ${m.phase.toUpperCase()}`, `${Math.round(m.vel.length())} m/s  tgo ${m.tgo.toFixed(1)}s`);
        this.label(pr.x, pr.y, lines, COLORS.friend, isSel || isHov ? 1 : 0.75);
      }
    }
    ctx.globalAlpha = 1;

    // ---------------------------------------------------------- threats
    const offscreen: { e: Threat; p: Proj }[] = [];
    // most urgent first, so they win the label-placement contest
    const ordered = W.threats.filter((t) => t.alive).sort((a, b) => a.pos.distanceTo(shipPos) - b.pos.distanceTo(shipPos));
    for (const th of ordered) {
      const tr = W.radar.byThreat.get(th.id);
      const tracked = !!tr && tr.firm && !tr.lost;
      this.project(th.pos, th.spec.length * 0.5, pr);
      const isSel = sel === th, isHov = hover === th;
      if (!pr.on) {
        if (pr.dist < 60000 && (tracked || this.showTruth)) offscreen.push({ e: th, p: { ...pr } });
        continue;
      }
      this.picks.push({ e: th, x: pr.x, y: pr.y });
      const a = fade(pr.size, 26, 8);
      if (a < 0.02 && !isSel && !isHov) continue;
      const col = tracked ? (tr!.cls === 'hostile' ? COLORS.hostile : COLORS.unknown) : COLORS.hostileDim;
      ctx.globalAlpha = Math.max(a * (tracked || this.showTruth ? 1 : 0.55), isSel || isHov ? 1 : 0);
      this.project(_v.copy(th.pos).addScaledVector(th.vel, 2), 1, pv);
      this.leader(pr, pv, col, tracked ? 34 : 18);
      this.symHostileAir(pr.x, pr.y, col, !tracked, th.phase === 'boost');
      if (isSel || isHov || (this.labelMode !== 'none' && (tracked || this.showTruth))) {
        const r = th.pos.distanceTo(shipPos);
        const alt = altitude(th.pos);
        const name = tracked ? `TN ${tr!.tn}` : th.phase === 'boost' ? 'LAUNCH' : 'UNDETECTED';
        const lines = [name];
        if (isSel || isHov || this.labelMode === 'all') lines.push(`${th.spec.short.split(' ')[0]}  ${Math.round(th.vel.length())} m/s`, `${fmtAlt(alt)}  ${(r / 1000).toFixed(1)} km`);
        if (th.engagedBy > 0 || (tr && tr.engagedBy.length)) lines.push(`ENGAGED ×${tr ? tr.engagedBy.filter((m) => m.alive).length : 0}`);
        if (th.seduced) lines.push('SEDUCED');
        this.label(pr.x, pr.y, lines, col, isSel || isHov ? 1 : 0.85);
      }
    }
    ctx.globalAlpha = 1;

    // ---------------------------------------------------------- selection brackets
    if (sel && sel.alive) {
      this.project(sel.pos, sel.radius, pr);
      if (pr.on) this.brackets(pr.x, pr.y, Math.max(pr.size * 1.2, 14), COLORS.select);
    }
    if (hover && hover !== sel) {
      this.project(hover.pos, hover.radius, pr);
      if (pr.on) this.brackets(pr.x, pr.y, Math.max(pr.size * 1.2, 12), 'rgba(255,255,255,0.5)');
    }

    // ---------------------------------------------------------- off-screen threat arrows (nearest few, clustered)
    offscreen.sort((a, b) => a.e.pos.distanceTo(shipPos) - b.e.pos.distanceTo(shipPos));
    const drawn: { x: number; y: number }[] = [];
    for (const o of offscreen) {
      if (drawn.length >= 8) break;
      const at = this.edgePoint(o.p);
      if (!at || drawn.some((d) => Math.hypot(d.x - at.x, d.y - at.y) < 34)) continue;
      drawn.push(at);
      this.edgeArrow(o.e, o.p);
    }
  }

  // ------------------------------------------------------------------ primitives
  private leader(a: Proj, b: Proj, col: string, maxLen: number) {
    if (!b.on && b.dist === 0) return;
    let dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    if (L < 2) return;
    const k = Math.min(maxLen, Math.max(10, L)) / L;
    dx *= k;
    dy *= k;
    const c = this.ctx;
    c.strokeStyle = col;
    c.lineWidth = 1.2;
    c.beginPath();
    c.moveTo(a.x + (dx / Math.hypot(dx, dy)) * 7, a.y + (dy / Math.hypot(dx, dy)) * 7);
    c.lineTo(a.x + dx, a.y + dy);
    c.stroke();
  }

  /** Hostile air: upper half-diamond (caret) with a centre dot. */
  private symHostileAir(x: number, y: number, col: string, dashed: boolean, launch: boolean) {
    const c = this.ctx, s = 8;
    c.strokeStyle = col;
    c.lineWidth = 1.8;
    c.setLineDash(dashed ? [3, 2.5] : []);
    c.beginPath();
    c.moveTo(x - s, y + 2);
    c.lineTo(x, y - s);
    c.lineTo(x + s, y + 2);
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = col;
    c.beginPath();
    c.arc(x, y, launch ? 2.8 : 2, 0, Math.PI * 2);
    c.fill();
    // subtle dark halo for contrast against bright sky/foam
    c.strokeStyle = 'rgba(0,0,0,0.35)';
    c.lineWidth = 0.8;
    c.beginPath();
    c.moveTo(x - s - 1.2, y + 3);
    c.lineTo(x, y - s - 1.6);
    c.lineTo(x + s + 1.2, y + 3);
    c.stroke();
  }
  /** Friendly air: upper half-circle. */
  private symFriendAir(x: number, y: number, col: string) {
    const c = this.ctx;
    c.strokeStyle = col;
    c.lineWidth = 1.6;
    c.beginPath();
    c.arc(x, y + 2, 6, Math.PI, 0);
    c.stroke();
    c.fillStyle = col;
    c.beginPath();
    c.arc(x, y + 1, 1.6, 0, Math.PI * 2);
    c.fill();
  }
  private symFriendSurface(x: number, y: number, col: string) {
    const c = this.ctx;
    c.strokeStyle = col;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(x, y, 9, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = col;
    c.beginPath();
    c.arc(x, y, 2.2, 0, Math.PI * 2);
    c.fill();
  }
  private symHostileGround(x: number, y: number, col: string) {
    const c = this.ctx, s = 7;
    c.strokeStyle = col;
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(x, y - s);
    c.lineTo(x + s, y);
    c.lineTo(x, y + s);
    c.lineTo(x - s, y);
    c.closePath();
    c.stroke();
    c.beginPath();
    c.moveTo(x - 3, y + 2);
    c.lineTo(x, y - 3);
    c.lineTo(x + 3, y + 2);
    c.stroke();
  }

  /** Placed label rects this frame (greedy declutter: later labels shrink to one line or move). */
  private placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
  private label(x: number, y: number, lines: string[], col: string, alpha: number, force = false) {
    const c = this.ctx;
    const lh = 13;
    const w = Math.max(...lines.map((t, i) => t.length * (i === 0 ? 7.2 : 6.5))) + 10;
    let n = lines.length;
    let ox = 12, oy = -6;
    const hit = (x0: number, y0: number, x1: number, y1: number) => this.placed.some((r) => x0 < r.x1 && x1 > r.x0 && y0 < r.y1 && y1 > r.y0);
    const rect = (nn: number, dx: number, dy: number) => [x + dx, y + dy - 10, x + dx + w, y + dy - 10 + nn * lh] as const;
    if (!force) {
      const tries: [number, number, number][] = [[n, 12, -6], [n, 12, -6 - n * lh + 6], [n, -12 - w, -6], [1, 12, -6], [1, 12, 10]];
      let ok = false;
      for (const [nn, dx, dy] of tries) {
        const [x0, y0, x1, y1] = rect(nn, dx, dy);
        if (!hit(x0, y0, x1, y1)) { n = nn; ox = dx; oy = dy; ok = true; break; }
      }
      if (!ok) return;
    }
    const [x0, y0, x1, y1] = rect(n, ox, oy);
    this.placed.push({ x0, y0, x1, y1 });
    const a0 = c.globalAlpha;
    c.globalAlpha = a0 * alpha;
    // measure for a snug chip
    let tw = 0;
    for (let i = 0; i < n; i++) {
      c.font = i === 0 ? FONT0 : FONT1;
      tw = Math.max(tw, c.measureText(lines[i]).width);
    }
    const cx0 = x + ox - 4, cy0 = y + oy - 10, cw = tw + 8, ch = n * lh + 3;
    c.fillStyle = 'rgba(4,10,14,0.58)';
    c.beginPath();
    c.roundRect(cx0, cy0, cw, ch, 2);
    c.fill();
    c.fillStyle = col;
    c.fillRect(cx0, cy0, 2, ch);
    let yy = y + oy;
    for (let i = 0; i < n; i++) {
      c.font = i === 0 ? FONT0 : FONT1;
      c.fillStyle = i === 0 ? col : 'rgba(236,243,247,0.96)';
      c.fillText(lines[i], x + ox + 1, yy);
      yy += lh;
    }
    c.globalAlpha = a0;
  }

  private brackets(x: number, y: number, r: number, col: string) {
    const c = this.ctx, k = Math.min(8, r * 0.5);
    c.strokeStyle = col;
    c.lineWidth = 1.5;
    c.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      c.moveTo(x + sx * r, y + sy * (r - k));
      c.lineTo(x + sx * r, y + sy * r);
      c.lineTo(x + sx * (r - k), y + sy * r);
    }
    c.stroke();
  }

  private horizonRing() {
    const W = this.game.world, c = this.ctx;
    const r = horizonDist(W.radar.height, K_REFRACTION) + horizonDist(5, K_REFRACTION);
    const p: Proj = { x: 0, y: 0, size: 0, dist: 0, on: false };
    const camH = altitude(this.game.camera.position);
    const a = Math.min(0.55, 0.15 + camH / 3000);
    c.strokeStyle = `rgba(255,179,71,${a})`;
    c.lineWidth = 1.2;
    c.setLineDash([7, 6]);
    c.beginPath();
    let pen = false;
    for (let i = 0; i <= 180; i++) {
      const q = destination(W.ship.pos, (i / 180) * Math.PI * 2, r);
      this.project(q, 1, p);
      if (p.dist > 0 && p.x > -2000 && p.x < innerWidth + 2000 && p.y > -2000 && p.y < innerHeight + 2000 && (p.on || p.dist < r * 3) && (this.game.camera.position.distanceTo(q) < 1e6)) {
        // only draw points in front of the camera
        _c.copy(q).applyMatrix4(this.game.camera.matrixWorldInverse);
        if (_c.z < 0) {
          if (!pen) { c.moveTo(p.x, p.y); pen = true; } else c.lineTo(p.x, p.y);
          continue;
        }
      }
      pen = false;
    }
    c.stroke();
    c.setLineDash([]);
  }

  private faintLink(m: Interceptor) {
    const a: Proj = { x: 0, y: 0, size: 0, dist: 0, on: false }, b: Proj = { ...a };
    this.project(m.pos, 1, a);
    this.project(m.target.pos, 1, b);
    if (!a.on || !b.on) return;
    const c = this.ctx;
    c.strokeStyle = 'rgba(94,200,255,0.22)';
    c.lineWidth = 1;
    c.setLineDash([2, 5]);
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.lineTo(b.x, b.y);
    c.stroke();
    c.setLineDash([]);
  }

  private engagementLine(m: Interceptor) {
    const a: Proj = { x: 0, y: 0, size: 0, dist: 0, on: false }, b: Proj = { ...a }, p: Proj = { ...a };
    this.project(m.pos, 1, a);
    this.project(m.target.pos, 1, b);
    this.project(m.pip, 1, p);
    const c = this.ctx;
    c.setLineDash([4, 4]);
    c.strokeStyle = 'rgba(94,200,255,0.7)';
    c.lineWidth = 1;
    if (a.on && p.on) {
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(p.x, p.y);
      c.stroke();
      c.setLineDash([]);
      c.strokeRect(p.x - 3, p.y - 3, 6, 6);
    }
    c.setLineDash([2, 3]);
    c.strokeStyle = 'rgba(255,90,70,0.6)';
    if (b.on && p.on) {
      c.beginPath();
      c.moveTo(b.x, b.y);
      c.lineTo(p.x, p.y);
      c.stroke();
    }
    c.setLineDash([]);
  }

  private edgePoint(p: Proj) {
    const cx = innerWidth / 2, cy = innerHeight / 2;
    const dx = p.x - cx, dy = p.y - cy;
    if (!isFinite(dx) || !isFinite(dy) || (dx === 0 && dy === 0)) return null;
    const m = 34;
    const s = Math.min((cx - m) / Math.abs(dx || 1e-6), (cy - m) / Math.abs(dy || 1e-6));
    return { x: cx + dx * s, y: cy + dy * s };
  }

  private edgeArrow(th: Threat, p: Proj) {
    const cx = innerWidth / 2, cy = innerHeight / 2;
    let dx = p.x - cx, dy = p.y - cy;
    if (!isFinite(dx) || !isFinite(dy) || (dx === 0 && dy === 0)) return;
    const m = 34;
    const sx = (cx - m) / Math.abs(dx || 1e-6), sy = (cy - m) / Math.abs(dy || 1e-6);
    const s = Math.min(sx, sy);
    const x = cx + dx * s, y = cy + dy * s;
    const ang = Math.atan2(dy, dx);
    const c = this.ctx;
    const r = th.pos.distanceTo(this.game.world.ship.pos);
    const urgent = r < 8000;
    c.save();
    c.translate(x, y);
    c.rotate(ang);
    c.fillStyle = urgent ? COLORS.hostile : 'rgba(255,90,70,0.6)';
    c.beginPath();
    c.moveTo(10, 0);
    c.lineTo(-4, -6);
    c.lineTo(-4, 6);
    c.closePath();
    c.fill();
    c.restore();
    c.font = '600 10px "SF Mono", ui-monospace, Menlo, monospace';
    c.fillStyle = urgent ? COLORS.hostile : 'rgba(255,120,100,0.75)';
    const t = `${(r / 1000).toFixed(1)}km`;
    const tw = c.measureText(t).width;
    c.fillText(t, x - tw / 2 - Math.cos(ang) * 22, y + 4 - Math.sin(ang) * 16);
  }
}

function fade(sizePx: number, hi: number, lo: number) {
  const t = THREE.MathUtils.clamp((hi - sizePx) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}
function fmtAlt(a: number) {
  return a < 1000 ? `${Math.max(0, Math.round(a))} m` : `${(a / 1000).toFixed(1)} km`;
}
function star(c: CanvasRenderingContext2D, x: number, y: number, r: number) {
  c.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI;
    c.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    c.lineTo(x - Math.cos(a) * r, y - Math.sin(a) * r);
  }
  c.stroke();
}
