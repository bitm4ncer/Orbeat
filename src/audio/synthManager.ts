import { SynthEngine } from './synth/SynthEngine';
import { getSynthOrbitInput } from './orbitEffects';
import type { SynthParams } from './synth/types';
import { getAudioContext } from 'superdough';

interface EngineEntry {
  engine: SynthEngine;
  orbitIndex: number;
  connected: boolean;
  paramsApplied: boolean; // true once initialParams have been applied (avoid re-applying every note)
}

const engines: Map<string, EngineEntry> = new Map();

export function getSynthEngine(instrumentId: string, orbitIndex: number, initialParams?: SynthParams): SynthEngine {
  const existing = engines.get(instrumentId);

  if (existing) {
    // Apply saved params only once (first call with initialParams after engine creation)
    if (initialParams && !existing.paramsApplied) {
      for (const key of Object.keys(initialParams) as (keyof SynthParams)[]) {
        existing.engine.setParam(key, initialParams[key] as never);
      }
      existing.paramsApplied = true;
    }
    // Reconnect if not yet connected (audio wasn't ready at creation time) or orbit changed
    if (!existing.connected || existing.orbitIndex !== orbitIndex) {
      const orbitInput = getSynthOrbitInput(orbitIndex);
      if (orbitInput) {
        if (existing.connected) {
          try { existing.engine.getOutputNode().disconnect(); } catch { /* ignore */ }
        }
        try {
          existing.engine.getOutputNode().connect(orbitInput);
          existing.orbitIndex = orbitIndex;
          existing.connected = true;
        } catch { /* cross-context or not-ready — will retry on next call */ }
      }
    }
    return existing.engine;
  }

  // Use superdough's AudioContext — it's the single shared context for everything
  // (Tone.js, superdough orbits, synth engines, effect chains).
  const ac = getAudioContext() as AudioContext;
  const engine = new SynthEngine(ac);
  engine.init();

  // Restore saved params if provided (e.g. from autosave / set load)
  if (initialParams) {
    try {
      for (const key of Object.keys(initialParams) as (keyof SynthParams)[]) {
        engine.setParam(key, initialParams[key] as never);
      }
    } catch (e) {
      console.warn('[synthManager] Error restoring params:', e);
    }
  }

  // Connect engine output → orbit effects chain input (may be null if audio not ready yet)
  const orbitInput = getSynthOrbitInput(orbitIndex);
  let connected = false;
  if (orbitInput) {
    try {
      engine.getOutputNode().connect(orbitInput);
      connected = true;
    } catch {
      // Orbit node may be on a different context if audio isn't fully initialized
    }
  }

  engines.set(instrumentId, { engine, orbitIndex, connected, paramsApplied: !!initialParams });
  return engine;
}

export function removeSynthEngine(instrumentId: string): void {
  const entry = engines.get(instrumentId);
  if (entry) {
    entry.engine.dispose();
    try { entry.engine.getOutputNode().disconnect(); } catch { /* ignore */ }
    engines.delete(instrumentId);
  }
}

export function getAllEngines(): Map<string, SynthEngine> {
  const result = new Map<string, SynthEngine>();
  for (const [id, entry] of engines) {
    result.set(id, entry.engine);
  }
  return result;
}

/** Number of active synth engines (for perf monitoring). */
export function getActiveSynthCount(): number {
  return engines.size;
}

/** Mark all engines as disconnected so they reconnect on next noteOn.
 *  Called when orbit nodes are destroyed (e.g. stopTransport → silenceAll). */
export function disconnectAllEngines(): void {
  for (const [, entry] of engines) {
    entry.connected = false;
  }
}

/** Sync BPM to all active ModulationEngines (for tempo-synced LFOs). */
let _lastSyncedBpm = 0;
export function syncBpmToEngines(bpm: number): void {
  if (bpm === _lastSyncedBpm) return;
  _lastSyncedBpm = bpm;
  for (const [, entry] of engines) {
    entry.engine.setBpm(bpm);
  }
}
