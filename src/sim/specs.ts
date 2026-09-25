/**
 * Weapon & threat performance data. Numbers are plausible, public-order-of-magnitude
 * values tuned for gameplay on a shrunken planet (see core/constants.ts).
 */

export type ThreatType = 'asm_subsonic' | 'asm_supersonic' | 'asm_heavy';
export type InterceptorType = 'halberd' | 'glaive' | 'stiletto';

export interface ThreatSpec {
  type: ThreatType;
  name: string;
  short: string;
  model: string;
  length: number;
  diameter: number;
  /** Cruise speed (m/s). */
  speed: number;
  /** Terminal speed (m/s). */
  terminalSpeed: number;
  /** Mid-course altitude (m) for the hi-lo profile. */
  cruiseAlt: number;
  /** Terminal / sea-skim altitude (m). */
  skimAlt: number;
  /** Distance to target at which the missile descends to skim altitude (m). */
  descentRange: number;
  seekerRange: number;
  maxG: number;
  rcs: number; // m^2
  /** Structural hit points vs 20mm hits (average hits to kill). */
  hp: number;
  warheadKg: number;
  boostTime: number;
  boostAccel: number;
  /** Detachable booster (jettisoned after boost). */
  booster: boolean;
  terminal: 'none' | 'popup' | 'weave' | 'dive';
  /** Probability the seeker is seduced by a decoy/chaff when one is in its FOV. */
  decoySusceptibility: number;
  /** Fraction of blast lethality an interceptor warhead achieves against this target (hardness). */
  interceptPkMod: number;
  /** Plume / trail style. */
  motor: 'turbojet' | 'ramjet' | 'rocket';
  color: string;
}

export const THREATS: Record<ThreatType, ThreatSpec> = {
  asm_subsonic: {
    type: 'asm_subsonic',
    name: 'Subsonic sea-skimming ASCM',
    short: 'SUBSONIC ASCM',
    model: 'asm_subsonic',
    length: 6.0,
    diameter: 0.36,
    speed: 275,
    terminalSpeed: 290,
    cruiseAlt: 30,
    skimAlt: 5,
    descentRange: 16000,
    seekerRange: 18000,
    maxG: 9,
    rcs: 0.1,
    hp: 2.2,
    warheadKg: 165,
    boostTime: 2.8,
    boostAccel: 95,
    booster: true,
    terminal: 'popup',
    decoySusceptibility: 0.16,
    interceptPkMod: 1.0,
    motor: 'turbojet',
    color: '#ff5a4a',
  },
  asm_supersonic: {
    type: 'asm_supersonic',
    name: 'Supersonic ramjet ASCM',
    short: 'SUPERSONIC ASCM',
    model: 'asm_supersonic',
    length: 8.5,
    diameter: 0.67,
    speed: 720,
    terminalSpeed: 800,
    cruiseAlt: 9000,
    skimAlt: 9,
    descentRange: 26000,
    seekerRange: 22000,
    maxG: 15,
    rcs: 0.5,
    hp: 3.5,
    warheadKg: 250,
    boostTime: 4.0,
    boostAccel: 170,
    booster: false,
    terminal: 'weave',
    decoySusceptibility: 0.08,
    interceptPkMod: 0.8,
    motor: 'ramjet',
    color: '#ff8a2a',
  },
  asm_heavy: {
    type: 'asm_heavy',
    name: 'Heavy high-diving ASM',
    short: 'HEAVY DIVER',
    model: 'asm_heavy',
    length: 11.6,
    diameter: 0.92,
    speed: 950,
    terminalSpeed: 1150,
    cruiseAlt: 16000,
    skimAlt: 0,
    descentRange: 22000,
    seekerRange: 30000,
    maxG: 10,
    rcs: 2.0,
    hp: 4.5,
    warheadKg: 900,
    boostTime: 6,
    boostAccel: 150,
    booster: false,
    terminal: 'dive',
    decoySusceptibility: 0.04,
    interceptPkMod: 0.7,
    motor: 'rocket',
    color: '#ff3aa0',
  },
};

