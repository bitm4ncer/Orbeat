/**
 * Wavetable bank definitions — 20 banks, 64 frames each.
 * Each bank generates its frames lazily on first access (cached).
 */

import type { WTFrame, WTBank } from './types';
import { NUM_HARMONICS, computeNativeCoeffs } from './wavetables';

const τ = Math.PI * 2;
const FRAME_COUNT = 64;
const COEFF_LEN = NUM_HARMONICS + 1; // 129

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeFrame(): WTFrame {
  return { real: new Float32Array(COEFF_LEN), imag: new Float32Array(COEFF_LEN) };
}

/** Linear interpolate between two coefficient sets */
function lerpFrames(a: WTFrame, b: WTFrame, t: number): WTFrame {
  const f = makeFrame();
  const t1 = 1 - t;
  for (let k = 0; k < COEFF_LEN; k++) {
    f.real[k] = a.real[k] * t1 + b.real[k] * t;
    f.imag[k] = a.imag[k] * t1 + b.imag[k] * t;
  }
  return f;
}

// ── Bank generators ─────────────────────────────────────────────────────────

/** 1. Basic Shapes — morph sin → tri → sqr → saw (4 segments of 16 frames) */
function genBasicShapes(): WTFrame[] {
  const sin = computeNativeCoeffs('sine');
  const tri = computeNativeCoeffs('triangle');
  const sqr = computeNativeCoeffs('square');
  const saw = computeNativeCoeffs('sawtooth');
  const stages = [sin, tri, sqr, saw];
  const frames: WTFrame[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const stage = (i / FRAME_COUNT) * stages.length;
    const idx = Math.min(Math.floor(stage), stages.length - 1);
    const next = (idx + 1) % stages.length;
    const t = stage - idx;
    frames.push(lerpFrames(stages[idx] as WTFrame, stages[next] as WTFrame, t));
  }
  return frames;
}

/** 2. Formant — vowel sweep (A → E → I → O → U) */
function genFormant(): WTFrame[] {
  // Formant center frequencies (Hz) for vowels at F1/F2/F3
  const vowels = [
    { f: [800, 1150, 2900], bw: [80, 90, 120] },  // A
    { f: [400, 1600, 2700], bw: [60, 80, 100] },   // E
    { f: [350, 2300, 3000], bw: [50, 100, 120] },   // I
    { f: [450, 800, 2830],  bw: [70, 80, 100] },    // O
    { f: [325, 700, 2530],  bw: [50, 60, 100] },    // U
  ];
  const frames: WTFrame[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const f = makeFrame();
    const pos = (i / (FRAME_COUNT - 1)) * (vowels.length - 1);
    const vIdx = Math.min(Math.floor(pos), vowels.length - 2);
    const t = pos - vIdx;
    // Interpolate formant parameters
    const v0 = vowels[vIdx], v1 = vowels[vIdx + 1];
    const fc = v0.f.map((f0, j) => f0 * (1 - t) + v1.f[j] * t);
    const bw = v0.bw.map((b0, j) => b0 * (1 - t) + v1.bw[j] * t);
    // Generate harmonic amplitudes based on formant peaks
    // Assume fundamental at ~130 Hz (C3) for harmonic spacing
    const f0 = 130;
    for (let k = 1; k <= NUM_HARMONICS; k++) {
      const freq = k * f0;
      let amp = 0;
      for (let p = 0; p < 3; p++) {
        const diff = (freq - fc[p]) / bw[p];
        amp += Math.exp(-0.5 * diff * diff) * (1 - p * 0.2);
      }
      f.imag[k] = amp / k;
    }
    frames.push(f);
  }
  return frames;
}

/** 3. Digital — FM synthesis spectra, sweep modulation index 0 → 8 */
function genDigital(): WTFrame[] {
  const frames: WTFrame[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const f = makeFrame();
    const beta = (i / (FRAME_COUNT - 1)) * 8; // modulation index
    // Bessel function approximation for FM carrier sidebands
    for (let k = 1; k <= NUM_HARMONICS; k++) {
      // Simple Bessel J_n approximation via series
      const n = k - 1;
      let jn = 0;
      for (let m = 0; m <= 10; m++) {
        const sign = m % 2 === 0 ? 1 : -1;
        let factM = 1;
        for (let x = 1; x <= m; x++) factM *= x;
        let factNM = 1;
        for (let x = 1; x <= n + m; x++) factNM *= x;
        jn += sign * Math.pow(beta / 2, n + 2 * m) / (factM * factNM);
      }
      f.imag[k] = Math.abs(jn) * 0.8;
    }
    frames.push(f);
  }
  return frames;
}

