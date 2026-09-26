/**
 * Vanguard spatial audio engine (WebAudio).
 *
 * Signal flow (main context):
 *   world voices ─┬─ LPF×2 (air absorption) ─ [near/far xfade] ─ distance gain ─ Panner (HRTF near / equal-power far) ─┐
 *                 └──────────────────────────────────────────── reverb send ─ HP ─ pre-delay ─ Convolver (sea IR) ────┤
 *                                                                                                                   sfxBus ─ slow-mo LPF ─ combat duck ─┐
 *   ambience beds (ocean / wind / engine / hull wash / fire) ─ ambBus ─ (same slow-mo LPF) ─────────────────────────────────────────────┤
 *   alarms (2D) ─ alarmBus ──────────────────────────────────────────────────────────────────────────────────────────────────────────── mix ─ compressor ─ trim ─ limiter ─ master ─ pause ─ out
 * UI sounds play in a second, never-suspended AudioContext so clicks work while the sim is paused.
 *
 * Time: propagation delay is computed in SIM time. One-shots wait in a queue until the expanding wavefront
 * (radius c·(t − t_emit)) reaches the (possibly moving) listener, then start sample-accurately inside a short
 * real-time lookahead. Loops use the retarded position (history of the source) for gain, panning and doppler, so
 * a supersonic missile is silent until its Mach cone arrives. Slow motion lowers playbackRate (bullet time);
 * >1× keeps pitch but thins/ducks one-shots; pause fades out and suspends the context.
 */
import {
  SOUND_DEFS, SoundDef, defFor, spatialParams, clamp, distGain, lawFor, airCutoff, timeRateFor, SPEED_OF_SOUND,
} from './soundDefs';
import { makeSeaIR } from './reverbIR';

export type Vec3 = { x: number; y: number; z: number };
export type Quat = { x: number; y: number; z: number; w: number };
export interface ListenerState { pos: Vec3; quat: Quat; vel: Vec3 }
export interface AudioEnv {
  shipPos: Vec3; shipSpeed: number; seaState: number;
  /** camera within ~120 m of the ship and < 60 m alt */
  onDeck: boolean; camAlt: number; night: number;
  /** 0..n intensity sum */
  shipFires: number; sinking: boolean;
}
export interface PlayOpts {
  gain?: number; rate?: number;
  /** approx loudness class: how far it carries (m) — e.g. 20mm splash 400, 5in gun 20000, warhead 30000 */
  range?: number; noDelay?: boolean; priority?: number;
  /** (addition) source velocity: used by baked stereo fly-bys to flip the L→R image for right→left passes */
  vel?: Vec3;
  /** (addition) sim time at which the event happened (default: simTime of the last update()) */
  simTime?: number;
}
export interface LoopOpts {
  gain?: number; rate?: number; range?: number;
  /** (addition) ignore propagation delay / retarded position (use current position) */
  noDelay?: boolean;
}
export interface LoopHandle {
  set(pos: Vec3 | null, vel?: Vec3, gain?: number, rate?: number): void;
  stop(fadeSec?: number): void;
  /** false once stop() was called (or the engine was disposed) */
  readonly alive: boolean;
}
export interface CiwsHandle {
  set(pos: Vec3, firing: boolean, slewRate: number /* rad/s, drives ciws_servo */): void;
  stop(): void;
}
export interface AudioEngineOptions {
  /** Use an existing (e.g. Offline) context instead of creating one. */
  context?: BaseAudioContext;
  /** Context for UI sounds. Default: a second realtime context (if the main one is realtime), null = use main. */
  uiContext?: BaseAudioContext | null;
  maxVoices?: number;
  maxLoops?: number;
}
export interface ProbeResult {
  name: string; dist: number; delay: number; gain: number; dist_dB: number; ref: number; range: number; k: number;
  cutoffNear: number; cutoffFar: number; nearW: number; farW: number; send: number; farName: string | null;
  panning: 'HRTF' | 'equalpower' | 'stereo' | 'none';
}

// ------------------------------------------------------------------------------------------------ constants
const C = SPEED_OF_SOUND;
const CULL = 0.0012; // ≈ −58 dB: inaudible, never start
const LOOKAHEAD = 0.1; // real seconds of scheduling lookahead for delayed events
const WINDOW = 0.05; // identical-start window (s)
const HRTF_NEAR = 150; // one-shots closer than this use HRTF
const HRTF_IN = 250, HRTF_OUT = 400; // loops: hysteresis for HRTF ↔ equal-power
const MAX_PENDING = 600;
const MAX_2D = 10;
const MAX_UI = 8;
const STEREO_WIDTH = 0.6;
const CIWS_P = 636 / 48000; // CIWS shot period (s of buffer time)
const CIWS_STOP_PHASE = 20 / 48000; // loop phase (mod P) at which the tail is spliced in (tail's 1st grain lands on the grid)

// ------------------------------------------------------------------------------------------------ small vec helpers
const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const copy3 = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
function rotq(q: Quat, x: number, y: number, z: number): Vec3 {
  // v' = v + 2w(q×v) + 2 q×(q×v)
  const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
  return {
    x: x + q.w * tx + (q.y * tz - q.z * ty),
    y: y + q.w * ty + (q.z * tx - q.x * tz),
    z: z + q.w * tz + (q.x * ty - q.y * tx),
  };
}
const finite3 = (v: Vec3 | null | undefined) => !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

const decodeCache = new Map<string, Promise<AudioBuffer | null>>();
function decode(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((res, rej) => {
    try {
      const p = ctx.decodeAudioData(data, res, rej) as unknown as Promise<AudioBuffer> | undefined;
      if (p && typeof (p as any).then === 'function') p.then(res, rej);
    } catch (e) { rej(e); }
  });
}

/** Parameter setter with change detection (avoids flooding the automation timeline every frame). */
class ParamCache {
  private m = new Map<AudioParam, number>();
  set(p: AudioParam, v: number, now: number, tau: number, rel = 0.004) {
    if (!Number.isFinite(v)) return;
    const last = this.m.get(p);
    if (last !== undefined && Math.abs(v - last) <= Math.abs(last) * rel + 1e-7) return;
    this.m.set(p, v);
    try {
      if (last === undefined || tau <= 0) p.setValueAtTime(v, now);
      else p.setTargetAtTime(v, now, tau);
    } catch { /* ignore */ }
  }
  forget(p: AudioParam) { this.m.delete(p); }
}

/** 'dual' = HRTF + equal-power panners in parallel with a gain crossfade (never mutate panningModel on a live node). */
type PanMode = 'hrtf' | 'eq' | 'dual' | 'stereo' | 'none';

interface Bank {
  name: string; def: SoundDef; buffers: AudioBuffer[]; trims: number[]; files: string[]; last: number; loop: boolean;
}

// ------------------------------------------------------------------------------------------------ spatial chain
interface ChainParams { gain: number; send: number; cutN: number; cutF: number; wN: number; wF: number }
class Chain {
  inN: AudioNode; inF: AudioNode | null = null;
  out: GainNode; send: GainNode | null = null;
  panner: PannerNode | null = null; panner2: PannerNode | null = null; sp: StereoPannerNode | null = null;
  private gH: GainNode | null = null; private gE: GainNode | null = null;
  mode: PanMode;
  private lpN: BiquadFilterNode[] = []; private lpF: BiquadFilterNode[] = [];
  private xfN: GainNode | null = null; private xfF: GainNode | null = null;
  private nodes: AudioNode[] = [];
  readonly pc = new ParamCache();
  private disposed = false;

  constructor(private ctx: BaseAudioContext, o: { far: boolean; filter: boolean; pan: PanMode; dest: AudioNode; send: AudioNode | null; gain0?: number }) {
    const ctx_ = ctx;
    this.mode = o.pan;
    this.out = ctx_.createGain();
    this.out.gain.value = o.gain0 ?? 0;
    this.nodes.push(this.out);
    if (o.send) { this.send = ctx_.createGain(); this.send.gain.value = 0; this.send.connect(o.send); this.nodes.push(this.send); }
    const mkLP = (): BiquadFilterNode[] => {
      const a = ctx_.createBiquadFilter(), b = ctx_.createBiquadFilter();
      a.type = b.type = 'lowpass'; a.Q.value = b.Q.value = 0.5; a.frequency.value = b.frequency.value = 20000;
      a.connect(b); this.nodes.push(a, b);
      return [a, b];
    };
    const tapTo = (n: AudioNode) => { n.connect(this.out); if (this.send) n.connect(this.send); };
    if (o.filter) {
      this.lpN = mkLP();
      this.inN = this.lpN[0];
      if (o.far) {
        this.xfN = ctx_.createGain(); this.xfF = ctx_.createGain();
        this.nodes.push(this.xfN, this.xfF);
        this.lpN[1].connect(this.xfN); tapTo(this.xfN);
        this.lpF = mkLP(); this.inF = this.lpF[0];
        this.lpF[1].connect(this.xfF); tapTo(this.xfF);
      } else tapTo(this.lpN[1]);
    } else {
      const g = ctx_.createGain(); this.nodes.push(g);
      tapTo(g); this.inN = g;
    }
    const mkP = (model: PanningModelType) => {
      const p = ctx_.createPanner();
      p.panningModel = model;
      p.distanceModel = 'inverse'; p.refDistance = 1; p.rolloffFactor = 0; p.maxDistance = 1e7;
      this.nodes.push(p);
      return p;
    };
    if (o.pan === 'hrtf' || o.pan === 'eq') {
      const p = mkP(o.pan === 'hrtf' ? 'HRTF' : 'equalpower');
      this.panner = p;
      this.out.connect(p); p.connect(o.dest);
    } else if (o.pan === 'dual') {
      this.panner = mkP('HRTF'); this.panner2 = mkP('equalpower');
      this.gH = ctx_.createGain(); this.gE = ctx_.createGain(); this.gH.gain.value = 1; this.gE.gain.value = 0;
      this.nodes.push(this.gH, this.gE);
      this.out.connect(this.gH); this.gH.connect(this.panner); this.panner.connect(o.dest);
      this.out.connect(this.gE); this.gE.connect(this.panner2); this.panner2.connect(o.dest);
    } else if (o.pan === 'stereo') {
      const s = ctx_.createStereoPanner(); this.sp = s; this.nodes.push(s);
      this.out.connect(s); s.connect(o.dest);
    } else this.out.connect(o.dest);
  }
  apply(p: ChainParams, now: number, tau: number) {
    const pc = this.pc;
    pc.set(this.out.gain, p.gain, now, tau);
    if (this.send) pc.set(this.send.gain, p.send, now, tau);
    if (this.lpN.length) { const f = clamp(p.cutN, 40, 22000); pc.set(this.lpN[0].frequency, f, now, tau, 0.01); pc.set(this.lpN[1].frequency, f, now, tau, 0.01); }
    if (this.lpF.length) { const f = clamp(p.cutF, 40, 22000); pc.set(this.lpF[0].frequency, f, now, tau, 0.01); pc.set(this.lpF[1].frequency, f, now, tau, 0.01); }
    if (this.xfN) pc.set(this.xfN.gain, p.wN, now, tau);
    if (this.xfF) pc.set(this.xfF.gain, p.wF, now, tau);
  }
  setPos(pos: Vec3, now: number, tau: number) {
    for (const p of [this.panner, this.panner2]) {
      if (!p) continue;
      if (p.positionX) {
        this.pc.set(p.positionX, pos.x, now, tau, 1e-6); this.pc.set(p.positionY, pos.y, now, tau, 1e-6); this.pc.set(p.positionZ, pos.z, now, tau, 1e-6);
      } else (p as any).setPosition(pos.x, pos.y, pos.z);
    }
  }
  /** 'dual' chains: equal-power crossfade between the HRTF (w=1) and equal-power (w=0) panners. */
  setHrtfMix(w: number, now: number) {
    if (!this.gH || !this.gE) return;
    this.pc.set(this.gH.gain, Math.sin(w * Math.PI / 2), now, 0.15, 0.01);
    this.pc.set(this.gE.gain, Math.cos(w * Math.PI / 2), now, 0.15, 0.01);
  }
  setPan(v: number, now: number, tau: number) { if (this.sp) this.pc.set(this.sp.pan, clamp(v, -1, 1), now, tau, 0.01); }
  fadeOut(now: number, tau = 0.02) {
    this.pc.forget(this.out.gain);
    try { this.out.gain.cancelScheduledValues(now); this.out.gain.setTargetAtTime(0, now, tau); } catch { /* */ }
    if (this.send) { this.pc.forget(this.send.gain); try { this.send.gain.cancelScheduledValues(now); this.send.gain.setTargetAtTime(0, now, tau); } catch { /* */ } }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const n of this.nodes) { try { n.disconnect(); } catch { /* */ } }
    this.nodes.length = 0;
  }
}

