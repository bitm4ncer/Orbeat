/**
 * Per-orbit Web Audio effect chains.
 *
 * Signal path:
 *   [summingNode / synthInputGain]
 *     → [EQ3: eqLow → eqMid → eqHigh]
 *     → [Chorus dry/wet mix]
 *     → [Phaser dry/wet mix]
 *     → [Filter dry/wet mix]
 *     → [Distortion dry/wet mix]
 *     → [Reverb dry/wet mix]
 *     → [Delay dry/wet mix]
 *     → [BitCrusher: bcSR(worklet) → bcBits(waveshaper) dry/wet mix]
 *     → [Param EQ: eqBands[0..5] dry/wet mix]
 *     → [Tremolo: tremoloAmpGain with LFO on gain]
 *     → [Ring Mod: ringModGain(carrier on gain) dry/wet mix]
 *     → [orbit.output] → ... → destination
 */

import { getSuperdoughAudioController } from 'superdough';
import type { Effect } from '../types/effects';
import { isAudioReady } from './engine';
import { DELAY_SYNC_DIVS } from './effectParams';
import { log } from '../logging/logger';

const MAX_PHASER_STAGES = 12;

// ── Trance Gate Scheduler ─────────────────────────────────────────────────
// Schedules gain automation on a GainNode to create a rhythmic gate.
class TranceGateScheduler {
  private readonly ac: AudioContext;
  private readonly gain: GainNode;
  private params: Record<string, number> = {};
  private bpm = 120;
  private running = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private nextStepTime = 0;
  private currentStep = 0;
  private readonly LOOKAHEAD = 0.15; // schedule this many seconds ahead
  private readonly TICK_MS   = 40;   // check interval

  constructor(ac: AudioContext, gain: GainNode) {
    this.ac   = ac;
    this.gain = gain;
  }

  update(params: Record<string, number>, bpm: number) {
    this.params = params;
    this.bpm    = bpm;
    if (!this.running) {
      this.running       = true;
      this.nextStepTime  = this.ac.currentTime;
      this.currentStep   = 0;
      this.intervalId    = setInterval(() => this.tick(), this.TICK_MS);
    }
  }

  stop() {
    if (this.intervalId !== null) { clearInterval(this.intervalId); this.intervalId = null; }
    this.running = false;
    const now = this.ac.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(1, now);
  }

  private tick() {
    // Guard against tab-backgrounded drift
    const now = this.ac.currentTime;
    if (this.nextStepTime < now - 1.0) { this.nextStepTime = now; this.currentStep = 0; }
    const until = now + this.LOOKAHEAD;
    while (this.nextStepTime < until) {
      this.scheduleStep(this.nextStepTime);
    }
  }

  private scheduleStep(time: number) {
    const steps   = Math.max(1, Math.round(this.params.steps ?? 8));
    const rate    = Math.max(1, this.params.rate ?? 8);
    const stepDur = (60 / this.bpm) * (4 / rate);
    const stepIdx = this.currentStep % steps;

    const isOn = (this.params[`s${stepIdx}`] ?? 1) > 0.5;
    const attack  = Math.max(0.002, Math.min(0.499, this.params.attack  ?? 0.02)) * stepDur;
    const release = Math.max(0.002, Math.min(0.499, this.params.release ?? 0.2))  * stepDur;

    if (isOn) {
      this.gain.gain.setValueAtTime(0, time);
      this.gain.gain.linearRampToValueAtTime(1, time + attack);
      this.gain.gain.setValueAtTime(1, time + stepDur - release);
      this.gain.gain.linearRampToValueAtTime(0, time + stepDur);
    } else {
      this.gain.gain.setValueAtTime(0, time);
    }

    this.currentStep++;
    this.nextStepTime = time + stepDur;
  }
}

/** Expose current scheduler phase (0–1 through pattern) for the UI playhead. */
const tranceGatePhaseRef = new Map<number, { bpm: number; rate: number; steps: number }>();

export function getTranceGatePhase(orbitIndex: number): number {
  const ref = tranceGatePhaseRef.get(orbitIndex);
  if (!ref) return 0;
  const { bpm, rate, steps } = ref;
  const stepDurMs = (60000 / bpm) * (4 / rate);
  const patternMs = stepDurMs * steps;
  return (performance.now() % patternMs) / patternMs;
}

// Schroeder reverb comb filter delay times (seconds)
const COMB_DELAY_TIMES = [0.0297, 0.0371, 0.0411, 0.0437];

interface CombFilter {
  delay: DelayNode;
  feedback: GainNode;
  damp: BiquadFilterNode;
}

// BiquadFilterType lookup for the 6-band param EQ
// Indices: 0=LP  1=HP  2=Bell  3=LS  4=HS  5=Notch
export const EQ_BAND_TYPES: BiquadFilterType[] = [
  'lowpass', 'highpass', 'peaking', 'lowshelf', 'highshelf', 'notch',
];

// Default per-band config for 6-band param EQ
const PARAM_EQ_DEFAULTS: { type: BiquadFilterType; freq: number; q: number }[] = [
  { type: 'highpass',  freq: 30,    q: 0.707 }, // band 1 — HP
  { type: 'lowshelf',  freq: 120,   q: 0.707 }, // band 2 — LS
  { type: 'peaking',   freq: 500,   q: 1.0   }, // band 3 — Bell low-mid
  { type: 'peaking',   freq: 3000,  q: 1.0   }, // band 4 — Bell high-mid
  { type: 'highshelf', freq: 10000, q: 0.707 }, // band 5 — HS
  { type: 'lowpass',   freq: 20000, q: 0.707 }, // band 6 — LP
];

// Tremolo LFO waveform types (index matches UI selector)
const TREMOLO_WAVEFORMS: OscillatorType[] = ['sine', 'triangle', 'square'];

// Ring mod carrier waveform types
const RING_WAVEFORMS: OscillatorType[] = ['sine', 'triangle', 'sawtooth'];

interface OrbitEffectChain {
  // Bypass state — when true, summingNode/synthInputGain route directly to outputNode
  // and the DSP chain is disconnected from the signal path.
  bypassed: boolean;
  _summingNode: AudioNode;   // orbit's summing node (stored for reconnection)
  _outputNode: AudioNode;    // orbit's output node (stored for reconnection)

  // EQ3 (3-band always-on)
  eqLow: BiquadFilterNode;
  eqMid: BiquadFilterNode;
  eqHigh: BiquadFilterNode;
  // Chorus
  chorusDelay: DelayNode;
  chorusDelay2: DelayNode;
  chorusLFO: OscillatorNode;
  chorusLFO2: OscillatorNode;
  chorusLFOGain: GainNode;
  chorusLFOGain2: GainNode;
  chorusDryGain: GainNode;
  chorusWetGain: GainNode;
  chorusMix: GainNode;
  // Phaser
  phaserAllpass: BiquadFilterNode[];
  phaserLFO: OscillatorNode;
  phaserLFOGain: GainNode;
  phaserFeedback: GainNode;
  phaserDryGain: GainNode;
  phaserWetGain: GainNode;
  phaserMix: GainNode;
  // Filter
  filterNode: BiquadFilterNode;
  filterLFO: OscillatorNode;
  filterLFOGain: GainNode;
  filterDryGain: GainNode;
  filterWetGain: GainNode;
  filterMix: GainNode;
  // Distortion (WaveShaperNode, 4 types)
  distortPreGain: GainNode;
  distortWaveshaper: WaveShaperNode;
  distortPostGain: GainNode;
  distortTone: BiquadFilterNode;
  distortDryGain: GainNode;
  distortWetGain: GainNode;
  distortMix: GainNode;
  // Reverb (Schroeder: 4 combs + 2 allpass)
  reverbPreDelay: DelayNode;
  reverbCombs: CombFilter[];
  reverbAllpass: BiquadFilterNode[];
  reverbDryGain: GainNode;
  reverbWetGain: GainNode;
  reverbMix: GainNode;
  // Delay (feedback delay with hi-cut in feedback path)
  delayNode: DelayNode;
  delayFeedback: GainNode;
  delayHighCut: BiquadFilterNode;
  delayDryGain: GainNode;
  delayWetGain: GainNode;
  delayMix: GainNode;
  // Delay — Tape wow/flutter LFO
  delayModLFO: OscillatorNode;
  delayModLFOGain: GainNode;
  // Delay — Lo-Fi saturation in feedback path
  delaySaturation: WaveShaperNode;
  // Delay — Multi-Tap
  delayTap2: DelayNode;
  delayTap3: DelayNode;
  delayTap2Gain: GainNode;
  delayTap3Gain: GainNode;
  // BitCrusher — AudioWorkletNode (SR) + WaveShaperNode (bit depth)
  bcSR: AudioWorkletNode | GainNode;   // GainNode fallback if worklet not loaded
  bcBits: WaveShaperNode;
  bcDryGain: GainNode;
  bcWetGain: GainNode;
  bcMix: GainNode;
  // Parametric EQ — 6 bands in series with dry/wet bypass
  eqBands: BiquadFilterNode[];         // 6 elements
  eqBandsDryGain: GainNode;
  eqBandsWetGain: GainNode;
  eqBandsMix: GainNode;
  // Tremolo — LFO modulates amplitude gain (always in chain, depth=0 = transparent)
  tremoloLFO: OscillatorNode;
  tremoloLFOGain: GainNode;
  tremoloAmpGain: GainNode;
  // Ring Mod — carrier OSC modulates gain (true ring mod, not AM)
  ringCarrier: OscillatorNode;
  ringModGain: GainNode;
  ringDryGain: GainNode;
  ringWetGain: GainNode;
  ringMix: GainNode;
  // Compressor — DynamicsCompressorNode at chain tail
  compressor: DynamicsCompressorNode;
  compressorMakeup: GainNode;
  // Trance Gate — rhythmic gate via scheduled GainNode automation
  tranceGateScheduler: TranceGateScheduler;
  tranceGateGain: GainNode;
  tranceDryGain: GainNode;
  tranceWetGain: GainNode;
  tranceMix: GainNode;
  // Ping Pong Delay — stereo alternating delay
  ppDelay1: DelayNode;
  ppDelay2: DelayNode;
  ppFeedGain: GainNode;
  ppHiCut: BiquadFilterNode;
  ppPanL: StereoPannerNode;
  ppPanR: StereoPannerNode;
  ppWetGain: GainNode;
  ppDryGain: GainNode;
  ppMix: GainNode;
  // Drum Buss — parallel saturation + compression with low boost
  dbDry: GainNode; dbWet: GainNode; dbMix: GainNode;
  dbPreGain: GainNode; dbSaturator: WaveShaperNode;
  dbLowShelf: BiquadFilterNode; dbCompressor: DynamicsCompressorNode; dbOutput: GainNode;
  // Stereo Image — M/S width via ChannelSplitter/Merger matrix
  siSplitter: ChannelSplitterNode; siMerger: ChannelMergerNode;
  siDL: GainNode; siDR: GainNode;        // direct L→L, R→R
  siCL: GainNode; siCR: GainNode;        // cross  L→R, R→L (after HPF)
  siBassHPL: BiquadFilterNode; siBassHPR: BiquadFilterNode;
  siDry: GainNode; siWet: GainNode; siMix: GainNode;
  // Limiter — brick-wall peak limiter at chain end
  limiterComp: DynamicsCompressorNode; limiterMakeup: GainNode;
  limiterDry: GainNode; limiterWet: GainNode; limiterMix: GainNode;

