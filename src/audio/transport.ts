import * as Tone from 'tone';
import { getAudioContext, getSuperdoughAudioController } from 'superdough';
import { useStore } from '../state/store';
import { triggerSuperdough, triggerLooperContinuous } from './superdoughAdapter';
import { applyOrbitToneEffects, invalidateSynthRouting } from './orbitEffects';
import { applySceneEffects, setSceneBusVolume, setSceneBusMuted } from './sceneBus';
import { syncBpmToEngines, disconnectAllEngines } from './synthManager';
import { log } from '../logging/logger';

let schedulerId: number | null = null;
let effectSyncId: ReturnType<typeof setInterval> | null = null;

// Simple monotonic step counter — incremented exactly once per scheduleRepeat
// callback. Eliminates all floating-point time→step drift.
let _globalStep = 0;

// Per-instrument: last globalStep at which each hit index was triggered.
// Prevents double-fires even if the callback is invoked twice for the same step.
let _lastFired: Map<string, Map<number, number>> = new Map();

// Effect sync change detection — skip applyOrbitToneEffects when nothing changed.
// Zustand always creates a new array reference on write, so reference equality is valid.
const _lastApplied = new Map<string, { ref: unknown; bpm: number }>();
const _lastSceneApplied = new Map<string, { ref: unknown; bpm: number }>();
const _lastSceneState = new Map<string, { muted: boolean; volume: number }>();

// Tick-level caches — recomputed only when instruments array reference changes.
let _instrRef: unknown = null;
let _maxLoopSize = 1;
let _anySolo = false;

// Pre-allocated per-tick buffer — avoids creating a new object every tick.
const _instProgress: Record<string, number> = {};


// Track Mode: cached active-scene instrument set — rebuilt when scenes/arrangement ref changes.
let _trackSceneRef: unknown = null;
let _trackArrangementRef: unknown = null;
let _trackActiveSceneIdsCache: Set<string> | null = null;
let _trackInAnySceneCache: Set<string> | null = null;
let _trackCachedArrangementIdx = -1;

// Track Mode variables — incremented each _tick to track arrangement progression
let _currentArrangementIdx = 0;
let _stepLoopCount = 0;  // full loops of _maxLoopSize elapsed in current arrangement step

// Live Mode variables
let _liveBarCount = 0;

// Position buffer — written by the audio tick (zero React involvement),
// read by the rAF sync loop which gates UI updates to ~60 fps.
const _pos = {
  progress: 0,
  currentStep: 0,
  trackPosition: -1,
  trackStepProgress: 0,
  dirty: false,
};
let _rafId: number | null = null;

function startUISync(): void {
  function sync(): void {
    if (_pos.dirty) {
      _pos.dirty = false;

      // Recompute instProgress from transport.seconds at RAF-time so the grid
      // playhead is in sync with the orbit renderers (which also read
      // transport.seconds at RAF-time).  The _tick() writes discrete-step
      // progress which lags by 1-2 frames; recomputing here eliminates that.
      const state = useStore.getState();
      const transport = Tone.getTransport();
      const stepsPerBeat = state.stepsPerBeat ?? 8;
      const secondsPerStep = 60 / state.bpm / stepsPerBeat;
      const totalSteps = transport.seconds / secondsPerStep;

      // Reuse _instProgress buffer — only spread when values actually change
      let progressChanged = false;
      for (const inst of state.instruments) {
        // For loopers with an active loop region, _tick() already sets
        // _instProgress to cycle within the region — don't overwrite it.
        if (inst.type === 'looper') {
          const ed = state.looperEditors[inst.id];
          if (ed && (ed.loopIn > 0 || ed.loopOut < 1)) {
            progressChanged = true; // ensure the tick-written value propagates
            continue;
          }
        }
        const p = (totalSteps % inst.loopSize) / inst.loopSize;
        if (_instProgress[inst.id] !== p) {
          _instProgress[inst.id] = p;
          progressChanged = true;
        }
      }

      useStore.getState().setPlaybackUI(
        _pos.progress, _pos.currentStep,
        progressChanged ? { ..._instProgress } : state.instrumentProgress,
        _pos.trackPosition, _pos.trackStepProgress,
      );
    }
    _rafId = requestAnimationFrame(sync);
  }
  _rafId = requestAnimationFrame(sync);
}

