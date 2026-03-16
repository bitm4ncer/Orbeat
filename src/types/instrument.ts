import type { SuperdoughSynthParams, SuperdoughSamplerParams } from './superdough';
import type { LooperParams } from './looper';
import type { SynthParams } from '../audio/synth/types';

export interface Instrument {
  id: string;
  name: string;
  type: 'sampler' | 'synth' | 'looper';
  sampleName?: string;   // superdough sound key (sanitized filename, e.g. 'clap')
  samplePath?: string;   // original file path for waveform display (e.g. 'Folder/clap.wav')
  color: string;
  hits: number;
  hitPositions: number[]; // normalized [0..1) angular positions
  loopSize: number; // steps per loop
  loopSizeLocked: boolean;
  muted: boolean;
  solo: boolean;
  volume: number; // dB
  orbitIndex: number; // superdough orbit channel index (unique per instrument)
  synthParams?: SuperdoughSynthParams;
  engineParams?: SynthParams;
  samplerParams?: SuperdoughSamplerParams;
  looperParams?: LooperParams;
  detectedBpm?: number;       // BPM detected from audio, 0 = unknown
  detectedLoopSize?: number;  // natural step count from BPM detection (for display scaling)
  bpmMultiplier?: number;     // 0.5 | 1 | 2 (half-time / normal / double-time)
}