  synthInputGain: GainNode;
  intercepted: boolean;
  // Curve-cache sentinels — avoid rebuilding WaveShaper curves when params unchanged.
  _prevDistortType: number;
  _prevDistortDrive: number;
  _prevBcBits: number;
  _prevDbDrive: number;
}

const chains = new Map<number, OrbitEffectChain>();
const orbitAnalysers = new Map<number, AnalyserNode>();

// Standalone synthInputGain nodes for orbits that have no effect chain yet.
// These connect directly to the orbit's outputNode until effects are enabled.
const _standaloneSynthInputs = new Map<number, GainNode>();

export function getOrbitAnalyser(orbitIndex: number): AnalyserNode | null {
  if (orbitAnalysers.has(orbitIndex)) return orbitAnalysers.get(orbitIndex)!;
  if (!isAudioReady()) return null;
  try {
    const orbit = getSuperdoughAudioController().getOrbit(orbitIndex);
    const outputNode = orbit.output as unknown as AudioNode;
    const ac = outputNode.context as AudioContext;
    const analyser = ac.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;
    outputNode.connect(analyser); // side-tap leaf node — never connected to destination
    orbitAnalysers.set(orbitIndex, analyser);
    return analyser;
  } catch {
    return null;
  }
}

/** Drop all cached analysers. Call when orbit output nodes are destroyed (e.g. on
 *  transport stop) so the next getOrbitAnalyser() re-taps the freshly recreated
 *  orbit output instead of a silent orphaned node. */
export function clearOrbitAnalysers(): void {
  for (const a of orbitAnalysers.values()) {
    try { a.disconnect(); } catch { /* ignore */ }
  }
  orbitAnalysers.clear();
}

/**
 * Build a WaveShaperNode curve that quantizes to 2^bits discrete steps.
 * At bits=16, the curve is effectively linear (full resolution).
 */
function makeBitCrushCurve(bits: number): Float32Array {
  const n = Math.max(1, Math.min(16, Math.round(bits)));
  const steps = Math.pow(2, n - 1);
  const N = 4096;
  const curve = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = (i * 2 / (N - 1)) - 1; // −1 to +1
    curve[i] = Math.round(x * steps) / steps;
  }
  return curve;
}

/**
 * Build a WaveShaperNode curve for the given distortion type and drive amount.
 * type: 0=soft clip, 1=hard clip, 2=tube (asymmetric), 3=fuzz
 * drive: 0–1
 */
function makeDistortionCurve(type: number, drive: number): Float32Array {
  const N = 512;
  const curve = new Float32Array(N);
  const d = Math.max(0, Math.min(1, drive));

  for (let i = 0; i < N; i++) {
    const x = (i * 2 / (N - 1)) - 1;
    let y: number;

    switch (type) {
      case 0: { // Soft clip — warm symmetric tanh overdrive
        const k = 1 + d * 50;
        y = Math.tanh(x * k) / Math.tanh(k);
        break;
      }
      case 1: { // Hard clip — sharp transistor/diode clipping
        const k = 1 + d * 100;
        y = Math.max(-1, Math.min(1, x * k));
        break;
      }
      case 2: { // Tube — asymmetric even-harmonic saturation (class A amp)
        const k = 1 + d * 25;
        const kx = x * k;
        y = kx >= 0
          ? 1 - Math.exp(-kx)
          : -(1 - Math.exp(kx * 0.8));
        y = Math.max(-1, Math.min(1, y));
        break;
      }
      case 3: { // Fuzz — extreme near-square-wave saturation
        const k = 1 + d * 200;
        const kx = x * k;
        y = Math.sign(kx) * (1 - Math.exp(-Math.abs(kx)));
        y = Math.max(-1, Math.min(1, y));
        break;
      }
      default:
        y = x;
    }

    curve[i] = d < 0.001 ? x : y;
  }

  return curve;
}

