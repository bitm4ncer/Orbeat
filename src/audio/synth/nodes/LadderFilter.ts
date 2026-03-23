/**
 * Moog-style 4-pole ladder filter (24dB/oct)
 *
 * Architecture: 4 cascaded BiquadFilterNodes with feedback saturation.
 *   input → bq1(LP) → bq2(LP) → bq3(LP) → bq4(LP) → output
 *                                                ↓
 *                                          feedbackGain (resonance)
 *                                                ↓
 *                                          saturation (tanh WaveShaper)
 *                                                ↓
 *                                          → input (Web Audio 1-block cycle delay)
 *
 * The 1-block delay (~2.9ms at 44.1kHz) from the feedback cycle causes slight
 * resonance peak detuning at high frequencies, which matches analog Moog behavior.
 */

const CURVE_SIZE = 1024;

/** Tanh saturation curve for feedback path */
function createTanhCurve(): Float32Array {
  const curve = new Float32Array(CURVE_SIZE);
  for (let i = 0; i < CURVE_SIZE; i++) {
    const x = (i * 2) / CURVE_SIZE - 1;
    curve[i] = Math.tanh(x * 2);
  }
  return curve;
}

export class LadderFilter {
  private ac: AudioContext;
  private inputNode: GainNode;
  private outputNode: GainNode;
  private stages: BiquadFilterNode[];
  private feedbackGain: GainNode;
  private saturation: WaveShaperNode;

  constructor(ac: AudioContext) {
    this.ac = ac;
    this.inputNode = ac.createGain();
    this.inputNode.gain.value = 1;
    this.outputNode = ac.createGain();
    this.outputNode.gain.value = 1;

    // 4 cascaded lowpass stages (Butterworth Q=0.5 per stage)
    this.stages = [];
    let prevNode: AudioNode = this.inputNode;
    for (let i = 0; i < 4; i++) {
      const bq = ac.createBiquadFilter();
      bq.type = 'lowpass';
      bq.frequency.value = 8000;
      bq.Q.value = 0.5; // Butterworth — flat passband per stage
      prevNode.connect(bq);
      prevNode = bq;
      this.stages.push(bq);
    }
    // Last stage → output
    this.stages[3].connect(this.outputNode);

    // Feedback path: output of stage 4 → gain → saturation → input
    this.feedbackGain = ac.createGain();
    this.feedbackGain.gain.value = 0; // resonance off by default
    this.saturation = ac.createWaveShaper();
    this.saturation.curve = createTanhCurve() as Float32Array<ArrayBuffer>;
    this.saturation.oversample = 'none';

    this.stages[3].connect(this.feedbackGain);
    this.feedbackGain.connect(this.saturation);
    this.saturation.connect(this.inputNode); // feedback loop (Web Audio handles cycle)
  }

  getInput(): AudioNode {
    return this.inputNode;
  }

  getOutput(): AudioNode {
    return this.outputNode;
  }

  /** Get the frequency AudioParam of the first stage (for filter envelope connection) */
  get frequency(): AudioParam {
    return this.stages[0].frequency;
  }

  /** Get the detune AudioParam of the first stage */
  get detune(): AudioParam {
    return this.stages[0].detune;
  }

  /** Connect an audio source to all 4 stages' detune for proper envelope modulation */
  connectToDetune(source: AudioNode): void {
    for (const stage of this.stages) {
      source.connect(stage.detune);
    }
  }

  /** Disconnect an audio source from all 4 stages' detune */
  disconnectFromDetune(source: AudioNode): void {
    for (const stage of this.stages) {
      try { source.disconnect(stage.detune); } catch { /* ignore */ }
    }
  }

  setFrequency(freq: number): void {
    const now = this.ac.currentTime;
    const f = Math.max(20, Math.min(20000, freq));
    for (const bq of this.stages) {
      bq.frequency.setTargetAtTime(f, now, 0.02);
    }
  }

  /** Set resonance (0–1.2). Values > 1.0 cause self-oscillation. */
  setResonance(q: number): void {
    const now = this.ac.currentTime;
    // Map Q (0–20 from filter control) to feedback gain (0–1.2)
    // Q range 0–20 → resonance 0–1.15 (just under self-oscillation at max)
    const reso = Math.min(1.15, q * 0.0575);
    this.feedbackGain.gain.setTargetAtTime(reso, now, 0.02);
  }

  connect(destination: AudioNode): void {
    this.outputNode.connect(destination);
  }

  disconnect(): void {
    try { this.outputNode.disconnect(); } catch { /* ignore */ }
  }

  dispose(): void {
    for (const bq of this.stages) {
      try { bq.disconnect(); } catch { /* ignore */ }
    }
    try { this.inputNode.disconnect(); } catch { /* ignore */ }
    try { this.outputNode.disconnect(); } catch { /* ignore */ }
    try { this.feedbackGain.disconnect(); } catch { /* ignore */ }
    try { this.saturation.disconnect(); } catch { /* ignore */ }
  }
}
