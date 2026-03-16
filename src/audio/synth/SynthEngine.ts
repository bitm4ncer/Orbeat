/**
 * Polyphonic SynthEngine — Web Audio API based
 *
 * Signal path (per voice → shared chain → output):
 *   mainOscs[N] ──┐
 *   sub1Osc ───── ┤→ voiceGain (ADSR) ──┐
 *   sub2Osc ───── ┘                      ↓
 *   fmOsc → fmGain → mainOscs[].freq   voiceSumNode
 *                                         ↓
 *                                     filterNode (+ filterEnv + ModulationEngine)
 *                                         ↓
 *                                     distortionNode
 *                                         ↓
 *                                     delayNode
 *                                         ↓
 *                                     reverbNode
 *                                         ↓
 *                                     volumeNode
 *                                         ↓
 *                                     [outputNode] → orbit summingNode → orbit effects chain
 */

import { Delay } from './nodes/Delay';
import { Reverb } from './nodes/Reverb';
import { Distortion } from './nodes/Distortion';
import { BitCrusher } from './nodes/BitCrusher';
import { LadderFilter } from './nodes/LadderFilter';
import { CombFilter } from './nodes/CombFilter';
import { KarplusStrong } from './nodes/KarplusStrong';
import { FMVoice } from './FMVoice';
import { FM_ALGORITHMS } from './fmAlgorithms';
import { SYNTH_PRESETS } from './presets';
import type { SynthParams } from './types';
import { DEFAULT_LFO_SLOT, DEFAULT_FM_PARAMS } from './types';
import { isNativeType, getPeriodicWave } from './wavetables';
import { getInterpolatedPeriodicWave } from './wavetableEngine';
import { ModulationEngine } from './ModulationEngine';
import { midiNoteToFreq } from '../../utils/music';

/** Fill in missing fields for backward-compatible preset loading. */
function ensureDefaults(p: Partial<SynthParams>): SynthParams {
  if (p.wtPosition === undefined) p.wtPosition = 0;
  if (p.wtWarpMode === undefined) p.wtWarpMode = 0;
  if (p.wtWarpAmount === undefined) p.wtWarpAmount = 0;
  if (p.distortionType === undefined) p.distortionType = 0;
  if (p.unisonDrift === undefined) p.unisonDrift = 0;
  if (p.portamentoCurve === undefined) p.portamentoCurve = 'exp';
  if (p.portamentoLegato === undefined) p.portamentoLegato = false;
  if (p.ringModEnabled === undefined) p.ringModEnabled = false;
  if (p.ringModMix === undefined) p.ringModMix = 0.5;
  if (p.stringDamping === undefined) p.stringDamping = 4000;
  if (p.stringDecay === undefined) p.stringDecay = 0.995;
  if (!p.lfos) {
    p.lfos = [
      { ...DEFAULT_LFO_SLOT, rate: p.lfo1Rate ?? 4, shape: (p.lfo1Shape as OscillatorType) ?? 'sine' },
      { ...DEFAULT_LFO_SLOT, enabled: false, rate: p.lfo2Rate ?? 0.5, shape: (p.lfo2Shape as OscillatorType) ?? 'sine' },
      { ...DEFAULT_LFO_SLOT, enabled: false },
      { ...DEFAULT_LFO_SLOT, enabled: false },
    ];
  }
  // Ensure LFO slots have new fields
  for (const lfo of p.lfos) {
    if (lfo.enabled === undefined) (lfo as Record<string, unknown>).enabled = true;
    if (lfo.mode === undefined) (lfo as Record<string, unknown>).mode = 'lfo';
    if (!lfo.steps) (lfo as Record<string, unknown>).steps = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  }
  if (!p.modAssignments) {
    p.modAssignments = [];
    // Migrate old LFO destinations to mod assignments
    if (p.lfo1Dest && p.lfo1Dest !== 'none' && (p.lfo1Depth ?? 0) > 0) {
      const target = p.lfo1Dest === 'filter' ? 'filterFreq' : 'vcoDetune';
      p.modAssignments.push({ id: 'legacy_lfo1', source: 'lfo1', target: target as keyof SynthParams, depth: (p.lfo1Depth ?? 0) / 1000 });
    }
    if (p.lfo2Dest && p.lfo2Dest !== 'none' && (p.lfo2Depth ?? 0) > 0) {
      const target = p.lfo2Dest === 'filter' ? 'filterFreq' : 'vcoDetune';
      p.modAssignments.push({ id: 'legacy_lfo2', source: 'lfo2', target: target as keyof SynthParams, depth: (p.lfo2Depth ?? 0) / 1000 });
    }
  }
  if (!p.synthMode) p.synthMode = 'osc';
  if (!p.fm) p.fm = { ...DEFAULT_FM_PARAMS, operators: [...DEFAULT_FM_PARAMS.operators.map(o => ({ ...o }))] as [typeof DEFAULT_FM_PARAMS.operators[0], typeof DEFAULT_FM_PARAMS.operators[0], typeof DEFAULT_FM_PARAMS.operators[0], typeof DEFAULT_FM_PARAMS.operators[0]] };
  return p as SynthParams;
}

