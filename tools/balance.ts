/**
 * Headless balance runner: flies scenarios in plain Node (no browser, no dev server) across many
 * seeds and missile mixes, in parallel, and reports how often the ship is sunk and what hits it.
 *
 *   npm run balance -- --scenario saturation --runs 80 --mix 12,12,8 --mix 16,16,4
 *   npm run balance -- --scenario overwhelm --arrivals        (raid timing check, defenses off)
 *   npm run balance -- --list
 *
 * Every run gets its own scenario-seeded simulation RNG, so results are repeatable and
 * parallel workers never replay the same fight. `npm run balance -- --help` for all options.
 */
import { fork } from 'node:child_process';
import { cpus } from 'node:os';
import { World } from '../src/sim/world';
import { PRESETS, cloneScenario, totalThreats, type ScenarioConfig } from '../src/sim/scenario';

const HELP = `Usage: npm run balance -- [options]

  --scenario <name>   preset to run (case/punctuation-insensitive substring; default "saturation")
  --runs <n>          runs per mix (default 40)
  --mix <a,b,c>       missile count per wave, in the preset's wave order; repeat to compare mixes
                      (default: the preset as authored)
  --seed <n>          first seed (default 1); runs use seed, seed+1, ...
  --jobs <n>          parallel worker processes (default: CPU cores - 1)
  --arrivals          timing check instead of a fight: defenses off, report each wave's actual
                      arrival vs its planned time-on-target and any missiles that fell short
  --max-time <s>      sim-time cap per run (default 1500)
  --list              list presets and their waves
  --help`;

interface Opts {
  scenario: string;
  runs: number;
  mixes: number[][] | null;
  seed: number;
  jobs: number;
  arrivals: boolean;
  maxTime: number;
}

interface Task {
  id: number;
  mix: number;
  cfg: ScenarioConfig;
  seeds: number[];
  arrivals: boolean;
  maxTime: number;
}