function createChain(ac: AudioContext): OrbitEffectChain {
  // ─── EQ3 ─────────────────────────────────────────────────────────────────
  const eqLow = ac.createBiquadFilter();
  eqLow.type = 'lowshelf';
  eqLow.frequency.value = 200;
  eqLow.gain.value = 0;

  const eqMid = ac.createBiquadFilter();
  eqMid.type = 'peaking';
  eqMid.frequency.value = 1000;
  eqMid.Q.value = 1;
  eqMid.gain.value = 0;

  const eqHigh = ac.createBiquadFilter();
  eqHigh.type = 'highshelf';
  eqHigh.frequency.value = 4000;
  eqHigh.gain.value = 0;

  // Synth input gain (SynthEngine audio enters here → eqLow)
  const synthInputGain = ac.createGain();
  synthInputGain.gain.value = 1;
  synthInputGain.connect(eqLow);

  eqLow.connect(eqMid);
  eqMid.connect(eqHigh);

  // ─── Drum Buss — parallel saturation + compression + low boost ───────────
  const dbDry = ac.createGain(); dbDry.gain.value = 1;
  const dbWet = ac.createGain(); dbWet.gain.value = 0;
  const dbMix = ac.createGain(); dbMix.gain.value = 1;

  const dbPreGain = ac.createGain(); dbPreGain.gain.value = 1;
  const dbSaturator = ac.createWaveShaper();
  dbSaturator.oversample = '2x';
  dbSaturator.curve = makeDistortionCurve(0, 0.3) as Float32Array<ArrayBuffer>;

  const dbLowShelf = ac.createBiquadFilter();
  dbLowShelf.type = 'lowshelf'; dbLowShelf.frequency.value = 80; dbLowShelf.gain.value = 3;

  const dbCompressor = ac.createDynamicsCompressor();
  dbCompressor.threshold.value = -18; dbCompressor.ratio.value = 2;
  dbCompressor.attack.value = 0.005; dbCompressor.release.value = 0.05; dbCompressor.knee.value = 6;

  const dbOutput = ac.createGain(); dbOutput.gain.value = 1;

  eqHigh.connect(dbDry); dbDry.connect(dbMix);
  eqHigh.connect(dbPreGain);
  dbPreGain.connect(dbSaturator); dbSaturator.connect(dbLowShelf);
  dbLowShelf.connect(dbCompressor); dbCompressor.connect(dbOutput);
  dbOutput.connect(dbWet); dbWet.connect(dbMix);

  // ─── Chorus (2 detuned delay lines for richer doubling) ──────────────────
  const chorusDryGain = ac.createGain();
  chorusDryGain.gain.value = 1;

  const chorusWetGain = ac.createGain();
  chorusWetGain.gain.value = 0;

  const chorusMix = ac.createGain();
  chorusMix.gain.value = 1;

  const chorusDelay = ac.createDelay(0.05);
  chorusDelay.delayTime.value = 0.02;

  const chorusLFO = ac.createOscillator();
  chorusLFO.type = 'sine';
  chorusLFO.frequency.value = 1.5;
  chorusLFO.start();

  const chorusLFOGain = ac.createGain();
  chorusLFOGain.gain.value = 0.005;
  chorusLFO.connect(chorusLFOGain);
  chorusLFOGain.connect(chorusDelay.delayTime);

  const chorusDelay2 = ac.createDelay(0.05);
  chorusDelay2.delayTime.value = 0.028;

  const chorusLFO2 = ac.createOscillator();
  chorusLFO2.type = 'sine';
  chorusLFO2.frequency.value = 1.73;
  chorusLFO2.start();

  const chorusLFOGain2 = ac.createGain();
  chorusLFOGain2.gain.value = 0.005;
  chorusLFO2.connect(chorusLFOGain2);
  chorusLFOGain2.connect(chorusDelay2.delayTime);

  dbMix.connect(chorusDryGain);
  chorusDryGain.connect(chorusMix);
  dbMix.connect(chorusDelay);
  dbMix.connect(chorusDelay2);
  chorusDelay.connect(chorusWetGain);
  chorusDelay2.connect(chorusWetGain);
  chorusWetGain.connect(chorusMix);

  // ─── Phaser (all-pass chain + feedback) ──────────────────────────────────
  const phaserAllpass: BiquadFilterNode[] = [];
  for (let i = 0; i < MAX_PHASER_STAGES; i++) {
    const ap = ac.createBiquadFilter();
    ap.type = 'allpass';
    ap.frequency.value = 1000;
    ap.Q.value = 0.01;
    phaserAllpass.push(ap);
  }
  for (let i = 0; i < MAX_PHASER_STAGES - 1; i++) {
    phaserAllpass[i].connect(phaserAllpass[i + 1]);
  }

  const phaserLFO = ac.createOscillator();
  phaserLFO.type = 'sine';
  phaserLFO.frequency.value = 0.5;
  phaserLFO.start();

  const phaserLFOGain = ac.createGain();
  phaserLFOGain.gain.value = 840;
  phaserLFO.connect(phaserLFOGain);
  for (const stage of phaserAllpass) {
    phaserLFOGain.connect(stage.detune);
  }

  const phaserFeedback = ac.createGain();
  phaserFeedback.gain.value = 0;
  phaserAllpass[MAX_PHASER_STAGES - 1].connect(phaserFeedback);
  phaserFeedback.connect(phaserAllpass[0]);

  const phaserDryGain = ac.createGain();
  phaserDryGain.gain.value = 1;

  const phaserWetGain = ac.createGain();
  phaserWetGain.gain.value = 0;

  const phaserMix = ac.createGain();
  phaserMix.gain.value = 1;

  chorusMix.connect(phaserDryGain);
  phaserDryGain.connect(phaserMix);
  chorusMix.connect(phaserAllpass[0]);
  phaserAllpass[MAX_PHASER_STAGES - 1].connect(phaserWetGain);
  phaserWetGain.connect(phaserMix);

  // ─── Filter (BiquadFilter + LFO on cutoff) ────────────────────────────────
  const filterNode = ac.createBiquadFilter();
  filterNode.type = 'lowpass';
  filterNode.frequency.value = 2000;
  filterNode.Q.value = 1;

  const filterLFO = ac.createOscillator();
  filterLFO.type = 'sine';
  filterLFO.frequency.value = 1;
  filterLFO.start();

  const filterLFOGain = ac.createGain();
  filterLFOGain.gain.value = 0;
  filterLFO.connect(filterLFOGain);
  filterLFOGain.connect(filterNode.detune);

  const filterDryGain = ac.createGain();
  filterDryGain.gain.value = 1;

  const filterWetGain = ac.createGain();
  filterWetGain.gain.value = 0;

  const filterMix = ac.createGain();
  filterMix.gain.value = 1;

  phaserMix.connect(filterDryGain);
  filterDryGain.connect(filterMix);
  phaserMix.connect(filterNode);
  filterNode.connect(filterWetGain);
  filterWetGain.connect(filterMix);

  // ─── Distortion (WaveShaperNode, 4 types) ────────────────────────────────
  const distortPreGain = ac.createGain();
  distortPreGain.gain.value = 1;

  const distortWaveshaper = ac.createWaveShaper();
  distortWaveshaper.oversample = '2x';
  distortWaveshaper.curve = makeDistortionCurve(0, 0) as Float32Array<ArrayBuffer>;

  const distortPostGain = ac.createGain();
  distortPostGain.gain.value = 1;

  const distortTone = ac.createBiquadFilter();
  distortTone.type = 'lowpass';
  distortTone.frequency.value = 8000;

  const distortDryGain = ac.createGain();
  distortDryGain.gain.value = 1;

  const distortWetGain = ac.createGain();
  distortWetGain.gain.value = 0;

  const distortMix = ac.createGain();
  distortMix.gain.value = 1;

  filterMix.connect(distortDryGain);
  distortDryGain.connect(distortMix);
  filterMix.connect(distortPreGain);
  distortPreGain.connect(distortWaveshaper);
  distortWaveshaper.connect(distortPostGain);
  distortPostGain.connect(distortTone);
  distortTone.connect(distortWetGain);
  distortWetGain.connect(distortMix);

  // ─── Reverb (Schroeder: 4 comb filters + 2 allpass) ──────────────────────
  const reverbPreDelay = ac.createDelay(0.2);
  reverbPreDelay.delayTime.value = 0;

  const reverbCombs: CombFilter[] = COMB_DELAY_TIMES.map((t) => {
    const delay = ac.createDelay(2);
    delay.delayTime.value = t;

    const damp = ac.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 8000;

    const feedback = ac.createGain();
    feedback.gain.value = 0.7;

    delay.connect(damp);
    damp.connect(feedback);
    feedback.connect(delay);

    return { delay, feedback, damp };
  });

  const reverbAllpass: BiquadFilterNode[] = [
    ac.createBiquadFilter(),
    ac.createBiquadFilter(),
  ];
  reverbAllpass[0].type = 'allpass';
  reverbAllpass[0].frequency.value = 800;
  reverbAllpass[0].Q.value = 1;
  reverbAllpass[1].type = 'allpass';
  reverbAllpass[1].frequency.value = 200;
  reverbAllpass[1].Q.value = 1;
  reverbAllpass[0].connect(reverbAllpass[1]);

  for (const comb of reverbCombs) {
    reverbPreDelay.connect(comb.delay);
    comb.delay.connect(reverbAllpass[0]);
  }

  const reverbDryGain = ac.createGain();
  reverbDryGain.gain.value = 1;

  const reverbWetGain = ac.createGain();
  reverbWetGain.gain.value = 0;

  const reverbMix = ac.createGain();
  reverbMix.gain.value = 1;

  distortMix.connect(reverbDryGain);
  reverbDryGain.connect(reverbMix);
  distortMix.connect(reverbPreDelay);
  reverbAllpass[1].connect(reverbWetGain);
  reverbWetGain.connect(reverbMix);

  // ─── Delay (feedback delay with hi-cut filter in feedback path) ───────────
  const delayNode = ac.createDelay(2);
  delayNode.delayTime.value = 0.25;

  const delayHighCut = ac.createBiquadFilter();
  delayHighCut.type = 'lowpass';
  delayHighCut.frequency.value = 8000;

  const delayFeedback = ac.createGain();
  delayFeedback.gain.value = 0.4;

  // Lo-Fi saturation in feedback path (identity curve by default)
  const delaySaturation = ac.createWaveShaper();
  delaySaturation.oversample = '2x';
  delaySaturation.curve = new Float32Array([-1, 1]); // linear identity

  // Feedback loop: delayNode → hiCut → saturation → feedback → delayNode
  delayNode.connect(delayHighCut);
  delayHighCut.connect(delaySaturation);
  delaySaturation.connect(delayFeedback);
  delayFeedback.connect(delayNode);

  // Tape wow/flutter LFO modulating delay time
  const delayModLFO = ac.createOscillator();
  delayModLFO.type = 'sine';
  delayModLFO.frequency.value = 0.5;
  const delayModLFOGain = ac.createGain();
  delayModLFOGain.gain.value = 0; // disabled by default
  delayModLFO.connect(delayModLFOGain);
  delayModLFOGain.connect(delayNode.delayTime);
  delayModLFO.start();

  // Multi-Tap: additional taps at fractional time offsets
  const delayTap2 = ac.createDelay(2);
  delayTap2.delayTime.value = 0.1875;
  const delayTap3 = ac.createDelay(2);
  delayTap3.delayTime.value = 0.125;
  const delayTap2Gain = ac.createGain();
  delayTap2Gain.gain.value = 0; // disabled by default
  const delayTap3Gain = ac.createGain();
  delayTap3Gain.gain.value = 0;

  const delayDryGain = ac.createGain();
  delayDryGain.gain.value = 1;

  const delayWetGain = ac.createGain();
  delayWetGain.gain.value = 0;

  const delayMix = ac.createGain();
  delayMix.gain.value = 1;

  reverbMix.connect(delayDryGain);
  delayDryGain.connect(delayMix);
  reverbMix.connect(delayNode);
  delayNode.connect(delayWetGain);
  delayWetGain.connect(delayMix);

  // Multi-tap routing: input → tap delay → tap gain → wet mix
  reverbMix.connect(delayTap2);
  delayTap2.connect(delayTap2Gain);
  delayTap2Gain.connect(delayWetGain);
  reverbMix.connect(delayTap3);
  delayTap3.connect(delayTap3Gain);
  delayTap3Gain.connect(delayWetGain);

  // ─── BitCrusher — AudioWorkletNode (SR) + WaveShaperNode (bit depth) ─────
  // SR reduction via AudioWorklet (sample-and-hold); bit depth via WaveShaper
  let bcSR: AudioWorkletNode | GainNode;
  try {
    bcSR = new AudioWorkletNode(ac, 'bitcrusher-processor');
  } catch {
    // Worklet not loaded yet — use passthrough GainNode as fallback
    bcSR = ac.createGain();
    (bcSR as GainNode).gain.value = 1;
  }

  const bcBits = ac.createWaveShaper();
  bcBits.oversample = 'none'; // staircase must not be smoothed
  bcBits.curve = makeBitCrushCurve(16) as Float32Array<ArrayBuffer>; // default: full resolution (transparent)

  const bcDryGain = ac.createGain();
  bcDryGain.gain.value = 1;

  const bcWetGain = ac.createGain();
  bcWetGain.gain.value = 0;

  const bcMix = ac.createGain();
  bcMix.gain.value = 1;

  delayMix.connect(bcDryGain);
  bcDryGain.connect(bcMix);
  delayMix.connect(bcSR);
  bcSR.connect(bcBits);
  bcBits.connect(bcWetGain);
  bcWetGain.connect(bcMix);

  // ─── Parametric EQ — 6 bands in series with dry/wet bypass ───────────────
  const eqBands = PARAM_EQ_DEFAULTS.map(({ type, freq, q }) => {
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    f.gain.value = 0;
    return f;
  });

  for (let i = 0; i < eqBands.length - 1; i++) {
    eqBands[i].connect(eqBands[i + 1]);
  }

  const eqBandsDryGain = ac.createGain();
  eqBandsDryGain.gain.value = 1;

  const eqBandsWetGain = ac.createGain();
  eqBandsWetGain.gain.value = 0;

  const eqBandsMix = ac.createGain();
  eqBandsMix.gain.value = 1;

  bcMix.connect(eqBandsDryGain);
  eqBandsDryGain.connect(eqBandsMix);
  bcMix.connect(eqBands[0]);
  eqBands[eqBands.length - 1].connect(eqBandsWetGain);
  eqBandsWetGain.connect(eqBandsMix);

  // ─── Tremolo — LFO modulates amplitude gain (always in path) ─────────────
  // gain.value = DC offset; LFOGain output adds ±depth/2 on top.
  // Result: gain oscillates between (1−depth) and 1.0
  const tremoloAmpGain = ac.createGain();
  tremoloAmpGain.gain.value = 1; // default: transparent

  const tremoloLFO = ac.createOscillator();
  tremoloLFO.type = 'sine';
  tremoloLFO.frequency.value = 4;
  tremoloLFO.start();

  const tremoloLFOGain = ac.createGain();
  tremoloLFOGain.gain.value = 0; // disabled by default (depth=0)
  tremoloLFO.connect(tremoloLFOGain);
  tremoloLFOGain.connect(tremoloAmpGain.gain);

  eqBandsMix.connect(tremoloAmpGain);

  // ─── Ring Mod — carrier OSC on gain input (true ring mod, not AM) ─────────
  // ringModGain.gain.value = 0; carrier provides ±1 → signal × carrier
  const ringCarrier = ac.createOscillator();
  ringCarrier.type = 'sine';
  ringCarrier.frequency.value = 440;
  ringCarrier.start();

  const ringModGain = ac.createGain();
  ringModGain.gain.value = 0; // carrier drives the gain; base = 0
  ringCarrier.connect(ringModGain.gain);

  const ringDryGain = ac.createGain();
  ringDryGain.gain.value = 1;

  const ringWetGain = ac.createGain();
  ringWetGain.gain.value = 0;

  const ringMix = ac.createGain();
  ringMix.gain.value = 1;

  tremoloAmpGain.connect(ringDryGain);
  ringDryGain.connect(ringMix);
  tremoloAmpGain.connect(ringModGain);
  ringModGain.connect(ringWetGain);
  ringWetGain.connect(ringMix);

  // ─── Compressor — always in chain at tail ────────────────────────────────
  const compressor = ac.createDynamicsCompressor();
  compressor.threshold.value  = -100; // transparent until enabled
  compressor.ratio.value      = 1;
  compressor.attack.value     = 0.003;
  compressor.release.value    = 0.25;
  compressor.knee.value       = 6;

  const compressorMakeup = ac.createGain();
  compressorMakeup.gain.value = 1;

  ringMix.connect(compressor);
  compressor.connect(compressorMakeup);

  // ─── Stereo Image — M/S width via ChannelSplitter/Merger ─────────────────
  const siSplitter = ac.createChannelSplitter(2);
  const siMerger   = ac.createChannelMerger(2);

  const siDL = ac.createGain(); siDL.channelCount = 1; siDL.channelCountMode = 'explicit'; siDL.gain.value = 1;
  const siDR = ac.createGain(); siDR.channelCount = 1; siDR.channelCountMode = 'explicit'; siDR.gain.value = 1;
  const siCL = ac.createGain(); siCL.channelCount = 1; siCL.channelCountMode = 'explicit'; siCL.gain.value = 0;
  const siCR = ac.createGain(); siCR.channelCount = 1; siCR.channelCountMode = 'explicit'; siCR.gain.value = 0;

  const siBassHPL = ac.createBiquadFilter(); siBassHPL.type = 'highpass'; siBassHPL.frequency.value = 120;
  const siBassHPR = ac.createBiquadFilter(); siBassHPR.type = 'highpass'; siBassHPR.frequency.value = 120;

  const siDry = ac.createGain(); siDry.gain.value = 1;
  const siWet = ac.createGain(); siWet.gain.value = 0;
  const siMix = ac.createGain(); siMix.gain.value = 1;

  compressorMakeup.connect(siDry); siDry.connect(siMix);
  compressorMakeup.connect(siSplitter);
  siSplitter.connect(siDL, 0);                            // L direct
  siSplitter.connect(siDR, 1);                            // R direct
  siSplitter.connect(siBassHPL, 0); siBassHPL.connect(siCL); // L→cross (HP filtered)
  siSplitter.connect(siBassHPR, 1); siBassHPR.connect(siCR); // R→cross (HP filtered)
  siDL.connect(siMerger, 0, 0);  siCR.connect(siMerger, 0, 0);  // L_out = direct-L + cross-R
  siDR.connect(siMerger, 0, 1);  siCL.connect(siMerger, 0, 1);  // R_out = direct-R + cross-L
  siMerger.connect(siWet); siWet.connect(siMix);

  // ─── Trance Gate — rhythmic gate via GainNode automation ─────────────────
  const tranceGateGain = ac.createGain();
  tranceGateGain.gain.value = 1; // transparent until scheduler activates

  const tranceDryGain = ac.createGain();
  tranceDryGain.gain.value = 1;

  const tranceWetGain = ac.createGain();
  tranceWetGain.gain.value = 0;

  const tranceMix = ac.createGain();
  tranceMix.gain.value = 1;

  const tranceGateScheduler = new TranceGateScheduler(ac, tranceGateGain);

  siMix.connect(tranceDryGain);
  tranceDryGain.connect(tranceMix);
  siMix.connect(tranceGateGain);
  tranceGateGain.connect(tranceWetGain);
  tranceWetGain.connect(tranceMix);

  // ─── Ping Pong Delay — stereo alternating delay ───────────────────────────
  const ppDelay1 = ac.createDelay(2);
  ppDelay1.delayTime.value = 0.25;

  const ppDelay2 = ac.createDelay(2);
  ppDelay2.delayTime.value = 0.25;

  const ppFeedGain = ac.createGain();
  ppFeedGain.gain.value = 0;

  const ppHiCut = ac.createBiquadFilter();
  ppHiCut.type = 'lowpass';
  ppHiCut.frequency.value = 8000;

  const ppPanL = ac.createStereoPanner();
  ppPanL.pan.value = -1;

  const ppPanR = ac.createStereoPanner();
  ppPanR.pan.value = 1;

  const ppWetGain = ac.createGain();
  ppWetGain.gain.value = 0;

  const ppDryGain = ac.createGain();
  ppDryGain.gain.value = 1;

  const ppMix = ac.createGain();
  ppMix.gain.value = 1;

  // Signal path: input → delay1 (L) → feedGain → hiCut → delay2 (R) → feedGain2 → delay1 (loop)
  tranceMix.connect(ppDryGain);
  ppDryGain.connect(ppMix);
  tranceMix.connect(ppDelay1);
  ppDelay1.connect(ppPanL);
  ppPanL.connect(ppWetGain);
  ppWetGain.connect(ppMix);
  ppDelay1.connect(ppFeedGain);
  ppFeedGain.connect(ppHiCut);
  ppHiCut.connect(ppDelay2);
  ppDelay2.connect(ppPanR);
  ppPanR.connect(ppWetGain);
  ppDelay2.connect(ppFeedGain); // feedback: delay2 → feedGain → hiCut → delay2 (loop)

  // ─── Limiter — brick-wall peak limiter at chain end ───────────────────────
  const limiterComp = ac.createDynamicsCompressor();
  limiterComp.threshold.value = -0.3; limiterComp.ratio.value = 20;
  limiterComp.knee.value = 3; limiterComp.attack.value = 0.001; limiterComp.release.value = 0.08;

  const limiterMakeup = ac.createGain(); limiterMakeup.gain.value = 1;
  const limiterDry    = ac.createGain(); limiterDry.gain.value    = 1;
  const limiterWet    = ac.createGain(); limiterWet.gain.value    = 0;
  const limiterMix    = ac.createGain(); limiterMix.gain.value    = 1;

  ppMix.connect(limiterDry); limiterDry.connect(limiterMix);
  ppMix.connect(limiterComp); limiterComp.connect(limiterMakeup);
  limiterMakeup.connect(limiterWet); limiterWet.connect(limiterMix);
  // limiterMix → outputNode is wired in ensureIntercepted()

  return {
    synthInputGain,
    eqLow, eqMid, eqHigh,
    chorusDelay, chorusDelay2, chorusLFO, chorusLFO2,
    chorusLFOGain, chorusLFOGain2,
    chorusDryGain, chorusWetGain, chorusMix,
    phaserAllpass, phaserLFO, phaserLFOGain, phaserFeedback,
    phaserDryGain, phaserWetGain, phaserMix,
    filterNode, filterLFO, filterLFOGain,
    filterDryGain, filterWetGain, filterMix,
    distortPreGain, distortWaveshaper, distortPostGain, distortTone,
    distortDryGain, distortWetGain, distortMix,
    reverbPreDelay, reverbCombs, reverbAllpass,
    reverbDryGain, reverbWetGain, reverbMix,
    delayNode, delayFeedback, delayHighCut,
    delayDryGain, delayWetGain, delayMix,
    delayModLFO, delayModLFOGain, delaySaturation,
    delayTap2, delayTap3, delayTap2Gain, delayTap3Gain,
    bcSR, bcBits, bcDryGain, bcWetGain, bcMix,
    eqBands, eqBandsDryGain, eqBandsWetGain, eqBandsMix,
    tremoloLFO, tremoloLFOGain, tremoloAmpGain,
    ringCarrier, ringModGain, ringDryGain, ringWetGain, ringMix,
    compressor, compressorMakeup,
    siSplitter, siMerger, siDL, siDR, siCL, siCR, siBassHPL, siBassHPR, siDry, siWet, siMix,
    tranceGateScheduler, tranceGateGain, tranceDryGain, tranceWetGain, tranceMix,
    ppDelay1, ppDelay2, ppFeedGain, ppHiCut, ppPanL, ppPanR, ppWetGain, ppDryGain, ppMix,
    dbDry, dbWet, dbMix, dbPreGain, dbSaturator, dbLowShelf, dbCompressor, dbOutput,
    limiterComp, limiterMakeup, limiterDry, limiterWet, limiterMix,
    intercepted: false,
    bypassed: false,
    _summingNode: null! as AudioNode,   // set in ensureIntercepted
    _outputNode: null! as AudioNode,    // set in ensureIntercepted
    _prevDistortType: -1,
    _prevDistortDrive: -1,
    _prevBcBits: -1,
    _prevDbDrive: -1,
  };
}

