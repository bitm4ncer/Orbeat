/**
 * FMVoice — manages 4 FM operators and their routing for one polyphonic voice.
 *
 * Handles algorithm-based operator wiring: disconnects/reconnects operators
 * when the algorithm changes, and triggers all operator envelopes on noteOn.
 */

import { FMOperator } from './nodes/FMOperator';
import type { FMAlgorithm } from './fmAlgorithms';
import { FM_ALGORITHMS } from './fmAlgorithms';
import type { FMParams } from './types';
import { midiNoteToFreq } from '../../utils/music';

export class FMVoice {
  private ac: AudioContext;
  operators: [FMOperator, FMOperator, FMOperator, FMOperator];
  private outputSum: GainNode;
  private currentAlgorithmId = -1;

  constructor(ac: AudioContext) {
    this.ac = ac;

    this.operators = [
      new FMOperator(ac),
      new FMOperator(ac),
      new FMOperator(ac),
      new FMOperator(ac),
    ];

    // Sum node for carrier outputs
    this.outputSum = ac.createGain();
    this.outputSum.gain.value = 1;

    // Apply default algorithm
    this.applyAlgorithm(FM_ALGORITHMS[0]);
  }

  /** Rewire operator connections based on algorithm topology. */
  applyAlgorithm(algo: FMAlgorithm): void {
    if (algo.id === this.currentAlgorithmId) return;
    this.currentAlgorithmId = algo.id;

    // Disconnect all operator outputs from other operators and from outputSum
    for (let mod = 0; mod < 4; mod++) {
      const output = this.operators[mod].getOutput();
      for (let car = 0; car < 4; car++) {
        if (mod !== car) {
          try { output.disconnect(this.operators[car].getFrequencyParam()); } catch { /* not connected */ }
        }
      }
      try { output.disconnect(this.outputSum); } catch { /* not connected */ }
    }

    // Wire modulation connections
    for (let mod = 0; mod < 4; mod++) {
      for (let car = 0; car < 4; car++) {
        if (algo.connections[mod][car]) {
          this.operators[mod].getOutput().connect(
            this.operators[car].getFrequencyParam(),
          );
        }
      }
    }

    // Wire carrier outputs to sum
    for (let i = 0; i < 4; i++) {
      if (algo.outputs[i]) {
        this.operators[i].getOutput().connect(this.outputSum);
      }
    }
  }

  /** Trigger all operators for a note. */
  trigger(
    midiNote: number,
    when: number,
    duration: number,
    fmParams: FMParams,
  ): void {
    const carrierFreq = midiNoteToFreq(midiNote);
    const algo = FM_ALGORITHMS[fmParams.algorithm] ?? FM_ALGORITHMS[0];

    // Ensure algorithm is applied
    this.applyAlgorithm(algo);

    for (let i = 0; i < 4; i++) {
      const op = this.operators[i];
      const opParams = fmParams.operators[i];
      const isModulator = !algo.outputs[i];

      // Set waveform
      op.setWaveform(opParams.waveform);

      // Set frequency and get the computed operator frequency
      const opFreq = op.setFrequency(
        carrierFreq,
        opParams.ratioCoarse,
        opParams.ratioFine,
        when,
      );

      // Set level with modulation index scaling for modulators
      op.setLevel(opParams.level, isModulator, opFreq, when);

      // Set self-feedback
      op.setFeedback(opParams.feedback, opFreq, when);

      // Trigger per-operator envelope
      op.triggerEnvelope(opParams, when, duration);
    }

    // Master FM level
    this.outputSum.gain.cancelScheduledValues(when);
    this.outputSum.gain.setValueAtTime(fmParams.masterLevel, when);
  }

  /** Silence all operators. */
  silence(when: number): void {
    for (const op of this.operators) {
      op.silence(when);
    }
  }

  /** Get the summed output node (connect to voiceGain or voiceSumNode). */
  getOutput(): GainNode {
    return this.outputSum;
  }

  /** Clean up all nodes. */
  dispose(): void {
    for (const op of this.operators) {
      op.dispose();
    }
    try { this.outputSum.disconnect(); } catch { /* ignore */ }
  }
}