function stopUISync(): void {
  if (_rafId !== null) {
    cancelAnimationFrame(_rafId);
    _rafId = null;
  }
}

export function startTransport(): void {
  const transport = Tone.getTransport();
  const state = useStore.getState();

  transport.bpm.value = state.bpm;
  transport.timeSignature = 4;
  _globalStep = 0;
  _lastFired.clear();

  // In Track Mode, start from the current playhead position (trackPosition)
  if (state.trackMode && state.arrangement.length > 0 && state.trackPosition >= 0) {
    _currentArrangementIdx = state.trackPosition;
    // Calculate globalStep to match the trackStepProgress
    const currentScene = state.arrangement[_currentArrangementIdx];
    _maxLoopSize = state.instruments.reduce((m, i) => Math.max(m, i.loopSize), 1);
    const stepsInScene = currentScene.bars * _maxLoopSize;
    const targetStep = Math.round(state.trackStepProgress * stepsInScene);
    _stepLoopCount = Math.floor(targetStep / _maxLoopSize);
    _globalStep = _stepLoopCount * _maxLoopSize + (targetStep % _maxLoopSize);
  } else {
    _currentArrangementIdx = 0;
    _stepLoopCount = 0;
  }
  _liveBarCount = 0;

  if (schedulerId !== null) {
    transport.clear(schedulerId);
  }

  // Schedule at finest resolution: stepsPerBeat * 4 gives us the note value
  // e.g., stepsPerBeat=8 → 32n, stepsPerBeat=4 → 16n
  const { stepsPerBeat } = useStore.getState();
  const intervalNote = `${stepsPerBeat * 4}n` as const;
  schedulerId = transport.scheduleRepeat((time) => {
    tick(time);
  }, intervalNote);

  transport.start();
  useStore.getState().setPlaying(true);
  startUISync();
  startEffectSync();
  log.info('transport', 'Transport started', { bpm: state.bpm, stepsPerBeat, trackMode: state.trackMode, liveMode: state.liveMode, instruments: state.instruments.length });
}

/** Sync orbit effect chains at ~25 Hz — outside the audio callback so the
 *  tick() stays lightweight.  This keeps continuous effects like Trance Gate
 *  running even when no notes are firing. */
function startEffectSync(): void {
  stopEffectSync();
  effectSyncId = setInterval(() => {
    try {
      const state = useStore.getState();
      // Sync BPM to all synth engines (for tempo-synced LFOs)
      syncBpmToEngines(state.bpm);
      for (const inst of state.instruments) {
        const effects = state.instrumentEffects[inst.id] ?? [];

        // Skip if neither effects array nor bpm changed since last apply.
        const prev = _lastApplied.get(inst.id);
        if (prev?.ref === effects && prev?.bpm === state.bpm) continue;
        _lastApplied.set(inst.id, { ref: effects, bpm: state.bpm });
        applyOrbitToneEffects(inst.orbitIndex, effects, state.bpm);
      }

      // Group effects sync
      for (const group of state.scenes) {
        const effects = state.sceneEffects[group.id] ?? [];
        const prev = _lastSceneApplied.get(group.id);
        if (prev?.ref === effects && prev?.bpm === state.bpm) continue;
        _lastSceneApplied.set(group.id, { ref: effects, bpm: state.bpm });
        applySceneEffects(group.id, effects, state.bpm);

        // Sync group mute/volume state
        const lastState = _lastSceneState.get(group.id);
        if (!lastState || lastState.muted !== group.muted) {
          setSceneBusMuted(group.id, group.muted);
        }
        if (!lastState || lastState.volume !== group.volume) {
          setSceneBusVolume(group.id, group.volume);
        }
        _lastSceneState.set(group.id, { muted: group.muted, volume: group.volume });
      }
    } catch { /* safe to ignore */ }
  }, 40);
}

function stopEffectSync(): void {
  if (effectSyncId !== null) {
    clearInterval(effectSyncId);
    effectSyncId = null;
  }
}

/** Instantly silence all audio by destroying orbit nodes.
 *  Old sources lose their output path. superdough recreates orbits on next trigger. */
function silenceAll(): void {
  try {
    const controller = getSuperdoughAudioController() as any;
    const nodes = controller.nodes ?? {};
    for (const [key, orbit] of Object.entries(nodes)) {
      try { (orbit as any).disconnect(); } catch { /* ok */ }
    }
    controller.nodes = {};
  } catch { /* graceful fallback */ }
}

