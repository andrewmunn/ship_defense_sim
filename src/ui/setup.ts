import type { Game } from '../game/game';
import { PRESETS, ScenarioConfig, cloneScenario, totalThreats, WaveConfig } from '../sim/scenario';
import { THREATS, INTERCEPTORS, ThreatType } from '../sim/specs';

function el<T extends HTMLElement = HTMLElement>(html: string) {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as T;
}

const THREAT_TYPES = Object.keys(THREATS) as ThreatType[];

/** Scenario editor: presets + every tunable (raid waves, loadout, doctrine, environment). */
export class SetupDialog {
  root: HTMLElement;
  private cfg: ScenarioConfig;
  private presetIdx = -1;
  onClose: () => void = () => {};

  constructor(private game: Game) {
    this.cfg = cloneScenario(game.cfg);
    this.root = el(`<div class="modal" id="setup"><div class="box"><h2>SCENARIO <small>tune the raid · Esc to close</small></h2><div class="inner"></div></div></div>`);
    document.body.appendChild(this.root);
    this.root.addEventListener('pointerdown', (e) => { if (e.target === this.root) this.close(); });
  }

  open() {
    this.cfg = cloneScenario(this.game.cfg);
    this.presetIdx = PRESETS.findIndex((p) => p.name === this.cfg.name);
    this.render();
    this.root.classList.add('show');
  }
  close() {
    this.root.classList.remove('show');
    this.onClose();
  }
  get isOpen() {
    return this.root.classList.contains('show');
  }

