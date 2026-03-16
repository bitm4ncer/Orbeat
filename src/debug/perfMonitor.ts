/**
 * Lightweight performance monitor for orbitrack.
 *
 * Toggle via console:  window.__orbitrackPerf.start() / .stop()
 * Or keyboard:         Ctrl+Shift+P
 *
 * Logs every 2 seconds:
 *   FPS | Orbit chains | Synth engines | Heap MB | AudioContext state
 *
 * When enabled, also:
 *   - Warns on long frames (>33ms) with delta timing
 *   - Tracks memory trend and warns on sustained growth (potential leak)
 *   - Counts Zustand store updates per interval
 */

import { getActiveChainCount } from '../audio/orbitEffects';
import { getActiveSynthCount } from '../audio/synthManager';
import { getAudioContext } from 'superdough';

const LOG_INTERVAL_MS = 2000;
const LONG_FRAME_MS = 33; // warn when a single frame exceeds this
const HEAP_HISTORY_SIZE = 15; // ~30s of 2s samples

interface PerfSnapshot {
  fps: number;
  orbitChains: number;
  synthEngines: number;
  heapMB: number | null;
  audioState: string;
  longFrames: number;
  maxFrameMs: number;
  storeUpdates: number;
}

// Global counter incremented by the store — avoids import cycles
let _storeUpdateCount = 0;
export function countStoreUpdate(): void { _storeUpdateCount++; }

class PerfMonitor {
  private _enabled = false;
  private _frameCount = 0;
  private _lastTime = 0;
  private _lastFrameTime = 0;
  private _rafId: number | null = null;
  private _logIntervalId: ReturnType<typeof setInterval> | null = null;
  private _snapshot: PerfSnapshot = {
    fps: 0, orbitChains: 0, synthEngines: 0, heapMB: null,
    audioState: 'unknown', longFrames: 0, maxFrameMs: 0, storeUpdates: 0,
  };

  // Long frame tracking per log interval
  private _longFrameCount = 0;
  private _maxFrameDelta = 0;

  // Memory trend tracking
  private _heapHistory: number[] = [];

  /** Start the performance monitor. */
  start(): void {
    if (this._enabled) return;
    this._enabled = true;
    this._frameCount = 0;
    this._longFrameCount = 0;
    this._maxFrameDelta = 0;
    this._lastTime = performance.now();
    this._lastFrameTime = this._lastTime;
    this._heapHistory = [];
    _storeUpdateCount = 0;

    // RAF loop — counts frames and detects long gaps
    const tick = (now: number) => {
      if (!this._enabled) return;
      this._frameCount++;

      const delta = now - this._lastFrameTime;
      this._lastFrameTime = now;

      if (delta > LONG_FRAME_MS && this._frameCount > 2) {
        this._longFrameCount++;
        if (delta > this._maxFrameDelta) this._maxFrameDelta = delta;

        // Warn in console for really long frames
        if (delta > 50) {
          console.warn(
            `%c[PerfMon] ⚠ Long frame: ${delta.toFixed(1)}ms (${(1000 / delta).toFixed(0)} fps)`,
            'color: #f59e0b',
          );
        }
      }

      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);

    // Log on a fixed interval
    this._logIntervalId = setInterval(() => this._log(), LOG_INTERVAL_MS);

    console.log(
      '%c[PerfMon] Started — logging every 2s. Warns on frames >33ms. Call window.__orbitrackPerf.stop() to disable.',
      'color: #22c55e; font-weight: bold',
    );
  }

  /** Stop the performance monitor. */
  stop(): void {
    if (!this._enabled) return;
    this._enabled = false;
    if (this._rafId !== null) cancelAnimationFrame(this._rafId);
    if (this._logIntervalId !== null) clearInterval(this._logIntervalId);
    this._rafId = null;
    this._logIntervalId = null;
    console.log('%c[PerfMon] Stopped.', 'color: #f59e0b; font-weight: bold');
  }

  /** Toggle on/off. */
  toggle(): void {
    this._enabled ? this.stop() : this.start();
  }

  /** Returns the latest snapshot (useful for programmatic access). */
  get snapshot(): Readonly<PerfSnapshot> {
    return { ...this._snapshot };
  }