const MAX_VOICES = 8;
const MAX_UNISON = 7;

// ─────────────────────────────────────────────────────────────────────────────
// PolyVoice: one polyphonic slot
// ─────────────────────────────────────────────────────────────────────────────

class PolyVoice {
  ac: AudioContext;
  mainOscs: OscillatorNode[];    // [MAX_UNISON] carrier oscillators
  mainGains: GainNode[];         // unison gain + mute unused
  mainPanners: StereoPannerNode[]; // unison stereo spread
  sub1Osc: OscillatorNode;
  sub1Gain: GainNode;
  sub2Osc: OscillatorNode;
  sub2Gain: GainNode;
  fmOsc: OscillatorNode;         // FM modulator (legacy simple FM)
  fmGain: GainNode;              // FM depth → carrier.frequency (legacy)
  fmVoice: FMVoice;              // 4-operator FM voice
  voiceGain: GainNode;           // ADSR envelope
  // Ring modulation: sub1 × main
  ringModGain: GainNode;         // main osc passes through; sub1 connects to .gain
  ringModWetGain: GainNode;      // wet mix for ring mod output
  ringModActive = false;
  // String oscillator (Karplus-Strong)
  stringOsc: KarplusStrong;
  // Drift: per-unison-voice slow LFOs for analog wander
  driftOscs: OscillatorNode[];
  driftGains: GainNode[];
  triggeredAt = 0;
  releaseEnd = 0;                // approx time voice becomes silent
  currentMidiNote: number | null = null; // track which note this voice is playing

  constructor(ac: AudioContext, destination: GainNode) {
    this.ac = ac;

    this.voiceGain = ac.createGain();
    this.voiceGain.gain.value = 0;
    this.voiceGain.connect(destination);

    // Main oscillators (unison pool)
    this.mainOscs = [];
    this.mainGains = [];
    this.mainPanners = [];
    for (let i = 0; i < MAX_UNISON; i++) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      const panner = ac.createStereoPanner();
      osc.connect(gain);
      gain.connect(panner);
      panner.connect(this.voiceGain);
      osc.start();
      this.mainOscs.push(osc);
      this.mainGains.push(gain);
      this.mainPanners.push(panner);
    }

    // Drift oscillators (slow LFOs for analog pitch wander per unison voice)
    this.driftOscs = [];
    this.driftGains = [];
    for (let i = 0; i < MAX_UNISON; i++) {
      const driftOsc = ac.createOscillator();
      const driftGain = ac.createGain();
      // Random rate between 0.1–0.4Hz per voice for independent wander
      driftOsc.frequency.value = 0.1 + Math.random() * 0.3;
      driftGain.gain.value = 0; // starts off — enabled via setDrift()
      driftOsc.connect(driftGain);
      driftGain.connect(this.mainOscs[i].detune);
      driftOsc.start();
      this.driftOscs.push(driftOsc);
      this.driftGains.push(driftGain);
    }

    // String oscillator (Karplus-Strong) — connected to voiceGain, muted when not in string mode
    this.stringOsc = new KarplusStrong(ac);
    this.stringOsc.connect(this.voiceGain);

    // Ring modulation node (main osc → ringModGain, sub1 → ringModGain.gain = multiplication)
    this.ringModGain = ac.createGain();
    this.ringModGain.gain.value = 0; // sub1 will drive this via AudioParam connection
    this.ringModWetGain = ac.createGain();
    this.ringModWetGain.gain.value = 0; // ring mod off by default
    this.ringModGain.connect(this.ringModWetGain);
    this.ringModWetGain.connect(this.voiceGain);

    // Sub oscillators
    this.sub1Osc = ac.createOscillator();
    this.sub1Gain = ac.createGain();
    this.sub1Osc.connect(this.sub1Gain);
    this.sub1Gain.connect(this.voiceGain);
    this.sub1Osc.start();

    this.sub2Osc = ac.createOscillator();
    this.sub2Gain = ac.createGain();
    this.sub2Osc.connect(this.sub2Gain);
    this.sub2Gain.connect(this.voiceGain);
    this.sub2Osc.start();

    // FM modulator
    this.fmOsc = ac.createOscillator();
    this.fmGain = ac.createGain();
    this.fmOsc.connect(this.fmGain);
    this.fmOsc.start();
    // fmGain → carrier freq: connected dynamically by setFrequencies
    this.fmGain.gain.value = 0;
    // Connect fmGain to all main oscillator frequency params
    for (const osc of this.mainOscs) {
      this.fmGain.connect(osc.frequency);
    }

