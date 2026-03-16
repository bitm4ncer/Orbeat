/**
 * Wavetable interpolation engine — handles frame blending, spectral warping,
 * PeriodicWave caching (256-step quantized), and time-domain sampling for display.
 */

import type { WTFrame } from './types';
import { NUM_HARMONICS } from './wavetables';
import { getWTFrames } from './wavetableBanks';

const COEFF_LEN = NUM_HARMONICS + 1;
const QUANT_STEPS = 256;
const τ = Math.PI * 2;

// ── Frame interpolation ────────────────────────────────────────────────────

export function interpolateFrames(frames: WTFrame[], position: number): WTFrame {
  const count = frames.length;
  const pos = Math.max(0, Math.min(1, position)) * (count - 1);
  const idx = Math.floor(pos);
  const frac = pos - idx;

  if (frac < 0.001 || idx >= count - 1) {
    return frames[Math.min(idx, count - 1)];
  }

  const a = frames[idx];
  const b = frames[idx + 1];
  const real = new Float32Array(COEFF_LEN);
  const imag = new Float32Array(COEFF_LEN);
  const t1 = 1 - frac;

  for (let k = 0; k < COEFF_LEN; k++) {
    real[k] = a.real[k] * t1 + b.real[k] * frac;
    imag[k] = a.imag[k] * t1 + b.imag[k] * frac;
  }

  return { real, imag };
}

// ── Spectral Warp Modes ────────────────────────────────────────────────────

export const WARP_MODE_NAMES = [
  'NONE', 'STRETCH', 'COMPRESS', 'TILT',
  'ODD/EVEN', 'COMB', 'SHIFT', 'PHASE RAND',
  'PHASE SPREAD', 'FOLD', 'QUANTIZE', 'REVERSE',
  'RING', 'FORMANT', 'FRACTAL', 'SYNC',
] as const;

export const WARP_MODE_COUNT = WARP_MODE_NAMES.length;

