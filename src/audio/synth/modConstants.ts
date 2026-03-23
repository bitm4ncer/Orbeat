/**
 * Param metadata for the modulation system.
 * Maps each modulatable SynthParam key to its range, label, and routing hint.
 */

import type { SynthParams, LFOShape } from './types';

export interface ParamMeta {
  min: number;
  max: number;
  label: string;
  unit?: string;
  /** If true, this param can be connected via AudioParam for audio-rate modulation */
  audioRate?: boolean;
}

export const MOD_PARAM_META: Partial<Record<keyof SynthParams, ParamMeta>> = {
  // VCO
  vcoGain:       { min: 0, max: 1,     label: 'Gain' },
  vcoPan:        { min: -1, max: 1,    label: 'Pan' },
  vcoDetune:     { min: -100, max: 100, label: 'Tune', unit: '¢', audioRate: true },
  wtPosition:    { min: 0, max: 1,     label: 'WT Pos' },
  wtWarpAmount:  { min: 0, max: 1,     label: 'WT Warp' },

  // Filter
  filterFreq:    { min: 20, max: 20000, label: 'Cutoff', unit: 'Hz', audioRate: true },
  filterQ:       { min: 0, max: 20,     label: 'Reso' },
  filterEnvAmount: { min: -12000, max: 12000, label: 'Filt Env' },
  filterAttack:  { min: 0, max: 2,      label: 'Filt Atk', unit: 's' },
  filterDecay:   { min: 0.001, max: 2,  label: 'Filt Dec', unit: 's' },
  ringModMix:    { min: 0, max: 1,      label: 'Ring Mix' },

  // Sub oscillators
  sub1Gain:      { min: 0, max: 1, label: 'Sub1 Gain' },
  sub1Pan:       { min: -1, max: 1, label: 'Sub1 Pan' },
  sub2Gain:      { min: 0, max: 1, label: 'Sub2 Gain' },
  sub2Pan:       { min: -1, max: 1, label: 'Sub2 Pan' },

  // Unison
  unisonDetune:  { min: 0, max: 50, label: 'Uni Det', unit: '¢' },
  unisonSpread:  { min: 0, max: 1,  label: 'Uni Sprd' },
  unisonDrift:   { min: 0, max: 1,  label: 'Drift' },

  // FM
  fmDepth:       { min: 0, max: 500, label: 'FM Depth', unit: 'Hz' },
  fmRatio:       { min: 0.5, max: 8, label: 'FM Ratio' },

  // Delay
  delayTime:     { min: 0, max: 1,    label: 'Dly Time', unit: 's' },
  delayFeedback: { min: 0, max: 0.95, label: 'Dly FB' },
  delayTone:     { min: 200, max: 12000, label: 'Dly Tone', unit: 'Hz' },
  delayAmount:   { min: 0, max: 1,    label: 'Dly Amt' },

  // Reverb
  reverbAmount:  { min: 0, max: 1, label: 'Rev Amt' },

  // Distortion
  distortionDist:   { min: 0, max: 50, label: 'Drive' },
  distortionAmount: { min: 0, max: 1,  label: 'Dist Amt' },

  // Bit Crusher
  bitCrushDepth:  { min: 1, max: 16, label: 'Bit Depth' },
  bitCrushAmount: { min: 0, max: 1,  label: 'Crush Amt' },

  // String oscillator
  stringDamping:  { min: 200, max: 12000, label: 'Damp', unit: 'Hz' },
  stringDecay:    { min: 0.9, max: 0.999, label: 'Str Decay' },

  // Glide
  portamentoSpeed: { min: 0, max: 0.5, label: 'Glide', unit: 's' },

  // Master
  masterVolume:   { min: 0, max: 1, label: 'Volume' },

  // Envelope (env1 — VCO)
  gainAttack:    { min: 0.001, max: 2, label: 'Attack', unit: 's' },
  gainDecay:     { min: 0.001, max: 2, label: 'Decay', unit: 's' },
  gainSustain:   { min: 0, max: 1, label: 'Sustain' },
  gainRelease:   { min: 0.001, max: 5, label: 'Release', unit: 's' },

  // Envelope 2 (Sub1)
  env2Attack:    { min: 0.001, max: 2, label: 'Env2 Atk', unit: 's' },
  env2Decay:     { min: 0.001, max: 2, label: 'Env2 Dec', unit: 's' },
  env2Sustain:   { min: 0, max: 1, label: 'Env2 Sus' },
  env2Release:   { min: 0.001, max: 5, label: 'Env2 Rel', unit: 's' },

  // Envelope 3 (Sub2)
  env3Attack:    { min: 0.001, max: 2, label: 'Env3 Atk', unit: 's' },
  env3Decay:     { min: 0.001, max: 2, label: 'Env3 Dec', unit: 's' },
  env3Sustain:   { min: 0, max: 1, label: 'Env3 Sus' },
  env3Release:   { min: 0.001, max: 5, label: 'Env3 Rel', unit: 's' },
};

/** All modulatable param keys (keys that have metadata) */
export const MODULATABLE_PARAMS = Object.keys(MOD_PARAM_META) as (keyof SynthParams)[];

/** LFO slot colors */
export const LFO_COLORS = ['#4fc3f7', '#ab47bc', '#66bb6a', '#ffa726'] as const;