  private render() {
    const c = this.cfg;
    const inner = this.root.querySelector('.inner')!;
    const cells = Math.ceil(c.loadout.stiletto / INTERCEPTORS.stiletto.perCell) + c.loadout.halberd + c.loadout.glaive;
    inner.innerHTML = `
      <div class="sect">Presets</div>
      <div class="presets">${PRESETS.map((p, i) => `<div class="preset ${i === this.presetIdx ? 'on' : ''}" data-p="${i}"><div class="n">${p.name.toUpperCase()}</div><div class="d">${p.desc}</div><div class="c">${totalThreats(p)} MISSILES · ${p.waves.length} WAVE${p.waves.length > 1 ? 'S' : ''}</div></div>`).join('')}</div>

      <div class="sect">Raid <span><button class="btn" data-a="mult" data-k="0.5">×½</button> <button class="btn" data-a="mult" data-k="2">×2</button> <button class="btn" data-a="add">+ wave</button></span></div>
      <table>
        <tr><th>Arrive (s)</th><th>Type</th><th>Count</th><th>Spacing (s)</th><th>Axes</th><th>Fan (°)</th><th>Profile</th><th></th></tr>
        ${c.waves.map((w, i) => `<tr data-w="${i}">
          <td><input type="number" data-f="time" value="${w.time}" min="30" step="5"></td>
          <td><select data-f="type">${THREAT_TYPES.map((t) => `<option value="${t}" ${t === w.type ? 'selected' : ''}>${THREATS[t].short}</option>`).join('')}</select></td>
          <td><input type="number" data-f="count" value="${w.count}" min="1" max="200"></td>
          <td><input type="number" data-f="spacing" value="${w.spacing}" min="0" step="0.1"></td>
          <td><input type="number" data-f="axes" value="${w.axes}" min="1" max="8"></td>
          <td><input type="number" data-f="fan" value="${w.fan}" min="0" max="120"></td>
          <td><select data-f="profile"><option value="hi" ${w.profile === 'hi' ? 'selected' : ''}>hi-lo</option><option value="lo" ${w.profile === 'lo' ? 'selected' : ''}>sea-skim</option></select></td>
          <td><button class="btn danger" data-a="del" data-i="${i}">✕</button></td></tr>`).join('')}
      </table>
      <div style="color:var(--dim);margin-top:6px">Total: <b style="color:var(--hostile)">${totalThreats(c)}</b> missiles from ${c.sites} coastal batteries. "Arrive" is the planned time-on-target; launches are scheduled backwards from it.</div>

      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(210px,1fr))">
        <div>
          <div class="sect">Magazine <span style="font-size:10px;color:${cells > 96 ? 'var(--hostile)' : 'var(--dim)'}">${cells}/96 cells</span></div>
          ${this.num('loadout.glaive', 'Glaive (ER SAM)', 0, 96)}
          ${this.num('loadout.halberd', 'Halberd (MR SAM)', 0, 96)}
          ${this.num('loadout.stiletto', 'Stiletto (quad-pack)', 0, 384, 4)}
          ${this.num('loadout.ciwsRounds', 'Hornet CIWS rounds / mount', 0, 1550, 50)}
          ${this.num('loadout.gunRounds', 'Anvil 5" rounds', 0, 600, 10)}
          ${this.num('loadout.wisp', 'Wisp decoys', 0, 24)}
          ${this.num('loadout.chaff', 'Chaff rounds', 0, 60)}
        </div>
        <div>
          <div class="sect">Doctrine</div>
          <label>Engagement policy</label>
          <select data-k="doctrine.policy"><option value="auto" ${c.doctrine.policy === 'auto' ? 'selected' : ''}>Auto (SLS when time permits)</option><option value="sls" ${c.doctrine.policy === 'sls' ? 'selected' : ''}>Shoot-look-shoot</option><option value="salvo" ${c.doctrine.policy === 'salvo' ? 'selected' : ''}>Salvo (2 per threat)</option></select>
          ${this.range('doctrine.reaction', 'Reaction time (s)', 0.5, 12, 0.5)}
          ${this.range('doctrine.illumShare', 'Engagements / illuminator', 1, 3, 1)}
          ${this.check('doctrine.ciws', 'Hornet CIWS weapons free')}
          ${this.check('doctrine.gun', 'Anvil gun engages missiles')}
          ${this.check('doctrine.decoys', 'Soft-kill (Wisp / chaff)')}
          ${this.check('doctrine.maneuver', 'Maneuver: flank speed, unmask mounts')}
        </div>
        <div>
          <div class="sect">Environment</div>
          ${this.range('env.timeOfDay', 'Time of day (h)', 0, 24, 0.25)}
          ${this.range('env.seaState', 'Sea state', 0, 6, 1)}
          ${this.range('env.visibilityKm', 'Visibility (km)', 8, 150, 1)}
          ${this.range('env.clouds', 'Cloud cover', 0, 1, 0.05)}
          ${this.range('env.windDeg', 'Wind from (°)', 0, 355, 5)}
        </div>
        <div>
          <div class="sect">Geography & ship</div>
          ${this.range('coastKm', 'Coast distance (km)', 18, 90, 1)}
          ${this.range('coastBearing', 'Coast bearing (°)', 0, 355, 5)}
          ${this.range('sites', 'Launch batteries', 1, 8, 1)}
          ${this.range('ship.speedKts', 'Ship speed (kt)', 0, 32, 1)}
          ${this.range('ship.heading', 'Ship heading (°)', 0, 355, 5)}
          ${this.num('seed', 'Random seed', 1, 99999)}
        </div>
      </div>
      <div class="foot">
        <span style="color:var(--dim)">Tip: stack several time-on-target waves from 4+ axes with a small magazine to saturate Bastion.</span>
        <span><button class="btn" data-a="cancel">Cancel</button> <button class="btn on" data-a="go">Commence ▶</button></span>
      </div>`;
    inner.querySelectorAll<HTMLElement>('.preset').forEach((p) => (p.onclick = () => {
      this.presetIdx = +p.dataset.p!;
      this.cfg = cloneScenario(PRESETS[this.presetIdx]);
      this.render();
    }));
    inner.querySelectorAll<HTMLInputElement | HTMLSelectElement>('tr[data-w] [data-f]').forEach((inp) => {
      inp.onchange = () => {
        const w = this.cfg.waves[+(inp.closest('tr') as HTMLElement).dataset.w!] as any;
        const f = inp.dataset.f!;
        w[f] = f === 'type' || f === 'profile' ? inp.value : parseFloat(inp.value) || 0;
        this.custom();
        this.render();
      };
    });
    inner.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]').forEach((inp) => {
      const upd = () => {
        const v = inp instanceof HTMLInputElement && inp.type === 'checkbox' ? inp.checked : inp instanceof HTMLSelectElement ? inp.value : parseFloat(inp.value);
        this.set(inp.dataset.k!, v);
        const out = inp.parentElement?.querySelector('.val');
        if (out) out.textContent = String(v);
        this.custom();
      };
      inp.oninput = upd;
      inp.onchange = () => { upd(); if (inp.dataset.k!.startsWith('loadout')) this.render(); };
    });
    inner.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((b) => (b.onclick = () => {
      const a = b.dataset.a;
      if (a === 'add') {
        const last = this.cfg.waves[this.cfg.waves.length - 1];
        this.cfg.waves.push({ time: (last?.time ?? 140) + 20, type: 'asm_subsonic', count: 6, spacing: 1, axes: 2, fan: 30, profile: 'hi' } as WaveConfig);
      } else if (a === 'del') this.cfg.waves.splice(+b.dataset.i!, 1);
      else if (a === 'mult') this.cfg.waves.forEach((w) => (w.count = Math.max(1, Math.round(w.count * parseFloat(b.dataset.k!)))));
      else if (a === 'cancel') return this.close();
      else if (a === 'go') {
        if (!this.cfg.waves.length) return;
        this.game.restart(this.cfg);
        return this.close();
      }
      this.custom();
      this.render();
    }));
  }

  private custom() {
    if (this.presetIdx >= 0 && !this.cfg.name.endsWith('*')) this.cfg.name = this.cfg.name + '*';
  }

  private get(k: string): any {
    return k.split('.').reduce((o: any, p) => o[p], this.cfg);
  }
  private set(k: string, v: any) {
    const ps = k.split('.');
    const last = ps.pop()!;
    const o = ps.reduce((o: any, p) => o[p], this.cfg);
    o[last] = v;
  }
  private num(k: string, label: string, min: number, max: number, step = 1) {
    return `<label>${label}</label><input type="number" data-k="${k}" value="${this.get(k)}" min="${min}" max="${max}" step="${step}">`;
  }
  private range(k: string, label: string, min: number, max: number, step: number) {
    return `<label>${label} <span class="val">${this.get(k)}</span></label><input type="range" data-k="${k}" value="${this.get(k)}" min="${min}" max="${max}" step="${step}">`;
  }
  private check(k: string, label: string) {
    return `<label style="display:flex;gap:8px;align-items:center;text-transform:none;letter-spacing:0.04em;font-family:var(--mono);color:var(--text)"><input type="checkbox" data-k="${k}" ${this.get(k) ? 'checked' : ''}> ${label}</label>`;
  }
}

