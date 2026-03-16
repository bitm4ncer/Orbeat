/**
 * FMOperator — single FM operator for 4-op FM synthesis.
 *
 * Signal path:
 *   osc → envGain → outputGain → [routed to other ops' frequency or audio output]
 *   osc → feedbackDelay → feedbackGain → osc.frequency  (self-feedback loop)
 *
 * Modulation index scaling:
 *   When this operator is a modulator, outputGain.gain = level × operatorFreq.
 *   This makes `level` behave as the modulation index (β), producing consistent
 *   timbre across the keyboard since peak deviation = β × f_mod.
 */

import type { FMOperatorParams, FMOperatorWaveform } from '../types';

export class FMOperator {
  private ac: AudioContext;
  osc: OscillatorNode;
  private envGain: GainNode;
  private outputGain: GainNode;
  private feedbackDelay: DelayNode;
  private feedbackGain: GainNode;

  constructor(ac: AudioContext) {
    this.ac = ac;

    // Oscillator (always running, muted by envGain when not triggered)
    this.osc = ac.createOscillator();
    this.osc.type = 'sine';

    // Per-operator envelope
    this.envGain = ac.createGain();
    this.envGain.gain.value = 0;

    // Output level / modulation index scaling
    this.outputGain = ac.createGain();
    this.outputGain.gain.value = 0;

    // Self-feedback loop: osc → delay → gain → osc.frequency
    // Minimum delay to break circular connection (128 samples)
    this.feedbackDelay = ac.createDelay(0.01);
    this.feedbackDelay.delayTime.value = 128 / ac.sampleRate;
    this.feedbackGain = ac.createGain();
    this.feedbackGain.gain.value = 0;

    // Wire signal path
    this.osc.connect(this.envGain);
    this.envGain.connect(this.outputGain);

    // Wire feedback loop
    this.osc.connect(this.feedbackDelay);
    this.feedbackDelay.connect(this.feedbackGain);
    this.feedbackGain.connect(this.osc.frequency);

    this.osc.start();
  }

  /** Set operator frequency based on carrier fundamental and ratio. */
  setFrequency(carrierFreq: number, ratioCoarse: number, ratioFine: number, when: number): number {
    const opFreq = carrierFreq * Math.max(0.01, ratioCoarse + ratioFine);
    this.osc.frequency.cancelScheduledValues(when);
    this.osc.frequency.setValueAtTime(opFreq, when);
    return opFreq;
  }

  /** Set output level with modulation index scaling for modulators. */
  setLevel(level: number, isModulator: boolean, opFreq: number, when: number): void {
    const gain = isModulator ? level * opFreq : level;
    this.outputGain.gain.cancelScheduledValues(when);
    this.outputGain.gain.setValueAtTime(gain, when);
  }

  /** Set waveform type. */
  setWaveform(waveform: FMOperatorWaveform): void {
    this.osc.type = waveform;
  }

  /** Set self-feedback amount (scaled by operator frequency). */
  setFeedback(amount: number, opFreq: number, when: number): void {
    const gain = amount * opFreq;
    this.feedbackGain.gain.cancelScheduledValues(when);
    this.feedbackGain.gain.setValueAtTime(gain, when);
  }

  /** Schedule per-operator ADSR envelope. */
  triggerEnvelope(params: FMOperatorParams, when: number, duration: number): void {
    const attack = Math.max(params.envAttack, 0.001);
    const decay = Math.max(params.envDecay, 0.001);
    const sustain = Math.max(0, Math.min(1, params.envSustain));
    const release = Math.max(params.envRelease, 0.01);
    const attackEnd = when + attack;
    const releaseStart = Math.max(when + duration, attackEnd + 0.001);

    const g = this.envGain.gain;
    g.cancelScheduledValues(when);
    g.setValueAtTime(0, when);
    g.linearRampToValueAtTime(1, attackEnd);
    g.setTargetAtTime(sustain, attackEnd, decay / 5);
    g.setTargetAtTime(0, releaseStart, release / 5);
  }

  /** Silence this operator. */
  silence(when: number): void {
    this.envGain.gain.cancelScheduledValues(when);
    this.envGain.gain.setTargetAtTime(0, when, 0.01);
  }

  /** Get the output node (for routing to other operators or audio output). */
  getOutput(): GainNode {
    return this.outputGain;
  }

  /** Get the oscillator frequency AudioParam (for incoming modulation from other operators). */
  getFrequencyParam(): AudioParam {
    return this.osc.frequency;
  }

  /** Clean up all nodes. */
  dispose(): void {
    try { this.osc.stop(); } catch { /* already stopped */ }
    try { this.osc.disconnect(); } catch { /* ignore */ }
    try { this.envGain.disconnect(); } catch { /* ignore */ }
    try { this.outputGain.disconnect(); } catch { /* ignore */ }
    try { this.feedbackDelay.disconnect(); } catch { /* ignore */ }
    try { this.feedbackGain.disconnect(); } catch { /* ignore */ }
  }
}