/** Tempo sync divisions — straight, dotted, and triplet */
export const SYNC_DIVS = [
  '4/1', '2/1', '1/1', '1/2', '1/4', '1/8', '1/16', '1/32',
  '1/2d', '1/4d', '1/8d', '1/16d',
  '1/2t', '1/4t', '1/8t', '1/16t',
] as const;

export const SYNC_DIV_LABELS: Record<string, string> = {
  '4/1': '4 bars', '2/1': '2 bars', '1/1': '1 bar',
  '1/2': '1/2', '1/4': '1/4', '1/8': '1/8', '1/16': '1/16', '1/32': '1/32',
  '1/2d': '1/2.', '1/4d': '1/4.', '1/8d': '1/8.', '1/16d': '1/16.',
  '1/2t': '1/2T', '1/4t': '1/4T', '1/8t': '1/8T', '1/16t': '1/16T',
};

/** Convert sync division string to seconds at a given BPM */
export function syncDivToSeconds(div: string, bpm: number): number {
  const beatSec = 60 / bpm;
  // Dotted = 1.5× straight, Triplet = 2/3× straight
  const isDotted = div.endsWith('d');
  const isTriplet = div.endsWith('t');
  const base = isDotted || isTriplet ? div.slice(0, -1) : div;

  let seconds: number;
  switch (base) {
    case '4/1':  seconds = beatSec * 16; break;
    case '2/1':  seconds = beatSec * 8;  break;
    case '1/1':  seconds = beatSec * 4;  break;
    case '1/2':  seconds = beatSec * 2;  break;
    case '1/4':  seconds = beatSec;      break;
    case '1/8':  seconds = beatSec / 2;  break;
    case '1/16': seconds = beatSec / 4;  break;
    case '1/32': seconds = beatSec / 8;  break;
    default:     seconds = beatSec;
  }

  if (isDotted)  return seconds * 1.5;
  if (isTriplet) return seconds * (2 / 3);
  return seconds;
}

/** Convert sync division to Hz at a given BPM */
export function syncDivToHz(div: string, bpm: number): number {
  return 1 / syncDivToSeconds(div, bpm);
}

// ── Custom LFO shapes ─────────────────────────────────────────────────────

const NATIVE_SHAPES: ReadonlySet<string> = new Set(['sine', 'triangle', 'square', 'sawtooth']);

export function isNativeLFOShape(shape: string): shape is OscillatorType {
  return NATIVE_SHAPES.has(shape);
}

/** All available LFO shapes in display order */
export const LFO_SHAPES: LFOShape[] = [
  'sine', 'triangle', 'square', 'sawtooth',
  'expDecay', 'expRise', 'punch', 'halfSine', 'staircase',
];
export const LFO_SHAPE_LABELS: Record<LFOShape, string> = {
  sine: 'SIN', triangle: 'TRI', square: 'SQR', sawtooth: 'SAW',
  expDecay: 'DEC', expRise: 'RISE', punch: 'PUNCH', halfSine: 'BUMP', staircase: 'STEP',
};

/** Sample an LFO shape at phase t (0-1), returns -1 to +1 */
export function sampleLFOShape(t: number, shape: LFOShape): number {
  switch (shape) {
    case 'sine':      return Math.sin(t * Math.PI * 2);
    case 'triangle':  return 1 - 4 * Math.abs(t - Math.round(t));
    case 'square':    return t < 0.5 ? 1 : -1;
    case 'sawtooth':  return 2 * (t - Math.floor(t + 0.5));
    case 'expDecay':  return 2 * Math.exp(-5 * t) - 1;
    case 'expRise':   return 1 - 2 * Math.exp(-5 * t);
    case 'punch':     return Math.max(-1, 4 * Math.exp(-15 * t) - 1);
    case 'halfSine':  return Math.sin(t * Math.PI);
    case 'staircase': return Math.floor(t * 4) / 1.5 - 1;
    default:          return 0;
  }
}

/** Cached PeriodicWave per AudioContext + shape */
const lfoWaveCache = new WeakMap<AudioContext, Map<string, PeriodicWave>>();

/** Get (or compute & cache) a PeriodicWave for a custom LFO shape */
export function getLFOPeriodicWave(ac: AudioContext, shape: LFOShape): PeriodicWave {
  let cache = lfoWaveCache.get(ac);
  if (!cache) { cache = new Map(); lfoWaveCache.set(ac, cache); }

  let wave = cache.get(shape);
  if (wave) return wave;

  // Compute Fourier coefficients via DFT
  const N = 128;    // harmonics
  const M = 4096;   // integration samples
  const real = new Float32Array(N + 1);
  const imag = new Float32Array(N + 1);

  // DC component
  let dc = 0;
  for (let k = 0; k < M; k++) dc += sampleLFOShape(k / M, shape);
  real[0] = dc / M;
  imag[0] = 0;

  for (let n = 1; n <= N; n++) {
    let cosSum = 0, sinSum = 0;
    for (let k = 0; k < M; k++) {
      const t = k / M;
      const v = sampleLFOShape(t, shape);
      const angle = 2 * Math.PI * n * t;
      cosSum += v * Math.cos(angle);
      sinSum += v * Math.sin(angle);
    }
    real[n] = (2 / M) * cosSum;
    imag[n] = (2 / M) * sinSum;
  }

  wave = ac.createPeriodicWave(real, imag);
  cache.set(shape, wave);
  return wave;
}