export function stopTransport(): void {
  const transport = Tone.getTransport();
  silenceAll();
  // Orbit nodes were just destroyed — invalidate synth routing so engines
  // and standalone inputs reconnect to fresh orbit nodes on next playback.
  invalidateSynthRouting();
  disconnectAllEngines();
  stopUISync();
  stopEffectSync();
  transport.stop();
  transport.position = 0;
  _globalStep = 0;
  _lastFired.clear();
  _lastApplied.clear();
  _lastSceneApplied.clear();
  _lastSceneState.clear();
  _instrRef = null;
  _trackSceneRef = null;
  _trackArrangementRef = null;
  _trackActiveSceneIdsCache = null;
  _trackInAnySceneCache = null;
  _trackCachedArrangementIdx = -1;
  _currentArrangementIdx = 0;
  _stepLoopCount = 0;
  _liveBarCount = 0;

  if (schedulerId !== null) {
    transport.clear(schedulerId);
    schedulerId = null;
  }

  useStore.getState().setPlaying(false);
  useStore.getState().setCurrentStep(-1);
  useStore.getState().setTransportProgress(0);
  useStore.getState().setTrackPosition(-1);
  log.info('transport', 'Transport stopped');
}

export function toggleTransport(): void {
  const { isPlaying } = useStore.getState();
  if (isPlaying) {
    stopTransport();
  } else {
    startTransport();
  }
}

export function setBpm(bpm: number): void {
  Tone.getTransport().bpm.value = bpm;
  useStore.getState().setBpm(bpm);
  log.debug('transport', `BPM set to ${bpm}`);
}

export function getGlobalStep(): number {
  return _globalStep;
}

export function getStepsPerBeat(): number {
  return useStore.getState().stepsPerBeat;
}

/** Remove cached data for a deleted instrument — prevents stale Map entries from leaking. */
export function cleanupInstrumentCache(id: string): void {
  _lastFired.delete(id);
  _lastApplied.delete(id);
}

let _tickCount = 0;

function tick(time: number): void {
  try {
    const t0 = performance.now();
    _tick(time);
    const dur = performance.now() - t0;

    // Always warn on slow ticks — these cause "schedule in the past" errors
    if (dur > 5) {
      console.warn(
        `%c[transport] ⚠ Slow tick: ${dur.toFixed(1)}ms (step ${_globalStep}, loop boundary: ${_globalStep % _maxLoopSize === 0})`,
        'color: #f59e0b',
      );
    }

    if (log.isEnabled && ++_tickCount % 100 === 0) {
      log.perf('transport', 'tick (avg over 100)', dur, { globalStep: _globalStep, maxLoopSize: _maxLoopSize });
    }
  } catch (e) {
    console.warn('[transport] tick error:', e);
    log.error('transport', 'Tick error', String(e));
  }
}

