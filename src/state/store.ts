import { create } from 'zustand';
import * as Tone from 'tone';
import { PASTEL_COLORS } from '../canvas/colors';
import type { Instrument } from '../types/instrument';
import type { Effect, EffectType } from '../types/effects';
import type { InstrumentScene } from '../types/scene';
import { SCENE_COLORS } from '../types/scene';
import type { ArrangementStep } from '../types/arrangement';
import type { SuperdoughSynthParams, SuperdoughSamplerParams } from '../types/superdough';
import type { SynthParams } from '../audio/synth/types';
import { DEFAULT_SYNTH_PARAMS, DEFAULT_SAMPLER_PARAMS } from '../types/superdough';
import { DEFAULT_EFFECT_PARAMS } from '../audio/effectParams';
import { loadSample } from '../audio/sampler';
import { registerSampleForPlayback } from '../audio/engine';
import { preloadSample, preloadCustomSample } from '../audio/sampleCache';
import { SAMPLE_BASE_URL } from '../audio/sampleBaseUrl';
import type { LooperParams, LooperEditorState } from '../types/looper';
import { DEFAULT_LOOPER_PARAMS, createLooperEditorState } from '../types/looper';
import { extractPeaks, bufferToBlobUrl, revokeBlobUrl } from '../audio/bufferOps';
import { estimateLoopSize, detectBpm } from '../audio/transientDetector';
import { getCachedBpm, setCachedBpm } from '../audio/bpmCache';
import type { OrbitrackSet } from '../types/storage';
import { base64ToBlob } from '../storage/serializer';
import { generateName } from '../utils/nameGenerator';
import { startRecording as recStart, stopRecordingAsync, type RecordingFormat } from '../audio/recorder';
import {
  saveRecording as dbSaveRec, deleteRecordingFromDB as dbDelRec,
  saveFolder as dbSaveFolder, deleteFolderFromDB as dbDelFolder,
  loadAllRecordings, loadAllFolders,
  type StoredRecording,
} from '../storage/recordingStore';
import { postSync } from '../storage/recordingSync';
import { createSceneBus, routeOrbitToScene, unrouteOrbitFromScene, destroySceneBus, destroyAllSceneBuses, initSceneBusesFromState } from '../audio/sceneBus';
import { fetchSampleTree, type SampleEntry } from '../audio/sampleApi';
import { removeSynthEngine } from '../audio/synthManager';
import { destroyOrbitChain } from '../audio/orbitEffects';
import type { MidiSettings } from '../types/midi';
import { saveMidiSettings, loadMidiSettings } from '../storage/midiSettingsStorage';
import { startInputCapture, stopInputCapture, setInputMonitor } from '../audio/audioInput';

// LLM Generation settings types
export type LLMEndpointType = 'none' | 'ollama' | 'claude' | 'custom';

export interface GenSettings {
  endpointType: LLMEndpointType;
  ollamaModel: string;
  ollamaUrl: string;
  customUrl: string;
  claudeModel: string;
  streamingEnabled: boolean;
}

export const DEFAULT_GEN_SETTINGS: GenSettings = {
  endpointType: 'none',
  ollamaModel: 'llama3.2',
  ollamaUrl: 'http://localhost:11434',
  customUrl: '',
  claudeModel: 'claude-3-5-haiku-20241022',
  streamingEnabled: false,
};

function generateEvenHits(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i / count);
}

function createId(): string {
  return Math.random().toString(36).slice(2, 9);
}

// Snap a [0,1) position to the nearest grid slot
function snapToGrid(pos: number, gridSize: number): number {
  return Math.round(pos * gridSize) % gridSize / gridSize;
}

function randomHits(min = 1, max = 8): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Sample favorites helpers
function loadSampleFavorites(): string[] {
  try {
    const stored = localStorage.getItem('orbitrack-sample-favorites');
    return stored ? JSON.parse(stored) : [];
  } catch (e) {
    console.error('Failed to load sample favorites:', e);
    return [];
  }
}

function saveSampleFavorites(paths: string[]): void {
  try {
    localStorage.setItem('orbitrack-sample-favorites', JSON.stringify(paths));
  } catch (e) {
    console.error('Failed to save sample favorites:', e);
  }
}

// Orbit index counter — incremented each time a new instrument is added
let orbitCounter = 0;

/** Reset orbit counter to a specific value (used by autosave restore). */
export function setOrbitCounter(value: number): void {
  orbitCounter = value;
}

const defaultInstruments: Instrument[] = (() => {
  const kickHits = randomHits(2, 6);
  const snareHits = randomHits(1, 5);
  const hihatHits = randomHits(3, 8);
  const clapHits = randomHits(1, 4);
  return [
    {
      id: createId(),
      name: 'Kick',
      type: 'sampler',
      sampleName: 'kick',
      color: PASTEL_COLORS[0],
      hits: kickHits,
      hitPositions: generateEvenHits(kickHits),
      loopSize: 16,
      loopSizeLocked: false,
      muted: false,
      solo: false,
      volume: 0,
      orbitIndex: orbitCounter++,
      samplerParams: { ...DEFAULT_SAMPLER_PARAMS },
    },
    {
      id: createId(),
      name: 'Snare',
      type: 'sampler',
      sampleName: 'snare',
      color: PASTEL_COLORS[1],
      hits: snareHits,
      hitPositions: generateEvenHits(snareHits),
      loopSize: 16,
      loopSizeLocked: false,
      muted: false,
      solo: false,
      volume: 0,
      orbitIndex: orbitCounter++,
      samplerParams: { ...DEFAULT_SAMPLER_PARAMS },
    },
    {
      id: createId(),
      name: 'Hi-Hat',
      type: 'sampler',
      sampleName: 'hihat',
      color: PASTEL_COLORS[2],
      hits: hihatHits,
      hitPositions: generateEvenHits(hihatHits),
      loopSize: 16,
      loopSizeLocked: false,
      muted: false,
      solo: false,
      volume: -3,
      orbitIndex: orbitCounter++,
      samplerParams: { ...DEFAULT_SAMPLER_PARAMS },
    },
    {
      id: createId(),
      name: 'Clap',
      type: 'sampler',
      sampleName: 'clap',
      color: PASTEL_COLORS[4],
      hits: clapHits,
      hitPositions: generateEvenHits(clapHits),
      loopSize: 16,
      loopSizeLocked: false,
      muted: true,
      solo: false,
      volume: -2,
      orbitIndex: orbitCounter++,
      samplerParams: { ...DEFAULT_SAMPLER_PARAMS },
    },
  ];
})();

export interface StoreState {
  // Transport
  bpm: number;
  stepsPerBeat: number;         // 4=16th, 8=32nd, 16=64th notes (default 4)
  isPlaying: boolean;
  currentStep: number;
  transportProgress: number;
  trackStepProgress: number;

  // Instruments
  instruments: Instrument[];
  selectedInstrumentId: string | null;
  selectedInstrumentIds: string[];
  selectedSceneId: string | null;
  renamingId: string | null;          // ID of instrument or group currently being renamed

  // Scenes
  scenes: InstrumentScene[];
  sceneEffects: Record<string, Effect[]>;

  // Track Mode
  trackMode: boolean;
  arrangement: ArrangementStep[];
  trackPosition: number;

  // Live Mode (Ableton-style session view)
  liveMode: boolean;
  liveLaunchMode: 'queue' | 'stack';
  liveActiveSceneId: string | null;
  liveQueuedSceneId: string | null;
  liveLaunchQuantize: 1 | 2 | 4 | 8;
  liveBarCountdown: number;
  liveBarsElapsed: number;
  // Stack mode: multiple scenes active simultaneously
  liveActiveSceneIds: string[];
  liveQueuedToggles: string[]; // scene IDs queued to toggle at next bar boundary

  // Transport actions
  setBpm: (bpm: number) => void;
  setStepsPerBeat: (stepsPerBeat: number) => void;
  setPlaying: (playing: boolean) => void;
  setCurrentStep: (step: number) => void;
  setTransportProgress: (progress: number) => void;

  // Instrument actions
  setInstruments: (instruments: Instrument[]) => void;
  updateInstrument: (id: string, updates: Partial<Instrument>) => void;
  setHitCount: (id: string, hits: number) => void;
  addHit: (id: string, position: number) => void;
  addSamplerHit: (id: string, position: number, midiNote?: number) => void;
  removeHit: (id: string, hitIndex: number) => void;
  moveSamplerNoteToStep: (id: string, fromStep: number, toStep: number, midiNote: number) => void;
  selectInstrument: (id: string | null) => void;
  toggleSelectInstrument: (id: string) => void;
  toggleMute: (id: string) => void;
  toggleSolo: (id: string) => void;
  removeInstrument: (id: string) => void;
  duplicateInstrument: (id: string) => void;
  randomizeHits: (id: string) => void;
  toggleLoopSizeLock: (id: string) => void;
  updateSynthParams: (id: string, params: Partial<SuperdoughSynthParams>) => void;
  updateEngineParams: (id: string, params: SynthParams) => void;
  updateSamplerParams: (id: string, params: Partial<SuperdoughSamplerParams>) => void;

  // Grid sequencer (per synth instrument)
  // gridNotes[instrumentId][hitIndex] = array of MIDI note numbers
  gridNotes: Record<string, number[][]>;
  gridGlide: Record<string, boolean[]>;
  gridLengths: Record<string, number[]>;
  gridVelocities: Record<string, number[]>;
  octaveOffset: number;

  setGridNote: (instrumentId: string, hitIndex: number, notes: number[]) => void;
  setGridGlide: (instrumentId: string, hitIndex: number, glide: boolean) => void;
  setGridLength: (instrumentId: string, hitIndex: number, length: number) => void;
  setGridVelocity: (instrumentId: string, hitIndex: number, velocity: number) => void;
  toggleGridNote: (instrumentId: string, hitIndex: number, midiNote: number) => void;
  moveGridNote: (instrumentId: string, hitIndex: number, fromNote: number, toNote: number) => void;
  moveGridNoteToStep: (instrumentId: string, fromHitIndex: number, toHitIndex: number, midiNote: number) => void;
  setOctaveOffset: (offset: number) => void;
  applyChordPreset: (instrumentId: string, chords: number[][], steps: number) => void;
  /** Move a batch of notes by a step/pitch delta atomically (for multi-select drag). */
  moveNotesBatch: (id: string, notes: { step: number; midi: number }[], stepDelta: number, pitchDelta: number) => void;
  /** Remove notes that fall within the time range of other notes at the same pitch. */
  removeOverlappedNotes: (id: string, ranges: { step: number; midi: number; length: number }[]) => void;
  /** Add notes in batch (for paste/duplicate). Returns the new note keys for selection. */
  addNotesBatch: (id: string, notes: { step: number; midi: number; length: number; velocity: number; glide: boolean }[]) => void;

  // Per-instrument progress (0-1) for polyrhythm
  instrumentProgress: Record<string, number>;
  setInstrumentProgress: (progress: Record<string, number>) => void;
  // Batched UI update — single set() call instead of three separate dispatches
  setPlaybackUI: (progress: number, currentStep: number, instProgress: Record<string, number>, trackPosition?: number, trackStepProgress?: number) => void;
  setLoopSize: (id: string, size: number) => void;

  // Default instrument type for the Add card
  addInstrumentType: 'sampler' | 'synth' | 'looper';
  setAddInstrumentType: (type: 'sampler' | 'synth' | 'looper') => void;

  // Snap to 16th note grid
  snapEnabled: boolean;
  setSnapEnabled: (enabled: boolean) => void;
  spinMode?: boolean;
  orbitDisplayMode: 'classic' | 'led' | 'rotate' | 'chase';
  setOrbitDisplayMode: (mode: 'classic' | 'led' | 'rotate' | 'chase') => void;
  showPerformanceMonitor: boolean;
  setShowPerformanceMonitor: (enabled: boolean) => void;

  // Synth panel mode: inline sidebar, floating window, or popout browser window
  synthPanelMode: 'inline' | 'floating' | 'popout';
  synthFloatPos: { x: number; y: number };
  synthFloatSize: { w: number; h: number };
  synthFloatMinimized: boolean;
  synthPanelCollapsed: boolean;
  setSynthPanelMode: (mode: 'inline' | 'floating' | 'popout') => void;
  setSynthFloatPos: (pos: { x: number; y: number }) => void;
  setSynthFloatSize: (size: { w: number; h: number }) => void;
  setSynthFloatMinimized: (minimized: boolean) => void;
  setSynthPanelCollapsed: (collapsed: boolean) => void;

  // Logging
  logEnabled: boolean;
  showLogConsole: boolean;
  setLogEnabled: (enabled: boolean) => void;
  setShowLogConsole: (show: boolean) => void;

  // Grid resolution: 1 = every step (1/16), 2 = 1/8, 4 = 1/4, 8 = 1/2
  gridResolution: number;
  setGridResolution: (res: number) => void;

  // Scale filter for piano roll
  scaleRoot: number;         // 0=C, 1=C#, ..., 11=B
  scaleType: string;         // key into SCALES map (e.g. 'chromatic', 'major')
  setScaleRoot: (root: number) => void;
  setScaleType: (type: string) => void;

  // Generation undo (per instrument snapshot before generation)
  generationUndo: Record<string, {
    hitPositions: number[];
    hits: number;
    gridNotes: number[][];
    gridLengths: number[];
    gridGlide: boolean[];
  }>;
  snapshotForUndo: (instrumentId: string) => void;
  undoGeneration: (instrumentId: string) => void;