export class HelpDialog {
  root: HTMLElement;
  constructor() {
    this.root = el(`<div class="modal" id="help"><div class="box" style="width:min(760px,calc(100vw - 32px))"><h2>CONTROLS <small>Esc / H to close</small></h2><div class="inner"><div class="keys">
      <span><kbd>Left drag</kbd></span><span>Orbit camera (in bridge / CIWS / wing / seeker cams: look around, riding along)</span>
      <span><kbd>Z</kbd></span><span>Look around from where the camera is, still following the target; <kbd>W A S D</kbd> <kbd>E</kbd> <kbd>Q</kbd> drift, wheel zooms, <kbd>Z</kbd> again back to orbit</span>
      <span><kbd>Alt</kbd>/<kbd>Option</kbd>+drag</span><span>Glance around while following; the view swings back when you let go</span>
      <span><kbd>Right drag</kbd> / <kbd>Shift</kbd>+drag</span><span>Pan (detaches from target)</span>
      <span><kbd>Wheel</kbd></span><span>Zoom (planet-scale: 3 m → 4000 km)</span>
      <span><kbd>W A S D</kbd></span><span>Pan / fly (free camera); <kbd>Q</kbd> <kbd>E</kbd> rotate, <kbd>R</kbd> <kbd>F</kbd> zoom</span>
      <span><kbd>Click</kbd> an icon</span><span>Select &amp; follow · <kbd>Double-click</kbd> zoom in close</span>
      <span><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd></span><span>Cycle through inbound threats</span>
      <span><kbd>I</kbd></span><span>Cycle interceptors in flight</span>
      <span><kbd>Home</kbd> / <kbd>0</kbd></span><span>Back to own ship</span>
      <span><kbd>C</kbd></span><span>Cinematic auto-director on/off</span>
      <span><kbd>V</kbd></span><span>Camera: orbit → chase → seeker (on missiles) / bridge → CIWS → wing (on ship)</span>
      <span><kbd>G</kbd></span><span>Free-fly camera</span>
      <span><kbd>Space</kbd></span><span>Pause</span>
      <span><kbd>[</kbd> <kbd>]</kbd> or <kbd>-</kbd> <kbd>=</kbd></span><span>Slower / faster time (1/20× … 32×)</span>
      <span><kbd>Shift+A</kbd> / AUTO button</span><span>Auto time: fast through quiet stretches, real time when the fight is on</span>
      <span><kbd>1</kbd>–<kbd>6</kbd></span><span>Time presets: ¼×, 1×, 2×, 4×, 8×, 16×</span>
      <span><kbd>K</kbd></span><span>Skip ahead to the first contact</span>
      <span><kbd>L</kbd></span><span>Labels: all / threats / none</span>
      <span><kbd>T</kbd></span><span>Toggle ground truth (show undetected missiles)</span>
      <span><kbd>O</kbd></span><span>Toggle radar-horizon ring &amp; engagement lines</span>
      <span><kbd>U</kbd></span><span>Hide/show HUD</span>
      <span><kbd>M</kbd></span><span>Mute audio</span>
      <span><kbd>P</kbd></span><span>Scenario setup</span>
      <span><kbd>Esc</kbd></span><span>Deselect / close dialogs</span>
    </div>
    <p style="color:var(--dim);line-height:1.5;margin-top:14px">The world is a sphere with 1/6.4 of Earth's radius, so the radar horizon against a 5 m sea-skimmer is only ~11 km: missiles pop over the horizon and the kill chain is compressed. Weapon speeds and timings are real-world plausible. Everything Bastion does is automatic — your job is to watch, tune the scenario, and try to break it.</p>
    </div></div></div>`);
    document.body.appendChild(this.root);
    this.root.addEventListener('pointerdown', (e) => { if (e.target === this.root) this.close(); });
  }
  open() { this.root.classList.add('show'); }
  close() { this.root.classList.remove('show'); }
  get isOpen() { return this.root.classList.contains('show'); }
  toggle() { this.isOpen ? this.close() : this.open(); }
}