// ------------------------------------------------------------------------------------------------ voices
interface Voice {
  id: number; name: string; def: SoundDef; kind: 'world' | '2d' | 'ui';
  pos: Vec3 | null; chain: Chain; srcs: AudioBufferSourceNode[]; baseRates: number[];
  extra: AudioNode[]; followsTime: boolean;
  userGain: number; trim: number; prio: number; range?: number; farDef?: SoundDef;
  startAt: number; dur: number; loud: number; cluster: number; ended: boolean; dead: boolean; lastRate: number;
}

interface Pending {
  bank: Bank; def: SoundDef; pos: Vec3; tEmit: number; gain: number; rate: number; range?: number;
  prio: number; vel?: Vec3; count: number; key: string;
}

// ------------------------------------------------------------------------------------------------ history (retarded time)
class History {
  private t: Float64Array; private d: Float64Array; private start = 0; count = 0; cursor = 0;
  constructor(private cap = 2600) { this.t = new Float64Array(cap); this.d = new Float64Array(cap * 6); }
  private idx(i: number) { return (this.start + i) % this.cap; }
  time(i: number) { return this.t[this.idx(i)]; }
  clear() { this.start = 0; this.count = 0; this.cursor = 0; }
  push(t: number, p: Vec3, v: Vec3 | null, minDt = 0.05, maxAge = 125) {
    if (this.count > 0 && t < this.time(this.count - 1) - 1e-9) this.clear();
    let j: number;
    if (this.count >= 2 && t - this.time(this.count - 2) < minDt) j = this.idx(this.count - 1);
    else {
      if (this.count === this.cap) { this.start = (this.start + 1) % this.cap; this.count--; this.cursor = Math.max(0, this.cursor - 1); }
      j = this.idx(this.count); this.count++;
    }
    this.t[j] = t;
    const o = j * 6;
    this.d[o] = p.x; this.d[o + 1] = p.y; this.d[o + 2] = p.z;
    this.d[o + 3] = v ? v.x : 0; this.d[o + 4] = v ? v.y : 0; this.d[o + 5] = v ? v.z : 0;
    while (this.count > 2 && this.time(0) < t - maxAge) { this.start = (this.start + 1) % this.cap; this.count--; this.cursor = Math.max(0, this.cursor - 1); }
  }
  private g(i: number, L: Vec3, now: number) {
    const j = this.idx(i), o = j * 6;
    return C * (now - this.t[j]) - Math.hypot(this.d[o] - L.x, this.d[o + 1] - L.y, this.d[o + 2] - L.z);
  }
  /** Most recent emission already heard at the listener. Returns null if nothing has arrived yet. */
  retarded(L: Vec3, now: number, out: { p: Vec3; v: Vec3; t: number; head: boolean }) {
    const n = this.count;
    if (!n) return null;
    let i = clamp(this.cursor, 0, n - 1);
    if (this.g(i, L, now) >= 0) { while (i + 1 < n && this.g(i + 1, L, now) >= 0) i++; }
    else {
      while (i > 0 && this.g(i, L, now) < 0) i--;
      if (this.g(i, L, now) < 0) { this.cursor = 0; return null; }
    }
    this.cursor = i;
    const a = this.idx(i);
    if (i === n - 1) { this.read(a, a, 0, out); out.t = this.t[a]; out.head = true; return out; }
    const b = this.idx(i + 1);
    const ga = this.g(i, L, now), gb = this.g(i + 1, L, now);
    const f = clamp(ga / (ga - gb), 0, 1);
    this.read(a, b, f, out);
    out.t = this.t[a] + f * (this.t[b] - this.t[a]); out.head = false;
    return out;
  }
  newest(out: { p: Vec3; v: Vec3; t: number; head: boolean }) {
    if (!this.count) return null;
    const a = this.idx(this.count - 1);
    this.read(a, a, 0, out); out.t = this.t[a]; out.head = true;
    return out;
  }
  private read(a: number, b: number, f: number, out: { p: Vec3; v: Vec3 }) {
    const d = this.d, oa = a * 6, ob = b * 6, g = 1 - f;
    out.p.x = d[oa] * g + d[ob] * f; out.p.y = d[oa + 1] * g + d[ob + 1] * f; out.p.z = d[oa + 2] * g + d[ob + 2] * f;
    out.v.x = d[oa + 3] * g + d[ob + 3] * f; out.v.y = d[oa + 4] * g + d[ob + 4] * f; out.v.z = d[oa + 5] * g + d[ob + 5] * f;
  }
}

// ------------------------------------------------------------------------------------------------ loops
class LoopImpl implements LoopHandle {
  aliveFlag = true; stopping = false; done = false; endSim = Infinity; fade = 0.3;
  cur: Vec3 | null = null; curVel: Vec3 = { x: 0, y: 0, z: 0 }; is2D = false; dirty = false;
  gainMul: number; rateMul: number; detune: number;
  hist = new History();
  chain: Chain | null = null; src: AudioBufferSourceNode | null = null;
  phase = 0; dop = 1; loud = 0; dist = 0; lastRate = 1; lastPan: Vec3 = { x: 0, y: 0, z: 0 };
  heard = { p: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 }, t: 0, head: false };
  audible = false; finished = false; hrtf = false;
  constructor(private eng: AudioEngine, public bank: Bank, readonly opts: LoopOpts) {
    this.gainMul = opts.gain ?? 1; this.rateMul = opts.rate ?? 1;
    const dt = bank.def.detune ?? 0.02;
    this.detune = 1 + (Math.random() * 2 - 1) * dt;
    this.phase = Math.random() * (bank.buffers[0]?.duration ?? 1);
  }
  get alive() { return this.aliveFlag; }
  set(pos: Vec3 | null, vel?: Vec3, gain?: number, rate?: number) {
    if (!this.aliveFlag) return;
    if (pos === null) { this.is2D = true; this.cur = null; }
    else if (finite3(pos)) {
      this.is2D = false;
      this.cur = this.cur ?? { x: 0, y: 0, z: 0 };
      this.cur.x = pos.x; this.cur.y = pos.y; this.cur.z = pos.z;
      if (vel && finite3(vel)) { this.curVel.x = vel.x; this.curVel.y = vel.y; this.curVel.z = vel.z; }
      this.dirty = true;
    }
    if (gain !== undefined && Number.isFinite(gain)) this.gainMul = Math.max(0, gain);
    if (rate !== undefined && Number.isFinite(rate) && rate > 0) this.rateMul = rate;
  }
  stop(fadeSec = 0.3) {
    if (!this.aliveFlag) return;
    this.aliveFlag = false; this.stopping = true; this.fade = Math.max(0.01, fadeSec);
    this.endSim = this.eng.simTimeNow;
  }
}

// ------------------------------------------------------------------------------------------------ CIWS
interface CiwsLogEntry { ev: string; t: number; [k: string]: number | string }
class CiwsImpl implements CiwsHandle {
  pos: Vec3 = { x: 0, y: 0, z: 0 }; hasPos = false; firing = false; slew = 0;
  events: { t: number; firing: boolean }[] = [];
  state: 'idle' | 'spin' | 'tail' = 'idle'; // 'spin' covers spin-up and the steady loop
  chain: Chain | null = null;
  n2f: BiquadFilterNode | null = null; n2fG: GainNode | null = null;
  spin: AudioBufferSourceNode | null = null; loop: AudioBufferSourceNode | null = null; far: AudioBufferSourceNode | null = null;
  loopG: GainNode | null = null; farG: GainNode | null = null; tail: AudioBufferSourceNode | null = null; tailG: GainNode | null = null;
  servo: AudioBufferSourceNode | null = null; servoG: GainNode | null = null;
  tSpin = 0; tLoop = 0; tStop = 0; tEnd = 0; refT = 0; refPhase = 0; rate = 1;
  dead = false; disposeAt = Infinity; loud = 0;
  log: CiwsLogEntry[] = [];
  constructor(private eng: AudioEngine) { }
  set(pos: Vec3, firing: boolean, slewRate: number) {
    if (this.dead) return;
    if (finite3(pos)) { this.pos.x = pos.x; this.pos.y = pos.y; this.pos.z = pos.z; this.hasPos = true; }
    const f = !!firing;
    if (f !== this.firing) { this.firing = f; this.events.push({ t: this.eng.simTimeNow, firing: f }); }
    this.slew = Number.isFinite(slewRate) ? Math.abs(slewRate) : 0;
  }
  stop() { if (!this.dead) this.eng._stopCiws(this); }
}

