export interface LooperParams {
  gain: number;           // 0-1
  speed: number;          // manual playback rate multiplier (when stretch OFF)
  attack: number;         // 0-2s
  release: number;        // 0-2s
  pan: number;            // -1 to 1
  cutoff: number;         // Hz, 20-20000
  resonance: number;      // 0-50
  pitchSemitones: number; // -24 to +24, pitch offset in semitones
  reverse: boolean;       // reverse playback
  startOffset: number;    // 0-1 normalized, shifts loop start point (phase)
  stretchToSteps: boolean; // time-stretch sample to fill grid steps
  keepPitch: boolean;     // pitch-independent speed via phase vocoder
}

export const DEFAULT_LOOPER_PARAMS: LooperParams = {
  gain: 0.9,
  speed: 1,
  attack: 0.001,
  release: 0.05,
  pan: 0,
  cutoff: 20000,
  resonance: 0,
  pitchSemitones: 0,
  reverse: false,
  startOffset: 0,
  stretchToSteps: false,
  keepPitch: false,
};

export interface LooperEditorState {
  audioBuffer: AudioBuffer | null;
  peaks: Float32Array | null;
  peakResolution: number;           // number of peak buckets (256-2048)
  loopIn: number;                   // loop region start, normalized 0-1
  loopOut: number;                  // loop region end, normalized 0-1
  viewStart: number;                // zoom range 0-1
  viewEnd: number;
}

export function createLooperEditorState(): LooperEditorState {
  return {
    audioBuffer: null,
    peaks: null,
    peakResolution: 2048,
    loopIn: 0,
    loopOut: 1,
    viewStart: 0,
    viewEnd: 1,
  };
}