export class Debrief {
  root: HTMLElement;
  onReplay: () => void = () => {};
  onSetup: () => void = () => {};
  constructor(private game: Game) {
    this.root = el(`<div class="modal" id="debrief"><div class="box" style="width:min(820px,calc(100vw - 32px))"><h2><span class="h">DEBRIEF</span> <small>Esc to keep watching</small></h2><div class="inner"></div></div></div>`);
    document.body.appendChild(this.root);
    this.root.addEventListener('pointerdown', (e) => { if (e.target === this.root) this.close(); });
  }
  open() {
    const W = this.game.world, s = W.stats;
    const ok = W.outcome === 'survived';
    this.root.querySelector('.h')!.innerHTML = ok ? '<span style="color:var(--good)">RAID DEFEATED</span>' : '<span style="color:var(--hostile)">VANGUARD LOST</span>';
    const fired = s.fired.glaive + s.fired.halberd + s.fired.stiletto;
    const rows = Object.entries(s.byWeapon).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
    this.root.querySelector('.inner')!.innerHTML = `
      <div class="stat">
        <div><div class="k">MISSILES LAUNCHED</div><div class="v">${s.launched}</div></div>
        <div><div class="k">KILLED</div><div class="v" style="color:var(--good)">${s.killed}</div></div>
        <div><div class="k">HITS TAKEN</div><div class="v" style="color:${s.hits ? 'var(--hostile)' : 'var(--text)'}">${s.hits}</div></div>
        <div><div class="k">HULL</div><div class="v">${Math.round(W.ship.hp)}%</div></div>
      </div>
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div><div class="sect">Kills by weapon</div><table>${rows || '<tr><td>—</td></tr>'}<tr><td>Decoy seductions</td><td>${s.decoysSeduced}</td></tr><tr><td>Fell into the sea</td><td>${s.splashedOther}</td></tr></table></div>
        <div><div class="sect">Expenditure</div><table>
          <tr><td>Glaive</td><td>${s.fired.glaive}</td></tr><tr><td>Halberd</td><td>${s.fired.halberd}</td></tr><tr><td>Stiletto</td><td>${s.fired.stiletto}</td></tr>
          <tr><td>Interceptors / kill</td><td>${s.killed ? (fired / s.killed).toFixed(2) : '—'}</td></tr>
          <tr><td>20 mm rounds</td><td>${s.ciwsRounds}</td></tr><tr><td>5" rounds</td><td>${s.gunRounds}</td></tr>
          <tr><td>Engagement time</td><td>${Math.round(W.t)} s</td></tr></table></div>
      </div>
      <div class="foot"><span style="color:var(--dim)">${ok ? 'Try doubling the raid or cutting the magazine in Scenario.' : 'The defenses were saturated. Try fewer axes, more Glaives, or salvo doctrine.'}</span>
      <span><button class="btn" data-a="setup">Scenario</button> <button class="btn on" data-a="replay">Replay ↺</button></span></div>`;
    this.root.querySelector<HTMLButtonElement>('[data-a=replay]')!.onclick = () => { this.close(); this.onReplay(); };
    this.root.querySelector<HTMLButtonElement>('[data-a=setup]')!.onclick = () => { this.close(); this.onSetup(); };
    this.root.classList.add('show');
  }
  close() { this.root.classList.remove('show'); }
  get isOpen() { return this.root.classList.contains('show'); }
}