function ensureIntercepted(orbitIndex: number): OrbitEffectChain {
  if (!chains.has(orbitIndex)) {
    // Defer chain creation until we have the orbit's actual context —
    // superdough may have created orbit nodes on a context that differs
    // from getAudioContext() if setAudioContext() was called after init.
    const controller = getSuperdoughAudioController();
    const orbit = controller.getOrbit(orbitIndex);
    const summingNode = orbit.summingNode as unknown as AudioNode;
    const outputNode = orbit.output as unknown as AudioNode;
    const ac = summingNode.context as AudioContext;

    const chain = createChain(ac);
    chain._summingNode = summingNode;
    chain._outputNode = outputNode;
    chains.set(orbitIndex, chain);

    try {
      (summingNode as GainNode).disconnect(outputNode as AudioNode);
    } catch {
      // May not be connected yet or already intercepted
    }

    // Reroute any standalone synthInputGain through the new chain so that
    // already-connected synth engines keep producing sound.
    const standaloneSig = _standaloneSynthInputs.get(orbitIndex);
    if (standaloneSig) {
      try { standaloneSig.disconnect(); } catch { /* ignore */ }
      standaloneSig.connect(chain.synthInputGain);
    }

    summingNode.connect(chain.eqLow);
    chain.synthInputGain.connect(chain.eqLow);
    chain.limiterMix.connect(outputNode);
    chain.intercepted = true;
    log.debug('orbitFx', `Chain created for orbit ${orbitIndex}`);
  }

  return chains.get(orbitIndex)!;
}

