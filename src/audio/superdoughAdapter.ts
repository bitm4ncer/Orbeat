import { superdough, getAudioContext } from 'superdough';
import type { Instrument } from '../types/instrument';
import type { StoreState } from '../state/store';
import { DEFAULT_SAMPLER_PARAMS } from '../types/superdough';
import { DEFAULT_LOOPER_PARAMS } from '../types/looper';
import { getSynthEngine } from './synthManager';

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** Clamp a scheduled time so it's never in the past (avoids superdough's
 *  "cannot schedule sounds in the past" error caused by Tone.js / native
 *  AudioContext clock drift). */
function safeTime(t: number): number {
  try {
    const now = getAudioContext().currentTime;
    return t < now ? now + 0.001 : t;
  } catch {
    return t;
  }
}

/**
 * Computes superdough effect parameter overrides from the instrument's own
 * effect chain (instrumentEffects[instrument.id]), applied in order.
 * Only the compressor is mapped here — all other effects are handled by the
 * per-orbit Web Audio chain in orbitEffects.ts (reverb, delay, distortion,
 * filter, phaser, eq3, chorus).
 */
function getEffectOverrides(
  instrument: Instrument,
  state: StoreState,
): Record<string, number> {
  const effects = state.instrumentEffects[instrument.id] ?? [];
  const overrides: Record<string, number> = {};

  for (const effect of effects) {
    if (!effect.enabled) continue;
    switch (effect.type) {
      case 'compressor':
        // superdough native: compressor = threshold; triggers the compressor node
        overrides.compressor = effect.params.threshold ?? -24;
        overrides.compressorRatio = effect.params.ratio ?? 4;
        overrides.compressorKnee = effect.params.knee ?? 6;
        overrides.compressorAttack = effect.params.attack ?? 0.003;
        overrides.compressorRelease = effect.params.release ?? 0.25;
        break;
      // All other effects handled via per-orbit Web Audio chain in orbitEffects.ts
    }
  }

  return overrides;
}

export function triggerSuperdough(
  instrument: Instrument,
  midiNote: number,
  noteDuration: number,
  audioTime: number,
  glide: boolean,
  velocity: number,
  state: StoreState,
): void {
  if (instrument.type === 'synth') {
    // Route through the custom SynthEngine — NOT superdough.
    // This fixes "sound supersaw not found" and enables poly, LFO, FM, unison.
    const engine = getSynthEngine(instrument.id, instrument.orbitIndex, instrument.engineParams);
    const instGain = dbToLinear(instrument.volume) * (velocity / 127);
    void glide; // portamentoSpeed is already in SynthParams
    engine.noteOn(midiNote, audioTime, noteDuration, instGain);

  } else if (instrument.type === 'sampler' && instrument.sampleName) {
    const instGain = dbToLinear(instrument.volume);
    const sp = instrument.samplerParams ?? DEFAULT_SAMPLER_PARAMS;
    const rootNote = sp.rootNote ?? 60;
    const speed = sp.speed * Math.pow(2, (midiNote - rootNote) / 12);
    const effectOverrides = getEffectOverrides(instrument, state);

    // Enforce minimum release to prevent clicks
    const safeRelease = Math.max(sp.release, 0.005);

    superdough({
      s: instrument.sampleName,
      gain: sp.gain * instGain * (velocity / 127),
      speed,
      begin: sp.begin,
      end: sp.end,
      attack: sp.attack,
      release: safeRelease,
      cutoff: sp.cutoff,
      resonance: sp.resonance,
      pan: (sp.pan + 1) / 2,
      orbit: instrument.orbitIndex,
      ...effectOverrides,
    }, safeTime(audioTime), noteDuration);
  }
}

/**
 * Trigger continuous looper playback. Called from transport on step 0 of each cycle.
 * Plays the full sample (or loop region) as a single superdough call spanning the
 * entire cycle duration. Speed is adjusted for time-stretch; phase vocoder
 * compensates pitch when keepPitch is enabled.
 */
export function triggerLooperContinuous(
  instrument: Instrument,
  secondsPerStep: number,
  audioTime: number,
  state: StoreState,
): void {
  if (!instrument.sampleName) return;

  const lp = { ...DEFAULT_LOOPER_PARAMS, ...instrument.looperParams };
  const editorState = state.looperEditors[instrument.id];
  const loopIn = editorState?.loopIn ?? 0;
  const loopOut = editorState?.loopOut ?? 1;
  const bufferDuration = editorState?.audioBuffer?.duration ?? 1;
  const cycleDuration = instrument.loopSize * secondsPerStep;

  // Region of the buffer to play
  const regionSize = loopOut - loopIn;
  const regionDuration = regionSize * bufferDuration;

  // Speed calculation
  let speed: number;
  let stretchSpeed = 1; // the tempo-change portion (before pitch offset)

  if (lp.stretchToSteps) {
    // Stretch: fit the sample region into the cycle duration
    stretchSpeed = regionDuration / Math.max(cycleDuration, 0.01);
    speed = stretchSpeed;
  } else {
    // No stretch: play at natural speed (pitch knob adjusts rate)
    speed = 1;
  }

  // Apply pitch offset (semitones)
  const pitchRatio = Math.pow(2, (lp.pitchSemitones ?? 0) / 12);
  speed *= pitchRatio;

  // Clamp to avoid extreme speed values
  speed = Math.max(0.1, Math.min(speed, 8));

  // Build superdough params
  const params: Record<string, unknown> = {
    s: instrument.sampleName,
    gain: lp.gain * dbToLinear(instrument.volume),
    speed: lp.reverse ? -speed : speed,
    begin: lp.reverse ? loopOut : loopIn,
    end: lp.reverse ? loopIn : loopOut,
    attack: Math.max(lp.attack, 0.002),
    release: Math.max(lp.release, 0.005),
    cutoff: lp.cutoff,
    resonance: lp.resonance,
    pan: (lp.pan + 1) / 2,
    orbit: instrument.orbitIndex,
    ...getEffectOverrides(instrument, state),
  };

  // Keep Pitch: phase vocoder compensates the tempo-change portion of speed
  // superdough's stretch param: pitchFactor = Math.max(0, stretch + 1)
  // We want pitchFactor = 1/stretchSpeed, so stretch = (1/stretchSpeed) - 1
  if (lp.keepPitch && lp.stretchToSteps && Math.abs(stretchSpeed - 1) > 0.01) {
    params.stretch = (1 / stretchSpeed) - 1;
  }

  superdough(params, safeTime(audioTime), cycleDuration);
}
