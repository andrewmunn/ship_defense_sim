import type { ThreatType } from './specs';

export interface WaveConfig {
  /** Seconds after scenario start at which the wave's first missile arrives (TOT) or launches (stream). */
  time: number;
  type: ThreatType;
  count: number;
  /** Seconds between missile arrivals (0 = perfectly simultaneous time-on-target). */
  spacing: number;
  /** Number of distinct attack axes (missiles are routed around to arrive from different bearings). */
  axes: number;
  /** Half-width of the arrival bearing fan (deg) around the coast bearing. */
  fan: number;
  /** Flight profile for high-flyers; 'lo' = sea-skim the whole way. */
  profile: 'hi' | 'lo';
}

export interface ScenarioConfig {
  name: string;
  desc: string;
  seed: number;
  /** Distance to the coast (km). */
  coastKm: number;
  /** Bearing from ship to the coast (deg). */
  coastBearing: number;
  /** Number of coastal launch sites. */
  sites: number;
  waves: WaveConfig[];
  loadout: { halberd: number; glaive: number; stiletto: number; ciwsRounds: number; gunRounds: number; wisp: number; chaff: number };
  doctrine: {
    /** Shoot-look-shoot vs salvo (2 per threat). */
    policy: 'sls' | 'salvo' | 'auto';
    /** Seconds from firm track to weapons release. */
    reaction: number;
    decoys: boolean;
    gun: boolean;
    ciws: boolean;
    /** Max simultaneous semi-active terminal engagements per illuminator. */
    illumShare: number;
    /** Ring up flank speed and turn to unmask both CIWS mounts against the threat axis. */
    maneuver?: boolean;
  };
  env: { timeOfDay: number; seaState: number; visibilityKm: number; clouds: number; windDeg: number };
  ship: { speedKts: number; heading: number };
}

const base = (): ScenarioConfig => ({
  name: 'Custom',
  desc: '',
  seed: 1,
  coastKm: 38,
  coastBearing: 40,
  sites: 3,
  waves: [],
  loadout: { halberd: 34, glaive: 12, stiletto: 32, ciwsRounds: 1550, gunRounds: 600, wisp: 8, chaff: 24 },
  doctrine: { policy: 'auto', reaction: 3.0, decoys: true, gun: true, ciws: true, illumShare: 1, maneuver: true },
  env: { timeOfDay: 16.4, seaState: 3, visibilityKm: 180, clouds: 0.4, windDeg: 220 },
  ship: { speedKts: 18, heading: 300 },
});

const W = (time: number, type: ThreatType, count: number, spacing = 4, axes = 1, fan = 20, profile: 'hi' | 'lo' = 'hi'): WaveConfig => ({ time, type, count, spacing, axes, fan, profile });

export const PRESETS: ScenarioConfig[] = [
  {
    ...base(),
    name: 'Leaker Drill',
    desc: 'Two subsonic sea-skimmers. Watch the full kill chain: radar pop-up at the horizon, Stiletto, and CIWS.',
    waves: [W(150, 'asm_subsonic', 2, 10)],
    loadout: { ...base().loadout, halberd: 0, glaive: 0, stiletto: 4 },
  },
  {
    ...base(),
    name: 'Coastal Raid',
    desc: 'Six subsonic ASCMs from three coastal batteries, arriving from two axes.',
    waves: [W(160, 'asm_subsonic', 6, 3, 2, 30)],
  },
  {
    ...base(),
    name: 'Mixed Raid',
    desc: 'Subsonic skimmers followed by supersonic ramjets diving from altitude.',
    waves: [W(150, 'asm_subsonic', 8, 2, 3, 40), W(170, 'asm_supersonic', 4, 3, 2, 25)],
  },
  {
    ...base(),
    name: 'Heavy Divers',
    desc: 'Four heavy Mach 3+ missiles screaming down from 16 km. Glaive territory.',
    waves: [W(120, 'asm_heavy', 4, 4, 2, 20)],
  },
  {
    ...base(),
    name: 'Saturation (TOT)',
    desc: '32 missiles timed to arrive together from four axes. Can Bastion keep up?',
    waves: [W(170, 'asm_subsonic', 12, 0.7, 4, 70), W(172, 'asm_supersonic', 12, 1, 3, 50), W(175, 'asm_heavy', 8, 2, 1, 10)],
  },
  {
    ...base(),
    name: 'Overwhelm',
    desc: '64 missiles in three waves. The magazine will run dry. Expect leakers.',
    sites: 5,
    waves: [
      W(150, 'asm_subsonic', 28, 0.6, 5, 80),
      W(185, 'asm_supersonic', 16, 0.8, 4, 60),
      W(200, 'asm_heavy', 6, 1.5, 2, 30),
      W(215, 'asm_subsonic', 14, 0.5, 3, 60, 'lo'),
    ],
    loadout: { ...base().loadout, halberd: 30, glaive: 8, stiletto: 24 },
  },
  {
    ...base(),
    name: 'Night Raid',
    desc: 'A mixed raid after dark in a rising sea.',
    waves: [W(150, 'asm_subsonic', 8, 2, 3, 50), W(165, 'asm_supersonic', 4, 2, 2, 30, 'lo')],
    env: { timeOfDay: 22.5, seaState: 4, visibilityKm: 60, clouds: 0.3, windDeg: 200 },
  },
];

export function cloneScenario(s: ScenarioConfig): ScenarioConfig {
  return JSON.parse(JSON.stringify(s));
}

export function totalThreats(s: ScenarioConfig) {
  return s.waves.reduce((a, w) => a + w.count, 0);
}