/** 4. Analog — sawtooth with variable harmonic rolloff (bright → warm → dark) */
function genAnalog(): WTFrame[] {
  const frames: WTFrame[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const f = makeFrame();
    // Rolloff exponent: 1.0 (bright saw) → 3.0 (very dark)
    const rolloff = 1.0 + (i / (FRAME_COUNT - 1)) * 2.0;
    for (let k = 1; k <= NUM_HARMONICS; k++) {
      const sign = k % 2 === 0 ? -1 : 1;
      f.imag[k] = sign * (2 / (Math.PI * Math.pow(k, rolloff)));
    }
    frames.push(f);
  }
  return frames;
}

/** 5. PWM — pulse width modulation, duty cycle 50% → 3% */
function genPWM(): WTFrame[] {
  const frames: WTFrame[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const f = makeFrame();
    const duty = 0.5 - (i / (FRAME_COUNT - 1)) * 0.47; // 50% → 3%
    for (let k = 1; k <= NUM_HARMONICS; k++) {
      f.real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
    }
    frames.push(f);
  }
  return frames;
}

/** 6. Harmonic Series — progressive additive harmonic stacking */
function genHarmonicSeries(): WTFrame[] {
  const frames: WTFrame[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const f = makeFrame();
    const numHarmonics = Math.max(1, Math.round(1 + (i / (FRAME_COUNT - 1)) * 63));
    let maxAmp = 0;
    for (let k = 1; k <= numHarmonics && k <= NUM_HARMONICS; k++) {
      f.imag[k] = 1;
      maxAmp += 1;
    }
    // Normalize
    if (maxAmp > 0) {
      const scale = 1 / Math.sqrt(maxAmp);
      for (let k = 1; k <= numHarmonics && k <= NUM_HARMONICS; k++) {
        f.imag[k] = scale;
      }
    }
    frames.push(f);
  }
  return frames;
}

/** 7. Organ — Hammond drawbar sweep through 8 registrations */
function genOrgan(): WTFrame[] {
  // Drawbar settings (8 registrations): [16', 5⅓', 8', 4', 2⅔', 2', 1⅗', 1⅓', 1']
  // harmonic indices:                    [ 1,    1.5,  2,  4,   3,    8,   5,    6,   16]
  // We'll use actual harmonics: 1,2,3,4,5,6,8,10,12,16
  const registrations = [
    [8, 0, 8, 0, 0, 0, 0, 0, 0], // jazz
    [8, 8, 8, 0, 0, 0, 0, 0, 0], // mellow
    [8, 8, 8, 8, 0, 0, 0, 0, 0], // full mellow
    [8, 6, 8, 8, 6, 0, 0, 0, 0], // gospel
    [8, 8, 8, 8, 8, 8, 0, 0, 0], // full
    [8, 8, 8, 8, 8, 8, 8, 0, 0], // bright
    [8, 8, 8, 8, 8, 8, 8, 8, 0], // very bright
    [8, 8, 8, 8, 8, 8, 8, 8, 8], // all out
  ];
  const drawbarHarmonics = [1, 3, 2, 4, 6, 8, 10, 12, 16];
  const frames: WTFrame[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const f = makeFrame();
    const pos = (i / (FRAME_COUNT - 1)) * (registrations.length - 1);
    const rIdx = Math.min(Math.floor(pos), registrations.length - 2);
    const t = pos - rIdx;
    const r0 = registrations[rIdx], r1 = registrations[rIdx + 1];
    for (let d = 0; d < 9; d++) {
      const amp = ((r0[d] * (1 - t) + r1[d] * t) / 8);
      const k = drawbarHarmonics[d];
      if (k <= NUM_HARMONICS) f.imag[k] += amp;
    }
    frames.push(f);
  }
  return frames;
}

/** 8. Spectral — odd-only → even-only → all harmonics crossfade */
function genSpectral(): WTFrame[] {
  const frames: WTFrame[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const f = makeFrame();
    const pos = i / (FRAME_COUNT - 1);
    for (let k = 1; k <= NUM_HARMONICS; k++) {
      const isOdd = k % 2 === 1;
      let amp: number;
      if (pos <= 0.5) {
        // 0→0.5: odd (1→0) + even (0→1)
        const t = pos * 2;
        amp = isOdd ? (1 - t) : t;
      } else {
        // 0.5→1: even (1→0.5) + odd (0→0.5), converging to all=0.5
        const t = (pos - 0.5) * 2;
        amp = isOdd ? t * 0.5 : (1 - t * 0.5);
      }
      f.imag[k] = amp / k;
    }
    frames.push(f);
  }
  return frames;
}