  // Sample bank
  sampleBankOpen: boolean;
  sampleBankInstrumentId: string | null;
  openSampleBank: (instrumentId: string) => void;
  closeSampleBank: () => void;
  assignSample: (instrumentId: string, samplePath: string, displayName: string) => void;

  // Custom imported samples
  customSamples: { key: string; url: string; name: string }[];
  addCustomSample: (sample: { key: string; url: string; name: string }) => void;
  removeCustomSample: (key: string) => void;

  // Per-instrument effect chains
  instrumentEffects: Record<string, Effect[]>;
  masterEffects: Effect[];
  masterVolume: number; // 0-1 linear

  addEffect: (instrumentId: string, type: EffectType) => void;
  addMasterEffect: (type: EffectType) => void;
  removeEffect: (instrumentId: string, effectId: string) => void;
  setEffectParam: (instrumentId: string, effectId: string, key: string, value: number) => void;
  toggleEffectEnabled: (instrumentId: string, effectId: string) => void;
  toggleEffectCollapsed: (instrumentId: string, effectId: string) => void;
  reorderEffects: (instrumentId: string, fromIdx: number, toIdx: number) => void;

  setMasterVolume: (vol: number) => void;

  // Group actions
  sceneSelected: () => void;
  unsceneSelected: () => void;
  selectScene: (groupId: string | null) => void;
  toggleSceneMute: (groupId: string) => void;
  toggleSceneSolo: (groupId: string) => void;
  setSceneVolume: (groupId: string, volume: number) => void;
  toggleSceneCollapsed: (groupId: string) => void;
  renameScene: (groupId: string, name: string) => void;
  deleteScene: (sceneId: string) => void;
  setRenamingId: (id: string | null) => void;
  addSceneEffect: (groupId: string, type: EffectType) => void;
  removeSceneEffect: (groupId: string, effectId: string) => void;
  setSceneEffectParam: (groupId: string, effectId: string, key: string, value: number) => void;
  toggleSceneEffectEnabled: (groupId: string, effectId: string) => void;
  toggleSceneEffectCollapsed: (groupId: string, effectId: string) => void;
  reorderSceneEffects: (groupId: string, fromIdx: number, toIdx: number) => void;
  addInstrumentToScene: (instrumentId: string, sceneId: string) => void;
  removeInstrumentFromScene: (instrumentId: string, sceneId: string) => void;

  // Track Mode actions
  toggleTrackMode: () => void;
  addArrangementStep: (sceneId: string, bars?: number) => void;
  removeArrangementStep: (stepId: string) => void;
  reorderArrangementSteps: (fromIdx: number, toIdx: number) => void;
  setArrangementStepBars: (stepId: string, bars: number) => void;
  duplicateArrangementStep: (stepId: string) => void;
  setTrackPosition: (index: number) => void;
  setTrackStepProgress: (progress: number) => void;

  // Live Mode actions
  toggleLiveMode: () => void;
  setLiveLaunchMode: (mode: 'queue' | 'stack') => void;
  launchScene: (sceneId: string) => void;
  stopLiveScene: () => void;
  setLiveLaunchQuantize: (bars: 1 | 2 | 4 | 8) => void;
  setLiveBarCountdown: (n: number) => void;
  setLiveBarsElapsed: (n: number) => void;
  switchToQueuedScene: () => void;
  processStackToggles: () => void;

  // Recording
  isRecording: boolean;
  recordings: StoredRecording[];
  recordingFolders: { id: string; name: string }[];
  recordingFormat: RecordingFormat;
  recordingQuality: number; // 0-1
  hydrateRecordings: () => Promise<void>;
  startRecording: () => void;
  stopRecording: () => void;
  deleteRecording: (id: string) => void;
  renameRecording: (id: string, name: string) => void;
  reorderRecordings: (fromIdx: number, toIdx: number) => void;
  moveRecordingToFolder: (recordingId: string, folderId: string | null) => void;
  createRecordingFolder: (name: string) => void;
  renameRecordingFolder: (id: string, name: string) => void;
  deleteRecordingFolder: (id: string) => void;
  setRecordingFormat: (format: RecordingFormat) => void;
  setRecordingQuality: (quality: number) => void;

  // Looper
  looperEditors: Record<string, LooperEditorState>;
  assignLoop: (instrumentId: string, loopPath: string, displayName: string) => void;
  updateLooperParams: (instrumentId: string, params: Partial<LooperParams>) => void;
  initLooperEditor: (instrumentId: string, buffer: AudioBuffer) => void;
  setLooperZoom: (instrumentId: string, viewStart: number, viewEnd: number) => void;
  setLooperLoop: (instrumentId: string, loopIn: number, loopOut: number) => void;
  setDetectedBpm: (instrumentId: string, bpm: number) => void;
  setLooperBpmMultiplier: (instrumentId: string, multiplier: number) => void;
  autoMatchBpm: (instrumentId: string) => void;

  // Generation settings (LLM endpoints, etc.)
  genSettings: GenSettings;
  setGenSettings: (settings: Partial<GenSettings>) => void;

  // MIDI settings
  midiSettings: MidiSettings;
  setMidiSettings: (settings: Partial<MidiSettings>) => void;

  // MIDI recording
  midiRecordArmed: boolean;
  midiRecordMode: 'overdub' | 'replace';
  setMidiRecordArmed: (armed: boolean) => void;
  setMidiRecordMode: (mode: 'overdub' | 'replace') => void;

  // Audio output device
  audioOutputDeviceId: string | null;
  setAudioOutputDevice: (id: string | null) => void;

  // Audio input recording
  audioInputDeviceId: string | null;
  audioInputMonitor: boolean;
  isCapturingInput: boolean;
  setAudioInputDevice: (id: string | null) => void;
  setAudioInputMonitor: (enabled: boolean) => void;
  startAudioCapture: () => Promise<boolean>;
  stopAudioCapture: () => void;

  // Sample favorites
  sampleFavorites: string[];
  toggleSampleFavorite: (path: string) => void;

  // Set (project) management
  currentSetId: string | null;
  currentSetName: string;
  currentSetThumbnail: string | null;
  setCurrentSetName: (name: string) => void;
  setCurrentSetThumbnail: (thumb: string | null) => void;
  getSerializableState: () => {
    bpm: number;
    masterVolume: number;
    instruments: Instrument[];
    gridNotes: Record<string, number[][]>;
    gridGlide: Record<string, boolean[]>;
    gridLengths: Record<string, number[]>;
    gridVelocities: Record<string, number[]>;
    instrumentEffects: Record<string, Effect[]>;
    masterEffects: Effect[];
    scenes: InstrumentScene[];
    sceneEffects: Record<string, Effect[]>;
    customSamples: { key: string; url: string; name: string }[];
    gridResolution: number;
    scaleRoot: number;
    scaleType: string;
    trackMode: boolean;
    arrangement: ArrangementStep[];
    liveLaunchQuantize: 1 | 2 | 4 | 8;
  };
  loadSet: (set: OrbitrackSet) => void;
  newSet: () => void;
}