function _tick(time: number): void {
  const state = useStore.getState();
  const globalStep = _globalStep++;

  const stepsPerBeat = state.stepsPerBeat ?? 8;
  const secondsPerStep = 60 / state.bpm / stepsPerBeat;

  // Recompute derived instrument stats only when the instruments array changes.
  if (state.instruments !== _instrRef) {
    _instrRef    = state.instruments;
    _maxLoopSize = state.instruments.reduce((m, i) => Math.max(m, i.loopSize), 1);
    _anySolo     = state.instruments.some((i) => i.solo);
  }

  // UI position — use globalStep (not transport.seconds) for consistency
  const progress = (globalStep % _maxLoopSize) / _maxLoopSize;
  const currentStep = globalStep % _maxLoopSize;

  // Track Mode: bar counting and scene advancement
  if (state.trackMode && state.arrangement.length > 0) {
    // Sync _currentArrangementIdx with store's trackPosition (user may have moved playhead)
    _currentArrangementIdx = Math.max(0, Math.min(state.trackPosition, state.arrangement.length - 1));

    // Ensure trackPosition is initialized
    if (_pos.trackPosition < 0) {
      _pos.trackPosition = _currentArrangementIdx;
    }

    // One full loop of _maxLoopSize steps = one "bar" — check at tick boundary FIRST
    if (globalStep > 0 && globalStep % _maxLoopSize === 0) {
      _stepLoopCount++;
      const sceneStep = state.arrangement[_currentArrangementIdx];
      if (_stepLoopCount >= sceneStep.bars) {
        _stepLoopCount = 0;
        _currentArrangementIdx = (_currentArrangementIdx + 1) % state.arrangement.length;
        log.info('transport', `Track: advanced to arrangement step ${_currentArrangementIdx}`, { sceneId: state.arrangement[_currentArrangementIdx]?.sceneId });
        _pos.trackPosition = _currentArrangementIdx;
        _pos.trackStepProgress = 0;
        _pos.dirty = true;
      }
    }

    // Now calculate progress with updated _stepLoopCount
    const currentSceneStep = state.arrangement[_currentArrangementIdx];
    const totalStepsInScene = currentSceneStep.bars * _maxLoopSize;
    const stepsElapsedInScene = _stepLoopCount * _maxLoopSize + currentStep;
    _pos.trackStepProgress = Math.min(stepsElapsedInScene / totalStepsInScene, 1);
    _pos.trackPosition = _currentArrangementIdx;
    _pos.dirty = true;
  }

  // Live Mode: bar counting and queued scene switching
  const liveHasActive = state.liveLaunchMode === 'stack'
    ? state.liveActiveSceneIds.length > 0
    : !!state.liveActiveSceneId;

  if (state.liveMode && liveHasActive) {
    if (globalStep > 0 && globalStep % _maxLoopSize === 0) {
      _liveBarCount++;
      const store = useStore.getState();

      if (state.liveLaunchMode === 'stack') {
        // Stack mode: process queued toggles at bar boundary
        if (state.liveQueuedToggles.length > 0) {
          const newCountdown = state.liveBarCountdown - 1;
          if (newCountdown <= 0) {
            store.processStackToggles();
            _liveBarCount = 0;
          } else {
            store.setLiveBarCountdown(newCountdown);
          }
        }
      } else {
        // Queue mode: switch to queued scene at bar boundary
        if (state.liveQueuedSceneId) {
          const newCountdown = state.liveBarCountdown - 1;
          if (newCountdown <= 0) {
            store.switchToQueuedScene();
            _liveBarCount = 0;
          } else {
            store.setLiveBarCountdown(newCountdown);
          }
        }
      }

      store.setLiveBarsElapsed(_liveBarCount);
    }
  }

  // _instProgress is overwritten per-instrument below (line 443) —
  // no need to clear; stale keys from deleted instruments are harmless
  // since startUISync recomputes from the current instrument list.

  // Scene membership: cache active-scene instrument sets for Track Mode or Live Mode
  let activeSceneInstIds: Set<string> | null = null;
  let inAnySceneIds: Set<string> | null = null;

  // Determine active scene ID(s) for either mode
  let _modeActiveSceneId: string | undefined;
  let _modeActiveSceneIds: string[] | undefined;

  if (state.trackMode && state.arrangement.length > 0) {
    _modeActiveSceneId = state.arrangement[_currentArrangementIdx]?.sceneId;
  } else if (state.liveMode) {
    if (state.liveLaunchMode === 'stack' && state.liveActiveSceneIds.length > 0) {
      _modeActiveSceneIds = state.liveActiveSceneIds;
    } else if (state.liveActiveSceneId) {
      _modeActiveSceneId = state.liveActiveSceneId;
    }
  }

  const hasActiveScene = !!_modeActiveSceneId || (_modeActiveSceneIds && _modeActiveSceneIds.length > 0);

  if (hasActiveScene) {
    // Cache key: arrangement idx for track, -2 for live queue, -3 for live stack
    const cacheKey = state.trackMode ? _currentArrangementIdx : (_modeActiveSceneIds ? -3 : -2);
    const cacheRef = state.trackMode
      ? state.arrangement
      : (_modeActiveSceneIds ? state.liveActiveSceneIds : state.liveActiveSceneId) as unknown;

    if (
      state.scenes !== _trackSceneRef ||
      (state.trackMode && state.arrangement !== _trackArrangementRef) ||
      cacheKey !== _trackCachedArrangementIdx ||
      cacheRef !== _trackArrangementRef
    ) {
      _trackSceneRef = state.scenes;
      _trackArrangementRef = cacheRef;
      _trackCachedArrangementIdx = cacheKey;

      if (_modeActiveSceneIds) {
        // Stack mode: union of all active scenes' instruments
        const unionSet = new Set<string>();
        for (const sceneId of _modeActiveSceneIds) {
          const scene = state.scenes.find((s) => s.id === sceneId);
          if (scene) {
            for (const id of scene.instrumentIds) unionSet.add(id);
          }
        }
        _trackActiveSceneIdsCache = unionSet;
      } else {
        const activeScene = state.scenes.find((s) => s.id === _modeActiveSceneId);
        _trackActiveSceneIdsCache = activeScene
          ? new Set(activeScene.instrumentIds)
          : new Set();
      }

      const anySet = new Set<string>();
      for (const s of state.scenes) {
        for (const id of s.instrumentIds) anySet.add(id);
      }
      _trackInAnySceneCache = anySet;
    }
    activeSceneInstIds = _trackActiveSceneIdsCache;
    inAnySceneIds = _trackInAnySceneCache;
  }

  for (const instrument of state.instruments) {
    const loopSize = instrument.loopSize;

    // Per-instrument progress (0-1) within its own loop
    _instProgress[instrument.id] = (globalStep % loopSize) / loopSize;

    if (_anySolo && !instrument.solo) continue;

    // Track Mode: scene membership overrides manual mute
    if (activeSceneInstIds && inAnySceneIds) {
      const inAny = inAnySceneIds.has(instrument.id);
      if (inAny) {
        // In the active scene → play (override manual mute); not in active → skip
        if (!activeSceneInstIds.has(instrument.id)) continue;
        // falls through to trigger — manual mute ignored for scene members
      } else {
        // Not in any scene — normal mute applies
        if (instrument.muted && !instrument.solo) continue;
      }
    } else {
      if (instrument.muted && !instrument.solo) continue;
    }

    // ── Looper: continuous playback (one trigger per cycle) ──
    if (instrument.type === 'looper') {
      const startOffset = instrument.looperParams?.startOffset ?? 0;
      const offsetSteps = Math.round(startOffset * loopSize);
      const instStep = (globalStep + offsetSteps) % loopSize;

      // Trigger sample playback at the start of each cycle
      if (instStep === 0) {
        triggerLooperContinuous(instrument, secondsPerStep, time, state);
      }

      // Progress for playhead/orb
      const ed = state.looperEditors[instrument.id];
      const loopIn = ed?.loopIn ?? 0;
      const loopOut = ed?.loopOut ?? 1;
      _instProgress[instrument.id] = loopIn + (instStep / loopSize) * (loopOut - loopIn);
      continue;
    }

    // ── Synth/Sampler: per-step hit processing ──
    const { hitPositions, hits } = instrument;
    if (hits === 0 || hitPositions.length === 0) continue;

    if (!_lastFired.has(instrument.id)) {
      _lastFired.set(instrument.id, new Map());
    }
    const fired = _lastFired.get(instrument.id)!;

    const instStep = globalStep % loopSize;

    for (let i = 0; i < hitPositions.length; i++) {
      const hitPos = hitPositions[i];
      const hitStep = Math.round(hitPos * loopSize) % loopSize;

      if (hitStep === instStep) {
        if (fired.get(i) === globalStep) continue;
        fired.set(i, globalStep);

        const notes = state.gridNotes[instrument.id]?.[i];
        if (notes && notes.length > 0) {
          const glide = state.gridGlide[instrument.id]?.[i] ?? false;
          const noteLengths = state.gridLengths[instrument.id]?.[i] || [];
          const velocity = state.gridVelocities[instrument.id]?.[i] ?? 100;

          for (let j = 0; j < notes.length; j++) {
            const noteLength = noteLengths[j] ?? 1;
            const noteDuration = secondsPerStep * noteLength * 0.9;
            triggerSuperdough(instrument, notes[j], noteDuration, time, glide, velocity, state);
          }
        }
      }
    }
  }

  // Write position to buffer — the rAF loop will flush to Zustand at ~60 fps.
  // Note: instProgress is NOT written here — startUISync recomputes it from
  // transport.seconds at RAF-time for smoother interpolation.
  _pos.progress = progress;
  _pos.currentStep = currentStep;
  _pos.dirty = true;
}