// ------------------------------------------------------------------------------------------------ engine
export class AudioEngine {
  private ctx: BaseAudioContext | null = null;
  private uiCtx: BaseAudioContext | null = null;
  private ownCtx = false; private ownUi = false; private offline = false;
  private banks = new Map<string, Bank>();
  private alias = new Map<string, { bank: Bank; idx: number }>();
  private warned = new Set<string>();
  private readyFlag = false;
  private unlocked = false;

  // buses
  private mix!: GainNode; private comp!: DynamicsCompressorNode; private trim!: GainNode; private lim!: DynamicsCompressorNode;
  private masterG!: GainNode; private pauseG!: GainNode;
  private sfxBus!: GainNode; private slowLP!: BiquadFilterNode; private duckG!: GainNode; private ambBus!: GainNode; private alarmBus!: GainNode;
  private revIn!: GainNode; private revHP!: BiquadFilterNode; private revDelay!: DelayNode; private conv!: ConvolverNode; private revOut!: GainNode;
  private uiMaster: GainNode | null = null;

  private _master = 0.8; private _muted = false;
  private world: Voice[] = []; private voices2d: Voice[] = []; private uiVoices: Voice[] = [];
  private pending: Pending[] = []; private pendKeys = new Map<string, { n: number; last: Pending }>();
  private recent = new Map<string, { t: number; v: Voice | null }[]>();
  private loops: LoopImpl[] = [];
  private ciwsList: CiwsImpl[] = [];
  private amb: Record<string, { src: AudioBufferSourceNode; lp: BiquadFilterNode; g: GainNode; sp: StereoPannerNode | null; pc: ParamCache }> = {};
  private ambStarted = false;
  private deckW = 0; private groanT = 6;
  private nextId = 1;
  private maxVoices: number; private maxLoops: number;
  private hasStereoPanner = false;