/** 9. Vocal — breathy formant sweep with wider bandwidths */
function genVocal(): WTFrame[] {
  // Choir-like vowels with wider bandwidths than Formant bank
  const vowels = [
    { f: [350, 600, 2400],  bw: [120, 150, 200] },  // oo
    { f: [450, 800, 2700],  bw: [100, 130, 180] },   // oh
    { f: [700, 1100, 2900], bw: [110, 140, 200] },   // ah
    { f: [500, 1500, 2500], bw: [100, 120, 160] },   // eh
    { f: [350, 2200, 2800], bw: [80, 120, 180] },    // ee
  ];
  const frames: WTFrame[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const f = makeFrame();
    const pos = (i / (FRAME_COUNT - 1)) * (vowels.length - 1);
    const vIdx = Math.min(Math.floor(pos), vowels.length - 2);
    const t = pos - vIdx;
    const v0 = vowels[vIdx], v1 = vowels[vIdx + 1];
    const fc = v0.f.map((f0, j) => f0 * (1 - t) + v1.f[j] * t);
    const bw = v0.bw.map((b0, j) => b0 * (1 - t) + v1.bw[j] * t);
    const f0 = 130;
    for (let k = 1; k <= NUM_HARMONICS; k++) {
      const freq = k * f0;
      let amp = 0.05; // breathy baseline
      for (let p = 0; p < 3; p++) {
        const diff = (freq - fc[p]) / bw[p];
        amp += Math.exp(-0.5 * diff * diff) * (1 - p * 0.15);
      }
      f.imag[k] = amp / Math.sqrt(k);
    }
    frames.push(f);
  }
  return frames;
}

/** 10. Metallic — bell/gong timbres emphasizing inharmonic-adjacent partials */
function genMetallic(): WTFrame[] {
  // Target "inharmonic" ratios (approximated to nearest integer harmonics)
  // Bell partials: 1, 2, 2.76→3, 5.4→5, 8.93→9, 13.34→13
  const bellPartials = [1, 2, 3, 5, 9, 13, 17, 23, 29];
  const frames: WTFrame[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const f = makeFrame();
    const pos = i / (FRAME_COUNT - 1);
    for (let k = 1; k <= NUM_HARMONICS; k++) {
      // Start harmonic (pos=0), end with bell emphasis (pos=1)
      const harmonicAmp = 1 / k;
      let bellAmp = 0;
      for (const bp of bellPartials) {
        const dist = Math.abs(k - bp);
        if (dist <= 1) bellAmp += (1 - dist) * (0.8 / Math.sqrt(bp));
      }
      f.imag[k] = harmonicAmp * (1 - pos) + bellAmp * pos;
    }
    frames.push(f);
  }
  return frames;
}

// ── New bank generators (Phase 1) ───────────────────────────────────────────

/** 11. Supersaw — JP-8000 style, single saw → 7 detuned saws via phase-shifted harmonics */
function genSupersaw(): WTFrame[] {
  const frames: WTFrame[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const f = makeFrame();
    const spread = (i / (FRAME_COUNT - 1)) * 0.06; // detune spread 0→6%
    const numVoices = 7;
    for (let k = 1; k <= NUM_HARMONICS; k++) {
      let re = 0, im = 0;
      for (let v = 0; v < numVoices; v++) {
        const detuneRatio = 1 + (v - (numVoices - 1) / 2) * spread / (numVoices - 1);
        const phase = v * 0.9173; // golden-ratio-ish phase offset per voice
        const sawAmp = (2 / (k * Math.PI)) * (k % 2 === 0 ? -1 : 1);
        re += sawAmp * Math.cos(k * τ * phase * detuneRatio) / numVoices;
        im += sawAmp * Math.sin(k * τ * phase * detuneRatio) / numVoices;
      }
      f.real[k] = re;
      f.imag[k] = im;
    }
    frames.push(f);
  }
  return frames;
}