export interface InterceptorSpec {
  type: InterceptorType;
  name: string;
  short: string;
  model: string;
  length: number;
  diameter: number;
  /** thrust phases: [duration s, accel m/s^2] */
  motor: [number, number][];
  /** Separate booster stage burn time (0 = none). */
  boosterSep: number;
  /** Drag coefficient * area / mass  (1/m) at sea level density. */
  dragK: number;
  maxG: number;
  minRange: number;
  maxRange: number;
  /** Planning fly-out average speed (m/s) for intercept prediction. */
  avgSpeed: number;
  lethalRadius: number;
  /** Semi-active: needs illuminator during terminal phase. */
  semiActive: boolean;
  terminalTime: number;
  /** Missiles per VLS cell. */
  perCell: number;
  verticalTime: number;
  basePk: number;
  color: string;
}

export const INTERCEPTORS: Record<InterceptorType, InterceptorSpec> = {
  halberd: {
    type: 'halberd',
    name: 'Halberd medium-range SAM',
    short: 'HALBERD',
    model: 'halberd',
    length: 4.72,
    diameter: 0.343,
    motor: [[5.5, 200], [16, 38]],
    boosterSep: 0,
    dragK: 0.000024,
    maxG: 30,
    minRange: 2500,
    maxRange: 60000,
    avgSpeed: 820,
    lethalRadius: 9,
    semiActive: true,
    terminalTime: 5.0,
    perCell: 1,
    verticalTime: 0.8,
    basePk: 0.8,
    color: '#5ac8ff',
  },
  glaive: {
    type: 'glaive',
    name: 'Glaive extended-range SAM',
    short: 'GLAIVE',
    model: 'glaive',
    length: 6.6,
    diameter: 0.53,
    motor: [[5.5, 240], [6, 200], [18, 40]],
    boosterSep: 5.5,
    dragK: 0.000022,
    maxG: 32,
    minRange: 3000,
    maxRange: 110000,
    avgSpeed: 980,
    lethalRadius: 10,
    semiActive: false,
    terminalTime: 6,
    perCell: 1,
    verticalTime: 0.9,
    basePk: 0.85,
    color: '#7ae0ff',
  },
  stiletto: {
    type: 'stiletto',
    name: 'Stiletto point-defense SAM',
    short: 'STILETTO',
    model: 'stiletto',
    length: 3.66,
    diameter: 0.254,
    motor: [[4.0, 330]],
    boosterSep: 0,
    dragK: 0.000033,
    maxG: 45,
    minRange: 1200,
    maxRange: 24000,
    avgSpeed: 850,
    lethalRadius: 7,
    semiActive: true,
    terminalTime: 3.5,
    perCell: 4,
    verticalTime: 0.5,
    basePk: 0.8,
    color: '#8affd0',
  },
};

export const CIWS_SPEC = {
  rpm: 4500,
  muzzleVel: 1100,
  /** Round dispersion (1-sigma, radians). */
  dispersion: 0.0011,
  magazine: 1550,
  reloadTime: 240,
  maxRange: 3600,
  openFireRange: 2100,
  slewRate: 2.4, // rad/s
  elevRate: 2.0,
  lockTime: 0.5,
  /** Effective hit radius of a round vs missile body (m), includes fragment / debris effects. */
  hitRadius: 0.5,
  /** Probability that a single hit detonates the warhead. */
  pkPerHit: 0.22,
  /** Quadratic drag constant (1/m) for the 20 mm APDS sub-caliber penetrator. */
  dragK: 0.00045,
  burst: 1.2,
};

export const GUN_SPEC = {
  roundsPerMin: 20,
  muzzleVel: 808,
  magazine: 600,
  maxRange: 13000,
  minRange: 1500,
  fuzeRadius: 14,
  pkInFuze: 0.3,
  slewRate: 0.55,
  elevRate: 0.35,
  dragK: 0.00005,
};

export const DECOY_SPEC = {
  wisp: 8,
  chaff: 24,
};