  private _log(): void {
    const now = performance.now();
    const elapsed = (now - this._lastTime) / 1000;
    const fps = elapsed > 0 ? Math.round(this._frameCount / elapsed) : 0;

    this._snapshot.fps = fps;
    this._snapshot.orbitChains = getActiveChainCount();
    this._snapshot.synthEngines = getActiveSynthCount();
    this._snapshot.longFrames = this._longFrameCount;
    this._snapshot.maxFrameMs = Math.round(this._maxFrameDelta);
    this._snapshot.storeUpdates = _storeUpdateCount;

    // Chrome-only heap info
    const perfMemory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    this._snapshot.heapMB = perfMemory
      ? Math.round(perfMemory.usedJSHeapSize / 1048576)
      : null;

    // Track heap trend
    if (this._snapshot.heapMB !== null) {
      this._heapHistory.push(this._snapshot.heapMB);
      if (this._heapHistory.length > HEAP_HISTORY_SIZE) {
        this._heapHistory.shift();
      }
      // Warn if heap has grown consistently over the window
      if (this._heapHistory.length >= HEAP_HISTORY_SIZE) {
        const first = this._heapHistory[0];
        const last = this._heapHistory[this._heapHistory.length - 1];
        const growthMB = last - first;
        // Check if ALL samples are monotonically increasing (true leak signal)
        let monotonic = true;
        for (let i = 1; i < this._heapHistory.length; i++) {
          if (this._heapHistory[i] < this._heapHistory[i - 1] - 1) {
            monotonic = false;
            break;
          }
        }
        if (monotonic && growthMB > 5) {
          console.warn(
            `%c[PerfMon] 🔴 Possible memory leak: heap grew ${growthMB}MB over ${HEAP_HISTORY_SIZE * 2}s (${first}MB → ${last}MB)`,
            'color: #ef4444; font-weight: bold',
          );
        }
      }
    }

    // Audio context state
    try {
      const ctx = getAudioContext() as AudioContext;
      this._snapshot.audioState = ctx.state;
    } catch {
      this._snapshot.audioState = 'unavailable';
    }

    // Color-code FPS
    const fpsColor = fps >= 55 ? '#22c55e' : fps >= 30 ? '#f59e0b' : '#ef4444';

    const parts = [
      `%cFPS: %c${fps}`,
      `%c| Chains: %c${this._snapshot.orbitChains}`,
      `%c| Synths: %c${this._snapshot.synthEngines}`,
      this._snapshot.heapMB !== null ? `%c| Heap: %c${this._snapshot.heapMB} MB` : '',
      `%c| Audio: %c${this._snapshot.audioState}`,
      `%c| Drops: %c${this._longFrameCount}`,
      this._maxFrameDelta > 0 ? `%c(max: %c${Math.round(this._maxFrameDelta)}ms%c)` : '',
      `%c| Store: %c${_storeUpdateCount}/s`,
    ].filter(Boolean).join(' ');

    const dropColor = this._longFrameCount > 5 ? '#ef4444' : this._longFrameCount > 0 ? '#f59e0b' : '#22c55e';
    const storeRate = Math.round(_storeUpdateCount / elapsed);
    const storeColor = storeRate > 120 ? '#ef4444' : storeRate > 60 ? '#f59e0b' : '#22c55e';

    const styles = [
      'color: #888', fpsColor,
      'color: #888', 'color: #60a5fa',
      'color: #888', 'color: #60a5fa',
      ...(this._snapshot.heapMB !== null ? ['color: #888', 'color: #c084fc'] : []),
      'color: #888', this._snapshot.audioState === 'running' ? 'color: #22c55e' : 'color: #ef4444',
      'color: #888', dropColor,
      ...(this._maxFrameDelta > 0 ? ['color: #888', this._maxFrameDelta > 50 ? '#ef4444' : '#f59e0b', 'color: #888'] : []),
      'color: #888', storeColor,
    ];

    console.log(`%c[PerfMon] ${parts}`, 'font-weight: bold', ...styles);

    // Reset per-interval counters
    this._frameCount = 0;
    this._longFrameCount = 0;
    this._maxFrameDelta = 0;
    _storeUpdateCount = 0;
    this._lastTime = now;
  }
}

// Singleton
export const perfMonitor = new PerfMonitor();