export const useStore = create<StoreState>((set, get) => ({
  // Transport
  bpm: 128,
  stepsPerBeat: 4,              // 4 = 16th notes (default), 8 = 32nd, 16 = 64th
  isPlaying: false,
  currentStep: -1,
  transportProgress: 0,
  trackStepProgress: 0,

  // Instruments
  instruments: defaultInstruments,
  selectedInstrumentId: null,
  selectedInstrumentIds: [],
  selectedSceneId: null,
  renamingId: null,

  // Scenes
  scenes: [],
  sceneEffects: {},

  // Track Mode
  trackMode: false,
  arrangement: [],
  trackPosition: -1,

  // Live Mode
  liveMode: false,
  liveLaunchMode: 'queue' as 'queue' | 'stack',
  liveActiveSceneId: null,
  liveQueuedSceneId: null,
  liveLaunchQuantize: 1 as 1 | 2 | 4 | 8,
  liveBarCountdown: 0,
  liveBarsElapsed: 0,
  liveActiveSceneIds: [] as string[],
  liveQueuedToggles: [] as string[],

  // Grid sequencer — pre-populate C4 (MIDI 60) for all default instrument hits
  gridNotes: (() => {
    const notes: Record<string, number[][]> = {};
    for (const inst of defaultInstruments) {
      notes[inst.id] = Array.from({ length: inst.hits }, () => [60]);
    }
    return notes;
  })(),
  gridGlide: {},
  gridLengths: {},
  gridVelocities: {},
  octaveOffset: 2, // Start at octave 2 (C4 centered, C2-C6 visible)

  // Per-instrument progress
  instrumentProgress: {},

  // Add card default type
  addInstrumentType: 'sampler',

  // Snap
  snapEnabled: true,
  gridResolution: 1,

  // Orbit display — persisted to localStorage
  orbitDisplayMode: ((): 'classic' | 'led' | 'rotate' | 'chase' => {
    const stored = localStorage.getItem('orbitrack:orbitDisplayMode');
    if (stored === 'classic' || stored === 'led' || stored === 'rotate' || stored === 'chase') return stored;
    return 'chase';
  })(),
  setOrbitDisplayMode: (mode: 'classic' | 'led' | 'rotate' | 'chase') => {
    localStorage.setItem('orbitrack:orbitDisplayMode', mode);
    set({ orbitDisplayMode: mode });
  },

  showPerformanceMonitor: localStorage.getItem('orbitrack:showPerformanceMonitor') === 'true',
  setShowPerformanceMonitor: (enabled: boolean) => {
    localStorage.setItem('orbitrack:showPerformanceMonitor', enabled ? 'true' : 'false');
    set({ showPerformanceMonitor: enabled });
  },

  synthPanelMode: (localStorage.getItem('orbitrack:synthPanelMode') as 'inline' | 'floating' | 'popout') || 'inline',
  synthFloatPos: JSON.parse(localStorage.getItem('orbitrack:synthFloatPos') || '{"x":100,"y":100}'),
  synthFloatSize: JSON.parse(localStorage.getItem('orbitrack:synthFloatSize') || '{"w":624,"h":468}'),
  synthFloatMinimized: false,
  synthPanelCollapsed: false,
  setSynthPanelMode: (mode) => {
    localStorage.setItem('orbitrack:synthPanelMode', mode);
    set({ synthPanelMode: mode, synthFloatMinimized: false });
  },
  setSynthFloatPos: (pos) => {
    localStorage.setItem('orbitrack:synthFloatPos', JSON.stringify(pos));
    set({ synthFloatPos: pos });
  },
  setSynthFloatSize: (size) => {
    localStorage.setItem('orbitrack:synthFloatSize', JSON.stringify(size));
    set({ synthFloatSize: size });
  },
  setSynthFloatMinimized: (minimized) => set({ synthFloatMinimized: minimized }),
  setSynthPanelCollapsed: (collapsed) => set({ synthPanelCollapsed: collapsed }),

  logEnabled: localStorage.getItem('orbitrack:logEnabled') === 'true',
  showLogConsole: localStorage.getItem('orbitrack:showLogConsole') === 'true',
  setLogEnabled: (enabled: boolean) => {
    localStorage.setItem('orbitrack:logEnabled', enabled ? 'true' : 'false');
    import('../logging/logger').then(({ log }) => {
      if (enabled) log.enable(); else log.disable();
    });
    set({ logEnabled: enabled });
  },
  setShowLogConsole: (show: boolean) => {
    localStorage.setItem('orbitrack:showLogConsole', show ? 'true' : 'false');
    set({ showLogConsole: show });
  },

  // Scale filter
  scaleRoot: 0,         // C
  scaleType: 'chromatic', // show all notes by default

  // Generation undo
  generationUndo: {},

  // Sample bank
  sampleBankOpen: false,
  sampleBankInstrumentId: null,
  customSamples: [],

  // Per-instrument effects
  instrumentEffects: {},
  masterEffects: [],
  masterVolume: 0.8,
  genSettings: DEFAULT_GEN_SETTINGS,
  midiSettings: loadMidiSettings(),
  sampleFavorites: loadSampleFavorites(),

  // Transport actions
  setBpm: (bpm: number) => set({ bpm }),
  setStepsPerBeat: (stepsPerBeat: number) => set({ stepsPerBeat }),
  setPlaying: (isPlaying: boolean) => set({ isPlaying }),
  setCurrentStep: (currentStep) => set({ currentStep }),
  setTransportProgress: (transportProgress) => set({ transportProgress }),

  // Instrument actions
  setInstruments: (instruments) => set({ instruments }),

  updateInstrument: (id, updates) =>
    set((s) => ({
      instruments: s.instruments.map((inst) =>
        inst.id === id ? { ...inst, ...updates } : inst
      ),
    })),

  updateSynthParams: (id, params) =>
    set((s) => ({
      instruments: s.instruments.map((inst) =>
        inst.id === id
          ? { ...inst, synthParams: { ...(inst.synthParams ?? DEFAULT_SYNTH_PARAMS), ...params } }
          : inst
      ),
    })),

  updateEngineParams: (id, params) =>
    set((s) => ({
      instruments: s.instruments.map((inst) =>
        inst.id === id ? { ...inst, engineParams: params } : inst
      ),
    })),

  updateSamplerParams: (id, params) =>
    set((s) => ({
      instruments: s.instruments.map((inst) =>
        inst.id === id
          ? { ...inst, samplerParams: { ...(inst.samplerParams ?? DEFAULT_SAMPLER_PARAMS), ...params } }
          : inst
      ),
    })),

  setHitCount: (id, hits) =>
    set((s) => {
      const inst = s.instruments.find((i) => i.id === id);
      if (!inst) return s;
      const defaultNote = inst.type === 'sampler' ? (inst.samplerParams?.rootNote ?? 60) : 60;
      // Preserve existing notes as persistent memory; only initialize genuinely new slots
      const existingNotes = s.gridNotes[id] || [];
      const newNotes = [...existingNotes];
      for (let i = existingNotes.length; i < hits; i++) {
        newNotes[i] = [defaultNote];
      }
      return {
        instruments: s.instruments.map((i) =>
          i.id === id ? { ...i, hits, hitPositions: generateEvenHits(hits) } : i
        ),
        gridNotes: { ...s.gridNotes, [id]: newNotes },
      };
    }),

  addHit: (id, position) =>
    set((s) => {
      const inst = s.instruments.find((i) => i.id === id);
      if (!inst) return s;
      const norm = ((position % 1) + 1) % 1;
      const final = s.snapEnabled ? snapToGrid(norm, inst.loopSize) : norm;
      const newIndex = inst.hitPositions.length;
      const grid = { ...s.gridNotes };
      if (!grid[id]) grid[id] = [];
      grid[id] = [...grid[id]];
      grid[id][newIndex] = [60];
      return {
        instruments: s.instruments.map((i) => {
          if (i.id !== id) return i;
          return { ...i, hits: i.hits + 1, hitPositions: [...i.hitPositions, final] };
        }),
        gridNotes: grid,
      };
    }),

  addSamplerHit: (id, position, midiNote?: number) =>
    set((s) => {
      const inst = s.instruments.find((i) => i.id === id);
      if (!inst) return s;
      // Use caller-supplied note, or fall back to the sample's root note
      const note = midiNote ?? inst.samplerParams?.rootNote ?? 60;
      const norm = ((position % 1) + 1) % 1;
      const final = s.snapEnabled ? snapToGrid(norm, inst.loopSize) : norm;
      // Guard: don't add if a hit already exists at this step
      const step = Math.round(final * inst.loopSize) % inst.loopSize;
      for (const pos of inst.hitPositions) {
        if (Math.round(pos * inst.loopSize) % inst.loopSize === step) return s;
      }
      const newIndex = inst.hitPositions.length;
      const grid = { ...s.gridNotes };
      if (!grid[id]) grid[id] = [];
      grid[id] = [...grid[id]];
      grid[id][newIndex] = [note];
      const gVelocities = { ...s.gridVelocities };
      if (!gVelocities[id]) gVelocities[id] = [];
      gVelocities[id] = [...gVelocities[id]];
      gVelocities[id][newIndex] = 100;
      return {
        instruments: s.instruments.map((i) => {
          if (i.id !== id) return i;
          return { ...i, hits: i.hits + 1, hitPositions: [...i.hitPositions, final] };
        }),
        gridNotes: grid,
        gridVelocities: gVelocities,
      };
    }),

  removeHit: (id, hitIndex) =>
    set((s) => {
      const newInstruments = s.instruments.map((inst) => {
        if (inst.id !== id) return inst;
        const newPositions = inst.hitPositions.filter((_, i) => i !== hitIndex);
        return { ...inst, hits: newPositions.length, hitPositions: newPositions };
      });
      // Clean up gridNotes: splice out hitIndex so subsequent indices shift
      const grid = { ...s.gridNotes };
      if (grid[id]) {
        const arr = [...grid[id]];
        arr.splice(hitIndex, 1);
        grid[id] = arr;
      }
      const gGlide = { ...s.gridGlide };
      if (gGlide[id]) {
        const arr = [...gGlide[id]];
        arr.splice(hitIndex, 1);
        gGlide[id] = arr;
      }
      const gLengths = { ...s.gridLengths };
      if (gLengths[id]) {
        const arr = [...gLengths[id]];
        arr.splice(hitIndex, 1);
        gLengths[id] = arr;
      }
      const gVelocities = { ...s.gridVelocities };
      if (gVelocities[id]) {
        const arr = [...gVelocities[id]];
        arr.splice(hitIndex, 1);
        gVelocities[id] = arr;
      }
      return { instruments: newInstruments, gridNotes: grid, gridGlide: gGlide, gridLengths: gLengths, gridVelocities: gVelocities };
    }),

  selectInstrument: (id) => set({
    selectedInstrumentId: id,
    selectedInstrumentIds: id ? [id] : [],
    selectedSceneId: null,
  }),

  toggleSelectInstrument: (id) =>
    set((s) => {
      const ids = s.selectedInstrumentIds.includes(id)
        ? s.selectedInstrumentIds.filter((x) => x !== id)
        : [...s.selectedInstrumentIds, id];
      return {
        selectedInstrumentIds: ids,
        selectedInstrumentId: ids[ids.length - 1] ?? null,
        selectedSceneId: null,
      };
    }),

  toggleMute: (id) =>
    set((s) => ({
      instruments: s.instruments.map((inst) =>
        inst.id === id ? { ...inst, muted: !inst.muted } : inst
      ),
    })),

  toggleSolo: (id) =>
    set((s) => ({
      instruments: s.instruments.map((inst) =>
        inst.id === id ? { ...inst, solo: !inst.solo } : inst
      ),
    })),

  removeInstrument: (id) => {
    const s = get();
    const inst = s.instruments.find((i) => i.id === id);
    import('../logging/logger').then(({ log }) => log.info('store', `Instrument removed: ${inst?.name ?? id}`, { type: inst?.type, orbitIndex: inst?.orbitIndex }));
    // Clean up synth engine if it's a synth instrument
    if (inst?.type === 'synth') removeSynthEngine(id);
    // Destroy the orbit effect chain ONLY if no other instrument shares this orbit
    if (inst) {
      const otherOnSameOrbit = s.instruments.some((i) => i.id !== id && i.orbitIndex === inst.orbitIndex);
      if (!otherOnSameOrbit) destroyOrbitChain(inst.orbitIndex);
    }
    // Clean up transport caches for this instrument (prevents stale Map entries)
    // Lazy import to avoid circular dependency (store ↔ transport)
    import('../audio/transport').then(({ cleanupInstrumentCache }) => cleanupInstrumentCache(id));
    // Revoke tracked blob URL for looper instruments to free memory
    if (inst?.sampleName) revokeBlobUrl(inst.samplePath ?? inst.sampleName);
    // Unroute from group bus if grouped
    if (inst) unrouteOrbitFromScene(inst.orbitIndex);
    const instruments = s.instruments.filter((i) => i.id !== id);
    const { [id]: _gn, ...gridNotes } = s.gridNotes;
    const { [id]: _gg, ...gridGlide } = s.gridGlide;
    const { [id]: _gl, ...gridLengths } = s.gridLengths;
    const { [id]: _fx, ...instrumentEffects } = s.instrumentEffects;
    const { [id]: _le, ...looperEditors } = s.looperEditors;
    // Remove from any scene; dissolve scenes with <2 members
    let scenes = s.scenes.map((g) =>
      g.instrumentIds.includes(id)
        ? { ...g, instrumentIds: g.instrumentIds.filter((x) => x !== id) }
        : g
    );
    const dissolvedIds = scenes.filter((g) => g.instrumentIds.length === 0).map((g) => g.id);
    scenes = scenes.filter((g) => g.instrumentIds.length > 0);
    const sceneEffects = { ...s.sceneEffects };
    for (const did of dissolvedIds) {
      // Unroute remaining members and destroy dissolved bus
      const oldGroup = s.scenes.find((g) => g.id === did);
      if (oldGroup) {
        for (const instId of oldGroup.instrumentIds) {
          if (instId !== id) {
            const member = s.instruments.find((i) => i.id === instId);
            if (member) unrouteOrbitFromScene(member.orbitIndex);
          }
        }
      }
      destroySceneBus(did);
      delete sceneEffects[did];
    }
    set({
      instruments,
      gridNotes,
      gridGlide,
      gridLengths,
      instrumentEffects,
      looperEditors,
      scenes,
      sceneEffects,
      selectedInstrumentId: s.selectedInstrumentId === id ? null : s.selectedInstrumentId,
      selectedInstrumentIds: s.selectedInstrumentIds.filter((x) => x !== id),
      selectedSceneId: dissolvedIds.includes(s.selectedSceneId ?? '') ? null : s.selectedSceneId,
    });
  },

  duplicateInstrument: (id) =>
    set((s) => {
      const src = s.instruments.find((i) => i.id === id);
      if (!src) return s;
      const newId = createId();
      const newInst = { ...src, id: newId, muted: true, orbitIndex: orbitCounter++ };
      const idx = s.instruments.findIndex((i) => i.id === id);
      const instruments = [...s.instruments.slice(0, idx + 1), newInst, ...s.instruments.slice(idx + 1)];
      const gridNotes = { ...s.gridNotes, [newId]: s.gridNotes[id] ? [...s.gridNotes[id]] : [] };
      const gridGlide = { ...s.gridGlide, [newId]: s.gridGlide[id] ? [...s.gridGlide[id]] : [] };
      const gridLengths = { ...s.gridLengths, [newId]: s.gridLengths[id] ? [...s.gridLengths[id]] : [] };
      return { instruments, gridNotes, gridGlide, gridLengths };
    }),

  randomizeHits: (id) =>
    set((s) => ({
      instruments: s.instruments.map((inst) => {
        if (inst.id !== id) return inst;
        const newPositions = Array.from({ length: inst.hits }, () => Math.random());
        return { ...inst, hitPositions: newPositions };
      }),
    })),

  toggleLoopSizeLock: (id) =>
    set((s) => ({
      instruments: s.instruments.map((inst) =>
        inst.id === id ? { ...inst, loopSizeLocked: !inst.loopSizeLocked } : inst
      ),
    })),

  // Grid sequencer actions
  setGridNote: (instrumentId, hitIndex, notes) =>
    set((s) => {
      const grid = { ...s.gridNotes };
      if (!grid[instrumentId]) grid[instrumentId] = [];
      grid[instrumentId] = [...grid[instrumentId]];
      grid[instrumentId][hitIndex] = notes;
      return { gridNotes: grid };
    }),

  setGridGlide: (instrumentId, hitIndex, glide) =>
    set((s) => {
      const grid = { ...s.gridGlide };
      if (!grid[instrumentId]) grid[instrumentId] = [];
      grid[instrumentId] = [...grid[instrumentId]];
      grid[instrumentId][hitIndex] = glide;
      return { gridGlide: grid };
    }),

  setGridLength: (instrumentId, hitIndex, length) =>
    set((s) => {
      const grid = { ...s.gridLengths };
      if (!grid[instrumentId]) grid[instrumentId] = [];
      grid[instrumentId] = [...grid[instrumentId]];
      grid[instrumentId][hitIndex] = length;
      return { gridLengths: grid };
    }),

  setGridVelocity: (instrumentId, hitIndex, velocity) =>
    set((s) => {
      const grid = { ...s.gridVelocities };
      if (!grid[instrumentId]) grid[instrumentId] = [];
      grid[instrumentId] = [...grid[instrumentId]];
      grid[instrumentId][hitIndex] = Math.max(1, Math.min(127, velocity));
      return { gridVelocities: grid };
    }),

  toggleGridNote: (instrumentId, hitIndex, midiNote) =>
    set((s) => {
      const grid = { ...s.gridNotes };
      if (!grid[instrumentId]) grid[instrumentId] = [];
      grid[instrumentId] = [...grid[instrumentId]];
      const current = grid[instrumentId][hitIndex] || [];
      if (current.includes(midiNote)) {
        grid[instrumentId][hitIndex] = current.filter((n) => n !== midiNote);
      } else {
        grid[instrumentId][hitIndex] = [...current, midiNote];
      }
      return { gridNotes: grid };
    }),

  moveGridNote: (instrumentId, hitIndex, fromNote, toNote) =>
    set((s) => {
      const grid = { ...s.gridNotes };
      if (!grid[instrumentId]) grid[instrumentId] = [];
      grid[instrumentId] = [...grid[instrumentId]];
      const current = grid[instrumentId][hitIndex] || [];
      grid[instrumentId][hitIndex] = current.map((n) => (n === fromNote ? toNote : n));
      return { gridNotes: grid };
    }),

  moveGridNoteToStep: (instrumentId, fromHitIndex, toHitIndex, midiNote) =>
    set((s) => {
      const grid = { ...s.gridNotes };
      if (!grid[instrumentId]) grid[instrumentId] = [];
      grid[instrumentId] = [...grid[instrumentId]];
      // Remove from old step
      const fromNotes = grid[instrumentId][fromHitIndex] || [];
      grid[instrumentId][fromHitIndex] = fromNotes.filter((n) => n !== midiNote);
      // Add to new step
      const toNotes = grid[instrumentId][toHitIndex] || [];
      if (!toNotes.includes(midiNote)) {
        grid[instrumentId][toHitIndex] = [...toNotes, midiNote];
      }
      // Move length and glide data too
      const gridLengths = { ...s.gridLengths };
      if (gridLengths[instrumentId]) {
        gridLengths[instrumentId] = [...gridLengths[instrumentId]];
        const len = gridLengths[instrumentId][fromHitIndex] ?? 1;
        gridLengths[instrumentId][toHitIndex] = len;
      }
      const gridGlide = { ...s.gridGlide };
      if (gridGlide[instrumentId]) {
        gridGlide[instrumentId] = [...gridGlide[instrumentId]];
        const gl = gridGlide[instrumentId][fromHitIndex] ?? false;
        gridGlide[instrumentId][toHitIndex] = gl;
      }
      return { gridNotes: grid, gridLengths, gridGlide };
    }),

  moveSamplerNoteToStep: (id, fromStep, toStep, midiNote) =>
    set((s) => {
      const inst = s.instruments.find((i) => i.id === id);
      if (!inst) return s;

      // Build step → hitIndex map
      const stepToHit = new Map<number, number>();
      for (let i = 0; i < inst.hitPositions.length; i++) {
        const step = Math.round(inst.hitPositions[i] * inst.loopSize) % inst.loopSize;
        stepToHit.set(step, i);
      }

      const fromHitIdx = stepToHit.get(fromStep);
      if (fromHitIdx === undefined) return s;

      let newPositions = [...inst.hitPositions];
      const grid = { ...s.gridNotes };
      if (!grid[id]) grid[id] = [];
      grid[id] = [...grid[id]];

      // Remove note from source hit
      const fromNotes = grid[id][fromHitIdx] || [];
      grid[id][fromHitIdx] = fromNotes.filter((n) => n !== midiNote);

      // If source hit has no remaining notes, remove the hit entirely
      if (grid[id][fromHitIdx].length === 0) {
        newPositions = newPositions.filter((_, i) => i !== fromHitIdx);
        grid[id].splice(fromHitIdx, 1);
      }

      // Find or create hit at destination step
      const stepToHit2 = new Map<number, number>();
      for (let i = 0; i < newPositions.length; i++) {
        const step = Math.round(newPositions[i] * inst.loopSize) % inst.loopSize;
        stepToHit2.set(step, i);
      }

      let toHitIdx = stepToHit2.get(toStep);
      const gVelocities = { ...s.gridVelocities };
      if (!gVelocities[id]) gVelocities[id] = [];
      gVelocities[id] = [...gVelocities[id]];

      if (toHitIdx === undefined) {
        toHitIdx = newPositions.length;
        const pos = toStep / inst.loopSize;
        newPositions.push(pos);
        grid[id][toHitIdx] = [midiNote];
        gVelocities[id][toHitIdx] = gVelocities[id][fromHitIdx] ?? 100;
      } else {
        const toNotes = grid[id][toHitIdx] || [];
        if (!toNotes.includes(midiNote)) {
          grid[id][toHitIdx] = [...toNotes, midiNote];
        }
      }

      return {
        instruments: s.instruments.map((i) => {
          if (i.id !== id) return i;
          return { ...i, hits: newPositions.length, hitPositions: newPositions };
        }),
        gridNotes: grid,
        gridVelocities: gVelocities,
      };
    }),

  moveNotesBatch: (id, notes, stepDelta, pitchDelta) =>
    set((s) => {
      const inst = s.instruments.find((i) => i.id === id);
      if (!inst || (stepDelta === 0 && pitchDelta === 0)) return s;

      const totalSteps = inst.loopSize;

      // Build step→hitIndex map
      const stepToHit = new Map<number, number>();
      for (let i = 0; i < inst.hitPositions.length; i++) {
        const step = Math.round(inst.hitPositions[i] * totalSteps) % totalSteps;
        stepToHit.set(step, i);
      }

      // Check all target positions are valid before making changes
      for (const n of notes) {
        const newMidi = n.midi + pitchDelta;
        if (newMidi < 0 || newMidi > 127) return s; // out of range, abort
      }

      // Clone mutable state
      let positions = [...inst.hitPositions];
      const grid: number[][] = [...(s.gridNotes[id] || [])].map((a) => [...a]);
      const gLen: number[] = [...(s.gridLengths[id] || [])];
      const gVel: number[] = [...(s.gridVelocities[id] || [])];
      const gGlide: boolean[] = [...(s.gridGlide[id] || [])];

      // Collect source info for each note, then remove them all
      interface NoteInfo { hitIdx: number; midi: number; step: number; vel: number; len: number; glide: boolean; }
      const infos: NoteInfo[] = [];
      for (const n of notes) {
        const hitIdx = stepToHit.get(n.step);
        if (hitIdx === undefined) continue;
        infos.push({
          hitIdx, midi: n.midi, step: n.step,
          vel: gVel[hitIdx] ?? 100,
          len: gLen[hitIdx] ?? 1,
          glide: gGlide[hitIdx] ?? false,
        });
      }

      // Remove source notes (process in reverse hitIdx order to keep indices stable)
      const sortedByHit = [...infos].sort((a, b) => b.hitIdx - a.hitIdx);
      for (const info of sortedByHit) {
        const hitNotes = grid[info.hitIdx];
        if (!hitNotes) continue;
        const filtered = hitNotes.filter((m) => m !== info.midi);
        if (filtered.length === 0) {
          // Remove the entire hit
          grid.splice(info.hitIdx, 1);
          positions.splice(info.hitIdx, 1);
          gLen.splice(info.hitIdx, 1);
          gVel.splice(info.hitIdx, 1);
          gGlide.splice(info.hitIdx, 1);
        } else {
          grid[info.hitIdx] = filtered;
        }
      }

      // Re-add notes at new positions
      for (const info of infos) {
        const newStep = ((info.step + stepDelta) % totalSteps + totalSteps) % totalSteps;
        const newMidi = info.midi + pitchDelta;

        // Rebuild step→hit map after removals
        const curMap = new Map<number, number>();
        for (let i = 0; i < positions.length; i++) {
          const st = Math.round(positions[i] * totalSteps) % totalSteps;
          curMap.set(st, i);
        }

        let targetHit = curMap.get(newStep);
        if (targetHit !== undefined) {
          // Add note to existing hit
          if (!grid[targetHit].includes(newMidi)) {
            grid[targetHit] = [...grid[targetHit], newMidi];
          }
        } else {
          // Create new hit
          targetHit = positions.length;
          positions.push(newStep / totalSteps);
          grid[targetHit] = [newMidi];
          gLen[targetHit] = info.len;
          gVel[targetHit] = info.vel;
          gGlide[targetHit] = info.glide;
        }
      }

      return {
        instruments: s.instruments.map((i) =>
          i.id !== id ? i : { ...i, hits: positions.length, hitPositions: positions },
        ),
        gridNotes: { ...s.gridNotes, [id]: grid },
        gridLengths: { ...s.gridLengths, [id]: gLen },
        gridVelocities: { ...s.gridVelocities, [id]: gVel },
        gridGlide: { ...s.gridGlide, [id]: gGlide },
      };
    }),

  removeOverlappedNotes: (id, ranges) =>
    set((s) => {
      const inst = s.instruments.find((i) => i.id === id);
      if (!inst || ranges.length === 0) return s;

      const totalSteps = inst.loopSize;
      let positions = [...inst.hitPositions];
      const grid: number[][] = [...(s.gridNotes[id] || [])].map((a) => [...a]);
      const gLen: number[] = [...(s.gridLengths[id] || [])];
      const gVel: number[] = [...(s.gridVelocities[id] || [])];
      const gGlide: boolean[] = [...(s.gridGlide[id] || [])];

      // Build step→hitIndex map
      const stepToHit = new Map<number, number>();
      for (let i = 0; i < positions.length; i++) {
        const step = Math.round(positions[i] * totalSteps) % totalSteps;
        stepToHit.set(step, i);
      }

      // Collect hit indices to remove notes from
      const hitsToRemove: { hitIdx: number; midi: number }[] = [];
      for (const range of ranges) {
        for (let offset = 1; offset < range.length; offset++) {
          const coveredStep = (range.step + offset) % totalSteps;
          const hitIdx = stepToHit.get(coveredStep);
          if (hitIdx === undefined) continue;
          const hitNotes = grid[hitIdx];
          if (hitNotes && hitNotes.includes(range.midi)) {
            hitsToRemove.push({ hitIdx, midi: range.midi });
          }
        }
      }

      if (hitsToRemove.length === 0) return s;

      // Deduplicate and sort by descending hitIdx for stable removal
      const seen = new Set<string>();
      const unique = hitsToRemove.filter((h) => {
        const k = `${h.hitIdx}-${h.midi}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      unique.sort((a, b) => b.hitIdx - a.hitIdx);

      for (const { hitIdx, midi } of unique) {
        const filtered = grid[hitIdx].filter((m) => m !== midi);
        if (filtered.length === 0) {
          grid.splice(hitIdx, 1);
          positions.splice(hitIdx, 1);
          gLen.splice(hitIdx, 1);
          gVel.splice(hitIdx, 1);
          gGlide.splice(hitIdx, 1);
        } else {
          grid[hitIdx] = filtered;
        }
      }

      return {
        instruments: s.instruments.map((i) =>
          i.id !== id ? i : { ...i, hits: positions.length, hitPositions: positions },
        ),
        gridNotes: { ...s.gridNotes, [id]: grid },
        gridLengths: { ...s.gridLengths, [id]: gLen },
        gridVelocities: { ...s.gridVelocities, [id]: gVel },
        gridGlide: { ...s.gridGlide, [id]: gGlide },
      };
    }),

  addNotesBatch: (id, notes) =>
    set((s) => {
      const inst = s.instruments.find((i) => i.id === id);
      if (!inst || notes.length === 0) return s;

      const totalSteps = inst.loopSize;
      let positions = [...inst.hitPositions];
      const grid: number[][] = [...(s.gridNotes[id] || [])].map((a) => [...a]);
      const gLen: number[] = [...(s.gridLengths[id] || [])];
      const gVel: number[] = [...(s.gridVelocities[id] || [])];
      const gGlide: boolean[] = [...(s.gridGlide[id] || [])];

      for (const note of notes) {
        const step = ((note.step % totalSteps) + totalSteps) % totalSteps;

        // Build fresh step→hit map each iteration (positions may have grown)
        const curMap = new Map<number, number>();
        for (let i = 0; i < positions.length; i++) {
          const st = Math.round(positions[i] * totalSteps) % totalSteps;
          curMap.set(st, i);
        }

        const hitIdx = curMap.get(step);
        if (hitIdx !== undefined) {
          if (!grid[hitIdx].includes(note.midi)) {
            grid[hitIdx] = [...grid[hitIdx], note.midi];
          }
          // Update metadata to match pasted note
          gLen[hitIdx] = note.length;
          gVel[hitIdx] = note.velocity;
          gGlide[hitIdx] = note.glide;
        } else {
          const newIdx = positions.length;
          positions.push(step / totalSteps);
          grid[newIdx] = [note.midi];
          gLen[newIdx] = note.length;
          gVel[newIdx] = note.velocity;
          gGlide[newIdx] = note.glide;
        }
      }

      return {
        instruments: s.instruments.map((i) =>
          i.id !== id ? i : { ...i, hits: positions.length, hitPositions: positions },
        ),
        gridNotes: { ...s.gridNotes, [id]: grid },
        gridLengths: { ...s.gridLengths, [id]: gLen },
        gridVelocities: { ...s.gridVelocities, [id]: gVel },
        gridGlide: { ...s.gridGlide, [id]: gGlide },
      };
    }),

  setOctaveOffset: (offset) => set({ octaveOffset: offset }),

  applyChordPreset: (instrumentId, chords, _steps) =>
    set((s) => {
      const inst = s.instruments.find((i) => i.id === instrumentId);
      if (!inst) return s;
      const grid = { ...s.gridNotes };
      grid[instrumentId] = [];
      for (let i = 0; i < inst.hits; i++) {
        grid[instrumentId][i] = chords[i % chords.length] || [];
      }
      return { gridNotes: grid };
    }),

  setInstrumentProgress: (instrumentProgress) => set({ instrumentProgress }),
  setPlaybackUI: (transportProgress, currentStep, instrumentProgress, trackPosition, trackStepProgress) =>
    set({ transportProgress, currentStep, instrumentProgress, ...(trackPosition !== undefined && { trackPosition }), ...(trackStepProgress !== undefined && { trackStepProgress }) }),

  setLoopSize: (id, size) =>
    set((s) => {
      const newLoopSize = Math.max(1, Math.min(256, Math.round(size)));
      const inst = s.instruments.find((i) => i.id === id);
      if (!inst) return s;

      let newInstruments;
      let gridUpdate: Partial<Pick<StoreState, 'gridNotes' | 'gridGlide' | 'gridLengths'>> = {};

      if (inst.type === 'synth') {
        // Preserve existing notes as persistent memory; only initialize genuinely new step slots
        const existingNotes = s.gridNotes[id] || [];
        const newNotes = [...existingNotes];
        for (let i = existingNotes.length; i < newLoopSize; i++) {
          newNotes[i] = [60];
        }
        newInstruments = s.instruments.map((i) =>
          i.id !== id ? i : {
            ...i,
            loopSize: newLoopSize,
            hits: newLoopSize,
            hitPositions: generateEvenHits(newLoopSize),
          }
        );
        gridUpdate = {
          gridNotes: { ...s.gridNotes, [id]: newNotes },
          gridGlide: { ...s.gridGlide, [id]: s.gridGlide[id] || [] },
          gridLengths: { ...s.gridLengths, [id]: s.gridLengths[id] || [] },
        };
      } else {
        // Just update loopSize; hit positions stay as-is
        newInstruments = s.instruments.map((i) =>
          i.id !== id ? i : {
            ...i,
            loopSize: newLoopSize,
          }
        );
      }

      return { instruments: newInstruments, ...gridUpdate };
    }),

  setAddInstrumentType: (addInstrumentType) => set({ addInstrumentType }),
  setSnapEnabled: (snapEnabled) => set({ snapEnabled }),
  setGridResolution: (gridResolution) => set({ gridResolution }),
  setScaleRoot: (scaleRoot) => set({ scaleRoot }),
  setScaleType: (scaleType) => set({ scaleType }),

  snapshotForUndo: (instrumentId) => set((s) => {
    const inst = s.instruments.find((i) => i.id === instrumentId);
    if (!inst) return s;
    return {
      generationUndo: {
        ...s.generationUndo,
        [instrumentId]: {
          hitPositions: [...inst.hitPositions],
          hits: inst.hits,
          gridNotes: (s.gridNotes[instrumentId] || []).map((n) => [...n]),
          gridLengths: [...(s.gridLengths[instrumentId] || [])],
          gridGlide: [...(s.gridGlide[instrumentId] || [])],
        },
      },
    };
  }),

  undoGeneration: (instrumentId) => set((s) => {
    const snapshot = s.generationUndo[instrumentId];
    if (!snapshot) return s;

    const instruments = s.instruments.map((inst) => {
      if (inst.id !== instrumentId) return inst;
      return { ...inst, hitPositions: snapshot.hitPositions, hits: snapshot.hits };
    });

    const gridNotes = { ...s.gridNotes, [instrumentId]: snapshot.gridNotes };
    const gridLengths = { ...s.gridLengths, [instrumentId]: snapshot.gridLengths };
    const gridGlide = { ...s.gridGlide, [instrumentId]: snapshot.gridGlide };

    const undo = { ...s.generationUndo };
    delete undo[instrumentId];

    return { instruments, gridNotes, gridLengths, gridGlide, generationUndo: undo };
  }),

  openSampleBank: (instrumentId) =>
    set({ sampleBankOpen: true, sampleBankInstrumentId: instrumentId }),

  closeSampleBank: () =>
    set({ sampleBankOpen: false, sampleBankInstrumentId: null }),

  assignSample: (instrumentId, samplePath, displayName) => {
    // For imported samples (blob URLs), look up the actual blob URL from state
    const customSamples = get().customSamples;
    const custom = customSamples.find((c) => c.key === samplePath);
    // Register once here — preloadSample skips re-registration via its loaded-set guard
    const sdKey = registerSampleForPlayback(samplePath, custom?.url);
    loadSample(samplePath, custom?.url ?? samplePath);
    if (custom) {
      void preloadCustomSample(sdKey, custom.url);
    } else {
      void preloadSample(samplePath);
    }
    set((s) => ({
      instruments: s.instruments.map((inst) =>
        inst.id === instrumentId
          ? { ...inst, sampleName: sdKey, samplePath: samplePath, name: displayName }
          : inst
      ),
    }));
  },

  addCustomSample: (sample) => {
    loadSample(sample.key, sample.url);
    set((s) => ({ customSamples: [...s.customSamples, sample] }));
  },

  removeCustomSample: (key) => {
    const existing = get().customSamples.find((cs) => cs.key === key);
    if (existing) {
      try { URL.revokeObjectURL(existing.url); } catch { /* ignore */ }
    }
    set((s) => ({ customSamples: s.customSamples.filter((cs) => cs.key !== key) }));
  },

  // Per-instrument effects actions
  addEffect: (instrumentId, type) =>
    set((s) => {
      const EFFECT_LABELS: Partial<Record<EffectType, string>> = {
        eq3: 'EQ 3-Band', reverb: 'Reverb', delay: 'Delay', compressor: 'Compressor',
        chorus: 'Chorus', phaser: 'Phaser', distortion: 'Distortion', filter: 'Filter',
        bitcrusher: 'Bit Crusher', parame: 'Param EQ', tremolo: 'Tremolo', ringmod: 'Ring Mod',
        trancegate: 'Orb Gate', limiter: 'Limiter', drumbuss: 'Drum Buss',
        stereoimage: 'Stereo Image',
      };
      const effect: Effect = {
        id: createId(),
        type,
        label: EFFECT_LABELS[type] ?? type,
        enabled: true,
        params: DEFAULT_EFFECT_PARAMS(type),
        collapsed: false,
      };
      if (instrumentId.startsWith('__scene_')) {
        const gid = instrumentId.slice(8, -2);
        const prev = s.sceneEffects[gid] ?? [];
        return { sceneEffects: { ...s.sceneEffects, [gid]: [...prev, effect] } };
      }
      const prev = s.instrumentEffects[instrumentId] ?? [];
      import('../logging/logger').then(({ log }) => log.info('store', `Effect added: ${type}`, { instrumentId }));
      return { instrumentEffects: { ...s.instrumentEffects, [instrumentId]: [...prev, effect] } };
    }),

  addMasterEffect: (type) =>
    set((s) => {
      const EFFECT_LABELS: Partial<Record<EffectType, string>> = {
        eq3: 'EQ 3-Band', reverb: 'Reverb', delay: 'Delay', compressor: 'Compressor',
        chorus: 'Chorus', phaser: 'Phaser', distortion: 'Distortion', filter: 'Filter',
        bitcrusher: 'Bit Crusher', parame: 'Param EQ', tremolo: 'Tremolo', ringmod: 'Ring Mod',
        trancegate: 'Orb Gate',
      };
      const effect: Effect = {
        id: createId(),
        type,
        label: EFFECT_LABELS[type] ?? type,
        enabled: true,
        params: DEFAULT_EFFECT_PARAMS(type),
        collapsed: false,
      };
      return { masterEffects: [...s.masterEffects, effect] };
    }),

  removeEffect: (instrumentId, effectId) =>
    set((s) => {
      if (instrumentId === '__master__')
        return { masterEffects: s.masterEffects.filter((e) => e.id !== effectId) };
      if (instrumentId.startsWith('__scene_')) {
        const gid = instrumentId.slice(8, -2);
        const prev = s.sceneEffects[gid] ?? [];
        return { sceneEffects: { ...s.sceneEffects, [gid]: prev.filter((e) => e.id !== effectId) } };
      }
      const prev = s.instrumentEffects[instrumentId] ?? [];
      return {
        instrumentEffects: {
          ...s.instrumentEffects,
          [instrumentId]: prev.filter((e) => e.id !== effectId),
        },
      };
    }),

  setEffectParam: (instrumentId, effectId, key, value) =>
    set((s) => {
      if (instrumentId === '__master__')
        return { masterEffects: s.masterEffects.map((e) => e.id === effectId ? { ...e, params: { ...e.params, [key]: value } } : e) };
      if (instrumentId.startsWith('__scene_')) {
        const gid = instrumentId.slice(8, -2);
        const prev = s.sceneEffects[gid] ?? [];
        return { sceneEffects: { ...s.sceneEffects, [gid]: prev.map((e) => e.id === effectId ? { ...e, params: { ...e.params, [key]: value } } : e) } };
      }
      const prev = s.instrumentEffects[instrumentId] ?? [];
      return {
        instrumentEffects: {
          ...s.instrumentEffects,
          [instrumentId]: prev.map((e) =>
            e.id === effectId ? { ...e, params: { ...e.params, [key]: value } } : e
          ),
        },
      };
    }),

  toggleEffectEnabled: (instrumentId, effectId) =>
    set((s) => {
      if (instrumentId === '__master__')
        return { masterEffects: s.masterEffects.map((e) => e.id === effectId ? { ...e, enabled: !e.enabled } : e) };
      if (instrumentId.startsWith('__scene_')) {
        const gid = instrumentId.slice(8, -2);
        const prev = s.sceneEffects[gid] ?? [];
        return { sceneEffects: { ...s.sceneEffects, [gid]: prev.map((e) => e.id === effectId ? { ...e, enabled: !e.enabled } : e) } };
      }
      const prev = s.instrumentEffects[instrumentId] ?? [];
      return {
        instrumentEffects: {
          ...s.instrumentEffects,
          [instrumentId]: prev.map((e) => (e.id === effectId ? { ...e, enabled: !e.enabled } : e)),
        },
      };
    }),

  toggleEffectCollapsed: (instrumentId, effectId) =>
    set((s) => {
      if (instrumentId === '__master__')
        return { masterEffects: s.masterEffects.map((e) => e.id === effectId ? { ...e, collapsed: !e.collapsed } : e) };
      if (instrumentId.startsWith('__scene_')) {
        const gid = instrumentId.slice(8, -2);
        const prev = s.sceneEffects[gid] ?? [];
        return { sceneEffects: { ...s.sceneEffects, [gid]: prev.map((e) => e.id === effectId ? { ...e, collapsed: !e.collapsed } : e) } };
      }
      const prev = s.instrumentEffects[instrumentId] ?? [];
      return {
        instrumentEffects: {
          ...s.instrumentEffects,
          [instrumentId]: prev.map((e) => (e.id === effectId ? { ...e, collapsed: !e.collapsed } : e)),
        },
      };
    }),

  reorderEffects: (instrumentId, fromIdx, toIdx) =>
    set((s) => {
      if (instrumentId === '__master__') {
        const effects = [...s.masterEffects];
        const [item] = effects.splice(fromIdx, 1);
        effects.splice(toIdx, 0, item);
        return { masterEffects: effects };
      }
      if (instrumentId.startsWith('__scene_')) {
        const gid = instrumentId.slice(8, -2);
        const effects = [...(s.sceneEffects[gid] ?? [])];
        const [item] = effects.splice(fromIdx, 1);
        effects.splice(toIdx, 0, item);
        return { sceneEffects: { ...s.sceneEffects, [gid]: effects } };
      }
      const effects = [...(s.instrumentEffects[instrumentId] ?? [])];
      const [item] = effects.splice(fromIdx, 1);
      effects.splice(toIdx, 0, item);
      return { instrumentEffects: { ...s.instrumentEffects, [instrumentId]: effects } };
    }),

  setMasterVolume: (masterVolume) => set({ masterVolume }),

  setGenSettings: (settings) => set((state) => ({
    genSettings: { ...state.genSettings, ...settings },
  })),

  setMidiSettings: (settings) => set((state) => {
    const newSettings = { ...state.midiSettings, ...settings };
    saveMidiSettings(newSettings);
    return { midiSettings: newSettings };
  }),

  // MIDI recording
  midiRecordArmed: false,
  midiRecordMode: 'overdub' as const,
  setMidiRecordArmed: (armed) => set({ midiRecordArmed: armed }),
  setMidiRecordMode: (mode) => set({ midiRecordMode: mode }),

  // Audio output device
  audioOutputDeviceId: localStorage.getItem('orbitrack_audioOutputDeviceId') || null,
  setAudioOutputDevice: (id) => {
    set({ audioOutputDeviceId: id });
    if (id) {
      localStorage.setItem('orbitrack_audioOutputDeviceId', id);
    } else {
      localStorage.removeItem('orbitrack_audioOutputDeviceId');
    }
  },

  // Audio input recording
  audioInputDeviceId: null,
  audioInputMonitor: false,
  isCapturingInput: false,
  setAudioInputDevice: (id) => set({ audioInputDeviceId: id }),
  setAudioInputMonitor: (enabled) => {
    set({ audioInputMonitor: enabled });
    setInputMonitor(enabled);
  },
  startAudioCapture: async () => {
    const { audioInputDeviceId } = get();
    const ok = await startInputCapture(audioInputDeviceId ?? undefined);
    if (ok) set({ isCapturingInput: true });
    return ok;
  },
  stopAudioCapture: () => {
    const buffer = stopInputCapture();
    set({ isCapturingInput: false });
    if (!buffer) return;

    // Convert to blob URL and register as custom sample
    const url = bufferToBlobUrl(buffer);
    const name = `Recording ${new Date().toLocaleTimeString()}`;
    const key = `__recorded_input__/${name}_${Date.now()}`;
    get().addCustomSample({ key, url, name });

    // If the selected instrument is a looper, assign directly
    // (can't use assignLoop because key isn't a fetchable URL — we already have the buffer)
    const state = get();
    const inst = state.instruments.find((i) => i.id === state.selectedInstrumentId);
    if (inst?.type === 'looper') {
      const sdKey = registerSampleForPlayback(key, url);
      set((s) => ({
        instruments: s.instruments.map((i) =>
          i.id === inst.id
            ? { ...i, sampleName: sdKey, samplePath: key, name }
            : i
        ),
      }));
      // Init looper editor directly with the captured buffer (no fetch needed)
      get().initLooperEditor(inst.id, buffer);

      // Override loopSize to match the natural duration of the captured buffer.
      const bpm = get().bpm;
      const stepsPerBeat = get().stepsPerBeat;
      const secondsPerStep = 60 / (bpm * stepsPerBeat);
      const naturalLoopSize = Math.max(1, Math.round(buffer.duration / secondsPerStep));
      set((s) => ({
        instruments: s.instruments.map((i) =>
          i.id === inst.id
            ? { ...i, hits: 1, hitPositions: [0], loopSize: naturalLoopSize }
            : i
        ),
        gridNotes: {
          ...s.gridNotes,
          [inst.id]: [[60]],
        },
      }));
    }
  },

  toggleSampleFavorite: (path: string) => set((state) => {
    const favorites = state.sampleFavorites.includes(path)
      ? state.sampleFavorites.filter(p => p !== path)
      : [...state.sampleFavorites, path];
    saveSampleFavorites(favorites);
    return { sampleFavorites: favorites };
  }),

  // ── Group actions ──────────────────────────────────────────────────────────

  sceneSelected: () => {
    const s = get();
    const ids = s.selectedInstrumentIds;
    if (ids.length < 1) return;
    // Remove selected instruments from any existing groups — unroute from old buses
    const oldGroups = s.scenes;
    for (const g of oldGroups) {
      for (const instId of g.instrumentIds) {
        if (ids.includes(instId)) {
          const inst = s.instruments.find((i) => i.id === instId);
          if (inst) unrouteOrbitFromScene(inst.orbitIndex);
        }
      }
    }
    let groups = oldGroups.map((g) => ({
      ...g,
      instrumentIds: g.instrumentIds.filter((x) => !ids.includes(x)),
    }));
    // Dissolve groups that became empty
    const dissolvedIds = groups.filter((g) => g.instrumentIds.length === 0).map((g) => g.id);
    groups = groups.filter((g) => g.instrumentIds.length > 0);
    const sceneEffects = { ...s.sceneEffects };
    for (const did of dissolvedIds) {
      delete sceneEffects[did];
      // Unroute remaining members of dissolved groups
      const oldGroup = oldGroups.find((g) => g.id === did);
      if (oldGroup) {
        for (const instId of oldGroup.instrumentIds) {
          if (!ids.includes(instId)) {
            const inst = s.instruments.find((i) => i.id === instId);
            if (inst) unrouteOrbitFromScene(inst.orbitIndex);
          }
        }
      }
      destroySceneBus(did);
    }
    // Create new scene
    const groupId = createId();
    const usedColors = s.scenes.map((g) => g.color);
    const color = SCENE_COLORS.find((c) => !usedColors.includes(c)) ?? SCENE_COLORS[s.scenes.length % SCENE_COLORS.length];
    const newScene: InstrumentScene = {
      id: groupId,
      name: `Scene ${s.scenes.length + 1}`,
      color,
      instrumentIds: [...ids],
      muted: false,
      solo: false,
      volume: 0,
      collapsed: false,
    };
    const scenes = [...s.scenes, newScene];
    sceneEffects[groupId] = [];
    // Reorder instruments so grouped instruments are adjacent
    const instruments = [...s.instruments];
    const grouped = ids.map((id) => instruments.find((i) => i.id === id)!).filter(Boolean);
    const rest = instruments.filter((i) => !ids.includes(i.id));
    const firstIdx = instruments.findIndex((i) => ids.includes(i.id));
    const before = rest.filter((_, idx) => {
      const origIdx = instruments.indexOf(rest[idx]);
      return origIdx < firstIdx;
    });
    const after = rest.filter((i) => !before.includes(i));
    set({
      instruments: [...before, ...grouped, ...after],
      scenes,
      sceneEffects,
      selectedSceneId: groupId,
    });
    // Wire audio: create group bus and route orbits
    createSceneBus(groupId);
    for (const instId of ids) {
      const inst = s.instruments.find((i) => i.id === instId);
      if (inst) routeOrbitToScene(inst.orbitIndex, groupId);
    }
  },

  unsceneSelected: () => {
    const s = get();
    const sceneEffects = { ...s.sceneEffects };
    // If a group is selected, dissolve it entirely
    if (s.selectedSceneId) {
      const group = s.scenes.find((g) => g.id === s.selectedSceneId);
      if (group) {
        for (const instId of group.instrumentIds) {
          const inst = s.instruments.find((i) => i.id === instId);
          if (inst) unrouteOrbitFromScene(inst.orbitIndex);
        }
        destroySceneBus(s.selectedSceneId);
      }
      const scenes = s.scenes.filter((g) => g.id !== s.selectedSceneId);
      delete sceneEffects[s.selectedSceneId];
      set({ scenes, sceneEffects, selectedSceneId: null });
      return;
    }
    // Otherwise, remove selected instruments from their groups
    const ids = s.selectedInstrumentIds;
    if (ids.length === 0) return;
    // Unroute selected instruments
    for (const instId of ids) {
      const inst = s.instruments.find((i) => i.id === instId);
      if (inst) unrouteOrbitFromScene(inst.orbitIndex);
    }
    let scenes = s.scenes.map((g) => ({
      ...g,
      instrumentIds: g.instrumentIds.filter((x) => !ids.includes(x)),
    }));
    const dissolvedIds = scenes.filter((g) => g.instrumentIds.length === 0).map((g) => g.id);
    scenes = scenes.filter((g) => g.instrumentIds.length > 0);
    for (const did of dissolvedIds) {
      delete sceneEffects[did];
      // Unroute remaining members and destroy dissolved bus
      const oldGroup = s.scenes.find((g) => g.id === did);
      if (oldGroup) {
        for (const instId of oldGroup.instrumentIds) {
          if (!ids.includes(instId)) {
            const inst = s.instruments.find((i) => i.id === instId);
            if (inst) unrouteOrbitFromScene(inst.orbitIndex);
          }
        }
      }
      destroySceneBus(did);
    }
    set({
      scenes,
      sceneEffects,
      selectedSceneId: dissolvedIds.includes(s.selectedSceneId ?? '') ? null : s.selectedSceneId,
    });
  },

  selectScene: (groupId) =>
    set((s) => {
      if (!groupId) return { selectedSceneId: null };
      const group = s.scenes.find((g) => g.id === groupId);
      if (!group) return { selectedSceneId: null };
      return {
        selectedSceneId: groupId,
        selectedInstrumentIds: [...group.instrumentIds],
        selectedInstrumentId: group.instrumentIds[0] ?? null,
      };
    }),

  toggleSceneMute: (groupId) =>
    set((s) => ({
      scenes: s.scenes.map((g) => g.id === groupId ? { ...g, muted: !g.muted } : g),
    })),

  toggleSceneSolo: (groupId) =>
    set((s) => ({
      scenes: s.scenes.map((g) => g.id === groupId ? { ...g, solo: !g.solo } : g),
    })),

  setSceneVolume: (groupId, volume) =>
    set((s) => ({
      scenes: s.scenes.map((g) => g.id === groupId ? { ...g, volume } : g),
    })),

  toggleSceneCollapsed: (groupId) =>
    set((s) => ({
      scenes: s.scenes.map((g) => g.id === groupId ? { ...g, collapsed: !g.collapsed } : g),
    })),

  renameScene: (groupId, name) =>
    set((s) => ({
      scenes: s.scenes.map((g) => g.id === groupId ? { ...g, name } : g),
    })),

  deleteScene: (sceneId) => {
    const s = get();
    const group = s.scenes.find((g) => g.id === sceneId);
    if (!group) return;
    // Unroute all instruments from the scene bus
    for (const instId of group.instrumentIds) {
      const inst = s.instruments.find((i) => i.id === instId);
      if (inst) unrouteOrbitFromScene(inst.orbitIndex);
    }
    destroySceneBus(sceneId);
    const scenes = s.scenes.filter((g) => g.id !== sceneId);
    const sceneEffects = { ...s.sceneEffects };
    delete sceneEffects[sceneId];
    // Clear arrangement steps referencing this scene
    const arrangement = s.arrangement.filter((step) => step.sceneId !== sceneId);
    set({
      scenes,
      sceneEffects,
      arrangement,
      selectedSceneId: s.selectedSceneId === sceneId ? null : s.selectedSceneId,
    });
  },

  setRenamingId: (id) => set({ renamingId: id }),

  addSceneEffect: (groupId, type) =>
    set((s) => {
      const EFFECT_LABELS: Partial<Record<EffectType, string>> = {
        eq3: 'EQ 3-Band', reverb: 'Reverb', delay: 'Delay', compressor: 'Compressor',
        chorus: 'Chorus', phaser: 'Phaser', distortion: 'Distortion', filter: 'Filter',
        bitcrusher: 'Bit Crusher', parame: 'Param EQ', tremolo: 'Tremolo', ringmod: 'Ring Mod',
        trancegate: 'Orb Gate', limiter: 'Limiter', drumbuss: 'Drum Buss',
        stereoimage: 'Stereo Image',
      };
      const effect: Effect = {
        id: createId(),
        type,
        label: EFFECT_LABELS[type] ?? type,
        enabled: true,
        params: DEFAULT_EFFECT_PARAMS(type),
        collapsed: false,
      };
      const prev = s.sceneEffects[groupId] ?? [];
      return { sceneEffects: { ...s.sceneEffects, [groupId]: [...prev, effect] } };
    }),

  removeSceneEffect: (groupId, effectId) =>
    set((s) => {
      const prev = s.sceneEffects[groupId] ?? [];
      return { sceneEffects: { ...s.sceneEffects, [groupId]: prev.filter((e) => e.id !== effectId) } };
    }),

  setSceneEffectParam: (groupId, effectId, key, value) =>
    set((s) => {
      const prev = s.sceneEffects[groupId] ?? [];
      return {
        sceneEffects: {
          ...s.sceneEffects,
          [groupId]: prev.map((e) => e.id === effectId ? { ...e, params: { ...e.params, [key]: value } } : e),
        },
      };
    }),

  toggleSceneEffectEnabled: (groupId, effectId) =>
    set((s) => {
      const prev = s.sceneEffects[groupId] ?? [];
      return {
        sceneEffects: {
          ...s.sceneEffects,
          [groupId]: prev.map((e) => e.id === effectId ? { ...e, enabled: !e.enabled } : e),
        },
      };
    }),

  toggleSceneEffectCollapsed: (groupId, effectId) =>
    set((s) => {
      const prev = s.sceneEffects[groupId] ?? [];
      return {
        sceneEffects: {
          ...s.sceneEffects,
          [groupId]: prev.map((e) => e.id === effectId ? { ...e, collapsed: !e.collapsed } : e),
        },
      };
    }),

  reorderSceneEffects: (groupId, fromIdx, toIdx) =>
    set((s) => {
      const effects = [...(s.sceneEffects[groupId] ?? [])];
      const [item] = effects.splice(fromIdx, 1);
      effects.splice(toIdx, 0, item);
      return { sceneEffects: { ...s.sceneEffects, [groupId]: effects } };
    }),

  addInstrumentToScene: (instrumentId: string, sceneId: string) => {
    const s = get();
    const inst = s.instruments.find((i) => i.id === instrumentId);
    if (!inst) return;
    const targetScene = s.scenes.find((g) => g.id === sceneId);
    if (!targetScene) return;
    if (targetScene.instrumentIds.includes(instrumentId)) return; // already in scene

    // Add to target scene (allow multi-scene membership)
    const scenes = s.scenes.map((g) =>
      g.id === sceneId ? { ...g, instrumentIds: [...g.instrumentIds, instrumentId] } : g,
    );

    // Route audio to this scene if not already routed to another
    const alreadyInAScene = s.scenes.some((g) => g.instrumentIds.includes(instrumentId));
    if (!alreadyInAScene) {
      routeOrbitToScene(inst.orbitIndex, sceneId);
    }

    set({ scenes });
  },

  removeInstrumentFromScene: (instrumentId: string, sceneId: string) => {
    const s = get();
    const inst = s.instruments.find((i) => i.id === instrumentId);
    if (!inst) return;
    const scene = s.scenes.find((g) => g.id === sceneId);
    if (!scene || !scene.instrumentIds.includes(instrumentId)) return;

    // Unroute from scene bus
    unrouteOrbitFromScene(inst.orbitIndex);

    const sceneEffects = { ...s.sceneEffects };
    let scenes = s.scenes.map((g) =>
      g.id === sceneId ? { ...g, instrumentIds: g.instrumentIds.filter((id) => id !== instrumentId) } : g,
    );

    // Dissolve empty scenes
    const dissolvedIds = scenes.filter((g) => g.instrumentIds.length === 0).map((g) => g.id);
    scenes = scenes.filter((g) => g.instrumentIds.length > 0);
    for (const did of dissolvedIds) {
      delete sceneEffects[did];
      destroySceneBus(did);
    }

    set({
      scenes,
      sceneEffects,
      selectedSceneId: dissolvedIds.includes(s.selectedSceneId ?? '') ? null : s.selectedSceneId,
    });
  },

  // Track Mode
  toggleTrackMode: () => set((s) => {
    const newTrackMode = !s.trackMode;
    return {
      trackMode: newTrackMode,
      trackPosition: newTrackMode && s.arrangement.length > 0 ? 0 : -1,
      // Mutual exclusivity: disable live mode when enabling track mode
      ...(newTrackMode ? { liveMode: false, liveActiveSceneId: null, liveQueuedSceneId: null, liveBarCountdown: 0, liveBarsElapsed: 0 } : {}),
    };
  }),

  addArrangementStep: (sceneId, bars = 4) =>
    set((s) => ({
      arrangement: [...s.arrangement, { id: crypto.randomUUID(), sceneId, bars }],
    })),

  removeArrangementStep: (stepId) =>
    set((s) => ({
      arrangement: s.arrangement.filter((a) => a.id !== stepId),
    })),

  reorderArrangementSteps: (fromIdx, toIdx) =>
    set((s) => {
      const arr = [...s.arrangement];
      const [item] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, item);
      return { arrangement: arr };
    }),

  setArrangementStepBars: (stepId, bars) =>
    set((s) => ({
      arrangement: s.arrangement.map((a) =>
        a.id === stepId ? { ...a, bars: Math.max(1, Math.min(64, bars)) } : a,
      ),
    })),

  duplicateArrangementStep: (stepId) =>
    set((s) => {
      const idx = s.arrangement.findIndex((a) => a.id === stepId);
      if (idx === -1) return s;
      const copy = { ...s.arrangement[idx], id: crypto.randomUUID() };
      const arr = [...s.arrangement];
      arr.splice(idx + 1, 0, copy);
      return { arrangement: arr };
    }),

  setTrackPosition: (index) => set({ trackPosition: index }),
  setTrackStepProgress: (progress) => set({ trackStepProgress: progress }),

  // Live Mode
  toggleLiveMode: () => set((s) => {
    const newLiveMode = !s.liveMode;
    return {
      liveMode: newLiveMode,
      // Mutual exclusivity: disable track mode
      ...(newLiveMode ? { trackMode: false, trackPosition: -1 } : {}),
      // Clear live state when disabling
      ...(!newLiveMode ? {
        liveActiveSceneId: null, liveQueuedSceneId: null,
        liveBarCountdown: 0, liveBarsElapsed: 0,
        liveActiveSceneIds: [], liveQueuedToggles: [],
      } : {}),
    };
  }),

  setLiveLaunchMode: (mode) => set(() => ({
    liveLaunchMode: mode,
    liveActiveSceneId: null, liveQueuedSceneId: null,
    liveBarCountdown: 0, liveBarsElapsed: 0,
    liveActiveSceneIds: [], liveQueuedToggles: [],
  })),

  launchScene: (sceneId) => set((s) => {
    if (s.liveLaunchMode === 'stack') {
      // Stack mode: toggle scene in/out — queue for bar boundary
      const alreadyQueued = s.liveQueuedToggles.includes(sceneId);
      if (alreadyQueued) {
        // Cancel the queued toggle
        return { liveQueuedToggles: s.liveQueuedToggles.filter((id) => id !== sceneId) };
      }
      // If nothing is active and nothing queued, activate immediately
      if (s.liveActiveSceneIds.length === 0 && s.liveQueuedToggles.length === 0) {
        return {
          liveActiveSceneIds: [sceneId],
          liveQueuedToggles: [],
          liveBarCountdown: 0,
          liveBarsElapsed: 0,
        };
      }
      // Queue toggle at next bar boundary
      return {
        liveQueuedToggles: [...s.liveQueuedToggles, sceneId],
        liveBarCountdown: s.liveBarCountdown || s.liveLaunchQuantize,
      };
    }

    // Queue mode (original behavior)
    // Re-launching the active scene → clear queue
    if (sceneId === s.liveActiveSceneId) {
      return { liveQueuedSceneId: null, liveBarCountdown: 0 };
    }
    // Nothing playing → activate immediately
    if (!s.liveActiveSceneId) {
      return { liveActiveSceneId: sceneId, liveQueuedSceneId: null, liveBarCountdown: 0, liveBarsElapsed: 0 };
    }
    // Already playing → queue with quantize
    return { liveQueuedSceneId: sceneId, liveBarCountdown: s.liveLaunchQuantize };
  }),

  stopLiveScene: () => set({
    liveActiveSceneId: null,
    liveQueuedSceneId: null,
    liveBarCountdown: 0,
    liveBarsElapsed: 0,
    liveActiveSceneIds: [],
    liveQueuedToggles: [],
  }),

  setLiveLaunchQuantize: (bars) => set({ liveLaunchQuantize: bars }),
  setLiveBarCountdown: (n) => set({ liveBarCountdown: n }),
  setLiveBarsElapsed: (n) => set({ liveBarsElapsed: n }),

  switchToQueuedScene: () => set((s) => ({
    liveActiveSceneId: s.liveQueuedSceneId,
    liveQueuedSceneId: null,
    liveBarCountdown: 0,
    liveBarsElapsed: 0,
  })),

  processStackToggles: () => set((s) => {
    if (s.liveQueuedToggles.length === 0) return {};
    const active = new Set(s.liveActiveSceneIds);
    for (const id of s.liveQueuedToggles) {
      if (active.has(id)) active.delete(id);
      else active.add(id);
    }
    return {
      liveActiveSceneIds: [...active],
      liveQueuedToggles: [],
      liveBarCountdown: 0,
    };
  }),

  // Recording
  isRecording: false,
  recordings: [],
  recordingFolders: [],
  recordingFormat: 'wav' as RecordingFormat,
  recordingQuality: 0.75,

  hydrateRecordings: async () => {
    const [recs, folders] = await Promise.all([loadAllRecordings(), loadAllFolders()]);
    recs.sort((a, b) => a.order - b.order);
    set({ recordings: recs, recordingFolders: folders });
  },

  startRecording: () => {
    if (recStart()) {
      set({ isRecording: true });
      import('../logging/logger').then(({ log }) => log.info('store', 'Recording started'));
    }
  },

  stopRecording: async () => {
    const { recordingFormat, recordingQuality } = get();
    const result = await stopRecordingAsync(recordingFormat, recordingQuality);
    if (result) {
      const order = get().recordings.length;
      const newRec: StoredRecording = {
        id: createId(), blob: result.blob, name: `Rec ${order + 1}`,
        duration: result.duration, timestamp: result.timestamp,
        folderId: null, format: recordingFormat, order,
      };
      set((s) => ({ isRecording: false, recordings: [...s.recordings, newRec] }));
      import('../logging/logger').then(({ log }) => log.info('store', `Recording stopped: ${newRec.name}`, { duration: result.duration, format: recordingFormat }));
      dbSaveRec(newRec).catch(console.error);
      postSync({ type: 'recording-added', id: newRec.id });
    } else {
      set({ isRecording: false });
    }
  },

  deleteRecording: (id) => {
    set((s) => ({ recordings: s.recordings.filter((r) => r.id !== id) }));
    dbDelRec(id).catch(console.error);
    postSync({ type: 'recording-deleted', id });
  },

  renameRecording: (id, name) => {
    set((s) => ({ recordings: s.recordings.map((r) => (r.id === id ? { ...r, name } : r)) }));
    const rec = get().recordings.find((r) => r.id === id);
    if (rec) dbSaveRec(rec).catch(console.error);
    postSync({ type: 'recording-updated', id });
  },

  reorderRecordings: (fromIdx, toIdx) => {
    set((s) => {
      const recs = [...s.recordings];
      const [item] = recs.splice(fromIdx, 1);
      recs.splice(toIdx, 0, item);
      // Update order fields
      return { recordings: recs.map((r, i) => ({ ...r, order: i })) };
    });
    // Persist all with updated order
    for (const rec of get().recordings) dbSaveRec(rec).catch(console.error);
    postSync({ type: 'recordings-reordered' });
  },

  moveRecordingToFolder: (recordingId, folderId) => {
    set((s) => ({ recordings: s.recordings.map((r) => (r.id === recordingId ? { ...r, folderId } : r)) }));
    const rec = get().recordings.find((r) => r.id === recordingId);
    if (rec) dbSaveRec(rec).catch(console.error);
    postSync({ type: 'recording-updated', id: recordingId });
  },

  createRecordingFolder: (name) => {
    const folder = { id: createId(), name };
    set((s) => ({ recordingFolders: [...s.recordingFolders, folder] }));
    dbSaveFolder(folder).catch(console.error);
    postSync({ type: 'folder-added', id: folder.id });
  },

  renameRecordingFolder: (id, name) => {
    set((s) => ({ recordingFolders: s.recordingFolders.map((f) => (f.id === id ? { ...f, name } : f)) }));
    const folder = get().recordingFolders.find((f) => f.id === id);
    if (folder) dbSaveFolder(folder).catch(console.error);
    postSync({ type: 'folder-updated', id });
  },

  deleteRecordingFolder: (id) => {
    set((s) => ({
      recordingFolders: s.recordingFolders.filter((f) => f.id !== id),
      recordings: s.recordings.map((r) => (r.folderId === id ? { ...r, folderId: null } : r)),
    }));
    dbDelFolder(id).catch(console.error);
    // Persist orphaned recordings with null folderId
    for (const rec of get().recordings.filter((r) => r.folderId === null)) {
      dbSaveRec(rec).catch(console.error);
    }
    postSync({ type: 'folder-deleted', id });
  },

  setRecordingFormat: (recordingFormat) => set({ recordingFormat }),
  setRecordingQuality: (recordingQuality) => set({ recordingQuality }),

  // Looper
  looperEditors: {},

  assignLoop: (instrumentId, loopPath, displayName) => {
    // Resolve blob URL from customSamples for imported samples
    const customSample = get().customSamples.find((cs) => cs.key === loopPath);
    const url = customSample?.url
      ? customSample.url
      : loopPath.startsWith('blob:') || loopPath.startsWith('http')
        ? loopPath
        : SAMPLE_BASE_URL + loopPath;

    const sdKey = registerSampleForPlayback(loopPath);
    loadSample(loopPath, url);

    set((s) => ({
      instruments: s.instruments.map((inst) =>
        inst.id === instrumentId
          ? { ...inst, sampleName: sdKey, samplePath: loopPath, name: displayName }
          : inst
      ),
    }));

    // Decode audio and init editor — reuse Tone.js AudioContext
    const ctx = Tone.getContext().rawContext as AudioContext;
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${loopPath}`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        if (buf.byteLength === 0) throw new Error('empty response');
        return ctx.decodeAudioData(buf);
      })
      .then((decoded) => {
        get().initLooperEditor(instrumentId, decoded);
      })
      .catch((e) => console.error('[assignLoop] decode failed:', e));
  },

  updateLooperParams: (id, params) =>
    set((s) => ({
      instruments: s.instruments.map((inst) =>
        inst.id === id
          ? { ...inst, looperParams: { ...(inst.looperParams ?? DEFAULT_LOOPER_PARAMS), ...params } }
          : inst
      ),
    })),

  initLooperEditor: (instrumentId, buffer) => {
    const projectBpm = get().bpm;
    const inst = get().instruments.find((i) => i.id === instrumentId);
    const samplePath = inst?.samplePath ?? '';
    const existingRes = get().looperEditors[instrumentId]?.peakResolution ?? 2048;
    const peaks = extractPeaks(buffer, existingRes);

    // Check BPM cache first for instant results
    const cachedBpm = getCachedBpm(samplePath);

    // Use cached BPM for initial estimate if available, otherwise fall back to project BPM
    const initialBpm = cachedBpm > 0 ? cachedBpm : 0;
    const stepsPerBeat = get().stepsPerBeat;
    const fallbackLoopSize = estimateLoopSize(buffer, projectBpm, initialBpm, stepsPerBeat);

    set((s) => ({
      looperEditors: {
        ...s.looperEditors,
        [instrumentId]: {
          ...createLooperEditorState(),
          peakResolution: existingRes,
          audioBuffer: buffer,
          peaks,
        },
      },
      instruments: s.instruments.map((i) =>
        i.id === instrumentId
          ? { ...i, hits: 0, hitPositions: [], loopSize: fallbackLoopSize, detectedLoopSize: fallbackLoopSize, detectedBpm: cachedBpm || i.detectedBpm, looperParams: { ...(i.looperParams ?? DEFAULT_LOOPER_PARAMS) } }
          : i
      ),
      gridNotes: {
        ...s.gridNotes,
        [instrumentId]: [],
      },
    }));

    if (cachedBpm > 0) {
      if (import.meta.env.DEV) console.log(`[looper] Using cached BPM: ${cachedBpm}, loopSize: ${fallbackLoopSize}`);
    }

    // Always run async BPM detection to verify/update cache
    detectBpm(buffer).then((detectedBpm) => {
      if (detectedBpm <= 0) {
        if (import.meta.env.DEV) console.log(`[looper] BPM detection returned 0, keeping loopSize=${fallbackLoopSize}`);
        return;
      }

      // Cache the detected BPM for future loads
      if (samplePath) setCachedBpm(samplePath, detectedBpm);

      // If we already applied this BPM from cache, just ensure it's on the instrument
      const currentInst = get().instruments.find((i) => i.id === instrumentId);
      if (currentInst?.detectedBpm === detectedBpm) return;

      const refinedLoopSize = estimateLoopSize(buffer, projectBpm, detectedBpm, stepsPerBeat);

      if (refinedLoopSize === fallbackLoopSize) {
        // loopSize unchanged, but still store detectedBpm
        set((s) => ({
          instruments: s.instruments.map((i) =>
            i.id === instrumentId ? { ...i, detectedBpm } : i
          ),
        }));
        if (import.meta.env.DEV) console.log(`[looper] BPM detected: ${detectedBpm.toFixed(1)}, loopSize unchanged: ${refinedLoopSize}`);
        return;
      }

      set((s) => ({
        instruments: s.instruments.map((i) =>
          i.id === instrumentId
            ? { ...i, loopSize: refinedLoopSize, detectedLoopSize: refinedLoopSize, detectedBpm }
            : i
        ),
      }));
      if (import.meta.env.DEV) console.log(`[looper] BPM detected: ${detectedBpm.toFixed(1)}, loopSize: ${refinedLoopSize} (was ${fallbackLoopSize})`);
    }).catch((e) => {
      if (import.meta.env.DEV) console.warn('[looper] BPM detection error:', e);
    });
  },

  setLooperZoom: (instrumentId, viewStart, viewEnd) =>
    set((s) => ({
      looperEditors: {
        ...s.looperEditors,
        [instrumentId]: {
          ...(s.looperEditors[instrumentId] ?? createLooperEditorState()),
          viewStart,
          viewEnd,
        },
      },
    })),

  setLooperLoop: (instrumentId, loopIn, loopOut) =>
    set((s) => ({
      looperEditors: {
        ...s.looperEditors,
        [instrumentId]: {
          ...(s.looperEditors[instrumentId] ?? createLooperEditorState()),
          loopIn: Math.max(0, Math.min(1, loopIn)),
          loopOut: Math.max(0, Math.min(1, Math.max(loopIn + 0.001, loopOut))),
        },
      },
    })),

  setDetectedBpm: (instrumentId, bpm) => {
    const inst = get().instruments.find((i) => i.id === instrumentId);
    if (inst?.samplePath) setCachedBpm(inst.samplePath, bpm);
    set((s) => ({
      instruments: s.instruments.map((i) =>
        i.id === instrumentId ? { ...i, detectedBpm: bpm } : i
      ),
    }));
  },

  setLooperBpmMultiplier: (instrumentId, multiplier) => {
    const inst = get().instruments.find((i) => i.id === instrumentId);
    const editor = get().looperEditors[instrumentId];
    if (!inst || !editor?.audioBuffer) return;

    const detectedBpm = inst.detectedBpm ?? 0;
    if (detectedBpm <= 0) return; // can't compute without detected BPM

    const projectBpm = get().bpm;
    const effectiveBpm = detectedBpm * multiplier;
    const newLoopSize = estimateLoopSize(editor.audioBuffer, projectBpm, effectiveBpm, get().stepsPerBeat);

    set((s) => ({
      instruments: s.instruments.map((i) =>
        i.id === instrumentId
          ? { ...i, bpmMultiplier: multiplier, loopSize: newLoopSize }
          : i
      ),
    }));
  },

  autoMatchBpm: (instrumentId) => {
    const inst = get().instruments.find((i) => i.id === instrumentId);
    if (!inst) return;
    const detectedBpm = inst.detectedBpm ?? 0;
    if (detectedBpm <= 0) return;
    const multiplier = inst.bpmMultiplier ?? 1;
    const projectBpm = get().bpm;
    const speed = Math.max(0.25, Math.min(4, projectBpm / (detectedBpm * multiplier)));
    get().updateLooperParams(instrumentId, { speed });
  },

  // Set (project) management
  currentSetId: null,
  currentSetName: generateName(),
  currentSetThumbnail: null,

  setCurrentSetName: (name) => set({ currentSetName: name }),
  setCurrentSetThumbnail: (thumb) => set({ currentSetThumbnail: thumb }),

  getSerializableState: () => {
    const s = get();
    return {
      bpm: s.bpm,
      masterVolume: s.masterVolume,
      instruments: s.instruments,
      gridNotes: s.gridNotes,
      gridGlide: s.gridGlide,
      gridLengths: s.gridLengths,
      gridVelocities: s.gridVelocities,
      instrumentEffects: s.instrumentEffects,
      masterEffects: s.masterEffects,
      scenes: s.scenes,
      sceneEffects: s.sceneEffects,
      customSamples: s.customSamples,
      gridResolution: s.gridResolution,
      scaleRoot: s.scaleRoot,
      scaleType: s.scaleType,
      trackMode: s.trackMode,
      arrangement: s.arrangement,
      liveLaunchQuantize: s.liveLaunchQuantize,
      liveLaunchMode: s.liveLaunchMode,
    };
  },

  loadSet: (orbitrackSet: OrbitrackSet) => {
    import('../logging/logger').then(({ log }) => log.info('store', `Set loaded: ${orbitrackSet.meta?.name ?? 'unnamed'}`, { instruments: orbitrackSet.instruments?.length, scenes: orbitrackSet.scenes?.length }));
    // Tear down existing group buses before loading new state
    destroyAllSceneBuses();

    // Revoke old blob URLs to free memory before creating new ones
    for (const cs of get().customSamples) {
      try { URL.revokeObjectURL(cs.url); } catch { /* ignore */ }
    }

    // Re-register custom samples from embedded data and pre-decode into superdough's buffer cache
    const customSamples: { key: string; url: string; name: string }[] = [];
    if (orbitrackSet.customSamples) {
      for (const es of orbitrackSet.customSamples) {
        const blob = base64ToBlob(es.base64, es.mimeType);
        const url = URL.createObjectURL(blob);
        registerSampleForPlayback(es.key, url);
        void preloadCustomSample(es.key, url); // pre-decode into superdough buffer cache
        customSamples.push({ key: es.key, url, name: es.name });
      }
    }

    // Re-register + pre-decode non-custom samples referenced by instruments
    for (const inst of orbitrackSet.instruments) {
      if ((inst.type === 'sampler' || inst.type === 'looper') && inst.samplePath) {
        const isCustom = customSamples.some((c) => c.key === inst.samplePath);
        if (!isCustom) {
          void preloadSample(inst.samplePath); // registers + pre-decodes into superdough buffer cache
        }
      }
    }

    // Reset orbit counter to match loaded instruments
    orbitCounter = orbitrackSet.instruments.reduce((max, i) => Math.max(max, i.orbitIndex + 1), 0);

    // Migration: use stepsPerBeat if saved, otherwise default to 16th notes
    let instruments = orbitrackSet.instruments;
    let stepsPerBeat = orbitrackSet.stepsPerBeat ?? 4;  // Default to 16th notes (4)

    set({
      bpm: orbitrackSet.bpm,
      stepsPerBeat,
      masterVolume: orbitrackSet.masterVolume,
      instruments,
      gridNotes: orbitrackSet.gridNotes,
      gridGlide: orbitrackSet.gridGlide,
      gridLengths: orbitrackSet.gridLengths,
      gridVelocities: orbitrackSet.gridVelocities ?? {},
      instrumentEffects: orbitrackSet.instrumentEffects,
      masterEffects: orbitrackSet.masterEffects ?? [],
      scenes: orbitrackSet.scenes ?? [],
      sceneEffects: orbitrackSet.sceneEffects ?? {},
      customSamples,
      currentSetId: orbitrackSet.meta.id,
      currentSetName: orbitrackSet.meta.name,
      currentSetThumbnail: orbitrackSet.meta.thumbnail ?? null,
      selectedInstrumentId: orbitrackSet.instruments[0]?.id ?? null,
      selectedInstrumentIds: orbitrackSet.instruments[0] ? [orbitrackSet.instruments[0].id] : [],
      selectedSceneId: null,
      gridResolution: orbitrackSet.gridResolution ?? 1,
      scaleRoot: orbitrackSet.scaleRoot ?? 0,
      scaleType: orbitrackSet.scaleType ?? 'chromatic',
      trackMode: orbitrackSet.trackMode ?? false,
      arrangement: orbitrackSet.arrangement ?? [],
      liveLaunchQuantize: ((orbitrackSet as unknown as Record<string, unknown>).liveLaunchQuantize as 1 | 2 | 4 | 8) ?? 1,
      liveLaunchMode: ((orbitrackSet as unknown as Record<string, unknown>).liveLaunchMode as 'queue' | 'stack') ?? 'queue',
      liveMode: false,
      liveActiveSceneId: null,
      liveQueuedSceneId: null,
      liveBarCountdown: 0,
      liveBarsElapsed: 0,
      liveActiveSceneIds: [],
      liveQueuedToggles: [],
    });

    // Persist last set ID for session restore on next load
    try {
      localStorage.setItem('orbitrack:lastSetId', orbitrackSet.meta.id);
    } catch { /* quota exceeded or private mode */ }

    // Re-init looper editors — async decode + BPM detection
    const baseUrl = SAMPLE_BASE_URL;
    for (const inst of orbitrackSet.instruments) {
      if (inst.type === 'looper' && inst.samplePath) {
        const custom = customSamples.find((c) => c.key === inst.samplePath);
        let url: string | null;
        if (custom) {
          url = custom.url;
        } else if (inst.samplePath.startsWith('blob:') || inst.samplePath.startsWith('http')) {
          url = inst.samplePath;
        } else if (inst.samplePath.startsWith('__recorded_input__/') || inst.samplePath.startsWith('__imported__/')) {
          // Custom sample whose data wasn't embedded — skip (can't fetch from file system)
          console.warn('[loadSet] skipping looper without embedded audio:', inst.samplePath);
          url = null;
        } else {
          url = baseUrl + inst.samplePath;
        }
        if (!url) continue;
        try {
          // Use native AudioContext (not the standardized-audio-context polyfill)
          const rawCtx = Tone.getContext().rawContext as unknown as { _nativeContext?: AudioContext };
          const ctx = rawCtx._nativeContext ?? (Tone.getContext().rawContext as unknown as AudioContext);
          fetch(url)
            .then((r) => {
              if (!r.ok) throw new Error(`fetch failed: ${r.status} ${r.statusText} for ${url}`);
              const ct = r.headers.get('content-type') ?? '';
              if (ct.includes('text/html')) throw new Error(`got HTML instead of audio for ${url}`);
              return r.arrayBuffer();
            })
            .then((buf) => {
              if (buf.byteLength === 0) throw new Error(`empty response for ${url}`);
              return ctx.decodeAudioData(buf);
            })
            .then((decoded) => get().initLooperEditor(inst.id, decoded))
            .catch((e) => console.error('[loadSet] looper decode failed:', e));
        } catch (e) {
          console.error('[loadSet] looper re-init failed:', e);
        }
      }
    }

    // Clear undo history — new project context
    import('./undoHistory').then((m) => m.clearHistory());

    // Re-initialize group buses from loaded state
    if (orbitrackSet.scenes && orbitrackSet.scenes.length > 0) {
      initSceneBusesFromState(orbitrackSet.scenes, orbitrackSet.instruments);
    }
  },

  newSet: () => {
    destroyAllSceneBuses();
    orbitCounter = 0;
    const instruments = defaultInstruments.map((inst) => ({
      ...inst,
      id: createId(),
      orbitIndex: orbitCounter++,
    }));
    const gridNotes: Record<string, number[][]> = {};
    for (const inst of instruments) {
      gridNotes[inst.id] = Array.from({ length: inst.hits }, () => [60]);
    }
    const bpm = Math.floor(Math.random() * (145 - 85 + 1)) + 85;
    set({
      bpm,
      masterVolume: 0.8,
      instruments,
      gridNotes,
      gridGlide: {},
      gridLengths: {},
      instrumentEffects: {},
      masterEffects: [],
      scenes: [],
      sceneEffects: {},
      customSamples: [],
      currentSetId: null,
      currentSetName: generateName(),
      currentSetThumbnail: null,
      selectedInstrumentId: null,
      selectedInstrumentIds: [],
      selectedSceneId: null,
      isPlaying: false,
      currentStep: -1,
      transportProgress: 0,
      gridResolution: 1,
      scaleRoot: 0,
      scaleType: 'chromatic',
      trackMode: false,
      arrangement: [],
      trackPosition: -1,
      liveMode: false,
      liveLaunchMode: 'queue' as 'queue' | 'stack',
      liveActiveSceneId: null,
      liveQueuedSceneId: null,
      liveLaunchQuantize: 1,
      liveBarCountdown: 0,
      liveBarsElapsed: 0,
      liveActiveSceneIds: [],
      liveQueuedToggles: [],
    });

    // Clear last set ID so autosave doesn't run for unsaved new sets
    try { localStorage.removeItem('orbitrack:lastSetId'); } catch { /* ignore */ }

    // Assign random samples to default sampler instruments
    const CATEGORIES: { keywords: string[]; index: number }[] = [
      { keywords: ['kick'],          index: 0 },
      { keywords: ['snare', 'clap'], index: 1 },
      { keywords: ['hat', 'hh'],     index: 2 },
      { keywords: ['conga'],         index: 3 },
    ];
    const flattenFiles = (entries: SampleEntry[]): SampleEntry[] => {
      const result: SampleEntry[] = [];
      for (const e of entries) {
        if (e.type === 'file') result.push(e);
        else if (e.children) result.push(...flattenFiles(e.children));
      }
      return result;
    };
    fetchSampleTree().then((tree) => {
      const files = flattenFiles(tree);
      const store = get();
      for (const { keywords, index } of CATEGORIES) {
        const inst = store.instruments[index];
        if (!inst) continue;
        const matches = files.filter((f) =>
          keywords.some((kw) => f.name.toLowerCase().includes(kw))
        );
        if (matches.length === 0) continue;
        const pick = matches[Math.floor(Math.random() * matches.length)];
        get().assignSample(inst.id, pick.path, pick.name.replace(/\.[^.]+$/, ''));
      }
    });

    // Clear undo history — new project context
    import('./undoHistory').then((m) => m.clearHistory());
  },
}));

// Auto-enable logger if persisted
if (useStore.getState().logEnabled) {
  import('../logging/logger').then(({ log }) => log.enable());
}