interface RunResult {
  sunk: boolean;
  hits: number;
  hull: number;
  hitBy: Record<string, number>;
  /** --arrivals: per missile, seconds late vs plan at closest approach, and how it ended. */
  arrivals?: { wave: number; late: number; end: string }[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// ------------------------------------------------------------------ one run
function runOne(base: ScenarioConfig, seed: number, arrivals: boolean, maxTime: number): RunResult {
  const cfg = cloneScenario(base);
  cfg.seed = seed;
  if (arrivals) {
    cfg.loadout = { ...cfg.loadout, halberd: 0, glaive: 0, stiletto: 0, wisp: 0, chaff: 0 };
    cfg.doctrine = { ...cfg.doctrine, gun: false, ciws: false, decoys: false };
  }
  const w = new World(cfg);
  const hitBy: Record<string, number> = {};
  w.events.on('shipHit', (e) => (hitBy[e.source] = (hitBy[e.source] ?? 0) + 1));

  // Launches happen in plan order, so the k-th launch is plan[k].
  const plan = w.plan.slice();
  const flights: { th: World['threats'][number]; arrival: number; wave: number; minD: number; tMin: number; end: string }[] = [];
  if (arrivals) w.events.on('threatLaunch', (e) => {
    const pl = plan[flights.length];
    flights.push({ th: e.threat, arrival: pl.arrival, wave: pl.wave, minD: Infinity, tMin: 0, end: '' });
  });

  while (!w.over && w.t < maxTime) {
    if (arrivals) w.ship.hp = w.ship.maxHp; // measuring timing, not damage: keep the ship afloat and on course
    w.step(1 / 60);
    if (arrivals) {
      for (const f of flights) {
        if (f.end) continue;
        const d = f.th.pos.distanceTo(w.ship.pos);
        if (d < f.minD) { f.minD = d; f.tMin = w.t; }
        if (!f.th.alive) f.end = f.th.killedBy ?? 'dead';
      }
      if (!w.plan.length && flights.every((f) => f.end)) break;
    }
  }
  return {
    sunk: w.outcome === 'sunk',
    hits: w.stats.hits,
    hull: w.ship.hp,
    hitBy,
    arrivals: arrivals ? flights.map((f) => ({ wave: f.wave, late: f.tMin - f.arrival, end: f.end || 'airborne' })) : undefined,
  };
}

// ------------------------------------------------------------------ coordinator
function parse(): Opts {
  const a = process.argv.slice(2);
  const o: Opts = { scenario: 'saturation', runs: 40, mixes: null, seed: 1, jobs: Math.max(1, cpus().length - 1), arrivals: false, maxTime: 1500 };
  for (let i = 0; i < a.length; i++) {
    const v = () => {
      if (i + 1 >= a.length) throw new Error(`${a[i]} needs a value`);
      return a[++i];
    };
    switch (a[i]) {
      case '--scenario': o.scenario = v(); break;
      case '--runs': o.runs = +v(); break;
      case '--mix': (o.mixes ??= []).push(v().split(/[,/]/).map(Number)); break;
      case '--seed': o.seed = +v(); break;
      case '--jobs': o.jobs = +v(); break;
      case '--arrivals': o.arrivals = true; break;
      case '--max-time': o.maxTime = +v(); break;
      case '--list':
        for (const p of PRESETS) console.log(`${p.name.padEnd(18)} ${p.waves.map((w) => `${w.type}×${w.count} @${w.time}s`).join(', ')}`);
        process.exit(0);
      case '--help': case '-h': console.log(HELP); process.exit(0);
      default: throw new Error(`unknown option ${a[i]} (see --help)`);
    }
  }
  return o;
}

const waveLabel = (t: string) => t.replace('asm_', '');
const pct = (k: number, n: number) => {
  const p = k / n;
  return `${Math.round(p * 100)}% ±${Math.round(196 * Math.sqrt((p * (1 - p)) / n))}`;
};

async function main() {
  let o: Opts;
  try {
    o = parse();
  } catch (e) {
    console.error(String((e as Error).message));
    process.exit(2);
  }
  const preset = PRESETS.find((p) => norm(p.name).includes(norm(o.scenario)));
  if (!preset) {
    console.error(`No preset matches "${o.scenario}". Presets: ${PRESETS.map((p) => p.name).join(', ')}`);
    process.exit(2);
  }
  const mixes = o.mixes ?? [preset.waves.map((w) => w.count)];
  const cfgs = mixes.map((m) => {
    if (m.length !== preset.waves.length || m.some((x) => !Number.isInteger(x) || x < 0)) {
      console.error(`--mix ${m.join(',')}: need ${preset.waves.length} whole numbers (${preset.waves.map((w) => waveLabel(w.type)).join(', ')})`);
      process.exit(2);
    }
    const c = cloneScenario(preset);
    c.waves.forEach((w, i) => (w.count = m[i]));
    return c;
  });

  console.log(`${preset.name} · waves ${preset.waves.map((w) => `${waveLabel(w.type)} @${w.time}s`).join(', ')} · ${o.runs} runs per mix from seed ${o.seed}${o.arrivals ? ' · ARRIVALS (defenses off)' : ''}`);

  // Split every mix's seeds into small tasks and feed them to a pool of workers.
  const jobs = Math.max(1, Math.min(o.jobs, mixes.length * o.runs));
  const chunk = Math.max(1, Math.ceil((mixes.length * o.runs) / (jobs * 3)));
  const tasks: Task[] = [];
  cfgs.forEach((cfg, mi) => {
    for (let s = 0; s < o.runs; s += chunk) {
      const seeds = Array.from({ length: Math.min(chunk, o.runs - s) }, (_, k) => o.seed + s + k);
      tasks.push({ id: tasks.length, mix: mi, cfg, seeds, arrivals: o.arrivals, maxTime: o.maxTime });
    }
  });
  const results: RunResult[][] = mixes.map(() => []);
  let done = 0;
  const total = mixes.length * o.runs;
  const t0 = Date.now();
  await new Promise<void>((resolve) => {
    let next = 0, live = 0;
    const feed = (child: ReturnType<typeof fork>) => {
      if (next < tasks.length) child.send(tasks[next++]);
      else {
        child.kill();
        if (--live === 0) resolve();
      }
    };
    for (let j = 0; j < jobs; j++) {
      const child = fork(process.argv[1], ['--worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      live++;
      child.on('message', (m: { id: number; results: RunResult[] }) => {
        results[tasks[m.id].mix].push(...m.results);
        done += m.results.length;
        process.stderr.write(`\r  ${done}/${total} runs · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
        feed(child);
      });
      child.on('exit', (code) => {
        if (code) {
          console.error(`\nworker exited with code ${code}`);
          process.exit(1);
        }
      });
      feed(child);
    }
  });
  process.stderr.write('\n');

  mixes.forEach((m, mi) => {
    const rs = results[mi];
    const n = rs.length;
    const label = `${m.join('/')} (${totalThreats(cfgs[mi])} missiles)`;
    if (o.arrivals) {
      console.log(`\n${label}`);
      cfgs[mi].waves.forEach((w, wi) => {
        const a = rs.flatMap((r) => r.arrivals!.filter((x) => x.wave === wi));
        if (!a.length) return;
        const late = a.map((x) => x.late);
        const short = a.filter((x) => x.end !== 'IMPACT');
        const ends = short.reduce<Record<string, number>>((acc, x) => ((acc[x.end] = (acc[x.end] ?? 0) + 1), acc), {});
        console.log(`  ${waveLabel(w.type).padEnd(11)} ×${String(w.count).padEnd(3)} late vs plan: min ${Math.min(...late).toFixed(1)} s · max ${Math.max(...late).toFixed(1)} s · didn't hit: ${short.length}${short.length ? ' ' + JSON.stringify(ends) : ''}`);
      });
      return;
    }
    const sunk = rs.filter((r) => r.sunk).length;
    const hits = rs.reduce((a, r) => a + r.hits, 0);
    const by: Record<string, number> = {};
    for (const r of rs) for (const [k, v] of Object.entries(r.hitBy)) by[k] = (by[k] ?? 0) + v;
    const byTxt = [...preset.waves.map((w) => w.type as string), 'debris'].filter((k, i, arr) => arr.indexOf(k) === i).map((k) => `${waveLabel(k)} ${by[k] ?? 0}`).join(' · ');
    console.log(`${label.padEnd(24)} sunk ${pct(sunk, n).padEnd(9)} · no-hit runs ${String(rs.filter((r) => r.hits === 0).length).padStart(3)} · hits/run ${(hits / n).toFixed(1)} · avg hull ${Math.round(rs.reduce((a, r) => a + r.hull, 0) / n)}% · hits by: ${byTxt}`);
  });
}

// ------------------------------------------------------------------ entry: coordinator, or a worker it forked
if (process.argv.includes('--worker')) {
  process.on('message', (t: Task) => {
    const results = t.seeds.map((s) => runOne(t.cfg, s, t.arrivals, t.maxTime));
    process.send!({ id: t.id, results });
  });
} else {
  main();
}