/**
 * Bypass the effect chain — disconnect DSP nodes from signal path
 * and route summingNode + synthInputGain directly to outputNode.
 * Uses smooth gain crossfade to avoid clicks.
 */
function bypassChain(chain: OrbitEffectChain): void {
  if (chain.bypassed) return;
  const { _summingNode: sumNode, _outputNode: outNode } = chain;

  // Stop any running schedulers
  chain.tranceGateScheduler.stop();

  // Disconnect chain from signal path
  try { sumNode.disconnect(chain.eqLow); } catch { /* ignore */ }
  try { chain.synthInputGain.disconnect(chain.eqLow); } catch { /* ignore */ }
  try { chain.limiterMix.disconnect(outNode); } catch { /* ignore */ }

  // Route direct: summingNode → outputNode, synthInputGain → outputNode
  sumNode.connect(outNode);
  chain.synthInputGain.connect(outNode);

  chain.bypassed = true;
}

/**
 * Un-bypass the effect chain — reconnect DSP nodes into signal path.
 */
function unbypassChain(chain: OrbitEffectChain): void {
  if (!chain.bypassed) return;
  const { _summingNode: sumNode, _outputNode: outNode } = chain;

  // Disconnect direct paths
  try { sumNode.disconnect(outNode); } catch { /* ignore */ }
  try { chain.synthInputGain.disconnect(outNode); } catch { /* ignore */ }

  // Reconnect through the chain
  sumNode.connect(chain.eqLow);
  chain.synthInputGain.connect(chain.eqLow);
  chain.limiterMix.connect(outNode);

  chain.bypassed = false;
}

const BIQUAD_FILTER_TYPES: BiquadFilterType[] = ['lowpass', 'highpass', 'bandpass', 'notch'];

/**
 * Apply (or bypass) all orbit-chain effects for the given orbit.
 * Must be called before superdough() so the intercept is in place.
 */
