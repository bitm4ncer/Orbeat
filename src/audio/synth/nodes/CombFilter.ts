/**
 * Comb filter — creates metallic, string-like, flanging resonances.
 *
 * Architecture:
 *   input ──────────────────→ (+) → output
 *      └→ DelayNode → LPF (damping) → feedbackGain → DelayNode
 *
 * Positive feedback (comb+): peaks at all harmonics of 1/delayTime
 * Negative feedback (comb-): peaks at odd harmonics only (inverted feedback)
 *
 * filterFreq maps to delay time: delayTime = 1/frequency
 * filterQ maps to feedback amount (0–0.95)
 */

export class CombFilter {
  private ac: AudioContext;
  private inputNode: GainNode;
  private outputNode: GainNode;
  private delayNode: DelayNode;
  private dampingFilter: BiquadFilterNode;
  private feedbackGain: GainNode;
  private negative: boolean;

  constructor(ac: AudioContext, negative = false) {
    this.ac = ac;
    this.negative = negative;
    this.inputNode = ac.createGain();
    this.inputNode.gain.value = 1;
    this.outputNode = ac.createGain();
    this.outputNode.gain.value = 1;

    // Direct path: input → output
    this.inputNode.connect(this.outputNode);

    // Delay line (max 50ms = 20Hz lowest pitch)
    this.delayNode = ac.createDelay(0.05);
    this.delayNode.delayTime.value = 0.005; // default ~200Hz

    // Damping filter in feedback path (simulates string absorption)
    this.dampingFilter = ac.createBiquadFilter();
    this.dampingFilter.type = 'lowpass';
    this.dampingFilter.frequency.value = 8000;
    this.dampingFilter.Q.value = 0;

    // Feedback gain (resonance)
    this.feedbackGain = ac.createGain();
    this.feedbackGain.gain.value = negative ? -0.5 : 0.5;

    // Wire feedback loop: input → delay → damping → feedback → delay
    this.inputNode.connect(this.delayNode);
    this.delayNode.connect(this.dampingFilter);
    this.dampingFilter.connect(this.feedbackGain);
    this.feedbackGain.connect(this.delayNode); // feedback cycle
    // Also connect delay output to main output for the comb effect
    this.delayNode.connect(this.outputNode);
  }

  getInput(): AudioNode {
    return this.inputNode;
  }

  getOutput(): AudioNode {
    return this.outputNode;
  }

  /** Get the delayTime AudioParam for direct envelope scheduling */
  getDelayTimeParam(): AudioParam {
    return this.delayNode.delayTime;
  }

  /** Get current base delay time from frequency */
  getBaseDelayTime(): number {
    return this.delayNode.delayTime.value;
  }

  /** Set pitch frequency — maps to delay time (1/freq) */
  setFrequency(freq: number): void {
    const now = this.ac.currentTime;
    const f = Math.max(20, Math.min(1000, freq));
    const delayTime = 1 / f;
    this.delayNode.delayTime.setTargetAtTime(delayTime, now, 0.02);
  }

  /** Set resonance/feedback (maps Q 0–20 to feedback 0–0.95) */
  setResonance(q: number): void {
    const now = this.ac.currentTime;
    const fb = Math.min(0.95, q * 0.0475);
    this.feedbackGain.gain.setTargetAtTime(this.negative ? -fb : fb, now, 0.02);
  }

  /** Set damping filter frequency */
  setDamping(freq: number): void {
    const now = this.ac.currentTime;
    this.dampingFilter.frequency.setTargetAtTime(Math.max(200, freq), now, 0.02);
  }

  connect(destination: AudioNode): void {
    this.outputNode.connect(destination);
  }

  disconnect(): void {
    try { this.outputNode.disconnect(); } catch { /* ignore */ }
  }

  dispose(): void {
    try { this.inputNode.disconnect(); } catch { /* ignore */ }
    try { this.outputNode.disconnect(); } catch { /* ignore */ }
    try { this.delayNode.disconnect(); } catch { /* ignore */ }
    try { this.dampingFilter.disconnect(); } catch { /* ignore */ }
    try { this.feedbackGain.disconnect(); } catch { /* ignore */ }
  }
}
