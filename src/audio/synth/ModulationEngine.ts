/**
 * ModulationEngine — 4 LFO slots, pure JS phase-accumulator approach.
 *
 * No OscillatorNode / AnalyserNode / GainNode chain.
 * Each LFO is simply a phase counter evaluated via sampleLFOShape() at ~60Hz.
 * All targets are applied via applyParamFn (setTargetAtTime with smoothing).
 *
 * This eliminates all OscillatorNode lifecycle issues (start/stop/recreate)
 * and makes trigger modes (free, retrig, envelope) trivially correct.
 */

import type { SynthParams, LFOSlotParams, ModAssignment } from './types';
import { MOD_PARAM_META, syncDivToHz, sampleLFOShape } from './modConstants';

const NUM_LFOS = 4;

export type LFOSourceId = 'lfo1' | 'lfo2' | 'lfo3' | 'lfo4';

interface LFOSlot {
  params: LFOSlotParams;
  phase: number;          // 0–1, advances each frame
  active: boolean;        // producing output (false = gated off)
  envDone: boolean;       // envelope one-shot completed
  delayRemaining: number; // seconds of delay left before LFO output starts
  smoothedValue: number;  // exponentially-smoothed output (-1 to +1)
  rawValue: number;       // unsmoothed current value (for UI)
}

interface ActiveConnection {
  assignmentId: string;
  source: LFOSourceId;
  target: keyof SynthParams;
  depth: number;
}

export class ModulationEngine {
  private slots: LFOSlot[] = [];
  private connections: ActiveConnection[] = [];
  private rafId = 0;
  private running = false;
  private lastPollTime = 0;
  private getParams: () => SynthParams;
  private applyParamFn: (key: keyof SynthParams, value: number) => void;

  /** Kept for SynthEngine compatibility — unused in simplified engine */
  audioParamGetters: Map<string, () => AudioParam[]> = new Map();
  /** Callback to check if any synth voices are active */
  hasActiveVoices: (() => boolean) | null = null;
  /** BPM for tempo sync */
  bpm = 120;

  constructor(
    _ac: AudioContext,
    getParams: () => SynthParams,
    applyParam: (key: keyof SynthParams, value: number) => void,
  ) {
    this.getParams = getParams;
    this.applyParamFn = applyParam;

    for (let i = 0; i < NUM_LFOS; i++) {
      this.slots.push(this.createSlot());
    }
  }