    // 4-operator FM voice — output goes through voiceGain (shared ADSR + filter chain)
    this.fmVoice = new FMVoice(ac);
    this.fmVoice.getOutput().connect(this.voiceGain);
  }

  /** Enable/disable ring modulation (sub1 × main oscillators) */
  setRingMod(enabled: boolean, mix: number): void {
    const now = this.ac.currentTime;
    if (enabled && !this.ringModActive) {
      // Wire: main oscs also connect to ringModGain, sub1 connects to ringModGain.gain
      for (const panner of this.mainPanners) {
        panner.connect(this.ringModGain);
      }
      this.sub1Osc.connect(this.ringModGain.gain);
      this.ringModActive = true;
    } else if (!enabled && this.ringModActive) {
      // Unwire ring mod
      for (const panner of this.mainPanners) {
        try { panner.disconnect(this.ringModGain); } catch { /* ignore */ }
      }
      try { this.sub1Osc.disconnect(this.ringModGain.gain); } catch { /* ignore */ }
      this.ringModActive = false;
    }
    this.ringModWetGain.gain.setTargetAtTime(enabled ? mix : 0, now, 0.02);
  }

  /** Update drift amount (0 = off, 1 = max ~15 cents wander) */
  setDrift(amount: number): void {
    const maxCents = 15;
    for (const g of this.driftGains) {
      g.gain.setTargetAtTime(amount * maxCents, this.ac.currentTime, 0.02);
    }
  }

  /** Stop all oscillators and disconnect all nodes in this voice. */
  dispose(): void {
    for (const osc of this.mainOscs) {
      try { osc.stop(); } catch { /* already stopped */ }
      try { osc.disconnect(); } catch { /* ignore */ }
    }
    for (const g of this.mainGains) { try { g.disconnect(); } catch { /* ignore */ } }
    for (const p of this.mainPanners) { try { p.disconnect(); } catch { /* ignore */ } }
    for (const osc of this.driftOscs) { try { osc.stop(); } catch { /* ignore */ } try { osc.disconnect(); } catch { /* ignore */ } }
    for (const g of this.driftGains) { try { g.disconnect(); } catch { /* ignore */ } }
    try { this.ringModGain.disconnect(); } catch { /* ignore */ }
    try { this.ringModWetGain.disconnect(); } catch { /* ignore */ }
    this.stringOsc.dispose();
    try { this.sub1Osc.stop(); } catch { /* already stopped */ }
    try { this.sub1Osc.disconnect(); } catch { /* ignore */ }
    try { this.sub1Gain.disconnect(); } catch { /* ignore */ }
    try { this.sub2Osc.stop(); } catch { /* already stopped */ }
    try { this.sub2Osc.disconnect(); } catch { /* ignore */ }
    try { this.sub2Gain.disconnect(); } catch { /* ignore */ }
    try { this.fmOsc.stop(); } catch { /* already stopped */ }
    try { this.fmOsc.disconnect(); } catch { /* ignore */ }
    try { this.fmGain.disconnect(); } catch { /* ignore */ }
    this.fmVoice.dispose();
    try { this.voiceGain.disconnect(); } catch { /* ignore */ }
  }

  /** Schedule ADSR envelope and set frequencies. Called from noteOn. */
  trigger(
    midiNote: number,
    audioTime: number,
    duration: number,
    p: SynthParams,
    gainScale = 1,
    skipGlide = false,
  ): void {
    const now = Math.max(audioTime, this.ac.currentTime + 0.001);
    const attack = Math.max(Number.isFinite(p.gainAttack) ? p.gainAttack : 0.001, 0.001);
    const decay = Math.max(Number.isFinite(p.gainDecay) ? p.gainDecay : 0.1, 0.001);
    const sustain = Math.max(0, Math.min(1, Number.isFinite(p.gainSustain) ? p.gainSustain : 0.7));
    const release = Math.max(Number.isFinite(p.gainRelease) ? p.gainRelease : 0.15, 0.02);
    const attackEnd = now + attack;
    const releaseStart = Math.max(now + duration, attackEnd + 0.001);
    this.triggeredAt = audioTime;
    this.releaseEnd = releaseStart + release * 5;
    this.currentMidiNote = midiNote; // track which note this voice is playing

    // Schedule ADSR (gainScale allows per-note volume from instrument dB)
    const mv = Number.isFinite(p.masterVolume) ? p.masterVolume : 0.75;
    const peak = mv * Math.max(0, gainScale);
    const g = this.voiceGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    g.linearRampToValueAtTime(peak, attackEnd);
    g.setTargetAtTime(sustain * peak, attackEnd, decay / 5);
    g.setTargetAtTime(0, releaseStart, release / 5);

    // Set frequencies with portamento (or trigger FM voice)
    if (p.synthMode === 'fm' && p.fm?.enabled) {
      // FM mode: mute subtractive oscillators, trigger FM operators
      for (let i = 0; i < MAX_UNISON; i++) {
        this.mainGains[i].gain.setValueAtTime(0, now);
      }
      this.sub1Gain.gain.setValueAtTime(0, now);
      this.sub2Gain.gain.setValueAtTime(0, now);
      this.fmGain.gain.setValueAtTime(0, now);
      this.fmVoice.trigger(midiNote, now, duration, p.fm);
    } else {
      // OSC mode: mute FM voice, use subtractive oscillators
      this.fmVoice.silence(now);
      this.setFrequencies(midiNote, p, now, skipGlide);
    }

    // Filter envelope
    this.triggerFilterEnv(p, now, attackEnd);
  }

  setFrequencies(midiNote: number, p: SynthParams, when: number, skipGlide = false): void {
    const freq = midiNoteToFreq(midiNote + Math.round(p.vcoOctave ?? 0) * 12);
    const glideTime = (!skipGlide && p.portamentoSpeed > 0) ? p.portamentoSpeed : 0;
    const isString = p.vcoType === 'string';

    // String oscillator mode
    if (isString) {
      this.stringOsc.setDamping(p.stringDamping ?? 4000);
      this.stringOsc.setDecay(p.stringDecay ?? 0.995);
      this.stringOsc.trigger(freq, when);
      // Mute all main oscillators
      for (let i = 0; i < MAX_UNISON; i++) {
        this.mainGains[i].gain.setValueAtTime(0, when);
      }
    }

    // Unison main oscillators
    const numUnison = Math.max(1, Math.round(p.unisonVoices));
    const detuneSpread = p.unisonDetune; // total spread in cents
    const spreadWidth = p.unisonSpread;

    for (let i = 0; i < MAX_UNISON; i++) {
      if (i < numUnison) {
        // Detune: spread voices symmetrically
        const t = numUnison === 1 ? 0 : (i / (numUnison - 1)) * 2 - 1; // -1 to +1
        const detuneCents = t * detuneSpread * 0.5 + p.vcoDetune;
        const panVal = t * spreadWidth;

        if (p.vcoType.startsWith('wt:')) {
          const bankId = p.vcoType.slice(3);
          const wave = getInterpolatedPeriodicWave(this.ac, bankId, p.wtPosition ?? 0, p.wtWarpMode ?? 0, p.wtWarpAmount ?? 0);
          if (wave) this.mainOscs[i].setPeriodicWave(wave);
        } else if (isNativeType(p.vcoType)) {
          this.mainOscs[i].type = p.vcoType;
        } else {
          const wave = getPeriodicWave(this.ac, p.vcoType);
          if (wave) this.mainOscs[i].setPeriodicWave(wave);
        }
        this.mainOscs[i].detune.cancelScheduledValues(when);
        this.mainOscs[i].detune.setValueAtTime(detuneCents, when);

        this.mainOscs[i].frequency.cancelScheduledValues(when);
        if (glideTime > 0) {
          const curve = p.portamentoCurve ?? 'exp';
          if (curve === 'lin') {
            this.mainOscs[i].frequency.linearRampToValueAtTime(freq, when + glideTime * 3);
          } else if (curve === 'log') {
            this.mainOscs[i].frequency.exponentialRampToValueAtTime(Math.max(freq, 0.01), when + glideTime * 3);
          } else {
            this.mainOscs[i].frequency.setTargetAtTime(freq, when, glideTime);
          }
        } else {
          this.mainOscs[i].frequency.setValueAtTime(freq, when);
        }

        this.mainGains[i].gain.setValueAtTime(p.vcoGain / numUnison, when);
        this.mainPanners[i].pan.setValueAtTime(panVal, when);
      } else {
        this.mainGains[i].gain.setValueAtTime(0, when);
      }
    }

    // Sub 1
    const sub1Freq = midiNoteToFreq(midiNote + p.sub1Offset);
    this.sub1Osc.type = p.sub1Type;
    this.sub1Osc.frequency.cancelScheduledValues(when);
    this.sub1Osc.frequency.setValueAtTime(sub1Freq, when);
    this.sub1Gain.gain.setValueAtTime(p.sub1Gain, when);

    // Sub 2
    const sub2Freq = midiNoteToFreq(midiNote + p.sub2Offset);
    this.sub2Osc.type = p.sub2Type;
    this.sub2Osc.frequency.cancelScheduledValues(when);
    this.sub2Osc.frequency.setValueAtTime(sub2Freq, when);
    this.sub2Gain.gain.setValueAtTime(p.sub2Gain, when);

    // FM modulator
    if (p.fmEnabled && p.fmDepth > 0) {
      const fmFreq = freq * Math.max(0.01, p.fmRatio);
      this.fmOsc.frequency.cancelScheduledValues(when);
      this.fmOsc.frequency.setValueAtTime(fmFreq, when);
      this.fmGain.gain.setValueAtTime(p.fmDepth, when);
    } else {
      this.fmGain.gain.setValueAtTime(0, when);
    }
  }

  triggerFilterEnv(p: SynthParams, now: number, attackEnd: number): void {
    // Filter envelope is applied to a separate filterEnvGain node (handled in SynthEngine)
    // Pass-through — SynthEngine will call scheduleFilterEnv directly
    void p; void now; void attackEnd;
  }

  isIdle(currentTime: number): boolean {
    return this.voiceGain.gain.value < 0.001 && currentTime >= this.releaseEnd;
  }

  silence(when: number): void {
    this.voiceGain.gain.cancelScheduledValues(when);
    this.voiceGain.gain.setTargetAtTime(0, when, 0.01);
    this.fmVoice.silence(when);
    this.releaseEnd = when + 0.05;
    this.currentMidiNote = null; // clear note tracking on silence
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SynthEngine
// ─────────────────────────────────────────────────────────────────────────────

export class SynthEngine {
  private ac: AudioContext;
  private params: SynthParams;
  private initialized = false;

  // Shared signal chain nodes
  private voiceSumNode: GainNode;        // all voices merge here
  private filterNode: BiquadFilterNode;
  private ladderFilter: LadderFilter;
  private combFilterPos: CombFilter;
  private combFilterNeg: CombFilter;
  private activeFilterType: string = 'lowpass'; // tracks which filter is wired
  private filterEnvGain: GainNode;       // offset for filter envelope
  private distortionNode: Distortion;
  private delayNode: Delay;
  private bitCrusherNode: BitCrusher;
  private reverbNode: Reverb;
  private volumeNode: GainNode;          // master output volume

  // Modulation Engine (replaces old lfo1/lfo2)
  private modEngine: ModulationEngine;

  // Voice pool
  private voices: PolyVoice[] = [];

  constructor(ac: AudioContext) {
    this.ac = ac;
    this.params = ensureDefaults({ ...SYNTH_PRESETS['INIT'] });

    this.voiceSumNode = ac.createGain();
    this.voiceSumNode.gain.value = 1;

    this.filterNode = ac.createBiquadFilter();
    this.filterNode.type = 'lowpass';
    this.filterNode.frequency.value = 6000;
    this.filterNode.Q.value = 0;

    this.ladderFilter = new LadderFilter(ac);
    this.combFilterPos = new CombFilter(ac, false);
    this.combFilterNeg = new CombFilter(ac, true);

    this.filterEnvGain = ac.createGain();
    this.filterEnvGain.gain.value = 0;

    this.distortionNode = new Distortion(ac);
    this.delayNode = new Delay(ac);
    this.bitCrusherNode = new BitCrusher(ac);
    this.reverbNode = new Reverb(ac);
    this.volumeNode = ac.createGain();
    this.volumeNode.gain.value = 0.75;

    // Create ModulationEngine
    this.modEngine = new ModulationEngine(
      ac,
      () => this.params,
      (key, val) => this.applyParam(key, val as never),
    );

    // Wire up voice activity check for trigger mode gating
    this.modEngine.hasActiveVoices = () => {
      const now = this.ac.currentTime;
      return this.voices.some(v => !v.isIdle(now));
    };
  }

  init(): void {
    if (this.initialized) return;

    // Post-filter signal chain (filter-agnostic):
    this.distortionNode.connect(this.delayNode.getDryInput());
    this.distortionNode.connect(this.delayNode.getWetInput());

    this.delayNode.connect(this.bitCrusherNode.getDryInput());
    this.delayNode.connect(this.bitCrusherNode.getWetInput());

    this.bitCrusherNode.connect(this.reverbNode.getDryInput());
    this.bitCrusherNode.connect(this.reverbNode.getWetInput());

    this.reverbNode.connect(this.volumeNode);

    // Wire the initial filter type
    this.wireFilter(this.params.filterType ?? 'lowpass');

    // Voice pool
    for (let i = 0; i < MAX_VOICES; i++) {
      this.voices.push(new PolyVoice(this.ac, this.voiceSumNode));
    }

    // Set up audio-rate modulation targets
    this.modEngine.audioParamGetters.set('filterFreq', () => [this.filterNode.frequency]);
    this.modEngine.audioParamGetters.set('vcoDetune', () => {
      const params: AudioParam[] = [];
      const now = this.ac.currentTime;
      for (const voice of this.voices) {
        if (!voice.isIdle(now)) {
          for (const osc of voice.mainOscs) params.push(osc.detune);
        }
      }
      return params;
    });

    // Start modulation engine
    this.modEngine.start();
    this.modEngine.syncFromParams(this.params);

    this.syncNodesToParams();
    this.initialized = true;
  }

  /** Connect voiceSumNode → active filter → distortion, switching between biquad/ladder/comb */
  private wireFilter(filterType: string): void {
    // Disconnect previous filter routing
    try { this.voiceSumNode.disconnect(); } catch { /* ignore */ }
    try { this.filterNode.disconnect(); } catch { /* ignore */ }
    try { this.ladderFilter.disconnect(); } catch { /* ignore */ }
    try { this.combFilterPos.disconnect(); } catch { /* ignore */ }
    try { this.combFilterNeg.disconnect(); } catch { /* ignore */ }
    try { this.filterEnvGain.disconnect(); } catch { /* ignore */ }

    const connectToDistortion = (output: AudioNode) => {
      output.connect(this.distortionNode.getDryInput());
      output.connect(this.distortionNode.getWetInput());
    };

    if (filterType === 'ladder') {
      this.voiceSumNode.connect(this.ladderFilter.getInput());
      connectToDistortion(this.ladderFilter.getOutput());
      this.filterEnvGain.connect(this.ladderFilter.detune);
      this.ladderFilter.setFrequency(this.params.filterFreq);
      this.ladderFilter.setResonance(this.params.filterQ);
    } else if (filterType === 'comb+') {
      this.voiceSumNode.connect(this.combFilterPos.getInput());
      connectToDistortion(this.combFilterPos.getOutput());
      this.filterEnvGain.connect(this.combFilterPos.detune);
      this.combFilterPos.setFrequency(this.params.filterFreq);
      this.combFilterPos.setResonance(this.params.filterQ);
    } else if (filterType === 'comb-') {
      this.voiceSumNode.connect(this.combFilterNeg.getInput());
      connectToDistortion(this.combFilterNeg.getOutput());
      this.filterEnvGain.connect(this.combFilterNeg.detune);
      this.combFilterNeg.setFrequency(this.params.filterFreq);
      this.combFilterNeg.setResonance(this.params.filterQ);
    } else {
      // Standard biquad filter
      this.voiceSumNode.connect(this.filterNode);
      connectToDistortion(this.filterNode);
      this.filterEnvGain.connect(this.filterNode.detune);
    }

    this.activeFilterType = filterType;
  }

  getOutputNode(): AudioNode {
    return this.volumeNode;
  }

  // ─── Note Triggering ───────────────────────────────────────────────────────

  noteOn(midiNote: number, audioTime: number, duration: number, gainScale = 1): void {
    // Legato check: skip glide if no voice is currently playing
    const hasPlaying = this.params.portamentoLegato
      ? this.voices.some(v => !v.isIdle(this.ac.currentTime))
      : true;
    const skipGlide = this.params.portamentoLegato && !hasPlaying;
    const voice = this.getOrStealVoice(audioTime);
    voice.trigger(midiNote, audioTime, duration, this.params, gainScale, skipGlide);
    this.scheduleFilterEnv(audioTime, duration);
    this.modEngine.onNoteOn(audioTime);
  }

  /** Called from SynthPanel for live keyboard/mouse playback (no scheduled time). */
  noteOnNow(midiNote: number, velocity?: number): void {
    const now = this.ac.currentTime;
    const p = this.params;
    // Legato check
    const hasPlaying = p.portamentoLegato
      ? this.voices.some(v => !v.isIdle(now))
      : true;
    const skipGlide = p.portamentoLegato && !hasPlaying;
    const voice = this.getOrStealVoice(now);
    // Convert velocity (0-127) to gainScale (0-1); default 1 if not provided
    const gainScale = velocity !== undefined ? Math.max(0, velocity / 127) : 1;
    voice.trigger(midiNote, now, 10, p, gainScale, skipGlide); // 10s sustain — noteOff stops it
    this._lastLiveVoice = voice;
    this.scheduleFilterEnv(now, 10);
    this.modEngine.onNoteOn();
  }

  private _lastLiveVoice: PolyVoice | null = null;

  /** Release the most recently triggered voice (for backward compatibility) */
  noteOff(): void {
    if (this._lastLiveVoice) {
      const now = this.ac.currentTime + 0.01;
      this._lastLiveVoice.silence(now);
      this._lastLiveVoice = null;
    }
  }

  /** Release the voice playing a specific MIDI note (for polyphonic keyboard) */
  noteOffForNote(midiNote: number): void {
    const now = this.ac.currentTime + 0.01;
    for (const voice of this.voices) {
      if (voice.currentMidiNote === midiNote && !voice.isIdle(now)) {
        voice.silence(now);
        return;
      }
    }
  }

  noteStop(): void {
    const now = this.ac.currentTime;
    for (const v of this.voices) {
      v.voiceGain.gain.cancelScheduledValues(now);
      v.voiceGain.gain.setValueAtTime(0, now);
      v.releaseEnd = now;
    }
    this._lastLiveVoice = null;
  }

  dispose(): void {
    this.noteStop();
    this.modEngine.dispose();
    // Dispose all poly voices (stops 64 oscillators)
    for (const v of this.voices) v.dispose();
    // Disconnect shared chain nodes
    try { this.voiceSumNode.disconnect(); } catch { /* ignore */ }
    try { this.filterNode.disconnect(); } catch { /* ignore */ }
    try { this.filterEnvGain.disconnect(); } catch { /* ignore */ }
    try { this.volumeNode.disconnect(); } catch { /* ignore */ }
  }

  private scheduleFilterEnv(audioTime: number, duration: number): void {
    const p = this.params;
    if (!p.filterEnvAmount) return;

    const now = Math.max(audioTime, this.ac.currentTime + 0.001);
    const attack = Math.max(p.filterAttack, 0.001);
    const decay = Math.max(p.filterDecay, 0.001);
    const attackEnd = now + attack;
    const releaseStart = Math.max(now + duration, attackEnd + 0.001);

    const d = this.filterEnvGain.gain;
    d.cancelScheduledValues(now);
    d.setValueAtTime(0, now);
    d.linearRampToValueAtTime(p.filterEnvAmount, attackEnd);
    d.setTargetAtTime(0, attackEnd, decay / 5);
    d.setTargetAtTime(0, releaseStart, 0.05);
  }

  private getOrStealVoice(audioTime: number): PolyVoice {
    const now = this.ac.currentTime;
    // 1. Try to find an idle voice
    for (const v of this.voices) {
      if (v.isIdle(now)) return v;
    }
    // 2. Steal the oldest triggered voice
    let oldest = this.voices[0];
    for (const v of this.voices) {
      if (v.triggeredAt < oldest.triggeredAt) oldest = v;
    }
    oldest.silence(audioTime);
    return oldest;
  }

  // ─── Params ───────────────────────────────────────────────────────────────

  setParam<K extends keyof SynthParams>(key: K, value: SynthParams[K]): void {
    // Guard: reject non-finite numeric values to prevent Web Audio API crashes
    if (typeof value === 'number' && !Number.isFinite(value)) return;
    (this.params as unknown as Record<string, unknown>)[key] = value;
    this.applyParam(key, value);
  }

  private applyParam<K extends keyof SynthParams>(key: K, value: SynthParams[K]): void {
    const now = this.ac.currentTime;
    const v = value as number;

    switch (key) {
      case 'masterVolume':
        this.volumeNode.gain.setTargetAtTime(v, now, 0.02);
        break;
      case 'filterType': {
        const ft = value as string;
        if (ft !== this.activeFilterType) {
          this.wireFilter(ft);
        }
        if (ft === 'lowpass' || ft === 'highpass' || ft === 'bandpass' || ft === 'notch') {
          this.filterNode.type = ft;
        }
        break;
      }
      case 'filterFreq':
        this.filterNode.frequency.setTargetAtTime(Math.max(20, v), now, 0.02);
        if (this.activeFilterType === 'ladder') this.ladderFilter.setFrequency(v);
        if (this.activeFilterType === 'comb+') this.combFilterPos.setFrequency(v);
        if (this.activeFilterType === 'comb-') this.combFilterNeg.setFrequency(v);
        break;
      case 'filterQ':
        this.filterNode.Q.setTargetAtTime(Math.max(0, v), now, 0.02);
        if (this.activeFilterType === 'ladder') this.ladderFilter.setResonance(v);
        if (this.activeFilterType === 'comb+') this.combFilterPos.setResonance(v);
        if (this.activeFilterType === 'comb-') this.combFilterNeg.setResonance(v);
        break;
      case 'distortionDist':
        this.distortionNode.setDistortion(v, this.params.distortionType ?? 0);
        break;
      case 'distortionType':
        this.distortionNode.setDistortion(this.params.distortionDist, v);
        break;
      case 'distortionAmount':
        this.distortionNode.setAmount(v);
        break;
      case 'delayTime':
        this.delayNode.setDelayTime(v);
        break;
      case 'delayFeedback':
        this.delayNode.setFeedback(v);
        break;
      case 'delayTone':
        this.delayNode.setTone(v);
        break;
      case 'delayAmount':
        this.delayNode.setAmount(v);
        break;
      case 'reverbType':
        this.reverbNode.setType(value as string);
        break;
      case 'bitCrushDepth':
        this.bitCrusherNode.setBitDepth(v);
        break;
      case 'bitCrushAmount':
        this.bitCrusherNode.setAmount(v);
        break;
      case 'reverbAmount':
        this.reverbNode.setAmount(v);
        break;

      // LFO params — forward to ModulationEngine
      case 'lfos':
      case 'modAssignments':
        this.modEngine.syncFromParams(this.params);
        break;

      // Legacy LFO params — ignored (handled by ensureDefaults migration)
      case 'lfo1Rate': case 'lfo1Depth': case 'lfo1Shape': case 'lfo1Dest':
      case 'lfo2Rate': case 'lfo2Depth': case 'lfo2Shape': case 'lfo2Dest':
        break;

      // Wavetable params: live-update playing voices
      case 'wtPosition':
      case 'wtWarpMode':
      case 'wtWarpAmount':
        this.updatePlayingVoicesWaveform();
        break;
      case 'vcoType':
        // If switching to/from wavetable mode, update playing voices
        if ((value as string).startsWith('wt:')) {
          this.updatePlayingVoicesWaveform();
        }
        break;
      // Live oscillator updates: applied to all voices on next noteOn
      case 'vcoGain':
      case 'vcoPan':
      case 'vcoDetune':
      case 'sub1Type':
      case 'sub1Gain':
      case 'sub1Pan':
      case 'sub1Offset':
      case 'sub2Type':
      case 'sub2Gain':
      case 'sub2Pan':
      case 'sub2Offset':
      case 'unisonVoices':
      case 'unisonDetune':
      case 'unisonSpread':
      case 'fmEnabled':
      case 'fmRatio':
      case 'fmDepth':
      case 'portamentoCurve':
      case 'portamentoLegato':
      case 'stringDamping':
      case 'stringDecay':
        // These take effect on next noteOn
        break;
      case 'ringModEnabled':
      case 'ringModMix':
        for (const voice of this.voices) {
          voice.setRingMod(this.params.ringModEnabled ?? false, this.params.ringModMix ?? 0.5);
        }
        break;
      case 'unisonDrift':
        for (const voice of this.voices) voice.setDrift(v);
        break;

      // FM 4-op params
      case 'synthMode':
      case 'fm': {
        // When algorithm changes, rewire all voices
        const fm = this.params.fm;
        if (fm) {
          const algo = FM_ALGORITHMS[fm.algorithm] ?? FM_ALGORITHMS[0];
          for (const voice of this.voices) {
            voice.fmVoice.applyAlgorithm(algo);
          }
        }
        // synthMode and fm operator changes take effect on next noteOn
        break;
      }
    }
  }

  /** Update wavetable waveform on all currently playing voices (for live WT position scanning). */
  private _lastWTUpdate = 0;
  private updatePlayingVoicesWaveform(): void {
    if (!this.params.vcoType.startsWith('wt:')) return;
    // Throttle to ~60Hz
    const now = performance.now();
    if (now - this._lastWTUpdate < 16) return;
    this._lastWTUpdate = now;

    const bankId = this.params.vcoType.slice(3);
    const wave = getInterpolatedPeriodicWave(this.ac, bankId, this.params.wtPosition ?? 0, this.params.wtWarpMode ?? 0, this.params.wtWarpAmount ?? 0);
    if (!wave) return;

    const acNow = this.ac.currentTime;
    for (const voice of this.voices) {
      if (!voice.isIdle(acNow)) {
        const numUnison = Math.max(1, Math.round(this.params.unisonVoices));
        for (let i = 0; i < numUnison && i < MAX_UNISON; i++) {
          voice.mainOscs[i].setPeriodicWave(wave);
        }
      }
    }
  }

  /** Update BPM for tempo-synced LFOs */
  setBpm(bpm: number): void {
    this.modEngine.bpm = bpm;
    // No need to re-apply — poll() reads bpm directly each frame
  }

  getParams(): SynthParams {
    return { ...this.params };
  }

  /** Get the current modulated value for a parameter (base + LFO), or null if unmodulated. */
  getModulatedValue(target: keyof SynthParams): number | null {
    return this.modEngine.getModulatedValue(target);
  }

  loadPreset(preset: SynthParams): void {
    this.params = ensureDefaults({ ...preset });
    if (this.initialized) {
      this.syncNodesToParams();
      this.modEngine.syncFromParams(this.params);
    }
  }

  private syncNodesToParams(): void {
    const p = this.params;
    const now = this.ac.currentTime;

    this.volumeNode.gain.setValueAtTime(p.masterVolume, now);
    // Switch filter type if needed and sync params
    const ft = p.filterType ?? 'lowpass';
    if (ft !== this.activeFilterType) this.wireFilter(ft);
    if (ft === 'lowpass' || ft === 'highpass' || ft === 'bandpass' || ft === 'notch') {
      this.filterNode.type = ft;
    }
    this.filterNode.frequency.setValueAtTime(Math.max(20, p.filterFreq), now);
    this.filterNode.Q.setValueAtTime(Math.max(0, p.filterQ), now);
    if (ft === 'ladder') { this.ladderFilter.setFrequency(p.filterFreq); this.ladderFilter.setResonance(p.filterQ); }
    if (ft === 'comb+') { this.combFilterPos.setFrequency(p.filterFreq); this.combFilterPos.setResonance(p.filterQ); }
    if (ft === 'comb-') { this.combFilterNeg.setFrequency(p.filterFreq); this.combFilterNeg.setResonance(p.filterQ); }
    this.distortionNode.setDistortion(p.distortionDist, p.distortionType ?? 0);
    this.distortionNode.setAmount(p.distortionAmount);
    // Apply drift to all voices
    for (const voice of this.voices) voice.setDrift(p.unisonDrift ?? 0);
    this.delayNode.setDelayTime(p.delayTime);
    this.delayNode.setFeedback(p.delayFeedback);
    this.delayNode.setTone(p.delayTone);
    this.delayNode.setAmount(p.delayAmount);
    this.reverbNode.setType(p.reverbType);
    this.reverbNode.setAmount(p.reverbAmount);
    this.bitCrusherNode.setBitDepth(p.bitCrushDepth);
    this.bitCrusherNode.setAmount(p.bitCrushAmount);
  }
}
