/**
 * Offline (OfflineAudioContext) verification scenarios for the audio engine. Driven headlessly by
 * tools/audiocheck.mjs through window.__audioCheck; every scenario steps engine.update() at 60 fps using
 * OfflineAudioContext.suspend(t) so scheduling, propagation delay and time scaling behave exactly as in the game.
 */
import { AudioEngine, AudioEnv, Vec3 } from '../audio/audioEngine';

const SR = 48000;
type L = { pos: Vec3; quat: { x: number; y: number; z: number; w: number }; vel: Vec3 };
const baseEnv = (): AudioEnv => ({ shipPos: { x: 0, y: 0, z: 0 }, shipSpeed: 9, seaState: 3, onDeck: false, camAlt: 2, night: 0, shipFires: 0, sinking: false });

export interface ScenarioOpts {
  dur: number; fps?: number; scale?: number | ((tReal: number) => number); ambience?: boolean;
  env?: Partial<AudioEnv>; listener?: Partial<L>; maxVoices?: number;
  setup?: (e: AudioEngine, lis: L, env: AudioEnv) => void;
  frame?: (e: AudioEngine, i: number, tReal: number, sim: number, lis: L, env: AudioEnv) => void;
}

export async function renderScenario(o: ScenarioOpts) {
  const fps = o.fps ?? 60;
  const ctx = new OfflineAudioContext(2, Math.ceil(o.dur * SR), SR);
  const eng = new AudioEngine({ context: ctx, uiContext: null, maxVoices: o.maxVoices });
  await eng.init('/audio/');
  eng.ambience = o.ambience ?? false;
  const lis: L = { pos: { x: 0, y: 2, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 }, vel: { x: 0, y: 0, z: 0 }, ...(o.listener ?? {}) } as L;
  const env: AudioEnv = { ...baseEnv(), ...(o.env ?? {}) };
  const scaleAt = (t: number) => (typeof o.scale === 'function' ? o.scale(t) : o.scale ?? 1);
  let sim = 0;
  eng.update(0, 0, scaleAt(0), lis, env);
  o.setup?.(eng, lis, env);
  eng.update(0, 0, scaleAt(0), lis, env);
  const dt = 1 / fps, q = 128 / SR;
  const n = Math.floor(o.dur * fps);
  let last = -1;
  const errors: string[] = [];
  for (let i = 1; i < n; i++) {
    const t = Math.round((i * dt) / q) * q;
    if (t <= last || t >= o.dur) continue;
    last = t;
    ctx.suspend(t).then(() => {
      try {
        const s = scaleAt(t);
        sim += dt * s;
        o.frame?.(eng, i, t, sim, lis, env);
        eng.update(dt, sim, s, lis, env);
      } catch (e) {
        errors.push(String((e as Error)?.stack ?? e));
      } finally { ctx.resume(); }
    }, () => { /* duplicate / past suspend time */ });
  }
  const buf = await ctx.startRendering();
  if (errors.length) throw new Error('scenario frame error: ' + errors[0]);
  return { buf, eng };
}