export function applyOrbitToneEffects(orbitIndex: number, effects: Effect[], bpm = 120): void {
  // Single O(n) pass — replaces 17 sequential find() calls.
  type EffectMap = Partial<Record<Effect['type'], Effect>>;
  const em: EffectMap = {};
  for (const e of effects) {
    if (e.enabled && !em[e.type]) em[e.type] = e;
  }
  const eq3Effect         = em['eq3'];
  const chorusEffect      = em['chorus'];
  const phaserEffect      = em['phaser'];
  const filterEffect      = em['filter'];
  const distortEffect     = em['distortion'];
  const reverbEffect      = em['reverb'];
  const delayEffect       = em['delay'];
  const bcEffect          = em['bitcrusher'];
  const parameEffect      = em['parame'];
  const tremoloEffect     = em['tremolo'];
  const ringmodEffect     = em['ringmod'];
  const compressorEffect  = em['compressor'];
  const tranceEffect      = em['trancegate'];
  const drumbussEffect    = em['drumbuss'];
  const stereoimageEffect = em['stereoimage'];
  const limiterEffect     = em['limiter'];

  const hasAny = eq3Effect || chorusEffect || phaserEffect || filterEffect
    || distortEffect || reverbEffect || delayEffect || bcEffect
    || parameEffect || tremoloEffect || ringmodEffect || compressorEffect
    || tranceEffect || drumbussEffect || stereoimageEffect || limiterEffect;

  if (!hasAny) {
    // No effects enabled — bypass the chain entirely (or skip creation).
    // This is the single biggest performance win: audio flows directly from
    // summingNode → outputNode instead of through 100+ DSP nodes.
    const chain = chains.get(orbitIndex);
    if (!chain) return; // no chain exists, nothing to do — orbit routes direct by default
    bypassChain(chain);
    tranceGatePhaseRef.delete(orbitIndex);
    return;
  }

  const chain = ensureIntercepted(orbitIndex);

  // If chain was bypassed, reconnect the DSP nodes into the signal path
  if (chain.bypassed) unbypassChain(chain);

  const now   = chain.eqLow.context.currentTime;
  const ramp  = 0.02; // 20 ms smoothing

  // ─── EQ3 ─────────────────────────────────────────────────────────────────
  if (eq3Effect) {
    const p = eq3Effect.params;
    chain.eqLow.frequency.value  = p.lowFreq  ?? 200;
    chain.eqLow.gain.value       = p.low      ?? 0;
    chain.eqMid.frequency.value  = p.midFreq  ?? 1000;
    chain.eqMid.Q.value          = p.midQ     ?? 1;
    chain.eqMid.gain.value       = p.mid      ?? 0;
    chain.eqHigh.frequency.value = p.highFreq ?? 4000;
    chain.eqHigh.gain.value      = p.high     ?? 0;
  } else {
    chain.eqLow.gain.value  = 0;
    chain.eqMid.gain.value  = 0;
    chain.eqHigh.gain.value = 0;
  }

  // ─── Chorus ──────────────────────────────────────────────────────────────
  if (chorusEffect) {
    const p      = chorusEffect.params;
    const amount = p.amount ?? 0.5;
    const spread = p.spread ?? 0.3;

    chain.chorusLFO.frequency.value    = p.rate  ?? 1.5;
    chain.chorusLFOGain.gain.value     = p.depth ?? 0.005;
    chain.chorusDelay.delayTime.value  = p.delay ?? 0.02;
    chain.chorusDelay2.delayTime.value = (p.delay ?? 0.02) + spread * 0.012;
    chain.chorusLFOGain2.gain.value    = (p.depth ?? 0.005) * (1 + spread * 0.5);

    chain.chorusDryGain.gain.value = Math.cos(amount * Math.PI / 2);
    chain.chorusWetGain.gain.value = Math.sin(amount * Math.PI / 2) * 0.5;
  } else {
    chain.chorusWetGain.gain.value = 0;
    chain.chorusDryGain.gain.value = 1;
  }

  // ─── Phaser ──────────────────────────────────────────────────────────────
  if (phaserEffect) {
    const p        = phaserEffect.params;
    const amount   = p.amount   ?? 0.5;
    const stages   = Math.max(2, Math.min(MAX_PHASER_STAGES, Math.round(p.stages ?? 4)));
    const rate     = p.rate     ?? 0.5;
    const baseFreq = p.baseFreq ?? 1000;
    const depth    = p.depth    ?? 0.7;
    const feedback = p.feedback ?? 0;

    chain.phaserLFO.frequency.setTargetAtTime(rate, now, ramp);
    chain.phaserLFOGain.gain.setTargetAtTime(depth * 1200, now, ramp);
    chain.phaserFeedback.gain.setTargetAtTime(Math.min(0.9, feedback), now, ramp);

    for (let i = 0; i < MAX_PHASER_STAGES; i++) {
      chain.phaserAllpass[i].frequency.setTargetAtTime(baseFreq, now, ramp);
      chain.phaserAllpass[i].Q.setTargetAtTime(i < stages ? 5 : 0.01, now, ramp);
    }

    chain.phaserDryGain.gain.setTargetAtTime(Math.cos(amount * Math.PI / 2), now, ramp);
    chain.phaserWetGain.gain.setTargetAtTime(Math.sin(amount * Math.PI / 2), now, ramp);
  } else {
    chain.phaserFeedback.gain.setTargetAtTime(0, now, ramp);
    chain.phaserWetGain.gain.setTargetAtTime(0, now, ramp);
    chain.phaserDryGain.gain.setTargetAtTime(1, now, ramp);
  }

  // ─── Filter ──────────────────────────────────────────────────────────────
  if (filterEffect) {
    const p        = filterEffect.params;
    const amount   = p.amount    ?? 1;
    const typeIdx  = Math.max(0, Math.min(3, Math.round(p.filterType ?? 0)));
    const freq     = p.frequency ?? 2000;
    const q        = p.q        ?? 1;
    const lfoRate  = p.lfoRate  ?? 1;
    const lfoDepth = p.lfoDepth ?? 0;

    chain.filterNode.type = BIQUAD_FILTER_TYPES[typeIdx];
    chain.filterNode.frequency.setTargetAtTime(freq, now, ramp);
    chain.filterNode.Q.setTargetAtTime(q, now, ramp);
    chain.filterLFO.frequency.setTargetAtTime(lfoRate, now, ramp);
    chain.filterLFOGain.gain.setTargetAtTime(lfoDepth * 1200, now, ramp);
    chain.filterDryGain.gain.setTargetAtTime(Math.cos(amount * Math.PI / 2), now, ramp);
    chain.filterWetGain.gain.setTargetAtTime(Math.sin(amount * Math.PI / 2), now, ramp);
  } else {
    chain.filterLFOGain.gain.setTargetAtTime(0, now, ramp);
    chain.filterWetGain.gain.setTargetAtTime(0, now, ramp);
    chain.filterDryGain.gain.setTargetAtTime(1, now, ramp);
  }

  // ─── Distortion ──────────────────────────────────────────────────────────
  if (distortEffect) {
    const p      = distortEffect.params;
    const type   = Math.max(0, Math.min(3, Math.round(p.type   ?? 0)));
    const drive  = p.drive  ?? 0.5;
    const amount = p.amount ?? 1;
    const tone   = p.tone   ?? 8000;
    const output = p.output ?? 0;

    if (type !== chain._prevDistortType || drive !== chain._prevDistortDrive) {
      chain._prevDistortType = type;
      chain._prevDistortDrive = drive;
      chain.distortWaveshaper.curve = makeDistortionCurve(type, drive) as Float32Array<ArrayBuffer>;
    }
    chain.distortTone.frequency.setTargetAtTime(tone, now, ramp);
    chain.distortPostGain.gain.setTargetAtTime(Math.pow(10, output / 20), now, ramp);
    chain.distortDryGain.gain.setTargetAtTime(Math.cos(amount * Math.PI / 2), now, ramp);
    chain.distortWetGain.gain.setTargetAtTime(Math.sin(amount * Math.PI / 2), now, ramp);
  } else {
    chain.distortWetGain.gain.setTargetAtTime(0, now, ramp);
    chain.distortDryGain.gain.setTargetAtTime(1, now, ramp);
  }

  // ─── Reverb ──────────────────────────────────────────────────────────────
  if (reverbEffect) {
    const p        = reverbEffect.params;
    const amount   = p.amount   ?? 0.3;
    const predelay = p.predelay ?? 0;
    const size     = p.size     ?? 0.5;
    const damp     = p.damp     ?? 0.5;

    chain.reverbPreDelay.delayTime.setTargetAtTime(predelay, now, ramp);

    const fbGain   = 0.5 + size * 0.4;
    const dampFreq = 8000 * Math.pow(0.0125, damp);

    for (let i = 0; i < chain.reverbCombs.length; i++) {
      const sizeScale = 0.3 + size * 1.7;
      chain.reverbCombs[i].delay.delayTime.setTargetAtTime(
        COMB_DELAY_TIMES[i] * sizeScale, now, ramp,
      );
      chain.reverbCombs[i].feedback.gain.setTargetAtTime(fbGain, now, ramp);
      chain.reverbCombs[i].damp.frequency.setTargetAtTime(dampFreq, now, ramp);
    }

    chain.reverbDryGain.gain.setTargetAtTime(Math.cos(amount * Math.PI / 2), now, ramp);
    chain.reverbWetGain.gain.setTargetAtTime(Math.sin(amount * Math.PI / 2), now, ramp);
  } else {
    chain.reverbWetGain.gain.setTargetAtTime(0, now, ramp);
    chain.reverbDryGain.gain.setTargetAtTime(1, now, ramp);
  }

  // ─── Delay ───────────────────────────────────────────────────────────────
  if (delayEffect) {
    const p        = delayEffect.params;
    const amount   = p.amount   ?? 0.3;
    let   time     = p.time     ?? 0.25;
    const feedback = p.feedback ?? 0.4;
    const tone     = p.tone     ?? 8000;
    const mode     = Math.round(p.mode    ?? 0);
    const sync     = Math.round(p.sync    ?? 0);
    const syncDiv  = Math.round(p.syncDiv ?? 8);

    // BPM sync: override time with musical subdivision
    if (sync === 1 && bpm > 0) {
      const beatSec = 60 / bpm;
      const div = DELAY_SYNC_DIVS[Math.min(syncDiv, DELAY_SYNC_DIVS.length - 1)];
      time = Math.min(2.0, beatSec * div.mult);
    }

    // Base delay time + feedback
    chain.delayNode.delayTime.setTargetAtTime(time,     now, ramp);
    chain.delayFeedback.gain.setTargetAtTime(feedback,  now, ramp);

    // Mode-specific behavior
    if (mode === 1) {
      // Tape: wow/flutter LFO, mild saturation, reduced hi-cut
      chain.delayModLFOGain.gain.setTargetAtTime(0.0005 + feedback * 0.0003, now, ramp);
      chain.delayModLFO.frequency.setTargetAtTime(0.5, now, ramp);
      chain.delaySaturation.curve = makeDistortionCurve(0, 0.2) as Float32Array<ArrayBuffer>;
      chain.delayHighCut.frequency.setTargetAtTime(Math.min(tone, 12000), now, ramp);
      chain.delayTap2Gain.gain.setTargetAtTime(0, now, ramp);
      chain.delayTap3Gain.gain.setTargetAtTime(0, now, ramp);
    } else if (mode === 2) {
      // Lo-Fi: heavier saturation, lower hi-cut
      chain.delayModLFOGain.gain.setTargetAtTime(0, now, ramp);
      chain.delaySaturation.curve = makeDistortionCurve(0, 0.6) as Float32Array<ArrayBuffer>;
      chain.delayHighCut.frequency.setTargetAtTime(Math.min(tone, 4000), now, ramp);
      chain.delayTap2Gain.gain.setTargetAtTime(0, now, ramp);
      chain.delayTap3Gain.gain.setTargetAtTime(0, now, ramp);
    } else if (mode === 3) {
      // Multi-Tap: taps at 0.75× and 0.5× time
      chain.delayModLFOGain.gain.setTargetAtTime(0, now, ramp);
      chain.delaySaturation.curve = new Float32Array([-1, 1]);
      chain.delayHighCut.frequency.setTargetAtTime(tone, now, ramp);
      chain.delayTap2.delayTime.setTargetAtTime(time * 0.75, now, ramp);
      chain.delayTap3.delayTime.setTargetAtTime(time * 0.5,  now, ramp);
      chain.delayTap2Gain.gain.setTargetAtTime(0.7, now, ramp);
      chain.delayTap3Gain.gain.setTargetAtTime(0.5, now, ramp);
    } else if (mode === 4) {
      // PingPong: make delay chain transparent, route through pp chain
      chain.delayModLFOGain.gain.setTargetAtTime(0, now, ramp);
      chain.delaySaturation.curve = new Float32Array([-1, 1]);
      chain.delayHighCut.frequency.setTargetAtTime(tone, now, ramp);
      chain.delayTap2Gain.gain.setTargetAtTime(0, now, ramp);
      chain.delayTap3Gain.gain.setTargetAtTime(0, now, ramp);

      // Delay chain transparent — ping-pong chain handles audio
      chain.delayDryGain.gain.setTargetAtTime(1, now, ramp);
      chain.delayWetGain.gain.setTargetAtTime(0, now, ramp);

      // Activate pp chain with delay params
      chain.ppDelay1.delayTime.setTargetAtTime(time, now, ramp);
      chain.ppDelay2.delayTime.setTargetAtTime(time, now, ramp);
      chain.ppFeedGain.gain.setTargetAtTime(feedback, now, ramp);
      chain.ppHiCut.frequency.setTargetAtTime(tone, now, ramp);
      chain.ppPanL.pan.setTargetAtTime(-1, now, ramp);
      chain.ppPanR.pan.setTargetAtTime(1, now, ramp);
      chain.ppDryGain.gain.setTargetAtTime(Math.cos(amount * Math.PI / 2), now, ramp);
      chain.ppWetGain.gain.setTargetAtTime(Math.sin(amount * Math.PI / 2), now, ramp);
    } else {
      // Normal: disable all extras
      chain.delayModLFOGain.gain.setTargetAtTime(0, now, ramp);
      chain.delaySaturation.curve = new Float32Array([-1, 1]);
      chain.delayHighCut.frequency.setTargetAtTime(tone, now, ramp);
      chain.delayTap2Gain.gain.setTargetAtTime(0, now, ramp);
      chain.delayTap3Gain.gain.setTargetAtTime(0, now, ramp);
    }

    // Wet/dry crossfade (equal-power) — skip for PingPong (handled above)
    if (mode !== 4) {
      chain.delayDryGain.gain.setTargetAtTime(Math.cos(amount * Math.PI / 2), now, ramp);
      chain.delayWetGain.gain.setTargetAtTime(Math.sin(amount * Math.PI / 2), now, ramp);
    }
  } else {
    chain.delayWetGain.gain.setTargetAtTime(0, now, ramp);
    chain.delayDryGain.gain.setTargetAtTime(1, now, ramp);
    chain.delayModLFOGain.gain.setTargetAtTime(0, now, ramp);
    chain.delayTap2Gain.gain.setTargetAtTime(0, now, ramp);
    chain.delayTap3Gain.gain.setTargetAtTime(0, now, ramp);
  }

  // ─── BitCrusher ──────────────────────────────────────────────────────────
  if (bcEffect) {
    const p          = bcEffect.params;
    const bits       = Math.max(1, Math.min(16, Math.round(p.bits       ?? 16)));
    const downsample = Math.max(0, Math.min(1,               p.downsample ?? 0));
    const amount     = p.amount ?? 1;

    // Update WaveShaper curve for bit depth — only regen when bits changed
    if (bits !== chain._prevBcBits) {
      chain._prevBcBits = bits;
      chain.bcBits.curve = makeBitCrushCurve(bits) as Float32Array<ArrayBuffer>;
    }

    // Update AudioWorklet parameter for SR reduction (if worklet node)
    if (chain.bcSR instanceof AudioWorkletNode) {
      const dsParam = chain.bcSR.parameters.get('downsample');
      if (dsParam) dsParam.setTargetAtTime(downsample, now, ramp);
    }

    chain.bcDryGain.gain.setTargetAtTime(Math.cos(amount * Math.PI / 2), now, ramp);
    chain.bcWetGain.gain.setTargetAtTime(Math.sin(amount * Math.PI / 2), now, ramp);
  } else {
    chain.bcWetGain.gain.setTargetAtTime(0, now, ramp);
    chain.bcDryGain.gain.setTargetAtTime(1, now, ramp);
  }

  // ─── Parametric EQ (6-band) ───────────────────────────────────────────────
  if (parameEffect) {
    const p = parameEffect.params;
    const bandKeys = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];

    for (let i = 0; i < 6; i++) {
      const k    = bandKeys[i];
      const defaultTypeIdx = EQ_BAND_TYPES.indexOf(PARAM_EQ_DEFAULTS[i].type);
      const type = Math.max(0, Math.min(5, Math.round(p[`${k}type`] ?? defaultTypeIdx)));
      const freq = p[`${k}freq`] ?? PARAM_EQ_DEFAULTS[i].freq;
      const gain = p[`${k}gain`] ?? 0;
      const q    = p[`${k}q`]    ?? PARAM_EQ_DEFAULTS[i].q;

      chain.eqBands[i].type = EQ_BAND_TYPES[type] ?? 'peaking';
      chain.eqBands[i].frequency.setTargetAtTime(freq, now, ramp);
      chain.eqBands[i].gain.setTargetAtTime(gain, now, ramp);
      chain.eqBands[i].Q.setTargetAtTime(q, now, ramp);
    }

    chain.eqBandsDryGain.gain.setTargetAtTime(0, now, ramp);
    chain.eqBandsWetGain.gain.setTargetAtTime(1, now, ramp);
  } else {
    chain.eqBandsWetGain.gain.setTargetAtTime(0, now, ramp);
    chain.eqBandsDryGain.gain.setTargetAtTime(1, now, ramp);
  }

  // ─── Tremolo ─────────────────────────────────────────────────────────────
  if (tremoloEffect) {
    const p        = tremoloEffect.params;
    const depth    = Math.max(0, Math.min(1, p.amount   ?? 0.5));
    const rate     = Math.max(0.1, p.rate    ?? 4);
    const waveIdx  = Math.max(0, Math.min(2, Math.round(p.waveform ?? 0)));

    chain.tremoloLFO.type = TREMOLO_WAVEFORMS[waveIdx];
    chain.tremoloLFO.frequency.setTargetAtTime(rate, now, ramp);
    // DC offset: gain oscillates between (1-depth) and 1
    chain.tremoloAmpGain.gain.setTargetAtTime(1 - depth / 2, now, ramp);
    chain.tremoloLFOGain.gain.setTargetAtTime(depth / 2, now, ramp);
  } else {
    chain.tremoloLFOGain.gain.setTargetAtTime(0, now, ramp);
    chain.tremoloAmpGain.gain.setTargetAtTime(1, now, ramp);
  }

  // ─── Ring Mod ─────────────────────────────────────────────────────────────
  if (ringmodEffect) {
    const p        = ringmodEffect.params;
    const freq     = Math.max(1, p.frequency ?? 440);
    const amount   = Math.max(0, Math.min(1, p.amount   ?? 1));
    const waveIdx  = Math.max(0, Math.min(2, Math.round(p.waveform ?? 0)));

    chain.ringCarrier.type = RING_WAVEFORMS[waveIdx];
    chain.ringCarrier.frequency.setTargetAtTime(freq, now, ramp);
    chain.ringDryGain.gain.setTargetAtTime(Math.cos(amount * Math.PI / 2), now, ramp);
    chain.ringWetGain.gain.setTargetAtTime(Math.sin(amount * Math.PI / 2), now, ramp);
  } else {
    chain.ringWetGain.gain.setTargetAtTime(0, now, ramp);
    chain.ringDryGain.gain.setTargetAtTime(1, now, ramp);
  }

  // ─── Compressor ──────────────────────────────────────────────────────────
  if (compressorEffect) {
    const p      = compressorEffect.params;
    const makeup = Math.pow(10, (p.makeupGain ?? 0) / 20);
    chain.compressor.threshold.setTargetAtTime(p.threshold ?? -24,   now, ramp);
    chain.compressor.ratio.setTargetAtTime(    p.ratio     ?? 4,     now, ramp);
    chain.compressor.attack.setTargetAtTime(   p.attack    ?? 0.003, now, ramp);
    chain.compressor.release.setTargetAtTime(  p.release   ?? 0.25,  now, ramp);
    chain.compressor.knee.setTargetAtTime(     p.knee      ?? 6,     now, ramp);
    chain.compressorMakeup.gain.setTargetAtTime(makeup,               now, ramp);
  } else {
    chain.compressor.threshold.setTargetAtTime(-100, now, ramp);
    chain.compressor.ratio.setTargetAtTime(1,        now, ramp);
    chain.compressorMakeup.gain.setTargetAtTime(1,   now, ramp);
  }

  // ─── Trance Gate ─────────────────────────────────────────────────────────
  if (tranceEffect) {
    const p      = tranceEffect.params;
    const amount = Math.max(0, Math.min(1, p.amount ?? 1));
    const steps  = Math.max(1, Math.round(p.steps ?? 8));
    const rate   = Math.max(1, p.rate ?? 8);
    chain.tranceDryGain.gain.setTargetAtTime(Math.cos(amount * Math.PI / 2), now, ramp);
    chain.tranceWetGain.gain.setTargetAtTime(Math.sin(amount * Math.PI / 2), now, ramp);
    chain.tranceGateScheduler.update(p, bpm);
    tranceGatePhaseRef.set(orbitIndex, { bpm, rate, steps });
  } else {
    chain.tranceGateScheduler.stop();
    chain.tranceDryGain.gain.setTargetAtTime(1, now, ramp);
    chain.tranceWetGain.gain.setTargetAtTime(0, now, ramp);
    tranceGatePhaseRef.delete(orbitIndex);
  }

  // ─── Ping Pong chain — controlled by delay mode=4 ────────────────────────
  {
    const delayHandlesPP = delayEffect && Math.round(delayEffect.params.mode ?? 0) === 4;
    if (!delayHandlesPP) {
      chain.ppFeedGain.gain.setTargetAtTime(0, now, ramp);
      chain.ppDryGain.gain.setTargetAtTime(1, now, ramp);
      chain.ppWetGain.gain.setTargetAtTime(0, now, ramp);
    }
  }

  // ─── Drum Buss ───────────────────────────────────────────────────────────
  if (drumbussEffect) {
    const p        = drumbussEffect.params;
    const drive    = Math.max(0, Math.min(1, p.drive    ?? 0.3));
    const low      = p.low      ?? 3;
    const compress = Math.max(1, p.compress ?? 2);
    const mix      = Math.max(0, Math.min(1, p.mix      ?? 0.6));
    const output   = p.output   ?? 0;
    chain.dbPreGain.gain.setTargetAtTime(1 + drive * 9, now, ramp);
    if (drive !== chain._prevDbDrive) {
      chain._prevDbDrive = drive;
      chain.dbSaturator.curve = makeDistortionCurve(0, drive) as Float32Array<ArrayBuffer>;
    }
    chain.dbLowShelf.gain.setTargetAtTime(low, now, ramp);
    chain.dbCompressor.ratio.setTargetAtTime(compress, now, ramp);
    chain.dbOutput.gain.setTargetAtTime(Math.pow(10, output / 20), now, ramp);
    chain.dbDry.gain.setTargetAtTime(1 - mix, now, ramp);
    chain.dbWet.gain.setTargetAtTime(mix, now, ramp);
  } else {
    chain.dbDry.gain.setTargetAtTime(1, now, ramp);
    chain.dbWet.gain.setTargetAtTime(0, now, ramp);
  }

  // ─── Stereo Image ─────────────────────────────────────────────────────────
  if (stereoimageEffect) {
    const p       = stereoimageEffect.params;
    const width   = Math.max(0, Math.min(2, p.width   ?? 1));
    const monoLow = Math.max(20, p.monoLow ?? 120);
    const gD = 0.5 + 0.5 * width;
    const gC = 0.5 - 0.5 * width;
    chain.siDL.gain.setTargetAtTime(gD, now, ramp);
    chain.siDR.gain.setTargetAtTime(gD, now, ramp);
    chain.siCL.gain.setTargetAtTime(gC, now, ramp);
    chain.siCR.gain.setTargetAtTime(gC, now, ramp);
    chain.siBassHPL.frequency.setTargetAtTime(monoLow, now, ramp);
    chain.siBassHPR.frequency.setTargetAtTime(monoLow, now, ramp);
    chain.siDry.gain.setTargetAtTime(0, now, ramp);
    chain.siWet.gain.setTargetAtTime(1, now, ramp);
  } else {
    chain.siDL.gain.setTargetAtTime(1,  now, ramp);
    chain.siDR.gain.setTargetAtTime(1,  now, ramp);
    chain.siCL.gain.setTargetAtTime(0,  now, ramp);
    chain.siCR.gain.setTargetAtTime(0,  now, ramp);
    chain.siDry.gain.setTargetAtTime(1, now, ramp);
    chain.siWet.gain.setTargetAtTime(0, now, ramp);
  }

  // ─── Limiter ─────────────────────────────────────────────────────────────
  if (limiterEffect) {
    const p       = limiterEffect.params;
    const ceiling = Math.max(-12, Math.min(0, p.ceiling ?? -1.0));
    const release = Math.max(0.02, p.release ?? 0.08);
    const makeup  = Math.pow(10, -ceiling / 20); // auto-compensate: -3dB ceiling → +3dB makeup
    chain.limiterComp.threshold.setTargetAtTime(ceiling, now, ramp);
    chain.limiterComp.ratio.setTargetAtTime(20, now, ramp);
    chain.limiterComp.release.setTargetAtTime(release, now, ramp);
    chain.limiterMakeup.gain.setTargetAtTime(makeup, now, ramp);
    chain.limiterDry.gain.setTargetAtTime(0, now, ramp);
    chain.limiterWet.gain.setTargetAtTime(1, now, ramp);
  } else {
    chain.limiterComp.threshold.setTargetAtTime(0,  now, ramp);
    chain.limiterComp.ratio.setTargetAtTime(1,       now, ramp);
    chain.limiterMakeup.gain.setTargetAtTime(1, now, ramp);
    chain.limiterDry.gain.setTargetAtTime(1, now, ramp);
    chain.limiterWet.gain.setTargetAtTime(0, now, ramp);
  }
}