  private createSlot(): LFOSlot {
    return {
      params: { mode: 'lfo', shape: 'sine', rate: 1, tempoSync: false, syncDiv: '1/4', triggerMode: 'free', smooth: 0, delay: 0, phase: 0, steps: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0] },
      phase: 0,
      active: true,   // free mode starts active
      envDone: false,
      delayRemaining: 0,
      smoothedValue: 0,
      rawValue: 0,
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    this.running = true;
    this.lastPollTime = performance.now();
    // Initialize slot activity based on trigger mode
    for (const slot of this.slots) {
      slot.active = slot.params.triggerMode === 'free';
      slot.envDone = false;
      slot.phase = slot.params.phase || 0;
    }
    this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  dispose(): void {
    this.stop();
    this.connections.length = 0;
  }

  // ── LFO parameter updates ──────────────────────────────────────────────

  updateLFO(idx: number, params: LFOSlotParams): void {
    if (idx < 0 || idx >= NUM_LFOS) return;
    const slot = this.slots[idx];
    const oldTrigger = slot.params.triggerMode;
    slot.params = { ...params };

    // Handle trigger mode changes
    if (oldTrigger !== params.triggerMode) {
      if (params.triggerMode === 'free') {
        slot.active = true;
        slot.envDone = false;
      } else {
        // retrig/envelope: deactivate until next noteOn
        slot.active = false;
        slot.envDone = false;
        slot.phase = params.phase || 0;
        slot.smoothedValue = 0;
        slot.rawValue = 0;
      }
    }
  }

  // ── Note triggers ──────────────────────────────────────────────────────

  onNoteOn(_audioTime?: number): void {
    for (const slot of this.slots) {
      if (slot.params.triggerMode === 'retrig' || slot.params.triggerMode === 'envelope') {
        // Reset phase and activate
        slot.phase = slot.params.phase || 0;
        slot.active = true;
        slot.envDone = false;
        // Apply delay
        slot.delayRemaining = slot.params.delay || 0;
      }
    }
  }

  // ── Connection management ──────────────────────────────────────────────

  addConnection(assignment: ModAssignment): void {
    this.removeConnection(assignment.id);

    const slotIdx = parseInt(assignment.source.slice(3)) - 1;
    if (slotIdx < 0 || slotIdx >= NUM_LFOS) return;

    const meta = MOD_PARAM_META[assignment.target];
    if (!meta) return;

    this.connections.push({
      assignmentId: assignment.id,
      source: assignment.source,
      target: assignment.target,
      depth: assignment.depth,
    });
  }

  removeConnection(id: string): void {
    const idx = this.connections.findIndex((c) => c.assignmentId === id);
    if (idx !== -1) this.connections.splice(idx, 1);
  }

  removeAllConnections(): void {
    this.connections.length = 0;
  }

  updateConnectionDepth(id: string, depth: number): void {
    const conn = this.connections.find((c) => c.assignmentId === id);
    if (conn) conn.depth = depth;
  }

  /** Get the current LFO value for a slot (for UI animation, -1 to +1) */
  getLFOValue(slotIdx: number): number {
    if (slotIdx < 0 || slotIdx >= NUM_LFOS) return 0;
    return this.slots[slotIdx].smoothedValue;
  }

  /** Get the current modulated value for a parameter (base + all LFO contributions). */
  getModulatedValue(target: keyof SynthParams): number | null {
    const meta = MOD_PARAM_META[target];
    if (!meta) return null;

    const params = this.getParams();
    const baseVal = (params as Record<string, number>)[target] ?? 0;
    let modAmount = 0;

    for (const conn of this.connections) {
      if (conn.target !== target) continue;
      const slotIdx = parseInt(conn.source.slice(3)) - 1;
      const slot = this.slots[slotIdx];
      if (!slot) continue;
      const range = meta.max - meta.min;
      modAmount += slot.smoothedValue * conn.depth * range;
    }

    if (modAmount === 0) return null; // no active modulation
    return Math.max(meta.min, Math.min(meta.max, baseVal + modAmount));
  }

  // ── Polling loop (~60Hz) ───────────────────────────────────────────────

  private poll = (): void => {
    if (!this.running) return;

    try {
      const now = performance.now();
      const dt = Math.min((now - this.lastPollTime) / 1000, 0.1); // seconds, capped at 100ms
      this.lastPollTime = now;

      const params = this.getParams();
      const voicesActive = this.hasActiveVoices ? this.hasActiveVoices() : true;

      // ── Advance each LFO slot ──────────────────────────────────────────
      for (const slot of this.slots) {
        // Skip disabled LFOs — output zero
        if (slot.params.enabled === false) {
          slot.rawValue = 0;
          slot.smoothedValue = 0;
          continue;
        }

        const rate = slot.params.tempoSync
          ? syncDivToHz(slot.params.syncDiv, this.bpm)
          : slot.params.rate;

        if (slot.params.triggerMode === 'free') {
          // Free: always running, wrap phase
          slot.phase = (slot.phase + rate * dt) % 1;
          slot.active = true;
        } else if (slot.active && !slot.envDone) {
          // Retrig / Envelope: advance if active
          if (slot.delayRemaining > 0) {
            slot.delayRemaining -= dt;
          } else {
            slot.phase += rate * dt;

            if (slot.params.triggerMode === 'envelope') {
              // One-shot: stop at phase >= 1
              if (slot.phase >= 1) {
                slot.phase = 1;
                slot.envDone = true;
              }
            } else {
              // Retrig: wrap
              slot.phase = slot.phase % 1;
            }
          }
        }

        // Deactivate retrig when voices go silent
        if (slot.params.triggerMode === 'retrig' && !voicesActive) {
          slot.active = false;
        }

        // Compute raw value
        if (slot.active && !slot.envDone && slot.delayRemaining <= 0) {
          if (slot.params.mode === 'stepseq' && slot.params.steps?.length) {
            // Step sequencer: read from steps array based on phase
            const numSteps = slot.params.steps.length;
            const stepIdx = Math.min(Math.floor((slot.phase % 1) * numSteps), numSteps - 1);
            slot.rawValue = slot.params.steps[stepIdx];
          } else {
            slot.rawValue = sampleLFOShape(slot.phase % 1, slot.params.shape);
          }
        } else if (slot.envDone) {
          // Envelope done — fade to 0
          slot.rawValue = slot.rawValue * 0.9; // quick decay
          if (Math.abs(slot.rawValue) < 0.001) slot.rawValue = 0;
        } else {
          slot.rawValue = 0;
        }

        // Apply smoothing (exponential)
        if (slot.params.smooth > 0.01) {
          // smooth 0→1 maps to smoothFactor 1→0.02 (instant → very smooth)
          const smoothFactor = 1 - slot.params.smooth * 0.98;
          slot.smoothedValue += (slot.rawValue - slot.smoothedValue) * smoothFactor;
        } else {
          slot.smoothedValue = slot.rawValue;
        }
      }

      // ── Apply modulation to targets ────────────────────────────────────
      // Group connections by target to sum multiple LFOs on the same param
      const targetMods = new Map<keyof SynthParams, number>();

      for (const conn of this.connections) {
        const slotIdx = parseInt(conn.source.slice(3)) - 1;
        const slot = this.slots[slotIdx];
        if (!slot) continue;

        const meta = MOD_PARAM_META[conn.target];
        if (!meta) continue;

        const lfoVal = slot.smoothedValue;
        const range = meta.max - meta.min;
        const modAmount = lfoVal * conn.depth * range;

        const existing = targetMods.get(conn.target) ?? 0;
        targetMods.set(conn.target, existing + modAmount);
      }

      // Apply summed modulations
      for (const [target, modAmount] of targetMods) {
        const meta = MOD_PARAM_META[target];
        if (!meta) continue;

        const baseVal = (params as Record<string, number>)[target] ?? 0;
        const modded = Math.max(meta.min, Math.min(meta.max, baseVal + modAmount));
        this.applyParamFn(target, modded);
      }
    } catch (e) {
      console.warn('[ModulationEngine] poll error:', e);
    }

    this.rafId = requestAnimationFrame(this.poll);
  };

  // ── Sync all assignments from params ───────────────────────────────────

  syncFromParams(params: SynthParams): void {
    // Update LFO slot params
    if (params.lfos) {
      for (let i = 0; i < NUM_LFOS && i < params.lfos.length; i++) {
        this.updateLFO(i, params.lfos[i]);
      }
    }

    // Sync mod assignments
    const currentIds = new Set(this.connections.map((c) => c.assignmentId));
    const targetIds = new Set((params.modAssignments ?? []).map((a) => a.id));

    // Remove old
    for (const id of currentIds) {
      if (!targetIds.has(id)) this.removeConnection(id);
    }

    // Add/update new
    for (const assignment of params.modAssignments ?? []) {
      const existing = this.connections.find((c) => c.assignmentId === assignment.id);
      if (!existing) {
        this.addConnection(assignment);
      } else if (existing.depth !== assignment.depth) {
        this.updateConnectionDepth(assignment.id, assignment.depth);
      }
    }
  }
}