/** 12. Noise Harmonics — deterministic seeded random amplitudes, sparse → dense */
function genNoiseHarmonics(): WTFrame[] {
  // Simple deterministic hash for reproducibility
  function hash(seed: number): number {
    let x = Math.sin(seed * 12.9898 + seed * 78.233) * 43758.5453;
    return x - Math.floor(x);
  }
  const frames: WTFrame[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const f = makeFrame();
    const density = 1 + (i / (FRAME_COUNT - 1)) * (NUM_HARMONICS - 1);
    for (let k = 1; k <= NUM_HARMONICS; k++) {
      if (k <= density) {
        const amp = hash(k * 137 + 7) * (1 / Math.sqrt(k));
        const phase = hash(k * 251 + 13) * τ;
        f.real[k] = amp * Math.cos(phase);
        f.imag[k] = amp * Math.sin(phase);
      }
    }
    frames.push(f);
  }
  return frames;
}

/** 13. Chaos (Logistic) — harmonic amps from logistic map x = rx(1-x) */
function genChaos(): WTFrame[] {
  const frames: WTFrame[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const f = makeFrame();
    const r = 3.5 + (i / (FRAME_COUNT - 1)) * 0.5; // r = 3.5 → 4.0
    let x = 0.4; // initial condition
    // Warm up the map
    for (let w = 0; w < 100; w++) x = r * x * (1 - x);
    for (let k = 1; k <= NUM_HARMONICS; k++) {
      x = r * x * (1 - x);
      f.imag[k] = (x * 2 - 1) / Math.sqrt(k); // normalize to [-1,1] range, with rolloff
    }
    frames.push(f);
  }
  return frames;
}

/** 14. Additive Sweep — single harmonic scanner, fundamental → 64th harmonic */
function genAdditiveSweep(): WTFrame[] {
  const frames: WTFrame[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const f = makeFrame();
    // Center harmonic sweeps from 1 to 64
    const center = 1 + (i / (FRAME_COUNT - 1)) * 63;
    const width = 2.0; // Gaussian width for smooth transition
    for (let k = 1; k <= NUM_HARMONICS; k++) {
      const dist = (k - center) / width;
      f.imag[k] = Math.exp(-0.5 * dist * dist);
    }
    frames.push(f);
  }
  return frames;
}

/** 15. Wavefold — sine → increasingly folded via Chebyshev polynomials */
function genWavefold(): WTFrame[] {
  const N = 2048;
  const invN = 1 / N;
  const frames: WTFrame[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const f = makeFrame();
    const foldAmount = 1 + (i / (FRAME_COUNT - 1)) * 7; // fold 1x → 8x
    // Generate time-domain folded sine, then DFT
    for (let k = 1; k <= NUM_HARMONICS; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        const t = n * invN;
        // Wavefold: wrap sin(2πt * foldAmount) into [-1,1] via triangle fold
        let v = Math.sin(τ * t * foldAmount);
        // Triangle fold: keep folding back
        v = v % 2;
        if (v > 1) v = 2 - v;
        if (v < -1) v = -2 - v;
        const angle = τ * k * t;
        re += v * Math.cos(angle);
        im -= v * Math.sin(angle);
      }
      f.real[k] = 2 * re * invN;
      f.imag[k] = 2 * im * invN;
    }
    frames.push(f);
  }
  return frames;
}

/** 16. Bit Crush — sine → staircase quantization */
function genBitCrush(): WTFrame[] {
  const N = 2048;
  const invN = 1 / N;
  const frames: WTFrame[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const f = makeFrame();
    // Quantization levels: 256 → 2 (smooth → harsh)
    const levels = Math.max(2, Math.round(256 * Math.pow(2 / 256, i / (FRAME_COUNT - 1))));
    for (let k = 1; k <= NUM_HARMONICS; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        const t = n * invN;
        let v = Math.sin(τ * t);
        // Quantize
        v = Math.round(v * levels / 2) / (levels / 2);
        const angle = τ * k * t;
        re += v * Math.cos(angle);
        im -= v * Math.sin(angle);
      }
      f.real[k] = 2 * re * invN;
      f.imag[k] = 2 * im * invN;
    }
    frames.push(f);
  }
  return frames;
}

/** 17. Resonant Peak — moving bandpass spectral shape */
function genResonantPeak(): WTFrame[] {
  const frames: WTFrame[] = [];
  const f0 = 130; // fundamental reference
  for (let i = 0; i < FRAME_COUNT; i++) {
    const f = makeFrame();
    // Center frequency sweeps from 200Hz to 8000Hz (log scale)
    const centerFreq = 200 * Math.pow(8000 / 200, i / (FRAME_COUNT - 1));
    const q = 8; // resonance
    const bw = centerFreq / q;
    for (let k = 1; k <= NUM_HARMONICS; k++) {
      const freq = k * f0;
      const diff = (freq - centerFreq) / bw;
      const resonance = Math.exp(-0.5 * diff * diff);
      // Add a subtle saw-like base
      const base = 0.05 / k;
      f.imag[k] = base + resonance / Math.sqrt(k);
    }
    frames.push(f);
  }
  return frames;
}