/** Deterministic hash for reproducible randomization */
function hash(seed: number): number {
  let x = Math.sin(seed * 12.9898 + seed * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Apply a spectral warp transformation to a WTFrame's Fourier coefficients.
 * Operates on the 128-harmonic arrays — computationally cheap (~128 float ops).
 */
export function applySpectralWarp(src: WTFrame, mode: number, amount: number): WTFrame {
  if (mode === 0 || amount < 0.001) return src;

  const real = new Float32Array(COEFF_LEN);
  const imag = new Float32Array(COEFF_LEN);
  const a = Math.max(0, Math.min(1, amount));

  switch (mode) {
    case 1: { // STRETCH — shift harmonics up (spectral stretch via resampling)
      const factor = 1 + a * 3; // stretch by 1x–4x
      for (let k = 1; k <= NUM_HARMONICS; k++) {
        const srcK = k / factor;
        const kLow = Math.floor(srcK);
        const kHigh = kLow + 1;
        const frac = srcK - kLow;
        if (kLow >= 1 && kLow <= NUM_HARMONICS) {
          real[k] += src.real[kLow] * (1 - frac);
          imag[k] += src.imag[kLow] * (1 - frac);
        }
        if (kHigh >= 1 && kHigh <= NUM_HARMONICS) {
          real[k] += src.real[kHigh] * frac;
          imag[k] += src.imag[kHigh] * frac;
        }
      }
      return { real, imag };
    }

    case 2: { // COMPRESS — squeeze spectrum toward fundamental
      const factor = 1 / (1 + a * 3); // compress by 1x–0.25x
      for (let k = 1; k <= NUM_HARMONICS; k++) {
        const srcK = k / factor;
        const kLow = Math.floor(srcK);
        const kHigh = kLow + 1;
        const frac = srcK - kLow;
        if (kLow >= 1 && kLow <= NUM_HARMONICS) {
          real[k] += src.real[kLow] * (1 - frac);
          imag[k] += src.imag[kLow] * (1 - frac);
        }
        if (kHigh >= 1 && kHigh <= NUM_HARMONICS) {
          real[k] += src.real[kHigh] * frac;
          imag[k] += src.imag[kHigh] * frac;
        }
      }
      return { real, imag };
    }

    case 3: { // TILT — spectral slope: boost lows / cut highs or vice versa
      const tilt = (a - 0.5) * 4; // -2 to +2 exponent offset
      for (let k = 1; k <= NUM_HARMONICS; k++) {
        const scale = Math.pow(k, -tilt);
        real[k] = src.real[k] * scale;
        imag[k] = src.imag[k] * scale;
      }
      return { real, imag };
    }

    case 4: { // ODD/EVEN — crossfade between odd and even harmonics
      for (let k = 1; k <= NUM_HARMONICS; k++) {
        const isOdd = k % 2 === 1;
        // a=0: all harmonics, a=0.5: odd only, a=1: even only
        let scale: number;
        if (a <= 0.5) {
          const t = a * 2; // 0→1
          scale = isOdd ? 1 : (1 - t);
        } else {
          const t = (a - 0.5) * 2; // 0→1
          scale = isOdd ? (1 - t) : 1;
        }
        real[k] = src.real[k] * scale;
        imag[k] = src.imag[k] * scale;
      }
      return { real, imag };
    }

    case 5: { // COMB — zero every Nth harmonic
      const n = Math.max(2, Math.round(2 + a * 14)); // N = 2→16
      for (let k = 1; k <= NUM_HARMONICS; k++) {
        const scale = (k % n === 0) ? 0 : 1;
        real[k] = src.real[k] * scale;
        imag[k] = src.imag[k] * scale;
      }
      return { real, imag };
    }

    case 6: { // SHIFT — frequency shift (moves all harmonics up by offset)
      const shift = Math.round(a * 32); // shift 0→32 harmonics up
      for (let k = 1; k <= NUM_HARMONICS; k++) {
        const srcK = k - shift;
        if (srcK >= 1 && srcK <= NUM_HARMONICS) {
          real[k] = src.real[srcK];
          imag[k] = src.imag[srcK];
        }
      }
      return { real, imag };
    }

    case 7: { // PHASE RAND — randomize phases, preserve magnitudes
      for (let k = 1; k <= NUM_HARMONICS; k++) {
        const mag = Math.sqrt(src.real[k] * src.real[k] + src.imag[k] * src.imag[k]);
        const origPhase = Math.atan2(src.imag[k], src.real[k]);
        const randPhase = hash(k * 137) * τ;
        const phase = origPhase + randPhase * a;
        real[k] = mag * Math.cos(phase);
        imag[k] = mag * Math.sin(phase);
      }
      return { real, imag };
    }

    case 8: { // PHASE SPREAD — Schroeder all-pass phase dispersion
      for (let k = 1; k <= NUM_HARMONICS; k++) {
        const mag = Math.sqrt(src.real[k] * src.real[k] + src.imag[k] * src.imag[k]);
        const origPhase = Math.atan2(src.imag[k], src.real[k]);
        // Schroeder phase: π * k * (k-1) / N, scaled by amount
        const spread = Math.PI * k * (k - 1) / NUM_HARMONICS * a;
        const phase = origPhase + spread;
        real[k] = mag * Math.cos(phase);
        imag[k] = mag * Math.sin(phase);
      }
      return { real, imag };
    }

    case 9: { // FOLD — fold harmonics above threshold back down
      const threshold = Math.max(1, Math.round(NUM_HARMONICS * (1 - a))); // fold point
      for (let k = 1; k <= NUM_HARMONICS; k++) {
        if (k <= threshold) {
          real[k] = src.real[k];
          imag[k] = src.imag[k];
        } else {
          // Fold back: k above threshold reflects down
          const folded = threshold - (k - threshold);
          if (folded >= 1) {
            real[folded] += src.real[k] * 0.7;
            imag[folded] += src.imag[k] * 0.7;
          }
        }
      }
      return { real, imag };
    }

    case 10: { // QUANTIZE — quantize harmonic amplitudes to N levels
      const levels = Math.max(2, Math.round(64 * (1 - a) + 2 * a)); // 64→2 levels
      for (let k = 1; k <= NUM_HARMONICS; k++) {
        const mag = Math.sqrt(src.real[k] * src.real[k] + src.imag[k] * src.imag[k]);
        const phase = Math.atan2(src.imag[k], src.real[k]);
        const qMag = Math.round(mag * levels) / levels;
        real[k] = qMag * Math.cos(phase);
        imag[k] = qMag * Math.sin(phase);
      }
      return { real, imag };
    }

    case 11: { // REVERSE — flip harmonic order (crossfade with amount)
      for (let k = 1; k <= NUM_HARMONICS; k++) {
        const rk = NUM_HARMONICS - k + 1;
        real[k] = src.real[k] * (1 - a) + src.real[rk] * a;
        imag[k] = src.imag[k] * (1 - a) + src.imag[rk] * a;
      }
      return { real, imag };
    }

    case 12: { // RING — spectral ring mod (multiply by carrier pattern)
      const carrierFreq = 1 + a * 15; // carrier at harmonic 1→16
      for (let k = 1; k <= NUM_HARMONICS; k++) {
        const mod = Math.cos(τ * k / carrierFreq);
        real[k] = src.real[k] * mod;
        imag[k] = src.imag[k] * mod;
      }
      return { real, imag };
    }

    case 13: { // FORMANT — apply resonant bandpass peaks to spectrum
      const centerK = 1 + a * (NUM_HARMONICS - 1); // peak harmonic
      const bw = 4 + (1 - a) * 12; // bandwidth narrows with amount
      for (let k = 1; k <= NUM_HARMONICS; k++) {
        const diff = (k - centerK) / bw;
        const env = Math.exp(-0.5 * diff * diff);
        // Blend: at a=0 passthrough, at a=1 fully filtered
        const scale = 1 - a + a * env;
        real[k] = src.real[k] * scale;
        imag[k] = src.imag[k] * scale;
      }
      return { real, imag };
    }

    case 14: { // FRACTAL — self-similar: copy+scale spectrum at octave intervals
      // Start with original
      for (let k = 1; k <= NUM_HARMONICS; k++) {
        real[k] = src.real[k];
        imag[k] = src.imag[k];
      }
      // Add scaled copies at octave multiples
      const depth = Math.round(1 + a * 3); // 1→4 octave copies
      for (let oct = 1; oct <= depth; oct++) {
        const scale = Math.pow(0.5, oct) * a;
        const mult = Math.pow(2, oct);
        for (let k = 1; k <= NUM_HARMONICS; k++) {
          const srcK = Math.round(k / mult);
          if (srcK >= 1 && srcK <= NUM_HARMONICS) {
            real[k] += src.real[srcK] * scale;
            imag[k] += src.imag[srcK] * scale;
          }
        }
      }
      return { real, imag };
    }

    case 15: { // SYNC — simulate hard sync by harmonic multiplication
      const syncRatio = 1 + a * 4; // 1→5x sync ratio
      for (let k = 1; k <= NUM_HARMONICS; k++) {
        // Resample spectrum at sync ratio intervals
        const srcK = k * syncRatio;
        const kLow = Math.floor(srcK);
        const kHigh = kLow + 1;
        const frac = srcK - kLow;
        if (kLow >= 1 && kLow <= NUM_HARMONICS) {
          real[k] += src.real[kLow] * (1 - frac);
          imag[k] += src.imag[kLow] * (1 - frac);
        }
        if (kHigh >= 1 && kHigh <= NUM_HARMONICS) {
          real[k] += src.real[kHigh] * frac;
          imag[k] += src.imag[kHigh] * frac;
        }
      }
      return { real, imag };
    }

    default:
      return src;
  }
}

// ── PeriodicWave cache (quantized to 1/256 steps) ──────────────────────────

const waveCache = new WeakMap<AudioContext, Map<string, PeriodicWave>>();

function cacheKey(bankId: string, position: number, warpMode = 0, warpAmount = 0): string {
  if (warpMode === 0 || warpAmount < 0.001) {
    return `${bankId}:${Math.round(position * QUANT_STEPS)}`;
  }
  return `${bankId}:${Math.round(position * QUANT_STEPS)}:${warpMode}:${Math.round(warpAmount * QUANT_STEPS)}`;
}

export function getInterpolatedPeriodicWave(
  ac: AudioContext,
  bankId: string,
  position: number,
  warpMode = 0,
  warpAmount = 0,
): PeriodicWave | null {
  const frames = getWTFrames(bankId);
  if (!frames) return null;

  const key = cacheKey(bankId, position, warpMode, warpAmount);
  let ctxMap = waveCache.get(ac);
  if (!ctxMap) { ctxMap = new Map(); waveCache.set(ac, ctxMap); }

  if (ctxMap.has(key)) return ctxMap.get(key)!;

  // Limit cache size per context to ~256 entries
  if (ctxMap.size > 256) {
    const firstKey = ctxMap.keys().next().value;
    if (firstKey !== undefined) ctxMap.delete(firstKey);
  }

  let frame = interpolateFrames(frames, position);
  frame = applySpectralWarp(frame, warpMode, warpAmount);
  const wave = ac.createPeriodicWave(frame.real, frame.imag, { disableNormalization: false });
  ctxMap.set(key, wave);
  return wave;
}

// ── Time-domain sampling for display ────────────────────────────────────────

const displayCache = new Map<string, Float32Array>();
const DISPLAY_SAMPLES = 512;

function displayCacheKey(bankId: string, position: number, warpMode = 0, warpAmount = 0): string {
  if (warpMode === 0 || warpAmount < 0.001) {
    return `d:${bankId}:${Math.round(position * QUANT_STEPS)}`;
  }
  return `d:${bankId}:${Math.round(position * QUANT_STEPS)}:${warpMode}:${Math.round(warpAmount * QUANT_STEPS)}`;
}

/**
 * Sample the wavetable waveform at a given position for display.
 * Returns a value at time t ∈ [0,1) by reconstructing from Fourier coefficients.
 */
export function sampleWTWaveShape(
  bankId: string,
  position: number,
  t: number,
  warpMode = 0,
  warpAmount = 0,
): number {
  const key = displayCacheKey(bankId, position, warpMode, warpAmount);

  // Check if we have a cached waveform array
  let samples = displayCache.get(key);
  if (!samples) {
    const frames = getWTFrames(bankId);
    if (!frames) return 0;

    let frame = interpolateFrames(frames, position);
    frame = applySpectralWarp(frame, warpMode, warpAmount);
    samples = new Float32Array(DISPLAY_SAMPLES);

    for (let n = 0; n < DISPLAY_SAMPLES; n++) {
      const phase = n / DISPLAY_SAMPLES;
      let val = 0;
      for (let k = 1; k <= NUM_HARMONICS; k++) {
        const angle = k * Math.PI * 2 * phase;
        val += frame.real[k] * Math.cos(angle) + frame.imag[k] * Math.sin(angle);
      }
      samples[n] = val;
    }

    // Limit display cache size
    if (displayCache.size > 64) {
      const firstKey = displayCache.keys().next().value;
      if (firstKey !== undefined) displayCache.delete(firstKey);
    }
    displayCache.set(key, samples);
  }

  // Lookup in cached samples with linear interpolation
  const idx = ((t % 1) + 1) % 1 * DISPLAY_SAMPLES;
  const i0 = Math.floor(idx) % DISPLAY_SAMPLES;
  const i1 = (i0 + 1) % DISPLAY_SAMPLES;
  const frac = idx - Math.floor(idx);
  return samples[i0] * (1 - frac) + samples[i1] * frac;
}
