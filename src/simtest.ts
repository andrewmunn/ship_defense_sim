import { World } from './sim/world';
import { PRESETS, cloneScenario } from './sim/scenario';

// Headless balance test: runs presets at full speed and prints outcomes.
const P = new URLSearchParams(location.search);
const out = document.getElementById('out')!;
const lines: string[] = [];
const log = (s: string) => { lines.push(s); out.textContent = lines.join('\n'); console.log(s); };
const only = P.get('p');
const runs = parseInt(P.get('n') ?? '1');
const verbose = P.has('v');
(globalThis as any).__dbg = P.has('dbg');
for (const preset of PRESETS) {
  if (only && !preset.name.toLowerCase().includes(only.toLowerCase())) continue;
  for (let r = 0; r < runs; r++) {
    const cfg = cloneScenario(preset);
    cfg.seed = 1 + r;
    const w = new World(cfg);
    if (verbose) w.events.on('log', (e) => log(`  ${e.t.toFixed(1).padStart(6)} ${e.text}`));
    const t0 = performance.now();
    while (!w.over && w.t < 900) w.step(1 / 60);
    const s = w.stats;
    if (!w.over) for (const th of w.threats.filter((x) => x.alive)) log(`   alive: ${th.spec.short} phase ${th.phase} alt ${th.pos.y.toFixed(0)} age ${th.age.toFixed(0)} fuel ${th.fuelTime.toFixed(0)} seduced ${th.seduced} lock ${!!th.lockTarget} rng ${th.pos.distanceTo(w.ship.pos).toFixed(0)}`);
    log(`${preset.name.padEnd(18)} seed ${cfg.seed}: ${w.outcome || 'timeout'} t=${w.t.toFixed(0)}s launched ${s.launched} killed ${s.killed} hits ${s.hits} hp ${w.ship.hp.toFixed(0)} | by ${JSON.stringify(s.byWeapon)} fired ${JSON.stringify(s.fired)} ciws ${s.ciwsRounds} gun ${s.gunRounds} seduced ${s.decoysSeduced} sea ${s.splashedOther} res ${JSON.stringify(s.results)} | ${(performance.now() - t0).toFixed(0)} ms`);
  }
}
log('DONE');
(window as any).__ready = true;
if (P.has('fly')) {
  // Interceptor fly-out profile vs a static far target
  const cfg = cloneScenario(PRESETS[0]);
  const w = new World(cfg);
  for (let i = 0; i < 60 * 150 && !w.interceptors.length; i++) w.step(1 / 60);
  const m = w.interceptors[0];
  if (m) {
    for (let i = 0; i < 60 * 40 && m.alive; i++) {
      w.step(1 / 60);
      if (i % 60 === 0) log(`fly t=${m.age.toFixed(1)} ${m.phase} v=${m.vel.length().toFixed(0)} alt=${(m.pos.y).toFixed(0)} rng=${m.pos.distanceTo(w.ship.pos).toFixed(0)} tgt=${m.pos.distanceTo(m.target.pos).toFixed(0)}`);
    }
  }
}
