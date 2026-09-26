import * as THREE from 'three';
import { Game, TIME_SCALES } from '../game/game';
import type { Entity } from '../sim/entities';
import type { Threat } from '../sim/threat';
import type { Interceptor } from '../sim/interceptor';
import type { Launcher, Ship } from '../sim/entities';
import type { World } from '../sim/world';
import { INTERCEPTORS } from '../sim/specs';
import { altitude, horizonDist, bearingTo, surfaceDistance, destination } from '../core/geo';
import { DEG, K_REFRACTION, KNOTS, SPEED_OF_SOUND } from '../core/constants';
import { totalThreats } from '../sim/scenario';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

function el(html: string) {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
}
const fmtT = (t: number) => {
  const s = Math.max(0, Math.floor(t));
  return `T+${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const fmtAlt = (a: number) => (a < 1000 ? `${Math.max(0, Math.round(a))} m` : `${(a / 1000).toFixed(2)} km`);
const brg = (b: number) => String(Math.round(((b / DEG) % 360 + 360) % 360)).padStart(3, '0');

export interface HudHooks {
  onVampire?(): void;
  onBrace?(): void;
  onClick?(): void;
  onKill?(): void;
  onNewTrack?(): void;
  openSetup?(): void;
  openHelp?(): void;
  toggleCinematic?(): boolean;
  camMode?(): string;
  setCam?(mode: string): void;
}

/** DOM heads-up display. */
export class Hud {
  root: HTMLElement;
  private logLines: HTMLElement;
  private scopeCanvas: HTMLCanvasElement;
  private scopeRange = 25000;
  private scopeAcc = 0;
  private slowAcc = 0;
  private coast: THREE.Vector3[] = [];
  private vampireShown = false;
  private braceUntil = 0;
  private bannerTimer = 0;
  private lastHostiles = 0;
  private overShown = false;
  hooks: HudHooks = {};
  private sweep = 0;

  constructor(private game: Game) {
    this.root = el(`<div id="hud"></div>`);
    document.body.appendChild(this.root);
    this.root.innerHTML = `
      <div class="panel keep" id="brand">
        <div class="t">VANGUARD</div>
        <div class="s">DDV-01 · BASTION AIR DEFENSE · <span class="scn"></span></div>
        <div class="btns">
          <button class="btn" data-a="setup">Scenario</button>
          <button class="btn" data-a="restart">Restart</button>
          <button class="btn" data-a="cine">Cinematic</button>
          <button class="btn" data-a="help">?</button>
        </div>
      </div>
      <div class="panel keep" id="topbar">
        <div class="cell" id="clock"><div class="k">Sim time</div><div class="v">T+00:00</div></div>
        <div class="cell" id="timectl"></div>
        <div class="cell" id="raid"><div class="k">Raid</div><div class="v"></div></div>
      </div>
      <div class="panel" id="weapons"><h3>Own ship <b class="hdg"></b></h3><div class="body"></div></div>
      <div class="panel" id="log"><h3>Combat log <b class="cnt"></b></h3><div class="lines"></div></div>
      <div class="panel" id="inspector" style="display:none"><h3><span class="kind">Track</span><b class="x" style="cursor:pointer">✕</b></h3><div class="body"></div></div>
      <div class="panel" id="scope"><h3>Sentinel PPI <span class="modes"></span></h3><canvas width="544" height="544"></canvas></div>
      <div class="panel keep" id="camchip"></div>
      <div class="banner" id="banner"></div>
    `;
    this.logLines = $('#log .lines', this.root);
    this.scopeCanvas = $('#scope canvas', this.root) as HTMLCanvasElement;
    // time controls
    const tc = $('#timectl', this.root);
    const pb = el(`<button class="pause" title="Pause (Space)">❚❚</button>`);
    pb.onclick = () => { this.hooks.onClick?.(); game.setPaused(!game.paused); };
    tc.appendChild(pb);
    const ab = el(`<button class="auto" title="Auto time: fast through quiet stretches, real time when threats close in (A)">AUTO</button>`);
    ab.onclick = () => { this.hooks.onClick?.(); game.setPaused(false); game.setAutoTime(!game.autoTime); };
    tc.appendChild(ab);
    for (const s of TIME_SCALES) {
      const b = el(`<button data-s="${s}">${s < 1 ? (s === 0.05 ? '1/20' : s === 0.1 ? '1/10' : s === 0.25 ? '¼' : '½') : s + '×'}</button>`);
      b.title = `${s}× time`;
      b.onclick = () => { this.hooks.onClick?.(); game.setPaused(false); game.setAutoTime(false); game.setTimeScale(s); };
      tc.appendChild(b);
    }
    game.events.on('timeScale', () => this.syncTime());
    this.syncTime();
    // scope range modes
    const modes = $('#scope .modes', this.root);
    for (const r of [10, 25, 50, 100]) {
      const s = el(`<span data-r="${r}">${r}</span>`);
      s.onclick = () => { this.scopeRange = r * 1000; this.syncScopeModes(); };
      modes.appendChild(s);
    }
    this.syncScopeModes();
    this.scopeCanvas.addEventListener('click', (e) => this.scopeClick(e));
    // buttons
    this.root.querySelectorAll<HTMLButtonElement>('#brand .btn').forEach((b) => {
      b.onclick = () => {
        this.hooks.onClick?.();
        const a = b.dataset.a;
        if (a === 'setup') this.hooks.openSetup?.();
        if (a === 'restart') game.restart(game.cfg);
        if (a === 'help') this.hooks.openHelp?.();
        if (a === 'cine') b.classList.toggle('on', !!this.hooks.toggleCinematic?.());
      };
    });
    $('#inspector .x', this.root).onclick = () => game.select(null);
    game.events.on('restart', ({ world }) => this.onRestart(world));
    game.events.on('select', () => this.updateInspector(true));
    this.onRestart(game.world);
  }

  private syncTime() {
    const g = this.game;
    this.root.querySelectorAll<HTMLButtonElement>('#timectl button').forEach((b) => {
      if (b.classList.contains('pause')) b.classList.toggle('on', g.paused);
      else if (b.classList.contains('auto')) b.classList.toggle('on', g.autoTime);
      else b.classList.toggle('on', !g.paused && Math.abs(parseFloat(b.dataset.s!) - g.timeScale) < 1e-6);
      b.classList.toggle('dim', !b.classList.contains('pause') && !b.classList.contains('auto') && g.autoTime);
    });
  }
  private syncScopeModes() {
    this.root.querySelectorAll<HTMLElement>('#scope .modes span').forEach((s) => s.classList.toggle('on', +s.dataset.r! * 1000 === this.scopeRange));
  }

  private onRestart(world: World) {
    this.logLines.innerHTML = '';
    this.vampireShown = false;
    this.overShown = false;
    this.lastHostiles = 0;
    this.braceUntil = 0;
    $('#brand .scn', this.root).textContent = this.game.cfg.name.toUpperCase();
    world.events.on('log', (e) => this.log(e.t, e.text, e.level));
    world.events.on('kill', () => this.hooks.onKill?.());
    world.events.on('track', () => this.hooks.onNewTrack?.());
    world.events.on('shipHit', (e) => this.banner('IMPACT', `${e.zone.toUpperCase()} · hull ${Math.round(world.ship.hp)}%`, 2.2, true, false));
    world.events.on('sunk', () => this.banner('SHIP LOST', 'Vanguard is sinking', 8, true, false));
    this.log(0, `Scenario "${this.game.cfg.name}" — ${totalThreats(this.game.cfg)} missiles expected. ${this.game.cfg.desc}`, 'info');
    if (world.raidDelay > 0) this.log(0, `Batteries are out of range for the planned arrival times: the raid is timed ${Math.round(world.raidDelay)} s later (first arrivals ~T+${Math.round(world.firstArrival)} s).`, 'info');
    // coastline for the scope
    this.coast = [];
    const cb = world.cfg.coastBearing * DEG;
    for (let a = -100; a <= 100; a += 2.5) {
      const b = cb + a * DEG;
      const d = world.coastPoint(b);
      if (d < 240000) this.coast.push(destination(new THREE.Vector3(), b, d));
      else this.coast.push(new THREE.Vector3(NaN, NaN, NaN));
    }
  }

  log(t: number, text: string, level: string) {
    const d = el(`<div class="l ${level} new"><span class="t">${fmtT(t).slice(2)}</span></div>`);
    d.appendChild(document.createTextNode(text));
    this.logLines.appendChild(d);
    while (this.logLines.children.length > 14) this.logLines.firstElementChild!.remove();
    setTimeout(() => d.classList.remove('new'), 1000);
  }

  banner(text: string, sub: string, dur: number, hostile = true, pulse = true) {
    const b = $('#banner', this.root);
    b.innerHTML = '';
    b.appendChild(document.createTextNode(text));
    if (sub) b.appendChild(el(`<span class="sub">${sub}</span>`));
    b.className = 'banner show' + (pulse ? ' pulse' : '') + (hostile ? '' : ' good');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => b.classList.remove('show', 'pulse'), dur * 1000);
  }

  update(dtReal: number) {
    const g = this.game, W = g.world;
    $('#clock .v', this.root).textContent = fmtT(W.t);
    this.scopeAcc += dtReal;
    this.slowAcc += dtReal;
    this.sweep += dtReal * 1.6;
    if (this.scopeAcc > 1 / 30) {
      this.scopeAcc = 0;
      this.drawScope();
    }
    if (this.slowAcc > 0.12) {
      this.slowAcc = 0;
      this.updateRaid();
      this.updateWeapons();
      this.updateInspector(false);
      this.updateCamChip();
      this.alerts();
    }
  }

  private alerts() {
    const W = this.game.world;
    const hostiles = W.radar.activeTracks().filter((t) => t.cls === 'hostile').length;
    if (hostiles > 0 && !this.vampireShown) {
      this.vampireShown = true;
      this.banner('VAMPIRE · VAMPIRE', `${hostiles} inbound anti-ship missile${hostiles > 1 ? 's' : ''}`, 3.5);
      this.hooks.onVampire?.();
    } else if (hostiles > this.lastHostiles + 3 && this.vampireShown) {
      this.banner('NEW RAID', `${hostiles} hostile tracks`, 2.5);
      this.hooks.onVampire?.();
    }
    this.lastHostiles = Math.max(this.lastHostiles, hostiles);
    // brace: a live threat about to reach the ship
    for (const th of W.threats) {
      if (!th.alive) continue;
      const r = th.pos.distanceTo(W.ship.pos);
      const cl = -th.pos.clone().sub(W.ship.pos).dot(th.vel.clone().sub(W.ship.vel)) / Math.max(r, 1);
      if (cl > 50 && r / cl < 3.5 && r < 3000 && W.t > this.braceUntil) {
        this.braceUntil = W.t + 6;
        this.banner('BRACE · BRACE · BRACE', 'leaker inbound', 2.5);
        this.hooks.onBrace?.();
        break;
      }
    }
    if (W.over && !this.overShown) {
      this.overShown = true;
      if (W.outcome === 'survived') this.banner('RAID DEFEATED', `${W.stats.killed}/${W.stats.launched} killed · ${W.stats.hits} hit${W.stats.hits === 1 ? '' : 's'} taken`, 7, false, false);
    }
  }

  private updateRaid() {
    const W = this.game.world;
    const alive = W.threats.filter((t) => t.alive).length;
    const pending = W.plan.length;
    $('#raid .v', this.root).innerHTML = `<span class="inb" title="airborne">▲ ${alive}</span><span class="kil" title="killed">✕ ${W.stats.killed}</span><span class="hit" title="hits taken">✹ ${W.stats.hits}</span><span style="color:var(--faint)" title="yet to launch">⧗ ${pending}</span>`;
    $('#raid .k', this.root).textContent = `Air · Kill · Hit · Queue`;
  }

  private updateWeapons() {
    const W = this.game.world, ship = W.ship;
    const body = $('#weapons .body', this.root);
    const lo = W.cfg.loadout;
    const inv = W.bastion.inventory;
    const hullCls = ship.hp > 60 ? '' : ship.hp > 30 ? 'mid' : 'low';
    const inflight = (k: string) => W.interceptors.filter((m) => m.alive && m.spec.type === k).length;
    const vls = (k: 'halberd' | 'glaive' | 'stiletto', max: number) => {
      const n = inv[k];
      const f = inflight(k);
      return `<div class="row"><span class="n">${INTERCEPTORS[k].short}</span><div class="bar"><i style="width:${max ? (100 * n) / max : 0}%"></i></div><span class="c">${n}${f ? ` <span style="color:var(--accent)">↑${f}</span>` : ''}</span></div>`;
    };
    const st = (s: string) => {
      const m: Record<string, string> = { standby: 'ready', track: 'track', fire: 'fire', reload: 'reload', out: 'out', disabled: 'disabled' };
      const lab: Record<string, string> = { standby: 'READY', track: 'TRACK', fire: 'FIRE', reload: 'RELOAD', out: 'EMPTY', disabled: 'OFFLINE' };
      return `<span class="st ${m[s] ?? ''}">${lab[s] ?? s.toUpperCase()}</span>`;
    };
    const zone = (d: number) => (d > 45 ? 'd2' : d > 5 ? 'd1' : '');
    const ciws = W.ciws.map((c, i) => `<div class="row"><span class="n">HORNET ${i + 1}</span><div class="bar"><i style="width:${(100 * c.ammo) / 1550}%"></i></div><span class="c">${st(c.state)}</span></div>`).join('');
    const illum = W.illuminators.map((il) => (il.enabled ? (il.assigned.length ? '◉' : '○') : '✕')).join(' ');
    body.innerHTML = `
      <div class="row"><span class="n">HULL</span><div class="bar hull ${hullCls}"><i style="width:${ship.hp}%"></i></div><span class="c">${Math.round(ship.hp)}%</span></div>
      <div class="zones"><div class="${zone(ship.damage.fwd)}">FWD</div><div class="${zone(ship.damage.mid)}">MID</div><div class="${zone(ship.damage.aft)}">AFT</div></div>
      ${vls('glaive', lo.glaive)}${vls('halberd', lo.halberd)}${vls('stiletto', lo.stiletto)}
      <div class="sep"></div>
      ${ciws}
      <div class="row"><span class="n">ANVIL 5"</span><div class="bar"><i style="width:${(100 * W.gun.ammo) / Math.max(1, lo.gunRounds)}%"></i></div><span class="c">${st(W.gun.state)}</span></div>
      <div class="sep"></div>
      <div class="row"><span class="n">LANTERN</span><span style="color:var(--dim);letter-spacing:0.3em">${illum}</span><span class="c">${W.illuminators.reduce((a, i) => a + i.assigned.length, 0)} ill</span></div>
      <div class="row"><span class="n">DECOYS</span><span style="color:var(--dim)">WISP ${W.wisp} · CHAFF ${W.chaff}</span><span class="c"></span></div>
      <div class="row" style="padding-bottom:8px"><span class="n">SENTINEL</span><span style="color:var(--dim)">${W.radar.activeTracks().length} tracks${W.radar.degraded > 0 ? ` · <span style="color:var(--warn)">DEGRADED</span>` : ''}</span><span class="c"></span></div>
    `;
    $('#weapons .hdg', this.root).textContent = `${brg(ship.heading)}° · ${(ship.speed / KNOTS).toFixed(0)} KT`;
  }

  private updateCamChip() {
    const g = this.game;
    const tgt = g.rig.target as Entity | null;
    const name = tgt ? entityName(g.world, tgt) : 'free point';
    const mode = this.hooks.camMode?.() ?? g.rig.mode;
    $('#camchip', this.root).innerHTML = mode === 'cinematic'
      ? `<span>CAM <b>CINEMATIC</b> · <b>${name}</b> · drag / scroll to take control · C toggles</span>`
      : `<span>CAM <b>${mode}</b> · <b>${name}</b> · V cycles views · C cinematic · H help</span>`;
  }

  // ------------------------------------------------------------------ inspector
  private updateInspector(force: boolean) {
    const g = this.game, W = g.world;
    const e = g.selected;
    const box = $('#inspector', this.root);
    if (!e) {
      box.style.display = 'none';
      return;
    }
    box.style.display = '';
    const body = $('.body', box);
    const kv = (rows: [string, string][]) => `<div class="kv">${rows.map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join('')}</div>`;
    const ship = W.ship;
    const rng = e.pos.distanceTo(ship.pos);
    const alt = altitude(e.pos);
    const sp = e.vel.length();
    let html = '', kind = '', cls = '';
    if (e.kind === 'threat') {
      const th = e as Threat;
      const tr = W.radar.byThreat.get(th.id);
      kind = 'Hostile missile';
      cls = 'hostile';
      const cl = -th.pos.clone().sub(ship.pos).dot(th.vel.clone().sub(ship.vel)) / Math.max(rng, 1);
      const ttg = cl > 20 ? rng / cl : Infinity;
      const inflight = tr ? tr.engagedBy.filter((m) => m.alive) : [];
      html = `<div class="title">${tr && tr.firm ? 'TN ' + tr.tn : 'UNTRACKED'} · ${th.spec.short}</div><div class="sub">${th.spec.name}</div>` +
        kv([
          ['Track', tr && tr.firm && !tr.lost ? `${tr.cls.toUpperCase()} · q ${(tr.quality * 100).toFixed(0)}%` : '<span style="color:var(--warn)">not held by radar</span>'],
          ['Phase', th.phase.toUpperCase() + (th.seduced ? ' · <span style="color:var(--good)">SEDUCED</span>' : '')],
          ['Speed', `${Math.round(sp)} m/s · M${(sp / SPEED_OF_SOUND).toFixed(2)}`],
          ['Altitude', fmtAlt(alt)],
          ['Range', `${(rng / 1000).toFixed(2)} km · brg ${brg(bearingTo(ship.pos, th.pos))}`],
          ['Time to ship', isFinite(ttg) ? `${ttg.toFixed(1)} s` : '—'],
          ['Seeker', th.seekerOn ? (th.lockTarget ? (th.seduced ? 'LOCKED · DECOY' : 'LOCKED · OWN SHIP') : 'SEARCHING') : 'OFF (midcourse)'],
          ['Engaged by', inflight.length ? inflight.map((m) => m.spec.short).join(', ') : '—'],
          ['CIWS hits', `${th.ciwsHits}`],
          ['Warhead', `${th.spec.warheadKg} kg`],
          ['Airframe', `${Math.max(0, th.hp).toFixed(1)} / ${th.spec.hp.toFixed(1)}`],
        ]);
    } else if (e.kind === 'interceptor') {
      const m = e as Interceptor;
      kind = 'Interceptor';
      cls = 'friend';
      const rt = m.pos.distanceTo(m.target.pos);
      html = `<div class="title">${m.spec.short} → TN ${m.track.tn}</div><div class="sub">${m.spec.name}</div>` +
        kv([
          ['Phase', m.phase.toUpperCase()],
          ['Motor', m.motorOn ? `BURN ${(m.thrust / 9.81).toFixed(0)} g` : 'COAST'],
          ['Speed', `${Math.round(sp)} m/s · M${(sp / SPEED_OF_SOUND).toFixed(2)}`],
          ['Altitude', fmtAlt(alt)],
          ['To target', `${(rt / 1000).toFixed(2)} km · tgo ${m.tgo.toFixed(1)} s`],
          ['Guidance', m.phase === 'terminal' ? (m.spec.semiActive ? (m.illuminated ? 'SARH · ILLUMINATED' : 'SARH · <span style="color:var(--warn)">NO ILLUM</span>') : 'ACTIVE SEEKER') : 'MIDCOURSE UPLINK'],
          ['Closest', isFinite(m.missDist) ? `${m.missDist.toFixed(1)} m` : '—'],
          ['Lethal radius', `${m.spec.lethalRadius} m`],
          ['From', `${m.launcher.toUpperCase()} VLS cell ${m.cell}`],
        ]);
    } else if (e.kind === 'ship') {
      const s = e as Ship;
      kind = 'Own ship';
      cls = 'friend';
      html = `<div class="title">DDV-01 VANGUARD</div><div class="sub">Vanguard-class guided missile destroyer</div>` +
        kv([
          ['Hull', `${Math.round(s.hp)}%${s.sinking ? ' · <span style="color:var(--hostile)">SINKING</span>' : ''}`],
          ['Course', `${brg(s.heading)}° · ${(s.speed / KNOTS).toFixed(1)} kt`],
          ['Motion', `roll ${(s.roll / DEG).toFixed(1)}° · pitch ${(s.pitch / DEG).toFixed(1)}°`],
          ['Hits taken', `${s.hits}`],
          ['Fires', `${s.fires.length}`],
          ['Radar', `${W.radar.activeTracks().length} tracks · horizon ${(horizonDist(W.radar.height, K_REFRACTION) / 1000).toFixed(1)} km`],
          ['Fired', `GLV ${W.stats.fired.glaive} · HAL ${W.stats.fired.halberd} · STL ${W.stats.fired.stiletto}`],
          ['CIWS rounds', `${W.stats.ciwsRounds}`],
          ['5" rounds', `${W.stats.gunRounds}`],
        ]);
    } else if (e.kind === 'launcher') {
      const L = e as Launcher;
      kind = 'Coastal battery';
      cls = 'hostile';
      html = `<div class="title">${L.name.toUpperCase()}</div><div class="sub">Mobile coastal anti-ship missile TEL</div>` +
        kv([
          ['Status', L.erect > 0.5 ? 'ERECTED' : 'TRAVEL'],
          ['Range', `${(surfaceDistance(L.pos, ship.pos) / 1000).toFixed(1)} km · brg ${brg(bearingTo(ship.pos, L.pos))}`],
          ['Elevation', `${Math.round(alt)} m`],
          ['Last launch', L.lastFire > 0 ? fmtT(L.lastFire) : '—'],
        ]);
    }
    box.className = 'panel ' + cls;
    $('.kind', box).textContent = kind;
    if (force || body.dataset.id !== String(e.id)) {
      body.dataset.id = String(e.id);
      body.innerHTML = `<div class="info"></div><div class="btns">
      <button class="btn" data-c="orbit">Orbit</button>
      ${e.kind === 'threat' || e.kind === 'interceptor' ? '<button class="btn" data-c="chase">Chase</button><button class="btn" data-c="nose">Seeker</button>' : ''}
      ${e.kind === 'ship' ? '<button class="btn" data-c="bridge">Bridge</button><button class="btn" data-c="ciws">CIWS</button><button class="btn" data-c="deck">Deck</button>' : ''}
      </div>`;
      body.querySelectorAll<HTMLButtonElement>('button[data-c]').forEach((b) => (b.onclick = () => { this.hooks.onClick?.(); this.hooks.setCam?.(b.dataset.c!); }));
    }
    $('.info', body).innerHTML = html;
  }

  // ------------------------------------------------------------------ PPI scope
  private drawScope() {
    const c = this.scopeCanvas, ctx = c.getContext('2d')!;
    const W = this.game.world, ship = W.ship;
    const S = c.width, cx = S / 2, cy = S / 2, R = S / 2 - 14;
    const k = R / this.scopeRange;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = 'rgba(2,12,16,0.55)';
    ctx.beginPath();
    ctx.arc(cx, cy, R + 6, 0, Math.PI * 2);
    ctx.fill();
    const toXY = (p: THREE.Vector3) => {
      const b = bearingTo(ship.pos, p);
      const d = surfaceDistance(ship.pos, p);
      return [cx + Math.sin(b) * d * k, cy - Math.cos(b) * d * k, d] as const;
    };
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    // coastline
    ctx.strokeStyle = 'rgba(150,190,120,0.55)';
    ctx.fillStyle = 'rgba(90,110,70,0.16)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    const pts: [number, number][] = [];
    for (const p of this.coast) {
      if (isNaN(p.x)) { started = false; continue; }
      const [x, y] = toXY(p);
      pts.push([x, y]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    if (pts.length > 2) {
      // shade the landward side
      const cb = W.cfg.coastBearing * DEG;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (const [x, y] of pts) ctx.lineTo(x, y);
      const far = 4 * R;
      ctx.lineTo(cx + Math.sin(cb + 1.8) * far, cy - Math.cos(cb + 1.8) * far);
      ctx.lineTo(cx + Math.sin(cb) * far, cy - Math.cos(cb) * far);
      ctx.lineTo(cx + Math.sin(cb - 1.8) * far, cy - Math.cos(cb - 1.8) * far);
      ctx.closePath();
      ctx.fill();
    }
    // range rings
    ctx.strokeStyle = 'rgba(94,200,255,0.16)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(94,200,255,0.4)';
    ctx.font = '500 16px "SF Mono", Menlo, monospace';
    const step = this.scopeRange / 4;
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, step * i * k, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(`${(step * i) / 1000}`, cx + 3, cy - step * i * k + 16);
    }
    for (let a = 0; a < 360; a += 30) {
      const r0 = a % 90 === 0 ? 0 : R * 0.9;
      ctx.beginPath();
      ctx.moveTo(cx + Math.sin(a * DEG) * r0, cy - Math.cos(a * DEG) * r0);
      ctx.lineTo(cx + Math.sin(a * DEG) * R, cy - Math.cos(a * DEG) * R);
      ctx.stroke();
    }
    // radar horizon vs a 5 m sea-skimmer (dashed amber)
    const hz = horizonDist(W.radar.height, K_REFRACTION) + horizonDist(5, K_REFRACTION);
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(255,179,71,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, hz * k, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // stylized sweep
    const sw = this.sweep % (Math.PI * 2);
    const grad = ctx.createConicGradient ? ctx.createConicGradient(sw - Math.PI / 2 - 0.6, cx, cy) : null;
    if (grad) {
      grad.addColorStop(0, 'rgba(94,200,255,0)');
      grad.addColorStop(0.095, 'rgba(94,200,255,0.12)');
      grad.addColorStop(0.1, 'rgba(94,200,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
    }
    // launch sites
    for (const L of W.launchers) {
      const [x, y] = toXY(L.pos);
      ctx.strokeStyle = 'rgba(255,75,62,0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath();
      ctx.stroke();
    }
    // decoys
    ctx.fillStyle = 'rgba(255,224,102,0.8)';
    for (const d of W.decoys) {
      if (d.remove) continue;
      const [x, y] = toXY(d.pos);
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }
    // interceptors
    ctx.fillStyle = '#5ec8ff';
    ctx.strokeStyle = 'rgba(94,200,255,0.6)';
    for (const m of W.interceptors) {
      if (!m.alive) continue;
      const [x, y] = toXY(m.pos);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // radar tracks (what Bastion sees)
    for (const tr of W.radar.tracks) {
      if (!tr.firm || tr.dead) continue;
      const [x, y] = toXY(tr.estPos);
      const col = tr.lost ? 'rgba(255,179,71,0.5)' : tr.cls === 'hostile' ? '#ff4b3e' : '#ffb347';
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = 2;
      const v = tr.estVel;
      const [x2, y2] = toXY(tr.estPos.clone().addScaledVector(v, 20));
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (x2 - x), y + (y2 - y));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 7, y + 3); ctx.lineTo(x, y - 7); ctx.lineTo(x + 7, y + 3);
      ctx.stroke();
      if (this.game.selected === tr.threat) {
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(x - 11, y - 11, 22, 22);
      }
      ctx.font = '600 14px "SF Mono", Menlo, monospace';
      ctx.fillText(String(tr.tn), x + 9, y + 12);
    }
    // undetected truth (faint)
    ctx.fillStyle = 'rgba(255,90,70,0.35)';
    for (const th of W.threats) {
      if (!th.alive) continue;
      const tr = W.radar.byThreat.get(th.id);
      if (tr && tr.firm && !tr.lost) continue;
      const [x, y] = toXY(th.pos);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    // own ship + heading
    ctx.strokeStyle = '#7fd3ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(ship.heading) * 22, cy - Math.cos(ship.heading) * 22);
    ctx.stroke();
    // bezel & north
    ctx.strokeStyle = 'rgba(94,200,255,0.35)';
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(200,225,235,0.8)';
    ctx.font = '700 15px "SF Mono", Menlo, monospace';
    ctx.fillText('N', cx - 5, 13);
    ctx.fillStyle = 'rgba(255,179,71,0.8)';
    ctx.font = '500 13px "SF Mono", Menlo, monospace';
    ctx.fillText('- - radar horizon (5 m target)', 8, S - 6);
  }

  private scopeClick(e: MouseEvent) {
    const c = this.scopeCanvas;
    const r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * c.width, y = ((e.clientY - r.top) / r.height) * c.height;
    const W = this.game.world, ship = W.ship;
    const S = c.width, cx = S / 2, cy = S / 2, R = S / 2 - 14, k = R / this.scopeRange;
    let best: Entity | null = null, bd = 20;
    for (const th of [...W.threats, ...W.interceptors]) {
      if (!th.alive) continue;
      const b = bearingTo(ship.pos, th.pos), d = surfaceDistance(ship.pos, th.pos);
      const dd = Math.hypot(cx + Math.sin(b) * d * k - x, cy - Math.cos(b) * d * k - y);
      if (dd < bd) { bd = dd; best = th; }
    }
    if (best) this.game.select(best, true);
  }
}

export function entityName(W: World, e: Entity): string {
  if (e.kind === 'ship') return 'DDV-01 VANGUARD';
  if (e.kind === 'threat') {
    const th = e as Threat;
    const tr = W.radar.byThreat.get(th.id);
    return `${tr && tr.firm ? 'TN ' + tr.tn : 'UNTRACKED'} ${th.spec.short}`;
  }
  if (e.kind === 'interceptor') {
    const m = e as Interceptor;
    return `${m.spec.short} → TN ${m.track.tn}`;
  }
  if (e.kind === 'launcher') return (e as Launcher).name.toUpperCase();
  return e.name || e.kind;
}