/** 18. Inharmonic Stretch — stretched partials (piano/gamelan) at k^(1+s) */
function genInharmonicStretch(): WTFrame[] {
  const frames: WTFrame[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const f = makeFrame();
    const stretch = (i / (FRAME_COUNT - 1)) * 0.05; // stretch 0 → 0.05
    for (let k = 1; k <= NUM_HARMONICS; k++) {
      // Stretched partial maps to non-integer harmonic index
      const stretchedK = Math.pow(k, 1 + stretch);
      // Place energy at the two nearest integer harmonics
      const kLow = Math.floor(stretchedK);
      const kHigh = kLow + 1;
      const frac = stretchedK - kLow;
      const amp = 1 / Math.sqrt(k);
      if (kLow >= 1 && kLow <= NUM_HARMONICS) {
        f.imag[kLow] += amp * (1 - frac);
      }
      if (kHigh >= 1 && kHigh <= NUM_HARMONICS) {
        f.imag[kHigh] += amp * frac;
      }
    }
    frames.push(f);
  }
  return frames;
}

/** 19. Phase Mod (FM) — carrier:modulator ratio sweep through 1:1, 1:2, 1:3, 1:4 */
function genPhaseMod(): WTFrame[] {
  const frames: WTFrame[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const f = makeFrame();
    // Sweep modulation index 0 → 12 with changing C:M ratios
    const pos = i / (FRAME_COUNT - 1);
    const beta = pos * 12; // modulation index
    // C:M ratio morphs: 1:1 → 1:2 → 1:3 → 1:4
    const ratioFloat = 1 + pos * 3; // 1 → 4
    const ratioLow = Math.floor(ratioFloat);
    const ratioHigh = Math.min(ratioLow + 1, 4);
    const ratioMix = ratioFloat - ratioLow;

    for (let k = 1; k <= NUM_HARMONICS; k++) {
      let amp = 0;
      for (const [ratio, weight] of [[ratioLow, 1 - ratioMix], [ratioHigh, ratioMix]] as [number, number][]) {
        // FM spectrum: sidebands at carrier ± n*modulator
        // For C:M = 1:R, harmonics appear at k = 1 ± n*R
        for (let n = 0; n <= 8; n++) {
          // Bessel J_n(beta) approximation
          let jn = 0;
          for (let m = 0; m <= 8; m++) {
            const sign = m % 2 === 0 ? 1 : -1;
            let factM = 1;
            for (let x = 1; x <= m; x++) factM *= x;
            let factNM = 1;
            for (let x = 1; x <= n + m; x++) factNM *= x;
            jn += sign * Math.pow(beta / 2, n + 2 * m) / (factM * factNM);
          }
          // Sidebands at 1 + n*ratio and |1 - n*ratio|
          const kPlus = 1 + n * ratio;
          const kMinus = Math.abs(1 - n * ratio);
          if (Math.round(kPlus) === k) amp += Math.abs(jn) * weight;
          if (n > 0 && Math.round(kMinus) === k) amp += Math.abs(jn) * weight * 0.7;
        }
      }
      f.imag[k] = Math.min(amp, 1.0) * 0.6;
    }
    frames.push(f);
  }
  return frames;
}

