import type { SynthParams } from '../audio/synth/types';
import type { Instrument } from './instrument';
import type { Effect } from './effects';
import type { InstrumentScene } from './scene';
import type { ArrangementStep } from './arrangement';

// ── Synth Presets ─────────────────────────────────────────────────────────────

export interface PresetMeta {
  id: string;
  name: string;
  folder: string;             // e.g. "Factory/Bass" or "User/My Sounds"
  source: 'factory' | 'user';
  createdAt: number;          // epoch ms
  updatedAt: number;
  starred?: boolean;          // favorite/starred status
}

export interface SynthPreset extends PresetMeta {
  params: SynthParams;
}

// ── Effect Presets ───────────────────────────────────────────────────────────

export interface EffectPreset extends PresetMeta {
  effectType: string;                // EffectType — e.g. 'delay', 'reverb'
  params: Record<string, number>;
}

// ── Sets (Projects) ───────────────────────────────────────────────────────────

export interface SetMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  thumbnail?: string;      // JPEG data URL for preview (~10-15KB)
  versionCount?: number;   // quick count without loading full versions array
}

export interface SetVersion {
  versionId: string;
  timestamp: number;
  source: 'manual' | 'autosave';
  thumbnail?: string;      // JPEG data URL
}

export interface SetVersionEntry extends SetVersion {
  snapshot: string;         // gzip+base64url of OrbitrackSet JSON (without versions array)
}

export interface EmbeddedSample {
  key: string;
  name: string;
  mimeType: string;
  base64: string;
}

export interface OrbitrackSet {
  id: string;           // top-level key for IndexedDB (mirrors meta.id)
  version: 1;
  meta: SetMeta;
  bpm: number;
  stepsPerBeat?: number; // 4=16th, 8=32nd, 16=64th (optional, defaults to 8 on load)
  masterVolume: number;
  instruments: Instrument[];
  gridNotes: Record<string, number[][]>;
  gridGlide: Record<string, boolean[]>;
  gridLengths: Record<string, number[] | number[][]>;
  gridVelocities?: Record<string, number[]>;
  instrumentEffects: Record<string, Effect[]>;
  masterEffects?: Effect[];
  groups?: InstrumentScene[];  // legacy: for backward compat on load
  scenes?: InstrumentScene[];
  groupEffects?: Record<string, Effect[]>;  // legacy: for backward compat on load
  sceneEffects?: Record<string, Effect[]>;
  customSamples?: EmbeddedSample[];
  versions?: SetVersionEntry[];   // newest-first, capped at 50
  gridResolution?: number;
  scaleRoot?: number;
  scaleType?: string;
  trackMode?: boolean;
  arrangement?: ArrangementStep[];
  liveLaunchQuantize?: 1 | 2 | 4 | 8;
  liveLaunchMode?: 'queue' | 'stack';
}

// ── Sample Library ────────────────────────────────────────────────────────────

export interface SampleMeta {
  key: string;
  name: string;
  blob: Blob;
  createdAt: number;
}

// ── User / Account (future) ──────────────────────────────────────────────────

export interface User {
  id: string;
  email?: string;
  plan: 'free' | 'pro';
  createdAt: number;
}