// ------------------------------------------------------------------------------------------------ metrics / io
function mono(buf: AudioBuffer) {
  const a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
  const m = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) m[i] = 0.5 * (a[i] + b[i]);
  return m;
}
export function metrics(buf: AudioBuffer) {
  let peak = 0, e = 0, clip = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const x = buf.getChannelData(c);
    for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > peak) peak = v; if (v >= 0.999) clip++; e += x[i] * x[i]; }
  }
  const m = mono(buf);
  let onset = -1;
  for (let i = 0; i < m.length; i++) if (Math.abs(m[i]) > 3e-4) { onset = i / SR; break; }
  const rms = Math.sqrt(e / (buf.length * buf.numberOfChannels));
  return { peak, peak_dB: 20 * Math.log10(peak + 1e-12), rms_dB: 20 * Math.log10(rms + 1e-12), onset, clip };
}
export function wavBase64(buf: AudioBuffer) {
  const ch = buf.numberOfChannels, n = buf.length;
  const ab = new ArrayBuffer(44 + n * ch * 2);
  const v = new DataView(ab);
  const ws = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, buf.sampleRate, true);
  v.setUint32(28, buf.sampleRate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); ws(36, 'data'); v.setUint32(40, n * ch * 2, true);
  const data = [...Array(ch)].map((_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const s = Math.max(-1, Math.min(1, data[c][i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  const u8 = new Uint8Array(ab);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(bin);
}

// ------------------------------------------------------------------------------------------------ scenarios
const at = (d: number, h = 2): Vec3 => ({ x: 0, y: h, z: -d }); // straight ahead (camera looks down −Z)

/** Pure table of computed parameters. */
export async function probeTable() {
  const ctx = new OfflineAudioContext(2, SR, SR);
  const eng = new AudioEngine({ context: ctx, uiContext: null });
  await eng.init('/audio/');
  const names = ['ciws_fire_loop', 'gun_5in', 'vls_launch', 'explosion_near', 'explosion_air', 'explosion_ship_hit', 'splash_small', 'splash_big', 'sonic_boom', 'jet_asm_loop', 'rocket_motor_loop'];
  const dists = [5, 30, 100, 300, 1000, 3000, 10000, 20000, 30000];
  const rows = [];
  for (const n of names) for (const d of dists) rows.push(eng.probe(n, d));
  return { rows, info: eng.bufferInfo() };
}

/** One sound at several distances (noDelay so the renders line up). */
export async function distanceSweep(name: string, dists: number[], dur: number) {
  const out: any[] = [];
  for (const d of dists) {
    const { buf } = await renderScenario({ dur, setup: (e) => e.play(name, at(d), { noDelay: true }) });
    out.push({ name, d, ...metrics(buf), wav: wavBase64(buf) });
  }
  return out;
}

/** Propagation delay in sim time: (d, scale, listener speed toward source) → expected onset (real s). */
export async function delayChecks() {
  const cases = [
    { d: 1029, scale: 1, lv: 0 }, { d: 3430, scale: 4, lv: 0 }, { d: 343, scale: 0.5, lv: 0 }, { d: 1000, scale: 1, lv: 100 },
    { d: 3430, scale: 8, lv: 0 },
  ];
  const res: any[] = [];
  for (const c of cases) {
    const expSim = c.d / (343 + c.lv);
    const expected = expSim / c.scale;
    const { buf } = await renderScenario({
      dur: expected + 1.5, scale: c.scale,
      listener: { vel: { x: 0, y: 0, z: -c.lv } },
      setup: (e) => e.play('explosion_near', at(c.d)),
      frame: (_e, _i, _t, sim, lis) => { lis.pos = { x: 0, y: 2, z: -c.lv * sim }; },
    });
    const m = metrics(buf);
    // baseline: the same sound at the same distance with no delay (asset/filter onset latency)
    const base = await renderScenario({ dur: 1, setup: (e) => e.play('explosion_near', at(c.d), { noDelay: true }) });
    const b0 = metrics(base.buf).onset;
    res.push({ ...c, expected, onset: m.onset, baseline: b0, err_ms: (m.onset - b0 - expected) * 1000 });
  }
  return res;
}

/** CIWS burst at 20 m: spin-up → loop → tail. Returns the schedule log + the render. */
export async function ciwsCheck(opts: { d?: number; on?: number; off?: number; dur?: number; scale?: number; rateSwitchAt?: number; scale2?: number } = {}) {
  const d = opts.d ?? 20, on = opts.on ?? 0.1, off = opts.off ?? 1.6, dur = opts.dur ?? 5;
  let h: ReturnType<AudioEngine['ciws']> | null = null;
  const { buf, eng } = await renderScenario({
    dur, scale: (t) => (opts.rateSwitchAt !== undefined && t >= opts.rateSwitchAt ? opts.scale2 ?? 1 : opts.scale ?? 1),
    setup: (e) => { h = e.ciws(); h.set(at(d, 10), false, 0); },
    frame: (_e, _i, t) => { h!.set(at(d, 10), t >= on && t < off, 0); },
  });
  const info = eng.ciwsInfo()[0];
  const bi = eng.bufferInfo();
  return { d, on, off, info, spinDur: bi.ciws_spinup.durations[0], loopDur: bi.ciws_fire_loop.durations[0], tailDur: bi.ciws_tail.durations[0], ...metrics(buf), wav: wavBase64(buf) };
}

/** Thousands of splashes + an explosion barrage in one frame: voice cap, 50 ms rule, clusters, no clipping. */
export async function voiceLimitCheck() {
  const starts = new Map<number, { name: string; t: number }>();
  let maxVoices = 0;
  const { buf, eng } = await renderScenario({
    dur: 4, maxVoices: 40,
    setup: (e) => {
      for (let i = 0; i < 2000; i++) {
        const r = 30 + Math.random() * 270, a = Math.random() * Math.PI * 2;
        e.play('splash_small', { x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r });
      }
      for (let i = 0; i < 20; i++) e.play('splash_small', { x: 50, y: 0, z: -50 }); // 20-splash salvo at one spot
      for (let i = 0; i < 100; i++) {
        const r = 300 + Math.random() * 1500, a = Math.random() * Math.PI * 2;
        e.play('explosion_near', { x: Math.cos(a) * r, y: 50, z: Math.sin(a) * r });
      }
    },
    frame: (e) => {
      const vi = e.voiceInfo();
      maxVoices = Math.max(maxVoices, vi.length);
      for (const v of vi) if (!starts.has((v as any).id)) starts.set((v as any).id, { name: v.name, t: v.startAt });
    },
  });
  // max identical starts inside any 50 ms window
  const byName = new Map<string, number[]>();
  for (const s of starts.values()) { if (!byName.has(s.name)) byName.set(s.name, []); byName.get(s.name)!.push(s.t); }
  const maxIn50: Record<string, number> = {};
  for (const [n, ts] of byName) {
    ts.sort((a, b) => a - b);
    let best = 0;
    for (let i = 0, j = 0; i < ts.length; i++) { while (ts[i] - ts[j] >= 0.05) j++; best = Math.max(best, i - j + 1); }
    maxIn50[n] = best;
  }
  const m = metrics(buf);
  return { maxVoices, uniqueStarts: starts.size, maxIn50, stats: eng.stats(), ...m, wav: wavBase64(buf) };
}

/** Doppler / retarded-time fly-by of a loop: returns a per-frame trace. */
export async function dopplerCheck(name = 'jet_asm_loop', speed = 285, miss = 30, len = 3000) {
  const trace: any[] = [];
  let h: ReturnType<AudioEngine['loop']> | null = null;
  const T = (2 * len) / speed;
  const { buf } = await renderScenario({
    dur: Math.min(T + 3, 30),
    setup: (e) => { h = e.loop(name); h.set({ x: -len, y: 10, z: -miss }, { x: speed, y: 0, z: 0 }); },
    frame: (e, i, t, sim) => {
      const x = -len + speed * sim;
      if (x > len) { if (h!.alive) h!.stop(0.5); } else h!.set({ x, y: 10, z: -miss }, { x: speed, y: 0, z: 0 });
      if (i % 6 === 0) { const li = e.loopInfo()[0]; trace.push({ t, x, ...(li ?? {}) }); }
    },
  });
  // theoretical doppler vs retarded geometry for reference
  return { name, speed, miss, trace, ...metrics(buf), wav: wavBase64(buf) };
}

/** Busy raid mix on deck with everything at once: the master bus must not clip. */
export async function raidCheck() {
  const loops: ReturnType<AudioEngine['loop']>[] = [];
  let ciws: ReturnType<AudioEngine['ciws']> | null = null;
  const tgt: { x0: number; z0: number; vx: number; vz: number; kill: number; dead: boolean }[] = [];
  const { buf, eng } = await renderScenario({
    dur: 14, ambience: true,
    env: { onDeck: true, camAlt: 12, shipSpeed: 9, seaState: 4, shipFires: 0 },
    listener: { pos: { x: 0, y: 12, z: 5 } },
    setup: (e) => {
      ciws = e.ciws();
      for (let i = 0; i < 8; i++) {
        const a = -0.6 + i * 0.15, r = 1800;
        tgt.push({ x0: Math.sin(a) * r, z0: -Math.cos(a) * r, vx: -Math.sin(a) * 250, vz: Math.cos(a) * 250, kill: 1.5 + i * 0.6, dead: false });
        const l = e.loop(i % 2 ? 'jet_asm_loop' : 'ramjet_loop');
        loops.push(l);
      }
    },
    frame: (e, i, t, sim, _l, env) => {
      ciws!.set({ x: 8, y: 14, z: -30 }, (t > 1 && t < 4.2) || (t > 5 && t < 7.5), 0.8);
      tgt.forEach((g, k) => {
        const p = { x: g.x0 + g.vx * sim, y: 8, z: g.z0 + g.vz * sim };
        if (!g.dead && sim >= g.kill) {
          g.dead = true; loops[k].stop(0.2);
          e.play('explosion_air', p); e.play('debris_metal', { x: p.x * 0.5, y: 0, z: p.z * 0.5 });
          e.play('splash_big', { x: p.x * 0.9, y: 0, z: p.z * 0.9 });
        } else if (!g.dead) loops[k].set(p, { x: g.vx, y: 0, z: g.vz });
      });
      if (i % 150 === 10) e.play('gun_5in', { x: 0, y: 10, z: -60 });
      if (t > 1) for (let s = 0; s < 8; s++) { const a = Math.random() * 6.28, r = 60 + Math.random() * 400; e.play('splash_small', { x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r }); }
      if (i === 120) e.play('vls_launch', { x: 0, y: 8, z: 40 });
      if (i === 540) { e.play('explosion_ship_hit', { x: 0, y: 8, z: 30 }); env.shipFires = 2; }
      if (i === 30) e.play('alarm_gq', null);
    },
  });
  return { stats: eng.stats(), ...metrics(buf), wav: wavBase64(buf) };
}

/** Slow motion: voices' playbackRate follows the time scale. */
export async function slowmoCheck() {
  const rates: any[] = [];
  await renderScenario({
    dur: 3, scale: (t) => (t < 1 ? 1 : t < 2 ? 0.25 : 0.1),
    setup: (e) => e.play('explosion_near', at(200), { noDelay: true }),
    frame: (e, i, t) => { if (i % 15 === 0) rates.push({ t, rates: e.voiceInfo().map((v) => v.rate), timeRate: e.stats().timeRate }); },
  });
  return rates;
}

/** Ambience beds vs camera state. */
export async function ambienceCheck() {
  const cases = [
    { label: 'on deck, 18 kt, SS4', env: { onDeck: true, camAlt: 12, shipSpeed: 9, seaState: 4 }, pos: { x: 0, y: 12, z: 0 } },
    { label: 'sea level 3 km from ship', env: { onDeck: false, camAlt: 5, shipSpeed: 9, seaState: 4 }, pos: { x: 3000, y: 5, z: 0 } },
    { label: '500 m up', env: { onDeck: false, camAlt: 500, seaState: 4 }, pos: { x: 3000, y: 500, z: 0 } },
    { label: '5 km up', env: { onDeck: false, camAlt: 5000, seaState: 4 }, pos: { x: 3000, y: 5000, z: 0 } },
    { label: '150 km up', env: { onDeck: false, camAlt: 150000, seaState: 4 }, pos: { x: 3000, y: 150000, z: 0 } },
    { label: 'on deck, fires 3', env: { onDeck: true, camAlt: 12, shipSpeed: 3, seaState: 3, shipFires: 3 }, pos: { x: 0, y: 12, z: 0 } },
  ];
  const out: any[] = [];
  for (const c of cases) {
    const { buf } = await renderScenario({ dur: 4, ambience: true, env: c.env as any, listener: { pos: c.pos } });
    // skip the 1.5 s fade-in of the beds
    const skip = Math.floor(1.5 * SR);
    const tb = new AudioBuffer({ numberOfChannels: 2, length: buf.length - skip, sampleRate: SR });
    for (let ch = 0; ch < 2; ch++) tb.copyToChannel(buf.getChannelData(ch).subarray(skip), ch);
    out.push({ label: c.label, ...metrics(tb), wav: wavBase64(tb) });
  }
  return out;
}