/** 20. Vowel Choir — 5-formant model with phase jitter for breathiness */
function genVowelChoir(): WTFrame[] {
  function hash(seed: number): number {
    let x = Math.sin(seed * 12.9898 + seed * 78.233) * 43758.5453;
    return x - Math.floor(x);
  }
  // 5-formant vowels (F1-F5) for richer choir sound
  const vowels = [
    { f: [300, 600, 2400, 3200, 3800],  bw: [80, 120, 160, 200, 220] },   // oo
    { f: [500, 900, 2600, 3400, 4000],  bw: [90, 130, 170, 200, 220] },    // oh
    { f: [750, 1200, 2800, 3600, 4200], bw: [100, 140, 180, 210, 230] },   // ah
    { f: [550, 1800, 2600, 3400, 4000], bw: [80, 120, 160, 200, 220] },    // eh
    { f: [350, 2300, 2900, 3500, 4100], bw: [70, 110, 150, 200, 220] },    // ee
  ];
  const frames: WTFrame[] = [];
  const f0 = 130;
  for (let i = 0; i < FRAME_COUNT; i++) {
    const f = makeFrame();
    const pos = (i / (FRAME_COUNT - 1)) * (vowels.length - 1);
    const vIdx = Math.min(Math.floor(pos), vowels.length - 2);
    const t = pos - vIdx;
    const v0 = vowels[vIdx], v1 = vowels[vIdx + 1];
    const fc = v0.f.map((fv, j) => fv * (1 - t) + v1.f[j] * t);
    const bw = v0.bw.map((bv, j) => bv * (1 - t) + v1.bw[j] * t);
    for (let k = 1; k <= NUM_HARMONICS; k++) {
      const freq = k * f0;
      let amp = 0.03; // breathy noise floor
      for (let p = 0; p < 5; p++) {
        const diff = (freq - fc[p]) / bw[p];
        amp += Math.exp(-0.5 * diff * diff) * (1 - p * 0.1);
      }
      amp /= Math.pow(k, 0.4);
      // Phase jitter for chorus/breath effect (deterministic)
      const jitter = hash(k * 997 + i * 31) * τ * 0.3;
      f.real[k] = amp * Math.cos(jitter);
      f.imag[k] = amp * Math.sin(jitter);
    }
    frames.push(f);
  }
  return frames;
}

// ── Bank registry ───────────────────────────────────────────────────────────

export const WAVETABLE_BANKS: WTBank[] = [
  // ── Original 10 ──
  { id: 'basic_shapes',    name: 'Basic Shapes',    frameCount: FRAME_COUNT, generate: genBasicShapes },
  { id: 'formant',         name: 'Formant',         frameCount: FRAME_COUNT, generate: genFormant },
  { id: 'digital',         name: 'Digital',         frameCount: FRAME_COUNT, generate: genDigital },
  { id: 'analog',          name: 'Analog',          frameCount: FRAME_COUNT, generate: genAnalog },
  { id: 'pwm',             name: 'PWM',             frameCount: FRAME_COUNT, generate: genPWM },
  { id: 'harmonic_series', name: 'Harmonic Series', frameCount: FRAME_COUNT, generate: genHarmonicSeries },
  { id: 'organ',           name: 'Organ',           frameCount: FRAME_COUNT, generate: genOrgan },
  { id: 'spectral',        name: 'Spectral',        frameCount: FRAME_COUNT, generate: genSpectral },
  { id: 'vocal',           name: 'Vocal',           frameCount: FRAME_COUNT, generate: genVocal },
  { id: 'metallic',        name: 'Metallic',        frameCount: FRAME_COUNT, generate: genMetallic },
  // ── Phase 1: 10 new banks ──
  { id: 'supersaw',        name: 'Supersaw',        frameCount: FRAME_COUNT, generate: genSupersaw },
  { id: 'noise_harmonics', name: 'Noise Harmonics', frameCount: FRAME_COUNT, generate: genNoiseHarmonics },
  { id: 'chaos',           name: 'Chaos',           frameCount: FRAME_COUNT, generate: genChaos },
  { id: 'additive_sweep',  name: 'Additive Sweep',  frameCount: FRAME_COUNT, generate: genAdditiveSweep },
  { id: 'wavefold',        name: 'Wavefold',        frameCount: FRAME_COUNT, generate: genWavefold },
  { id: 'bit_crush',       name: 'Bit Crush',       frameCount: FRAME_COUNT, generate: genBitCrush },
  { id: 'resonant_peak',   name: 'Resonant Peak',   frameCount: FRAME_COUNT, generate: genResonantPeak },
  { id: 'inharmonic',      name: 'Inharmonic',      frameCount: FRAME_COUNT, generate: genInharmonicStretch },
  { id: 'phase_mod',       name: 'Phase Mod',       frameCount: FRAME_COUNT, generate: genPhaseMod },
  { id: 'vowel_choir',     name: 'Vowel Choir',     frameCount: FRAME_COUNT, generate: genVowelChoir },
];

const framesCache = new Map<string, WTFrame[]>();

export function getWTBank(id: string): WTBank | undefined {
  return WAVETABLE_BANKS.find((b) => b.id === id);
}

export function getWTFrames(id: string): WTFrame[] | null {
  if (framesCache.has(id)) return framesCache.get(id)!;
  const bank = getWTBank(id);
  if (!bank) return null;
  const frames = bank.generate();
  framesCache.set(id, frames);
  return frames;
}