/**
 * Expose the 6 param-EQ BiquadFilterNodes so the UI can compute live
 * frequency response curves via getFrequencyResponse().
 */
export function getParaEQBands(orbitIndex: number): BiquadFilterNode[] | null {
  return chains.get(orbitIndex)?.eqBands ?? null;
}

export function getSynthOrbitInput(orbitIndex: number): GainNode | null {
  // If the full chain exists, use its synthInputGain (works for both bypassed and active)
  const chain = chains.get(orbitIndex);
  if (chain) return chain.synthInputGain;

  // No chain yet — create a lightweight standalone GainNode routed direct to outputNode.
  // This avoids creating the full 100+ node chain just because a synth is playing
  // on an orbit with no effects. The chain will be created later if effects are enabled.
  if (_standaloneSynthInputs.has(orbitIndex)) return _standaloneSynthInputs.get(orbitIndex)!;

  try {
    const controller = getSuperdoughAudioController();
    const orbit = controller.getOrbit(orbitIndex);
    const outputNode = orbit.output as unknown as AudioNode;
    const ac = outputNode.context as AudioContext;

    const sig = ac.createGain();
    sig.gain.value = 1;
    sig.connect(outputNode);
    _standaloneSynthInputs.set(orbitIndex, sig);
    return sig;
  } catch {
    return null;
  }
}

