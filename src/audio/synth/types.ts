export type LFODestination = 'none' | 'filter' | 'pitch' | 'amp' | 'pan';

// ── Wavetable types ─────────────────────────────────────────────────────────

export interface WTFrame {
  real: Float32Array;   // length = NUM_HARMONICS + 1
  imag: Float32Array;
}

export interface WTBank {
  id: string;           // e.g. 'basic_shapes'
  name: string;         // display name: 'Basic Shapes'
  frameCount: number;   // typically 64
  generate: () => WTFrame[];
}

// ── Modulation types ────────────────────────────────────────────────────────

export type LFOTriggerMode = 'free' | 'retrig' | 'envelope';

export type LFOShape = OscillatorType | 'expDecay' | 'expRise' | 'punch' | 'halfSine' | 'staircase';

export type LFOMode = 'lfo' | 'stepseq';

export interface LFOSlotParams {
  enabled: boolean;               // on/off toggle
  mode: LFOMode;                  // 'lfo' (default) or 'stepseq'
  shape: LFOShape;
  rate: number;                   // Hz (when not tempo-synced)
  tempoSync: boolean;
  syncDiv: string;                // '1/1','1/2','1/4','1/8','1/16','1/32'
  triggerMode: LFOTriggerMode;
  smooth: number;                 // 0-1
  delay: number;                  // 0-2s fade-in
  phase: number;                  // 0-1 initial phase offset
  steps: number[];                // 16 values, -1 to +1 (step sequencer mode)
}

export interface ModAssignment {
  id: string;
  source: 'lfo1' | 'lfo2' | 'lfo3' | 'lfo4';
  target: keyof SynthParams;
  depth: number;                  // -1 to +1 (bipolar)
}

export const DEFAULT_LFO_SLOT: LFOSlotParams = {
  enabled: true,
  mode: 'lfo',
  shape: 'sine',
  rate: 1,
  tempoSync: false,
  syncDiv: '1/4',
  triggerMode: 'free',
  smooth: 0,
  delay: 0,
  phase: 0,
  steps: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};

// ── FM Operator types ───────────────────────────────────────────────────────

export type FMOperatorWaveform = 'sine' | 'triangle' | 'square' | 'sawtooth';

export interface FMOperatorParams {
  waveform: FMOperatorWaveform;
  ratioCoarse: number;    // 1–16 (integer frequency multiplier)
  ratioFine: number;      // -0.99 to +0.99 (added to coarse)
  level: number;          // 0–1 (modulation index for modulators, amplitude for carriers)
  feedback: number;       // 0–1 (self-feedback amount)
  envAttack: number;      // 0–4s
  envDecay: number;       // 0.001–4s
  envSustain: number;     // 0–1
  envRelease: number;     // 0.01–4s
}

export interface FMParams {
  enabled: boolean;
  algorithm: number;       // index into FM_ALGORITHMS
  operators: [FMOperatorParams, FMOperatorParams, FMOperatorParams, FMOperatorParams];
  masterLevel: number;     // 0–1
}

export const DEFAULT_FM_OPERATOR: FMOperatorParams = {
  waveform: 'sine',
  ratioCoarse: 1,
  ratioFine: 0,
  level: 1,
  feedback: 0,
  envAttack: 0.001,
  envDecay: 0.1,
  envSustain: 1,
  envRelease: 0.15,
};

export const DEFAULT_FM_PARAMS: FMParams = {
  enabled: true,
  algorithm: 0,
  operators: [
    { ...DEFAULT_FM_OPERATOR, level: 1 },       // Op1 — carrier
    { ...DEFAULT_FM_OPERATOR, level: 0.5 },     // Op2 — modulator
    { ...DEFAULT_FM_OPERATOR, level: 0, ratioCoarse: 1 },  // Op3 — off
    { ...DEFAULT_FM_OPERATOR, level: 0, ratioCoarse: 1 },  // Op4 — off
  ],
  masterLevel: 0.75,
};

// ── Synth params ────────────────────────────────────────────────────────────

export interface SynthParams {
  masterVolume: number;

  // Gain envelope (ADSR)
  gainAttack: number;
  gainDecay: number;
  gainSustain: number;
  gainRelease: number;

  // VCO (main oscillator)
  vcoType: string; // OscillatorType or custom wavetable key
  vcoGain: number;
  vcoPan: number;
  vcoDetune: number; // cents, -100 to +100
  vcoOctave: number; // integer, -2 to +2

  // Sub 1
  sub1Type: OscillatorType;
  sub1Offset: number; // semitones, -24 to +24
  sub1Pan: number;
  sub1Gain: number;

  // Sub 2
  sub2Type: OscillatorType;
  sub2Offset: number;
  sub2Pan: number;
  sub2Gain: number;

  // Unison
  unisonVoices: number;   // 1–7
  unisonDetune: number;   // 0–50 cents spread
  unisonSpread: number;   // 0–1 stereo width
  unisonDrift: number;    // 0–1 analog drift amount

  // Filter
  filterType: BiquadFilterType | 'ladder' | 'comb+' | 'comb-';
  filterFreq: number;
  filterQ: number;
  filterAttack: number;
  filterDecay: number;
  filterEnvAmount: number;

  // LFO 1
  lfo1Rate: number;
  lfo1Depth: number;
  lfo1Shape: OscillatorType;
  lfo1Dest: LFODestination;

  // LFO 2
  lfo2Rate: number;
  lfo2Depth: number;
  lfo2Shape: OscillatorType;
  lfo2Dest: LFODestination;

  // Ring Mod
  ringModEnabled: boolean;
  ringModMix: number;     // 0–1 dry/wet

  // FM
  fmEnabled: boolean;
  fmRatio: number;   // 0.5–8
  fmDepth: number;   // 0–500 Hz

  // Delay
  delayTime: number;
  delayFeedback: number;
  delayTone: number;
  delayAmount: number;

  // Reverb
  reverbType: string;
  reverbAmount: number;

  // Distortion
  distortionType: number;    // 0=soft, 1=hard, 2=tanh, 3=fold, 4=asym, 5=rectify, 6=fuzz
  distortionDist: number;
  distortionAmount: number;

  // Bit Crusher
  bitCrushDepth: number;
  bitCrushAmount: number;

  // Wavetable
  wtPosition: number;      // 0–1, position within wavetable bank
  wtWarpMode: number;      // 0–15, spectral warp mode index
  wtWarpAmount: number;    // 0–1, warp intensity

  // String oscillator (Karplus-Strong)
  stringDamping: number;   // 200–12000 Hz (damping filter cutoff)
  stringDecay: number;     // 0.9–0.999 (feedback amount)

  // Modulation (new system — 4 LFO slots + assignments)
  lfos: [LFOSlotParams, LFOSlotParams, LFOSlotParams, LFOSlotParams];
  modAssignments: ModAssignment[];

  // Synth mode
  synthMode: 'osc' | 'fm';  // subtractive or FM synthesis

  // 4-operator FM synthesis
  fm: FMParams;

  // Poly / Glide
  maxVoices: number;       // 1–8
  portamentoSpeed: number;
  portamentoCurve: 'lin' | 'log' | 'exp';  // glide curve shape
  portamentoLegato: boolean;               // only glide when overlapping notes
}