  // state
  private simNow = 0; private scale = 1; private timeRate = 1; private paused = false; private suspendTimer: any = null;
  private hidden = false;
  private lis: ListenerState = { pos: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 }, vel: { x: 0, y: 0, z: 0 } };
  private right: Vec3 = { x: 1, y: 0, z: 0 };
  private env: AudioEnv = { shipPos: { x: 0, y: 0, z: 0 }, shipSpeed: 0, seaState: 3, onDeck: false, camAlt: 10, night: 0, shipFires: 0, sinking: false };
  /** Ambience beds on/off (checks turn this off to isolate sounds). */
  ambience = true;
  readonly counters = { played: 0, started: 0, cull: 0, rate: 0, budget: 0, scale: 0, queue: 0, missing: 0, clustered: 0, stolen: 0 };

  constructor(opts: AudioEngineOptions = {}) {
    this.maxVoices = opts.maxVoices ?? 40;
    this.maxLoops = opts.maxLoops ?? 20;
    try {
      if (opts.context) this.ctx = opts.context;
      else {
        const AC: any = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
        if (!AC) throw new Error('WebAudio unavailable');
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.ownCtx = true;
      }
      const ctx = this.ctx!;
      this.offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
      this.hasStereoPanner = typeof (ctx as any).createStereoPanner === 'function';
      if (opts.uiContext !== undefined) this.uiCtx = opts.uiContext;
      else if (!this.offline) {
        try {
          const AC: any = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
          this.uiCtx = new AC({ latencyHint: 'interactive' });
          this.ownUi = true;
        } catch { this.uiCtx = null; }
      }
      this.buildGraph();
      if (typeof document !== 'undefined' && !this.offline) document.addEventListener('visibilitychange', this.onVis);
    } catch (e) {
      console.warn('[audio] disabled:', e);
      this.ctx = null;
    }
  }

  // ---------------------------------------------------------------------------------------------- public API
  get ready() { return this.readyFlag; }
  get context() { return this.ctx; }
  get simTimeNow() { return this.simNow; }

  get master() { return this._master; }
  set master(v: number) { this._master = clamp(Number.isFinite(v) ? v : 0.8, 0, 1); this.applyMaster(); }
  get muted() { return this._muted; }
  set muted(v: boolean) { this._muted = !!v; this.applyMaster(); }

  /** Fetch manifest + decode all buffers. */
  async init(base = 'audio/'): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!base.endsWith('/')) base += '/';
    let manifest: any;
    try {
      const r = await fetch(base + 'manifest.json');
      manifest = await r.json();
    } catch (e) { console.warn('[audio] manifest load failed', e); return; }
    const sounds = manifest?.sounds ?? {};
    const jobs: Promise<void>[] = [];
    const queue: (() => Promise<void>)[] = [];
    for (const [name, s] of Object.entries<any>(sounds)) {
      const files: string[] = Array.isArray(s.variants) && s.variants.length ? s.variants : [s.file];
      const bank: Bank = { name, def: defFor(name), buffers: [], trims: [], files, last: -1, loop: !!s.loop };
      const bufs: (AudioBuffer | null)[] = new Array(files.length).fill(null);
      queue.push(async () => {
        await Promise.all(files.map(async (f, i) => { bufs[i] = await this.load(base + f); }));
        const ok = files.map((f, i) => ({ f, b: bufs[i] })).filter((x) => !!x.b) as { f: string; b: AudioBuffer }[];
        if (!ok.length) return;
        bank.buffers = ok.map((x) => x.b); bank.files = ok.map((x) => x.f);
        bank.trims = variantTrims(bank.buffers);
        this.banks.set(name, bank);
        ok.forEach((x, i) => this.alias.set(x.f.replace(/\.[a-z0-9]+$/i, ''), { bank, idx: i }));
      });
    }
    // bounded concurrency (Safari chokes on dozens of parallel decodes)
    let qi = 0;
    const worker = async () => { while (qi < queue.length) { const j = queue[qi++]; await j(); } };
    for (let i = 0; i < 6; i++) jobs.push(worker());
    await Promise.all(jobs);
    this.readyFlag = true;
  }

  /** Call from a user gesture (click/keydown) to start the AudioContext. */
  unlock(): void {
    this.unlocked = true;
    for (const c of [this.ctx, this.uiCtx]) {
      if (!c || (typeof OfflineAudioContext !== 'undefined' && c instanceof OfflineAudioContext)) continue;
      const ac = c as AudioContext;
      try {
        if (ac.state !== 'running') ac.resume().catch(() => { });
        // iOS: play one silent sample inside the gesture
        const b = ac.createBuffer(1, 1, ac.sampleRate), s = ac.createBufferSource();
        s.buffer = b; s.connect(ac.destination); s.start(0);
        s.onended = () => { try { s.disconnect(); } catch { /* */ } };
      } catch { /* */ }
    }
  }

  /** Per-frame update. simTime = sim seconds; timeScale = current scale (0 = paused). */
  update(dtReal: number, simTime: number, timeScale: number,
    listener: { pos: Vec3; quat: { x: number; y: number; z: number; w: number }; vel: Vec3 }, env: AudioEnv): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!Number.isFinite(dtReal) || dtReal < 0) dtReal = 0;
    dtReal = Math.min(dtReal, 0.25);
    if (!Number.isFinite(simTime)) simTime = this.simNow;
    if (simTime < this.simNow - 0.5) this.resetTime();
    this.simNow = simTime;
    const scale = Number.isFinite(timeScale) ? Math.max(0, timeScale) : 1;
    this.scale = scale;
    if (listener) {
      if (finite3(listener.pos)) this.lis.pos = copy3(listener.pos);
      if (listener.quat && Number.isFinite(listener.quat.w)) this.lis.quat = { x: listener.quat.x, y: listener.quat.y, z: listener.quat.z, w: listener.quat.w };
      if (finite3(listener.vel)) this.lis.vel = copy3(listener.vel);
    }
    if (env) this.env = env;
    const now = ctx.currentTime;

    this.handlePause(scale === 0, now);
    this.applyListener(now);

    // time-scale dependent globals
    const tr = scale > 0 ? timeRateFor(scale) : this.timeRate;
    const rateChanged = Math.abs(tr - this.timeRate) > 1e-4;
    this.timeRate = tr;
    const pc = this.busPC;
    // bullet-time softening: cutoff falls with the playback rate (22 kHz at 1 → ~3 kHz at 0.35)
    pc.set(this.slowLP.frequency, tr >= 0.999 ? 22000 : 22000 * Math.pow(tr, 1.9), now, 0.12, 0.01);
    pc.set(this.ambBus.gain, (scale > 1 ? Math.max(0.6, 1 - 0.1 * Math.log2(scale)) : 1) * (1 - 0.1 * clamp(this.env.night ?? 0, 0, 1)), now, 0.3);

    if (!this.readyFlag) return;

    if (scale > 0) this.processPending(now);
    this.updateVoices(now, rateChanged);
    this.updateLoops(now, dtReal);
    this.updateCiws(now, rateChanged);
    this.updateAmbience(now, dtReal);
    this.sweep(now);
  }

  /** One-shot at a world position (null = 2D/UI/interior sound, no spatialization or delay). */
  play(name: string, pos: Vec3 | null, opts: PlayOpts = {}): void {
    if (!this.ctx) return;
    const r = this.resolve(name);
    if (!r) return;
    if (!this.readyFlag) return;
    this.counters.played++;
    const { bank, idx } = r;
    const def = bank.def;
    const gain = Math.max(0, opts.gain ?? 1);
    const prio = Math.max(0.01, opts.priority ?? def.prio ?? 1);
    if (def.cls === 'ui') { this.playUI(bank, idx, gain); return; }
    if (pos === null || !finite3(pos)) { this.play2D(bank, idx, gain, opts.rate ?? 1, prio); return; }
    // thinning at high time scales
    if (this.scale >= 8 && !def.big && prio < 3) { this.counters.scale++; return; }
    const p = copy3(pos);
    const d = dist3(p, this.lis.pos);
    const law = lawFor(def, opts.range);
    const est = def.vol * gain * distGain(d, law.ref, law.range, law.k) * this.combatDuck(def);
    if (est < CULL) { this.counters.cull++; return; }
    const ev: Pending = {
      bank, def, pos: p, tEmit: opts.simTime ?? this.simNow, gain, rate: opts.rate ?? 1, range: opts.range, prio,
      vel: opts.vel ? copy3(opts.vel) : undefined, count: 1, key: '',
    };
    (ev as any).idx = idx;
    if (opts.noDelay) { this.startWorld(ev, this.ctx.currentTime); return; }
    // merge identical events arriving within the same 50 ms (sim) bucket beyond the burst allowance
    const tArr = ev.tEmit + d / C;
    const key = bank.name + '|' + Math.round(tArr / (WINDOW * Math.max(1, this.scale)));
    const k = this.pendKeys.get(key);
    const burst = def.burst ?? 3;
    if (k && k.n >= burst) { k.last.count++; this.counters.clustered++; return; }
    if (this.pending.length >= MAX_PENDING) { this.counters.queue++; return; }
    ev.key = key;
    if (k) { k.n++; k.last = ev; } else this.pendKeys.set(key, { n: 1, last: ev });
    this.pending.push(ev);
  }

  /** A positional continuous loop attached to a moving source. */
  loop(name: string, opts: LoopOpts = {}): LoopHandle {
    const r = this.ctx ? this.resolve(name) : null;
    const bank: Bank = r?.bank ?? { name, def: defFor(name), buffers: [], trims: [], files: [], last: -1, loop: true };
    const l = new LoopImpl(this, bank, opts);
    // unknown name (after init) or no audio: return an inert handle; before init: resolve once loaded
    if (!this.ctx || (!r && this.readyFlag)) { l.aliveFlag = false; l.done = true; return l; }
    this.loops.push(l);
    return l;
  }

  /** The CIWS gun: spinup → loop → tail splice, near/distant crossfade, servo whine. */
  ciws(): CiwsHandle {
    const c = new CiwsImpl(this);
    if (!this.ctx) { c.dead = true; return c; }
    this.ciwsList.push(c);
    return c;
  }

  dispose(): void {
    for (const v of [...this.world, ...this.voices2d, ...this.uiVoices]) this.killVoice(v, true);
    for (const l of this.loops) { l.aliveFlag = false; this.loopVirtual(l, 0, true); }
    for (const c of this.ciwsList) this.disposeCiws(c);
    this.loops = []; this.ciwsList = []; this.pending = []; this.pendKeys.clear();
    for (const a of Object.values(this.amb)) { try { a.src.stop(); } catch { /* */ } a.src.disconnect(); a.lp.disconnect(); a.g.disconnect(); a.sp?.disconnect(); }
    this.amb = {};
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVis);
    if (this.ownCtx) (this.ctx as AudioContext)?.close?.().catch(() => { });
    if (this.ownUi) (this.uiCtx as AudioContext)?.close?.().catch(() => { });
    this.ctx = null; this.uiCtx = null; this.readyFlag = false;
  }

  // ---------------------------------------------------------------------------------------------- extras (debug / tools)
  /** Names of all loaded sounds. */
  soundNames(): string[] { return [...this.banks.keys()]; }
  /** Decoded buffer durations (s) per file, for checks. */
  bufferInfo() {
    const out: Record<string, { files: string[]; durations: number[]; channels: number[]; trims: number[] }> = {};
    for (const b of this.banks.values()) out[b.name] = { files: b.files, durations: b.buffers.map((x) => x.duration), channels: b.buffers.map((x) => x.numberOfChannels), trims: b.trims };
    return out;
  }
  /** What the engine would compute for `name` heard at distance d (m). */
  probe(name: string, d: number, opts: { range?: number } = {}): ProbeResult {
    const r = this.resolve(name, true);
    const def = r?.bank.def ?? defFor(name);
    const farDef = def.far ? defFor(def.far.name) : undefined;
    const sp = spatialParams(def, d, opts.range, farDef);
    const stereo = (r?.bank.buffers[0]?.numberOfChannels ?? 1) > 1;
    return {
      name, dist: d, delay: sp.delay, gain: sp.gain, dist_dB: 20 * Math.log10(Math.max(sp.dist, 1e-9)), ref: sp.ref, range: sp.range, k: sp.k,
      cutoffNear: sp.cutoffNear, cutoffFar: sp.cutoffFar, nearW: sp.nearW, farW: sp.farW, send: sp.send, farName: def.far?.name ?? null,
      panning: def.cls === 'ui' || def.cls === 'alarm' ? 'none' : def.baked || stereo ? 'stereo' : d < HRTF_NEAR ? 'HRTF' : 'equalpower',
    };
  }
  stats() {
    return {
      ready: this.readyFlag, ctxState: (this.ctx as AudioContext | null)?.state ?? 'none', uiState: (this.uiCtx as AudioContext | null)?.state ?? 'none',
      time: this.ctx?.currentTime ?? 0, sim: this.simNow, scale: this.scale, timeRate: this.timeRate, paused: this.paused,
      voices: this.world.length, voices2d: this.voices2d.length, uiVoices: this.uiVoices.length,
      loops: this.loops.length, loopsReal: this.loops.filter((l) => !!l.src).length, ciws: this.ciwsList.length,
      pending: this.pending.length, deckW: this.deckW, counters: { ...this.counters },
    };
  }
  /** Debug snapshot of loops (retarded distance, doppler, loudness). */
  loopInfo() {
    return this.loops.map((l) => ({ name: l.bank.name, real: !!l.src, audible: l.audible, dist: l.dist, dop: l.dop, rate: l.lastRate, loud: l.loud, alive: l.alive }));
  }
  /** Debug: CIWS schedule logs. */
  ciwsInfo() { return this.ciwsList.map((c) => ({ state: c.state, log: c.log.slice(), rate: c.rate })); }
  /** Debug: active world voices. */
  voiceInfo() { return this.world.map((v) => ({ id: v.id, name: v.name, loud: v.loud, cluster: v.cluster, startAt: v.startAt, rate: v.lastRate, mode: v.chain.mode })); }

  // ---------------------------------------------------------------------------------------------- internals: setup
  private busPC = new ParamCache();
  private buildGraph() {
    const ctx = this.ctx!;
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    this.mix = g(0.9);
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16; this.comp.knee.value = 12; this.comp.ratio.value = 2.5; this.comp.attack.value = 0.008; this.comp.release.value = 0.35;
    this.trim = g(0.85); // partly cancels the compressor's automatic make-up gain (~+4 dB)
    this.lim = ctx.createDynamicsCompressor();
    this.lim.threshold.value = -3; this.lim.knee.value = 0; this.lim.ratio.value = 20; this.lim.attack.value = 0.001; this.lim.release.value = 0.12;
    this.masterG = g(this._master);
    this.pauseG = g(1);
    this.mix.connect(this.comp); this.comp.connect(this.trim); this.trim.connect(this.lim); this.lim.connect(this.masterG);
    this.masterG.connect(this.pauseG); this.pauseG.connect(ctx.destination);

    this.slowLP = ctx.createBiquadFilter(); this.slowLP.type = 'lowpass'; this.slowLP.frequency.value = 22000; this.slowLP.Q.value = 0.6;
    this.sfxBus = g(1); this.duckG = g(1); this.ambBus = g(1); this.alarmBus = g(1);
    this.sfxBus.connect(this.slowLP); this.ambBus.connect(this.slowLP); this.slowLP.connect(this.duckG); this.duckG.connect(this.mix);
    this.alarmBus.connect(this.mix);

    this.revIn = g(1);
    this.revHP = ctx.createBiquadFilter(); this.revHP.type = 'highpass'; this.revHP.frequency.value = 30; this.revHP.Q.value = 0.6;
    this.revDelay = ctx.createDelay(0.2); this.revDelay.delayTime.value = 0.018;
    this.conv = ctx.createConvolver(); this.conv.normalize = false; this.conv.buffer = makeSeaIR(ctx);
    this.revOut = g(0.9);
    this.revIn.connect(this.revHP); this.revHP.connect(this.revDelay); this.revDelay.connect(this.conv); this.conv.connect(this.revOut); this.revOut.connect(this.sfxBus);

    if (this.uiCtx) { this.uiMaster = this.uiCtx.createGain(); this.uiMaster.gain.value = this._master; this.uiMaster.connect(this.uiCtx.destination); }
  }

  private async load(url: string): Promise<AudioBuffer | null> {
    const ctx = this.ctx!;
    const key = url + '@' + ctx.sampleRate;
    let p = decodeCache.get(key);
    if (!p) {
      p = (async () => {
        try {
          const r = await fetch(url);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return await decode(ctx, await r.arrayBuffer());
        } catch (e) {
          console.warn('[audio] failed to load/decode', url, e);
          return null;
        }
      })();
      decodeCache.set(key, p);
    }
    return p;
  }

  private resolve(name: string, quiet = false): { bank: Bank; idx: number } | null {
    const b = this.banks.get(name);
    if (b) return { bank: b, idx: -1 };
    const a = this.alias.get(name);
    if (a) return a;
    if (!this.readyFlag) return null; // not loaded yet: silently ignore
    if (!quiet && !this.warned.has(name)) { this.warned.add(name); console.warn(`[audio] unknown sound "${name}"`); }
    this.counters.missing++;
    return null;
  }

  private pickVariant(bank: Bank, idx: number) {
    const n = bank.buffers.length;
    if (idx >= 0 && idx < n) return idx;
    if (n <= 1) return 0;
    let i = Math.floor(Math.random() * (n - 1));
    if (i >= bank.last) i++;
    bank.last = i;
    return i;
  }

  private applyMaster() {
    const v = this._muted ? 0 : this._master;
    const t = this.ctx?.currentTime ?? 0;
    try { this.masterG?.gain.setTargetAtTime(v, t, 0.05); } catch { /* */ }
    if (this.uiMaster && this.uiCtx) { try { this.uiMaster.gain.setTargetAtTime(v, this.uiCtx.currentTime, 0.05); } catch { /* */ } }
  }

  private onVis = () => {
    if (typeof document === 'undefined') return;
    this.hidden = document.hidden;
    const ac = this.ctx as AudioContext | null;
    if (!ac || this.offline) return;
    if (this.hidden) ac.suspend?.().catch(() => { });
    else if (this.unlocked && !this.paused) ac.resume?.().catch(() => { });
  };

  private handlePause(paused: boolean, now: number) {
    const ac = this.ctx as AudioContext;
    if (paused !== this.paused) {
      this.paused = paused;
      if (paused) {
        try { this.pauseG.gain.cancelScheduledValues(now); this.pauseG.gain.setTargetAtTime(0, now, 0.015); } catch { /* */ }
        if (!this.offline) {
          clearTimeout(this.suspendTimer);
          this.suspendTimer = setTimeout(() => { this.suspendTimer = null; if (this.paused) ac.suspend?.().catch(() => { }); }, 110);
        }
      } else {
        clearTimeout(this.suspendTimer); this.suspendTimer = null;
        const fadeIn = () => { const t = ac.currentTime; try { this.pauseG.gain.cancelScheduledValues(t); this.pauseG.gain.setTargetAtTime(1, t, 0.03); } catch { /* */ } };
        if (!this.offline && ac.state === 'suspended' && this.unlocked && !this.hidden) ac.resume().then(fadeIn, fadeIn);
        else fadeIn();
      }
    } else if (paused && !this.offline && ac.state === 'running' && !this.suspendTimer) {
      // e.g. unlock() resumed the context while paused
      this.suspendTimer = setTimeout(() => { this.suspendTimer = null; if (this.paused) ac.suspend?.().catch(() => { }); }, 110);
    }
  }

  private applyListener(now: number) {
    const L = this.ctx!.listener as any;
    const q = this.lis.quat, p = this.lis.pos;
    const f = rotq(q, 0, 0, -1), u = rotq(q, 0, 1, 0);
    this.right = rotq(q, 1, 0, 0);
    try {
      if (L.positionX) {
        L.positionX.setValueAtTime(p.x, now); L.positionY.setValueAtTime(p.y, now); L.positionZ.setValueAtTime(p.z, now);
        L.forwardX.setValueAtTime(f.x, now); L.forwardY.setValueAtTime(f.y, now); L.forwardZ.setValueAtTime(f.z, now);
        L.upX.setValueAtTime(u.x, now); L.upY.setValueAtTime(u.y, now); L.upZ.setValueAtTime(u.z, now);
      } else {
        L.setPosition(p.x, p.y, p.z);
        L.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
      }
    } catch { /* */ }
  }

  private resetTime() {
    this.pending = []; this.pendKeys.clear();
    for (const l of this.loops) l.hist.clear();
    for (const c of this.ciwsList) c.events = [];
  }

  private combatDuck(def: SoundDef) {
    if (this.scale <= 1 || def.big || def.cls === 'alarm') return 1;
    return Math.pow(this.scale, -0.35);
  }

  /** Pan for stereo (baked) sounds: sine of azimuth in the listener's horizontal frame. */
  private stereoPan(pos: Vec3) {
    const L = this.lis.pos;
    const dx = pos.x - L.x, dy = pos.y - L.y, dz = pos.z - L.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-3) return 0;
    return ((dx * this.right.x + dy * this.right.y + dz * this.right.z) / d) * STEREO_WIDTH;
  }

  // ---------------------------------------------------------------------------------------------- one-shots
  private rateOk(name: string, when: number, def: SoundDef): boolean {
    let arr = this.recent.get(name);
    if (!arr) { arr = []; this.recent.set(name, arr); }
    const now = this.ctx!.currentTime;
    while (arr.length && arr[0].t < now - 1) arr.shift();
    const win = WINDOW * Math.min(Math.max(this.scale, 1), 8);
    const burst = def.burst ?? 3;
    let n = 0; let last: Voice | null = null;
    for (const e of arr) if (Math.abs(e.t - when) < win) { n++; if (e.v && !e.v.dead) last = e.v; }
    if (n >= burst) {
      this.counters.rate++;
      if (last) last.cluster++;
      return false;
    }
    return true;
  }

  private steal(loud: number, list: Voice[]): boolean {
    const now = this.ctx!.currentTime;
    let worst: Voice | null = null, wl = Infinity;
    for (const v of list) {
      if (v.dead) continue;
      const prog = clamp((now - v.startAt) / Math.max(0.05, v.dur), 0, 1);
      const l = v.loud * v.prio * (1 - 0.7 * prog);
      if (l < wl) { wl = l; worst = v; }
    }
    if (!worst || wl >= loud) return false;
    this.counters.stolen++;
    this.killVoice(worst, false);
    return true;
  }

  private startWorld(ev: Pending, when: number) {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    when = Math.max(when, now);
    const { bank, def } = ev;
    const d = dist3(ev.pos, this.lis.pos);
    const farBank = def.far ? this.banks.get(def.far.name) : undefined;
    const sp = spatialParams(def, d, ev.range, farBank?.def);
    const duck = this.combatDuck(def);
    const loud = sp.gain * ev.gain * duck;
    if (loud < CULL) { this.counters.cull++; return; }
    if (!this.rateOk(bank.name, when, def)) return;
    if (this.world.length >= this.maxVoices && !this.steal(loud * ev.prio, this.world)) { this.counters.budget++; return; }

    const idx = this.pickVariant(bank, (ev as any).idx ?? -1);
    const buf = bank.buffers[idx];
    const useFar = !!farBank && farBank.buffers.length > 0 && sp.farW > 0.001;
    const fIdx = useFar ? this.pickVariant(farBank!, -1) : -1;
    const stereo = buf.numberOfChannels > 1;
    const pan: PanMode = def.baked || stereo ? (this.hasStereoPanner ? 'stereo' : 'eq') : d < HRTF_NEAR ? 'hrtf' : 'eq';
    const chain = new Chain(ctx, { far: useFar, filter: true, pan, dest: this.sfxBus, send: this.revIn });
    const det = def.detune ?? 0.03;
    const rate0 = ev.rate * (1 + (Math.random() * 2 - 1) * det);
    const v: Voice = {
      id: this.nextId++, name: bank.name, def, kind: 'world', pos: ev.pos, chain, srcs: [], baseRates: [], extra: [], followsTime: true,
      userGain: ev.gain, trim: bank.trims[idx] ?? 1, prio: ev.prio, range: ev.range, farDef: farBank?.def,
      startAt: when, dur: 0, loud, cluster: ev.count, ended: false, dead: false, lastRate: rate0 * this.timeRate,
    };
    const mk = (b: AudioBuffer, dest: AudioNode, swap: boolean) => {
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.playbackRate.value = rate0 * this.timeRate;
      if (swap && b.numberOfChannels === 2) {
        const sp_ = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2);
        s.connect(sp_); sp_.connect(mg, 0, 1); sp_.connect(mg, 1, 0); mg.connect(dest);
        v.extra.push(sp_, mg);
      } else s.connect(dest);
      v.srcs.push(s); v.baseRates.push(rate0);
      return s;
    };
    // baked L→R fly-by: flip the image when the source moves right→left relative to the listener
    const swap = !!ev.vel && def.baked === true && (ev.vel.x * this.right.x + ev.vel.y * this.right.y + ev.vel.z * this.right.z) < 0 && bank.name === 'missile_flyby';
    let longest = 0, endSrc: AudioBufferSourceNode | null = null;
    // skip the near layer entirely when the listener is far beyond the crossfade (it would be silent)
    if (!useFar || sp.nearW > 0.001) { endSrc = mk(buf, chain.inN, swap); longest = buf.duration; }
    if (useFar) {
      const fb = farBank!.buffers[fIdx];
      const s = mk(fb, chain.inF!, false);
      if (fb.duration > longest) { longest = fb.duration; endSrc = s; }
      (v as any).farTrim = farBank!.trims[fIdx] ?? 1;
    }
    v.dur = longest / Math.max(0.1, rate0 * this.timeRate);
    this.applyWorldVoice(v, now, 0, sp);
    if (chain.panner) chain.setPos(ev.pos, now, 0);
    if (chain.sp) chain.setPan(this.stereoPan(ev.pos), now, 0);
    endSrc!.onended = () => { v.ended = true; this.killVoice(v, true); };
    for (const s of v.srcs) s.start(when);
    this.world.push(v);
    this.counters.started++;
    const arr = this.recent.get(bank.name)!;
    arr.push({ t: when, v });
  }

  private applyWorldVoice(v: Voice, now: number, tau: number, sp?: ReturnType<typeof spatialParams>) {
    const d = dist3(v.pos!, this.lis.pos);
    sp = sp ?? spatialParams(v.def, d, v.range, v.farDef);
    const cl = Math.min(2, Math.sqrt(Math.max(1, v.cluster)));
    const g = v.userGain * this.combatDuck(v.def) * cl;
    const trimN = v.trim, trimF = (v as any).farTrim ?? 1;
    v.loud = sp.gain * g;
    // paired chains carry the variant trims in the crossfade gains; near-only chains in the output gain
    const gT = v.chain.inF ? 1 : trimN;
    v.chain.apply({
      gain: sp.gain * g * gT, send: sp.send * g * gT, cutN: sp.cutoffNear, cutF: sp.cutoffFar,
      wN: sp.nearW * trimN, wF: sp.farW * trimF,
    }, now, tau);
  }

  private play2D(bank: Bank, idx: number, gain: number, rate: number, prio: number) {
    const ctx = this.ctx!;
    const def = bank.def;
    const now = ctx.currentTime;
    if (this.scale >= 8 && !def.big && prio < 3 && def.cls !== 'alarm') { this.counters.scale++; return; }
    if (!this.rateOk(bank.name, now, def)) return;
    const loud = def.vol * gain;
    if (this.voices2d.length >= MAX_2D && !this.steal(loud * prio, this.voices2d)) { this.counters.budget++; return; }
    const i = this.pickVariant(bank, idx);
    const buf = bank.buffers[i];
    const alarm = def.cls === 'alarm';
    const chain = new Chain(ctx, { far: false, filter: false, pan: 'none', dest: alarm ? this.alarmBus : this.sfxBus, send: null, gain0: loud * (bank.trims[i] ?? 1) * this.combatDuck(def) });
    const det = def.detune ?? 0.03;
    const r0 = rate * (1 + (Math.random() * 2 - 1) * det);
    const s = ctx.createBufferSource();
    s.buffer = buf;
    const follows = !alarm;
    s.playbackRate.value = r0 * (follows ? this.timeRate : 1);
    s.connect(chain.inN);
    const v: Voice = {
      id: this.nextId++, name: bank.name, def, kind: '2d', pos: null, chain, srcs: [s], baseRates: [r0], extra: [], followsTime: follows,
      userGain: gain, trim: bank.trims[i] ?? 1, prio, startAt: now, dur: buf.duration / Math.max(0.1, r0), loud, cluster: 1, ended: false, dead: false, lastRate: r0,
    };
    s.onended = () => { v.ended = true; this.killVoice(v, true); };
    s.start(now);
    this.voices2d.push(v);
    this.counters.started++;
    this.recent.get(bank.name)!.push({ t: now, v });
  }

  private playUI(bank: Bank, idx: number, gain: number) {
    const ctx = this.uiCtx ?? this.ctx!;
    const dest = this.uiMaster ?? this.alarmBus;
    const now = ctx.currentTime;
    // rate-limit in the UI context's clock
    let arr = this.recent.get(bank.name);
    if (!arr) { arr = []; this.recent.set(bank.name, arr); }
    while (arr.length && arr[0].t < now - 1) arr.shift();
    let n = 0;
    for (const e of arr) if (Math.abs(e.t - now) < WINDOW) n++;
    if (n >= (bank.def.burst ?? 2)) { this.counters.rate++; return; }
    if (this.uiVoices.length >= MAX_UI) this.killVoice(this.uiVoices[0], false);
    const i = this.pickVariant(bank, idx);
    const chain = new Chain(ctx, { far: false, filter: false, pan: 'none', dest, send: null, gain0: bank.def.vol * gain * (bank.trims[i] ?? 1) });
    const s = ctx.createBufferSource();
    s.buffer = bank.buffers[i];
    s.connect(chain.inN);
    const v: Voice = {
      id: this.nextId++, name: bank.name, def: bank.def, kind: 'ui', pos: null, chain, srcs: [s], baseRates: [1], extra: [], followsTime: false,
      userGain: gain, trim: 1, prio: 1, startAt: now, dur: bank.buffers[i].duration, loud: bank.def.vol * gain, cluster: 1, ended: false, dead: false, lastRate: 1,
    };
    s.onended = () => { v.ended = true; this.killVoice(v, true); };
    s.start(now);
    this.uiVoices.push(v);
    arr.push({ t: now, v });
    this.counters.started++;
  }

  private killVoice(v: Voice, immediate: boolean) {
    if (v.dead) return;
    v.dead = true;
    const list = v.kind === 'world' ? this.world : v.kind === '2d' ? this.voices2d : this.uiVoices;
    const i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1);
    const ctx = v.kind === 'ui' ? (this.uiCtx ?? this.ctx) : this.ctx;
    const cleanup = () => {
      for (const s of v.srcs) { s.onended = null; try { s.disconnect(); } catch { /* */ } }
      for (const n of v.extra) { try { n.disconnect(); } catch { /* */ } }
      v.chain.dispose();
    };
    if (immediate || !ctx) { for (const s of v.srcs) { try { s.stop(); } catch { /* */ } } cleanup(); return; }
    const now = ctx.currentTime;
    v.chain.fadeOut(now, 0.012);
    for (const s of v.srcs) { try { s.stop(now + 0.06); } catch { /* */ } }
    if (v.srcs[0]) v.srcs[0].onended = cleanup;
    // safety net if onended never fires (e.g. context closed); main-context clock
    this.zombies.push({ at: (this.ctx?.currentTime ?? 0) + 1, fn: cleanup });
  }
  private zombies: { at: number; fn: () => void }[] = [];

  private processPending(now: number) {
    const L = this.lis.pos;
    const horizon = this.simNow + this.scale * LOOKAHEAD;
    let w = 0;
    const list = this.pending;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const tArr = this.arrival(p.tEmit, p.pos);
      if (tArr <= horizon) {
        const when = now + Math.max(0, (tArr - this.simNow) / this.scale) + 0.004;
        const k = this.pendKeys.get(p.key);
        if (k) { k.n--; if (k.n <= 0 || k.last === p) this.pendKeys.delete(p.key); }
        this.startWorld(p, when);
      } else if (this.simNow - p.tEmit > 200) {
        this.pendKeys.delete(p.key);
      } else list[w++] = p;
    }
    list.length = w;
  }

  /** Sim time at which a wavefront emitted at (tEmit, pos) reaches the listener, accounting for the listener's closing speed. */
  private arrival(tEmit: number, pos: Vec3) {
    const L = this.lis.pos, V = this.lis.vel;
    const dx = pos.x - L.x, dy = pos.y - L.y, dz = pos.z - L.z;
    const d = Math.hypot(dx, dy, dz);
    const gap = d - C * (this.simNow - tEmit);
    if (gap <= 0 || d < 1e-6) return tEmit + d / C;
    const vr = (V.x * dx + V.y * dy + V.z * dz) / d; // listener speed toward the source
    return this.simNow + gap / Math.max(0.2 * C, C + vr);
  }

  private updateVoices(now: number, rateChanged: boolean) {
    for (const v of this.world) {
      if (v.dead) continue;
      this.applyWorldVoice(v, now, 0.05);
      if (v.chain.sp && v.pos) v.chain.setPan(this.stereoPan(v.pos), now, 0.05);
    }
    if (rateChanged) {
      for (const list of [this.world, this.voices2d]) for (const v of list) {
        if (!v.followsTime || v.dead) continue;
        v.srcs.forEach((s, i) => { try { s.playbackRate.setTargetAtTime(v.baseRates[i] * this.timeRate, now, 0.06); } catch { /* */ } });
        v.lastRate = v.baseRates[0] * this.timeRate;
      }
    }
    for (const v of this.voices2d) if (!v.dead && v.kind === '2d') v.chain.pc.set(v.chain.out.gain, v.def.vol * v.userGain * v.trim * this.combatDuck(v.def), now, 0.1);
  }

  private sweep(now: number) {
    // safety: voices whose onended never fired
    for (const list of [this.world, this.voices2d]) {
      for (let i = list.length - 1; i >= 0; i--) {
        const v = list[i];
        if (now > v.startAt + v.dur / Math.max(0.35, this.timeRate) + 3) this.killVoice(v, true);
      }
    }
    if (this.zombies.length) {
      const keep: typeof this.zombies = [];
      for (const z of this.zombies) { if (now >= z.at) { try { z.fn(); } catch { /* */ } } else keep.push(z); }
      this.zombies = keep;
    }
  }

  // ---------------------------------------------------------------------------------------------- loops
  private updateLoops(now: number, dtReal: number) {
    const L = this.lis.pos, LV = this.lis.vel;
    const scale = this.scale;
    const loopDuck = scale <= 1 ? 1 : Math.max(0.4, Math.pow(scale, -0.3));
    const kDop = 1 - Math.exp(-dtReal / 0.08);
    for (const l of this.loops) {
      if (l.done) continue;
      if (!l.bank.buffers.length) {
        const r = this.resolve(l.bank.name);
        if (!r) { l.done = true; continue; }
        l.bank = r.bank;
        l.phase = Math.random() * r.bank.buffers[0].duration;
      }
      const def = l.bank.def;
      const buf = l.bank.buffers[0];
      // record history at the current sim time (the caller's set() for this frame is the position at simNow)
      if (l.aliveFlag && l.cur && !l.is2D) l.hist.push(this.simNow, l.cur, l.curVel);
      let d = 0, dop = 1, P: Vec3 | null = null, audible = true;
      if (l.is2D) {
        if (l.stopping) l.finished = true;
      } else {
        const h = l.opts.noDelay ? l.hist.newest(l.heard) : l.hist.retarded(L, this.simNow, l.heard);
        if (!h) audible = false;
        else {
          P = h.p; d = dist3(P, L);
          if (l.stopping && (l.opts.noDelay || h.head)) l.finished = true; // last emission has reached the listener
          const nx = (L.x - P.x) / Math.max(d, 1e-3), ny = (L.y - P.y) / Math.max(d, 1e-3), nz = (L.z - P.z) / Math.max(d, 1e-3);
          const vs = h.v.x * nx + h.v.y * ny + h.v.z * nz;
          const vl = LV.x * nx + LV.y * ny + LV.z * nz;
          const den = C - vs;
          dop = den <= 1e-3 ? 2.2 : clamp((C - vl) / den, 0.5, 2.2);
        }
        if (l.stopping && this.simNow - l.endSim > 130) l.finished = true;
      }
      if (l.finished) {
        l.done = true;
        this.loopVirtual(l, now, false, l.fade);
        continue;
      }
      l.dop += (dop - l.dop) * kDop;
      l.dist = d;
      l.audible = audible;
      const law = lawFor(def, l.opts.range);
      const a = l.is2D ? 1 : distGain(d, law.ref, law.range, law.k);
      l.loud = audible ? def.vol * l.gainMul * a * loopDuck : 0;
      if (P) { l.lastPan.x = P.x; l.lastPan.y = P.y; l.lastPan.z = P.z; }
      // phase keeps running while virtual so a resumed loop continues naturally
      const rate = l.detune * l.rateMul * l.dop * this.timeRate;
      l.lastRate = rate;
      if (!this.paused) l.phase = (l.phase + dtReal * rate) % buf.duration;
    }
    this.loops = this.loops.filter((l) => !l.done);
    // virtualisation: loudest N audible loops get real voices
    const order = this.loops.filter((l) => l.loud >= CULL).sort((a, b) => b.loud - a.loud);
    const realSet = new Set(order.slice(0, this.maxLoops));
    for (const l of this.loops) {
      if (realSet.has(l)) {
        if (!l.src) this.loopReal(l, now);
        this.applyLoop(l, now);
      } else if (l.src) this.loopVirtual(l, now, false, 0.06);
    }
  }

  private loopReal(l: LoopImpl, now: number) {
    const ctx = this.ctx!;
    const buf = l.bank.buffers[0];
    const stereo = buf.numberOfChannels > 1;
    l.hrtf = !l.is2D && !stereo && (l.hrtf ? l.dist <= HRTF_OUT : l.dist < HRTF_IN);
    const pan: PanMode = l.is2D ? 'none' : stereo ? (this.hasStereoPanner ? 'stereo' : 'eq') : l.hrtf ? 'hrtf' : 'eq';
    const dest = l.bank.def.cls === 'amb' ? this.ambBus : this.sfxBus;
    l.chain = new Chain(ctx, { far: false, filter: !l.is2D, pan, dest, send: l.is2D ? null : this.revIn, gain0: 0 });
    const s = ctx.createBufferSource();
    s.buffer = buf; s.loop = true;
    s.playbackRate.value = l.lastRate;
    s.connect(l.chain.inN);
    s.start(now, l.phase % buf.duration);
    l.src = s;
    l.chain.pc.set(l.chain.out.gain, 0, now, 0);
  }

  private loopVirtual(l: LoopImpl, now: number, immediate: boolean, fade = 0.06) {
    const s = l.src, ch = l.chain;
    l.src = null; l.chain = null;
    if (!s || !ch) return;
    if (immediate || !this.ctx) { try { s.stop(); } catch { /* */ } s.disconnect(); ch.dispose(); return; }
    ch.fadeOut(now, fade / 3);
    try { s.stop(now + fade * 1.2 + 0.02); } catch { /* */ }
    s.onended = () => { try { s.disconnect(); } catch { /* */ } ch.dispose(); };
    this.zombies.push({ at: now + fade * 1.2 + 2, fn: () => { try { s.disconnect(); } catch { /* */ } ch.dispose(); } });
  }

  private applyLoop(l: LoopImpl, now: number) {
    const ch = l.chain!, s = l.src!;
    const def = l.bank.def;
    const loopDuck = this.scale <= 1 ? 1 : Math.max(0.4, Math.pow(this.scale, -0.3));
    if (l.is2D) {
      ch.apply({ gain: def.vol * l.gainMul * loopDuck, send: 0, cutN: 22000, cutF: 0, wN: 1, wF: 0 }, now, 0.05);
    } else {
      const sp = spatialParams(def, l.dist, l.opts.range);
      const g = l.gainMul * loopDuck;
      ch.apply({ gain: sp.gain * g, send: sp.send * g, cutN: sp.cutoffNear, cutF: 0, wN: 1, wF: 0 }, now, 0.05);
      if (ch.panner) {
        // crossing the HRTF threshold: crossfade to a freshly built chain (never mutate panningModel on a live node)
        if ((!l.hrtf && l.dist < HRTF_IN) || (l.hrtf && l.dist > HRTF_OUT)) {
          this.loopVirtual(l, now, false, 0.08);
          this.loopReal(l, now);
          this.applyLoop(l, now);
          return;
        }
        ch.setPos(l.lastPan, now, 0.03);
      }
      if (ch.sp) ch.setPan(this.stereoPan(l.lastPan), now, 0.05);
    }
    ch.pc.set(s.playbackRate, l.lastRate, now, 0.04, 0.001);
  }

  // ---------------------------------------------------------------------------------------------- CIWS
  private ciwsBanks() {
    const b = (n: string) => this.banks.get(n)?.buffers[0] ?? null;
    return { spin: b('ciws_spinup'), loop: b('ciws_fire_loop'), tail: b('ciws_tail'), far: b('ciws_distant_loop'), servo: b('ciws_servo') };
  }

  private ciwsInit(c: CiwsImpl) {
    const ctx = this.ctx!;
    c.chain = new Chain(ctx, { far: true, filter: true, pan: 'dual', dest: this.sfxBus, send: this.revIn, gain0: 0 });
    // near-perspective transients (spin-up / tail) also feed the far path through a fixed "distance" low-pass
    c.n2f = ctx.createBiquadFilter(); c.n2f.type = 'lowpass'; c.n2f.frequency.value = 900; c.n2f.Q.value = 0.5;
    c.n2fG = ctx.createGain(); c.n2fG.gain.value = 0.6;
    c.n2f.connect(c.n2fG); c.n2fG.connect(c.chain.inF!);
    const B = this.ciwsBanks();
    if (B.servo) {
      c.servo = ctx.createBufferSource(); c.servo.buffer = B.servo; c.servo.loop = true;
      c.servoG = ctx.createGain(); c.servoG.gain.value = 0;
      c.servo.connect(c.servoG); c.servoG.connect(c.chain.inN);
      c.servo.start(ctx.currentTime, Math.random() * B.servo.duration);
    }
  }

  private ciwsSrc(b: AudioBuffer, loop: boolean, rate: number) {
    const s = this.ctx!.createBufferSource();
    s.buffer = b; s.loop = loop; s.playbackRate.value = rate;
    return s;
  }

  /** Loop phase (buffer seconds) at ctx time t while the loop runs. */
  private ciwsPhase(c: CiwsImpl, t: number) { return c.refPhase + (t - c.refT) * c.rate; }

  private ciwsStart(c: CiwsImpl, when: number) {
    const ctx = this.ctx!;
    const B = this.ciwsBanks();
    if (!B.spin || !B.loop || !B.tail || !c.chain) return;
    const now = ctx.currentTime;
    let t0 = Math.max(when, now + 0.012);
    if (c.state === 'spin') return;
    if (c.state === 'tail') {
      // re-fire during the tail: cut the tail quickly, spin up again
      t0 = Math.max(t0, c.tStop);
      if (c.tailG) { try { c.tailG.gain.setValueAtTime(1, t0); c.tailG.gain.setTargetAtTime(0, t0, 0.04); } catch { /* */ } }
      if (c.tail) { try { c.tail.stop(t0 + 0.4); } catch { /* */ } }
    }
    const r = this.timeRate;
    c.rate = r;
    const spin = this.ciwsSrc(B.spin, false, r);
    spin.connect(c.chain.inN); spin.connect(c.n2f!);
    spin.start(t0);
    spin.onended = () => { try { spin.disconnect(); } catch { /* */ } };
    c.spin = spin;
    c.tSpin = t0;
    c.tLoop = t0 + B.spin.duration / r;
    this.ciwsMakeLoops(c, c.tLoop, 0);
    c.state = 'spin';
    c.log.push({ ev: 'start', t: t0, tLoop: c.tLoop, spinDur: B.spin.duration, rate: r, when });
    if (c.log.length > 200) c.log.splice(0, 100);
  }

  private ciwsMakeLoops(c: CiwsImpl, tStart: number, offset: number) {
    const ctx = this.ctx!;
    const B = this.ciwsBanks();
    const r = c.rate;
    const loopG = ctx.createGain(); loopG.gain.value = 1; loopG.connect(c.chain!.inN);
    const loop = this.ciwsSrc(B.loop!, true, r); loop.connect(loopG); loop.start(tStart, offset);
    c.loop = loop; c.loopG = loopG;
    loop.onended = () => { try { loop.disconnect(); loopG.disconnect(); } catch { /* */ } };
    if (B.far) {
      const farG = ctx.createGain(); farG.gain.value = 0; farG.connect(c.chain!.inF!);
      farG.gain.setValueAtTime(0, tStart); farG.gain.linearRampToValueAtTime(1, tStart + 0.03);
      const far = this.ciwsSrc(B.far, true, r); far.connect(farG); far.start(tStart, offset % B.far.duration);
      far.onended = () => { try { far.disconnect(); farG.disconnect(); } catch { /* */ } };
      c.far = far; c.farG = farG;
    }
    c.refT = tStart; c.refPhase = offset;
  }

  private ciwsStopFiring(c: CiwsImpl, when: number) {
    if (c.state !== 'spin') return;
    const ctx = this.ctx!;
    const B = this.ciwsBanks();
    const now = ctx.currentTime;
    const t = Math.max(when, now + 0.012);
    let tStop: number;
    if (t <= c.tLoop) {
      // released during spin-up: let the spin-up finish, the loop never sounds, tail at the splice point
      tStop = c.tLoop;
      try { c.loop?.stop(tStop); } catch { /* */ }
      try { c.far?.stop(tStop); } catch { /* */ }
    } else {
      // quantise to the shot grid so the tail's first round lands exactly one period after the last loop round
      const ph = this.ciwsPhase(c, t);
      const m = ((ph % CIWS_P) + CIWS_P) % CIWS_P;
      let dPh = CIWS_STOP_PHASE - m;
      if (dPh < 0) dPh += CIWS_P;
      tStop = t + dPh / c.rate;
      if (c.loopG) { c.loopG.gain.setValueAtTime(1, tStop - 0.001); c.loopG.gain.linearRampToValueAtTime(0, tStop + 0.0005); }
      try { c.loop?.stop(tStop + 0.002); } catch { /* */ }
      if (c.farG) { c.farG.gain.setValueAtTime(1, tStop); c.farG.gain.setTargetAtTime(0, tStop, 0.035); }
      try { c.far?.stop(tStop + 0.3); } catch { /* */ }
    }
    const tail = this.ciwsSrc(B.tail!, false, c.rate);
    const tailG = ctx.createGain(); tailG.gain.value = 1;
    tail.connect(tailG); tailG.connect(c.chain!.inN); tailG.connect(c.n2f!);
    tail.start(tStop);
    tail.onended = () => { try { tail.disconnect(); tailG.disconnect(); } catch { /* */ } };
    c.tail = tail; c.tailG = tailG;
    c.tStop = tStop;
    c.tEnd = tStop + B.tail!.duration / c.rate;
    c.state = 'tail';
    c.log.push({ ev: 'stop', t: tStop, when, phaseAtStop: tStop > c.tLoop ? this.ciwsPhase(c, tStop) : 0, tLoop: c.tLoop, rate: c.rate });
  }

  private ciwsRate(c: CiwsImpl, now: number) {
    const rNew = this.timeRate, rOld = c.rate;
    if (Math.abs(rNew - rOld) < 1e-4) return;
    for (const s of [c.spin, c.loop, c.far, c.tail]) if (s) { try { s.playbackRate.setValueAtTime(rNew, now); } catch { /* */ } }
    if (c.state === 'spin') {
      if (now < c.tLoop) {
        // still spinning up: reschedule the loop start for the new rate
        const remain = (c.tLoop - now) * rOld;
        try { c.loop?.stop(); } catch { /* */ }
        try { c.far?.stop(); } catch { /* */ }
        c.rate = rNew;
        c.tLoop = now + remain / rNew;
        this.ciwsMakeLoops(c, c.tLoop, 0);
      } else {
        c.refPhase = this.ciwsPhase(c, now); c.refT = now; c.rate = rNew;
      }
    } else {
      c.rate = rNew;
      if (c.state === 'tail' && now < c.tEnd) c.tEnd = now + ((c.tEnd - now) * rOld) / rNew;
    }
    c.log.push({ ev: 'rate', t: now, rate: rNew });
  }

  private updateCiws(now: number, rateChanged: boolean) {
    const L = this.lis.pos;
    for (const c of this.ciwsList) {
      if (c.dead) continue;
      if (!c.hasPos) continue;
      if (!c.chain) this.ciwsInit(c);
      if (rateChanged) this.ciwsRate(c, now);
      const d = dist3(c.pos, L);
      // delayed state changes (propagation in sim time)
      if (this.scale > 0) {
        const horizon = this.simNow + this.scale * LOOKAHEAD;
        while (c.events.length && this.arrival(c.events[0].t, c.pos) <= horizon) {
          const e = c.events.shift()!;
          const when = now + Math.max(0, (this.arrival(e.t, c.pos) - this.simNow) / this.scale);
          if (e.firing) this.ciwsStart(c, when); else this.ciwsStopFiring(c, when);
        }
      }
      if (c.state === 'tail' && now > c.tEnd + 0.05) { c.state = 'idle'; c.spin = c.loop = c.far = c.tail = null; }
      const def = SOUND_DEFS.ciws_fire_loop;
      const sp = spatialParams(def, d, undefined, SOUND_DEFS.ciws_distant_loop);
      const duck = this.scale >= 8 ? 0.5 : this.scale > 1 ? Math.pow(this.scale, -0.15) : 1;
      c.chain!.apply({ gain: sp.gain * duck, send: sp.send * duck, cutN: sp.cutoffNear, cutF: sp.cutoffFar, wN: sp.nearW, wF: sp.farW }, now, 0.05);
      c.chain!.setPos(c.pos, now, 0.03);
      c.chain!.setHrtfMix(clamp((HRTF_OUT - d) / (HRTF_OUT - HRTF_IN), 0, 1), now);
      c.loud = sp.gain;
      // servo: its own (short-range) law relative to the gun's
      if (c.servoG && c.servo) {
        const sd = SOUND_DEFS.ciws_servo;
        const sl = lawFor(sd);
        const rel = (sd.vol * distGain(d, sl.ref, sl.range, sl.k)) / Math.max(1e-6, sp.gain * Math.max(sp.nearW, 1e-3));
        const amt = Math.pow(clamp(c.slew / 1.2, 0, 1), 0.7);
        c.chain!.pc.set(c.servoG.gain, clamp(rel * amt, 0, 4), now, 0.06);
        c.chain!.pc.set(c.servo.playbackRate, (0.8 + 0.5 * clamp(c.slew / 2, 0, 1)) * this.timeRate, now, 0.08, 0.002);
      }
    }
    this.ciwsList = this.ciwsList.filter((c) => !(c.dead && now >= c.disposeAt));
  }

  /** @internal */
  _stopCiws(c: CiwsImpl) {
    const ctx = this.ctx;
    c.dead = true;
    if (!ctx) return;
    const now = ctx.currentTime;
    c.chain?.fadeOut(now, 0.02);
    for (const s of [c.spin, c.loop, c.far, c.tail, c.servo]) if (s) { try { s.stop(now + 0.12); } catch { /* */ } }
    c.disposeAt = now + 0.2;
    this.zombies.push({ at: now + 0.2, fn: () => this.disposeCiws(c) });
  }
  private disposeCiws(c: CiwsImpl) {
    c.dead = true;
    for (const s of [c.spin, c.loop, c.far, c.tail, c.servo]) if (s) { try { s.stop(); } catch { /* */ } try { s.disconnect(); } catch { /* */ } }
    for (const n of [c.loopG, c.farG, c.tailG, c.servoG, c.n2f, c.n2fG]) if (n) { try { n.disconnect(); } catch { /* */ } }
    c.chain?.dispose();
    c.chain = null;
  }

  // ---------------------------------------------------------------------------------------------- ambience
  private ambBed(name: string) {
    const a = this.amb[name];
    if (a) return a;
    const bank = this.banks.get(name);
    if (!bank || !bank.buffers.length) return null;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = bank.buffers[0]; src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.5; lp.frequency.value = 20000;
    const g = ctx.createGain(); g.gain.value = 0;
    const sp = this.hasStereoPanner ? ctx.createStereoPanner() : null;
    src.connect(lp); lp.connect(g);
    if (sp) { g.connect(sp); sp.connect(this.ambBus); } else g.connect(this.ambBus);
    src.start(ctx.currentTime, Math.random() * bank.buffers[0].duration);
    return (this.amb[name] = { src, lp, g, sp, pc: new ParamCache() });
  }

  private updateAmbience(now: number, dtReal: number) {
    const env = this.env;
    const on = this.ambience;
    const L = this.lis.pos;
    const alt = Math.max(0, Number.isFinite(env.camAlt) ? env.camAlt : 10);
    const ss = clamp(env.seaState ?? 3, 0, 6);
    const dS = env.shipPos ? dist3(L, env.shipPos) : 1e9;
    this.deckW += ((env.onDeck ? 1 : 0) - this.deckW) * (1 - Math.exp(-dtReal / 0.5));
    const deck = this.deckW;
    const prox = clamp(1 - Math.log10(Math.max(dS, 60) / 60) / Math.log10(800 / 60), 0, 1);
    const spd = clamp((env.shipSpeed ?? 0) / 9, 0, 1.3);
    const seaNear = clamp(1 - Math.log10(Math.max(alt, 6) / 6) / Math.log10(2000 / 6), 0, 1);
    const aW = clamp(Math.log10(Math.max(alt, 20) / 20) / Math.log10(20000 / 20), 0, 1);
    const camSpeed = Math.hypot(this.lis.vel.x, this.lis.vel.y, this.lis.vel.z);
    const ambRate = 1 - (1 - this.timeRate) * 0.5;

    const beds: [string, number, number, number, number][] = []; // name, gain, cutoff, rate, pan
    const ocean = 0.34 * Math.pow(seaNear, 1.4) * (0.65 + 0.1 * ss) * (1 + 0.35 * deck);
    beds.push(['ocean_loop', ocean, airCutoff(Math.max(alt, 3)) * 1.3, ambRate, 0]);
    const wind = (0.1 + 0.05 * ss) * (1 - aW) + 0.3 * Math.pow(aW, 0.8) + 0.15 * clamp(camSpeed / 250, 0, 1);
    beds.push(['wind_loop', wind * (1 + 0.1 * deck), 14000 - 11000 * aW, ambRate * (1 - 0.2 * aW), 0]);
    const eng = 0.42 * deck + 0.15 * prox * (1 - deck);
    beds.push(['ship_engine_loop', eng, airCutoff(Math.max(5, dS * (1 - deck))) * 1.3, ambRate * (0.95 + 0.05 * spd), (1 - deck) * this.stereoPan(env.shipPos)]);
    const wash = 0.4 * spd * (deck + 0.35 * prox * (1 - deck));
    beds.push(['hull_wash_loop', wash, airCutoff(Math.max(5, dS * (1 - deck))) * 1.3, ambRate * (0.92 + 0.1 * spd), (1 - deck) * this.stereoPan(env.shipPos)]);
    const fireAmt = 1 - Math.exp(-0.8 * Math.max(0, env.shipFires ?? 0));
    const fd = SOUND_DEFS.fire_loop, fl = lawFor(fd);
    const fireProx = Math.max(deck, Math.min(1, distGain(dS, fl.ref, fl.range, fl.k)));
    beds.push(['fire_loop', fd.vol * fireAmt * fireProx, airCutoff(Math.max(5, dS * (1 - deck))) * 1.3, ambRate, (1 - deck) * this.stereoPan(env.shipPos)]);

    for (const [name, g0, cut, rate, pan] of beds) {
      const g = on ? g0 : 0;
      if (g < 1e-4 && !this.amb[name]) continue;
      const b = this.ambBed(name);
      if (!b) continue;
      b.pc.set(b.g.gain, g, now, 0.35);
      b.pc.set(b.lp.frequency, clamp(cut, 60, 20000), now, 0.3, 0.01);
      b.pc.set(b.src.playbackRate, rate, now, 0.15, 0.002);
      if (b.sp) b.pc.set(b.sp.pan, clamp(pan, -0.8, 0.8), now, 0.2, 0.01);
    }

    // hull groans while sinking
    if (on && env.sinking && this.scale > 0 && env.shipPos) {
      this.groanT -= dtReal * Math.min(this.scale, 2);
      if (this.groanT <= 0) {
        this.groanT = 4 + Math.random() * 8;
        const p = env.shipPos;
        this.play('metal_groan', { x: p.x + (Math.random() - 0.5) * 60, y: p.y + 2, z: p.z + (Math.random() - 0.5) * 60 }, { priority: 2, gain: 0.8 + Math.random() * 0.3 });
      }
    }
  }
}

/** Per-variant loudness trims: pull each variant half-way toward the group's mean RMS (±4 dB max). */
function variantTrims(bufs: AudioBuffer[]): number[] {
  if (bufs.length < 2) return bufs.map(() => 1);
  const db = bufs.map((b) => {
    let e = 0, n = 0;
    for (let c = 0; c < b.numberOfChannels; c++) {
      const x = b.getChannelData(c);
      for (let i = 0; i < x.length; i += 4) { e += x[i] * x[i]; n++; }
    }
    return 10 * Math.log10(Math.max(e / Math.max(n, 1), 1e-12));
  });
  const mean = db.reduce((a, b) => a + b, 0) / db.length;
  return db.map((v) => Math.pow(10, clamp(0.5 * (mean - v), -4, 4) / 20));
}