export function getCompressorNode(orbitIndex: number): DynamicsCompressorNode | null {
  return chains.get(orbitIndex)?.compressor ?? null;
}

/** Returns the chain tail (limiterMix) and the orbit's output node for group bus routing. */
export function getOrbitChainTail(orbitIndex: number): { limiterMix: GainNode; outputNode: AudioNode } | null {
  const chain = chains.get(orbitIndex);
  if (!chain || !chain.intercepted) return null;
  try {
    const controller = getSuperdoughAudioController();
    const orbit = controller.getOrbit(orbitIndex);
    const outputNode = orbit.output as unknown as AudioNode;
    return { limiterMix: chain.limiterMix, outputNode };
  } catch {
    return null;
  }
}

/** Clear all standalone synth inputs and effect chains so they are recreated
 *  with fresh orbit nodes on next playback.  Called after silenceAll() destroys
 *  orbit nodes — the old GainNodes point to dead outputs. */
export function invalidateSynthRouting(): void {
  for (const [, sig] of _standaloneSynthInputs) {
    try { sig.disconnect(); } catch { /* ignore */ }
  }
  _standaloneSynthInputs.clear();

  // Also destroy all effect chains — their _summingNode / _outputNode refs are stale.
  for (const idx of [...chains.keys()]) {
    destroyOrbitChain(idx);
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

/** Stop all running oscillators/schedulers and disconnect every node in the chain. */
export function destroyOrbitChain(orbitIndex: number): void {
  const chain = chains.get(orbitIndex);
  if (chain) {
    // Stop all oscillators (they throw if already stopped — swallow)
    const oscs: OscillatorNode[] = [
      chain.chorusLFO, chain.chorusLFO2,
      chain.phaserLFO, chain.filterLFO,
      chain.delayModLFO, chain.tremoloLFO, chain.ringCarrier,
    ];
    for (const osc of oscs) {
      try { osc.stop(); } catch { /* already stopped */ }
      try { osc.disconnect(); } catch { /* ignore */ }
    }

    // Stop trance gate scheduler interval
    chain.tranceGateScheduler.stop();

    // Bulk-disconnect every AudioNode in the chain.
    // Iterating the interface keys is safest — anything that has .disconnect()
    // is an AudioNode (or AudioWorkletNode).
    for (const key of Object.keys(chain) as (keyof OrbitEffectChain)[]) {
      const node = chain[key];
      if (node && typeof (node as AudioNode).disconnect === 'function') {
        try { (node as AudioNode).disconnect(); } catch { /* ignore */ }
      }
      // Handle arrays of nodes (phaserAllpass, eqBands, reverbAllpass)
      if (Array.isArray(node)) {
        for (const item of node) {
          if (item && typeof item === 'object' && 'delay' in item) {
            // CombFilter objects have nested nodes
            const cf = item as CombFilter;
            try { cf.delay.disconnect(); } catch { /* ignore */ }
            try { cf.feedback.disconnect(); } catch { /* ignore */ }
            try { cf.damp.disconnect(); } catch { /* ignore */ }
          } else if (item && typeof (item as AudioNode).disconnect === 'function') {
            try { (item as AudioNode).disconnect(); } catch { /* ignore */ }
          }
        }
      }
    }

    chains.delete(orbitIndex);
    log.debug('orbitFx', `Chain destroyed for orbit ${orbitIndex}`);
  }

  // Clean up analyser side-tap
  const analyser = orbitAnalysers.get(orbitIndex);
  if (analyser) {
    try { analyser.disconnect(); } catch { /* ignore */ }
    orbitAnalysers.delete(orbitIndex);
  }

  // Clean up trance gate phase ref
  tranceGatePhaseRef.delete(orbitIndex);

  // Clean up standalone synth input if any
  const standaloneSig = _standaloneSynthInputs.get(orbitIndex);
  if (standaloneSig) {
    try { standaloneSig.disconnect(); } catch { /* ignore */ }
    _standaloneSynthInputs.delete(orbitIndex);
  }
}

/** Number of active orbit effect chains (for perf monitoring). */
export function getActiveChainCount(): number {
  return chains.size;
}
