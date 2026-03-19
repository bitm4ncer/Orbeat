/**
 * Global undo/redo history for orbitrack.
 *
 * Subscribe-based: watches the Zustand store for changes, captures snapshots
 * of only the "undoable" state slice, debounces rapid changes (knob drags),
 * and exposes undo()/redo() functions.
 *
 * Does NOT modify any existing store actions — purely additive.
 */

import { useStore } from './store';
import type { StoreState } from './store';
import type { Instrument } from '../types/instrument';
import type { Effect } from '../types/effects';
import type { InstrumentScene } from '../types/scene';
import {
  destroyAllSceneBuses,
  initSceneBusesFromState,
  applySceneEffects,
} from '../audio/sceneBus';

// --- Undoable state slice ---

interface UndoableState {
  bpm: number;
  masterVolume: number;
  instruments: Instrument[];
  gridNotes: Record<string, number[][]>;
  gridGlide: Record<string, boolean[]>;
  gridLengths: Record<string, number[][]>;
  instrumentEffects: Record<string, Effect[]>;
  masterEffects: Effect[];
  customSamples: { key: string; url: string; name: string }[];
  octaveOffset: number;
  snapEnabled: boolean;
  gridResolution: number;
  scaleRoot: number;
  scaleType: string;
  scenes: InstrumentScene[];
  sceneEffects: Record<string, Effect[]>;
}

const UNDOABLE_KEYS: (keyof UndoableState)[] = [
  'bpm', 'masterVolume', 'instruments',
  'gridNotes', 'gridGlide', 'gridLengths',
  'instrumentEffects', 'masterEffects', 'customSamples',
  'octaveOffset', 'snapEnabled', 'gridResolution',
  'scaleRoot', 'scaleType',
  'scenes', 'sceneEffects',
];

function pickUndoable(state: StoreState): UndoableState {
  return {
    bpm: state.bpm,
    masterVolume: state.masterVolume,
    instruments: state.instruments,
    gridNotes: state.gridNotes,
    gridGlide: state.gridGlide,
    gridLengths: state.gridLengths,
    instrumentEffects: state.instrumentEffects,
    masterEffects: state.masterEffects,
    customSamples: state.customSamples,
    octaveOffset: state.octaveOffset,
    snapEnabled: state.snapEnabled,
    gridResolution: state.gridResolution,
    scaleRoot: state.scaleRoot,
    scaleType: state.scaleType,
    scenes: state.scenes,
    sceneEffects: state.sceneEffects,
  };
}

/** Rebuild scene audio buses to match restored state (after undo/redo). */
function reconcileSceneBuses(snapshot: UndoableState): void {
  destroyAllSceneBuses();
  if (snapshot.scenes.length > 0) {
    initSceneBusesFromState(snapshot.scenes, snapshot.instruments);
    const bpm = snapshot.bpm;
    for (const scene of snapshot.scenes) {
      const fx = snapshot.sceneEffects[scene.id];
      if (fx && fx.length > 0) {
        applySceneEffects(scene.id, fx, bpm);
      }
    }
  }
}

/** Shallow reference equality — leverages Zustand's structural sharing. */
function snapshotsEqual(a: UndoableState, b: UndoableState): boolean {
  for (const key of UNDOABLE_KEYS) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

// --- History stacks ---

const MAX_HISTORY = 50;
const DEBOUNCE_MS = 300;

let past: UndoableState[] = [];
let future: UndoableState[] = [];
let currentSnapshot: UndoableState | null = null;
let isProgrammaticUpdate = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function pushSnapshot(snapshot: UndoableState): void {
  if (currentSnapshot) {
    past.push(currentSnapshot);
    if (past.length > MAX_HISTORY) {
      past = past.slice(past.length - MAX_HISTORY);
    }
  }
  currentSnapshot = snapshot;
  future = [];
}

// --- Public API ---

export function undo(): void {
  // Flush any pending debounced snapshot first
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    const latest = pickUndoable(useStore.getState());
    if (currentSnapshot && !snapshotsEqual(latest, currentSnapshot)) {
      pushSnapshot(latest);
    }
  }

  if (past.length === 0) return;

  future.push(currentSnapshot!);
  if (future.length > MAX_HISTORY) {
    future = future.slice(future.length - MAX_HISTORY);
  }
  currentSnapshot = past.pop()!;

  isProgrammaticUpdate = true;
  useStore.setState(currentSnapshot);
  reconcileSceneBuses(currentSnapshot);
  isProgrammaticUpdate = false;
}

export function redo(): void {
  if (future.length === 0) return;

  past.push(currentSnapshot!);
  if (past.length > MAX_HISTORY) {
    past = past.slice(past.length - MAX_HISTORY);
  }
  currentSnapshot = future.pop()!;

  isProgrammaticUpdate = true;
  useStore.setState(currentSnapshot);
  reconcileSceneBuses(currentSnapshot);
  isProgrammaticUpdate = false;
}

export function clearHistory(): void {
  past = [];
  future = [];
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  currentSnapshot = pickUndoable(useStore.getState());
}

export function initUndoHistory(): void {
  currentSnapshot = pickUndoable(useStore.getState());

  useStore.subscribe((state) => {
    if (isProgrammaticUpdate) return;

    const picked = pickUndoable(state);
    if (currentSnapshot && snapshotsEqual(picked, currentSnapshot)) return;

    // Debounce: batch rapid changes (knob drags) into one undo entry
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const latest = pickUndoable(useStore.getState());
      if (currentSnapshot && !snapshotsEqual(latest, currentSnapshot)) {
        pushSnapshot(latest);
      }
    }, DEBOUNCE_MS);
  });
}
