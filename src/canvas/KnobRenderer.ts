import * as Tone from 'tone';
import { useStore } from '../state/store';
import { isInstrumentEffectivelyMuted } from './renderUtils';

const TWO_PI = Math.PI * 2;
const TRIGGER_ANGLE = Math.PI / 2; // 6 o'clock (bottom)
const HIT_RADIUS = 7;
const RING_PADDING = 22; // px from canvas edge to ring center

const colorCache = new Map<string, { r: number; g: number; b: number }>();
function parseColor(hex: string): { r: number; g: number; b: number } {
  let c = colorCache.get(hex);
  if (!c) {
    c = {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16),
    };
    colorCache.set(hex, c);
  }
  return c;
}

function rgba(hex: string, alpha: number): string {
  const c = parseColor(hex);
  return `rgba(${c.r},${c.g},${c.b},${alpha})`;
}

export class KnobRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animationId: number | null = null;
  private instrumentId: string;
  // Cache instrument reference to avoid O(N) .find() every frame
  private _lastInstrRef: unknown = null;
  private _cachedInst: ReturnType<typeof useStore.getState>['instruments'][number] | null = null;
  // Cache layout to avoid getBoundingClientRect() every frame (forces layout recalc)
  private _rectW = 0;
  private _rectH = 0;

  constructor(canvas: HTMLCanvasElement, instrumentId: string) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true })!;
    this.instrumentId = instrumentId;
  }

  start(): void {
    if (this.animationId !== null) return;
    this.loop();
  }

  stop(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this._rectW = rect.width;
    this._rectH = rect.height;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private loop = (): void => {
    this.render();
    this.animationId = requestAnimationFrame(this.loop);
  };

  private getLayout(): { cx: number; cy: number; radius: number } {
    const w = this._rectW;
    const h = this._rectH;
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(cx, cy) - RING_PADDING;
    return { cx, cy, radius };
  }

  // Cached hit step set for LED mode — rebuilt only when hitPositions ref changes
  private _ledHitRef: unknown = null;
  private _ledHitSteps = new Set<number>();
  // Chase mode: reuse set to avoid GC pressure
  private _chaseRotated = new Set<number>();
  private _chaseLastStep = -1;

  private render(): void {
    const state = useStore.getState();
    if (state.orbitDisplayMode === 'led') {
      this.renderLED(state);
      return;
    }
    if (state.orbitDisplayMode === 'rotate') {
      this.renderRotate(state);
      return;
    }
    if (state.orbitDisplayMode === 'chase') {
      this.renderChase(state);
      return;
    }
    // Only re-find when instruments array reference changes (immutable updates)
    if (state.instruments !== this._lastInstrRef) {
      this._lastInstrRef = state.instruments;
      this._cachedInst = state.instruments.find((i) => i.id === this.instrumentId) ?? null;
    }
    const inst = this._cachedInst;
    if (!inst) return;

    const w = this._rectW;
    const h = this._rectH;
    if (w <= 0 || h <= 0) return;
    const ctx = this.ctx;
    const { cx, cy, radius } = this.getLayout();
    if (radius <= 0) return;

    ctx.clearRect(0, 0, w, h);

    // Real-time transport position
    const transport = Tone.getTransport();
    const stepsPerBeatGlobal = state.stepsPerBeat ?? 8;
    const secondsPerStep = 60 / state.bpm / stepsPerBeatGlobal;
    const totalSteps = state.isPlaying ? transport.seconds / secondsPerStep : 0;

    const isSelected = state.selectedInstrumentId === this.instrumentId;
    const effectivelyMuted = isInstrumentEffectivelyMuted(state, this.instrumentId, inst.muted, inst.solo);
    const isMuted = effectivelyMuted;

    // Muted orbits don't rotate unless soloed
    const instProg = state.isPlaying && !effectivelyMuted
      ? (totalSteps % inst.loopSize) / inst.loopSize : 0;
    const dotRotation = instProg * TWO_PI;

    // --- 1. Dark knob background ---
    const bgRadius = Math.min(cx, cy) - 2;
    ctx.beginPath();
    ctx.arc(cx, cy, bgRadius, 0, TWO_PI);
    ctx.fillStyle = isSelected ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.35)';
    ctx.fill();

    // --- 2. Step tick marks on the ring — batched by style (3 passes) ---
    const stepCount = inst.loopSize;
    const stepsPerBeat = Math.round(stepCount / 4); // beats every quarter note
    const tickStyles: [string, number, (g: number) => boolean, number, number][] = [
      [inst.color, 2, (g) => g === 0, 10, 5],                        // first tick
      [rgba(inst.color, 0.7), 1.5, (g) => g !== 0 && g % stepsPerBeat === 0, 10, 5],  // beats
      [rgba(inst.color, 0.5), 1.25, (g) => g % stepsPerBeat !== 0, 5, 3],              // subdivisions
    ];
    for (const [style, lw, match, innerLen, outerLen] of tickStyles) {
      ctx.beginPath();
      for (let g = 0; g < stepCount; g++) {
        if (!match(g)) continue;
        const tickAngle = TRIGGER_ANGLE - (g / stepCount) * TWO_PI - dotRotation;
        const cos = Math.cos(tickAngle);
        const sin = Math.sin(tickAngle);
        ctx.moveTo(cx + cos * (radius - innerLen), cy + sin * (radius - innerLen));
        ctx.lineTo(cx + cos * (radius + outerLen), cy + sin * (radius + outerLen));
      }
      ctx.strokeStyle = style;
      ctx.lineWidth = lw;
      ctx.stroke();
    }

    // --- 3. Grid ticks on ring (rotate with dots) — removed, replaced by fixed ticks above ---

    // Loop region state (needed for ring + hit dot rendering)
    const editorState = inst.type === 'looper' ? state.looperEditors[inst.id] : undefined;
    const loopIn = editorState?.loopIn ?? 0;
    const loopOut = editorState?.loopOut ?? 1;
    const hasLoopRegion = inst.type === 'looper' && (loopIn > 0 || loopOut < 1);

    // --- 4. Ring (skip if loop region draws its own) ---
    if (!hasLoopRegion) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TWO_PI);
      ctx.strokeStyle = isMuted ? rgba(inst.color, 0.25) : inst.color;
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.stroke();
    }

    if (hasLoopRegion) {
      // Draw dimmed full ring, then bright arc for loop region
      const arcStart = TRIGGER_ANGLE - loopIn * TWO_PI - dotRotation;
      const arcEnd = TRIGGER_ANGLE - loopOut * TWO_PI - dotRotation;

      // Dim arc for the inactive region (draw full ring dimmed, then overdraw active)
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TWO_PI);
      ctx.strokeStyle = rgba(inst.color, 0.12);
      ctx.lineWidth = 4;
      ctx.stroke();

      // Bright arc for the active loop region
      ctx.beginPath();
      ctx.arc(cx, cy, radius, arcStart, arcEnd);
      ctx.strokeStyle = isMuted ? rgba(inst.color, 0.4) : inst.color;
      ctx.lineWidth = 4;
      ctx.stroke();

      // Small ticks at loop in/out boundaries
      for (const pos of [loopIn, loopOut]) {
        const tickAngle = TRIGGER_ANGLE - pos * TWO_PI - dotRotation;
        const tc = Math.cos(tickAngle);
        const ts = Math.sin(tickAngle);
        ctx.beginPath();
        ctx.moveTo(cx + tc * (radius - 8), cy + ts * (radius - 8));
        ctx.lineTo(cx + tc * (radius + 8), cy + ts * (radius + 8));
        ctx.strokeStyle = 'rgba(0,255,255,0.7)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // --- 5. Hit dots (rotate with ring) / Looper coverage dots ---

    if (inst.type === 'looper') {
      // Looper: draw dots at each step, filled where sample covers
      const ls = inst.loopSize;
      const detectedLS = inst.detectedLoopSize || ls;
      const pitchRatio = Math.pow(2, ((inst.looperParams?.pitchSemitones ?? 0) / 12));
      const isStretched = inst.looperParams?.stretchToSteps ?? false;
      const baseScale = isStretched ? 1 : detectedLS / ls;
      const sampleScale = baseScale / pitchRatio;
      const filledSteps = Math.min(ls, Math.max(0, Math.ceil(sampleScale * ls)));

      const currentStep = Math.floor(instProg * ls) % ls;

      for (let g = 0; g < ls; g++) {
        const stepPos = g / ls;
        const stepAngle = TRIGGER_ANGLE - stepPos * TWO_PI - dotRotation;
        const sx = cx + Math.cos(stepAngle) * radius;
        const sy = cy + Math.sin(stepAngle) * radius;
        const isFilled = g < filledSteps;
        const isCurrentStep = state.isPlaying && !isMuted && g === currentStep;

        if (isCurrentStep && isFilled) {
          ctx.beginPath();
          ctx.arc(sx, sy, HIT_RADIUS, 0, TWO_PI);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
        } else if (isFilled) {
          ctx.beginPath();
          ctx.arc(sx, sy, HIT_RADIUS * 0.75, 0, TWO_PI);
          ctx.fillStyle = rgba(inst.color, isMuted ? 0.25 : 0.9);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(sx, sy, HIT_RADIUS * 0.35, 0, TWO_PI);
          ctx.fillStyle = rgba('#ffffff', isMuted ? 0.1 : 0.3);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(sx, sy, 3, 0, TWO_PI);
          ctx.fillStyle = 'rgba(255,255,255,0.07)';
          ctx.fill();
        }
      }
    } else {
      for (let i = 0; i < inst.hitPositions.length; i++) {
        const hitPos = inst.hitPositions[i];
        const hitAngle = TRIGGER_ANGLE - hitPos * TWO_PI - dotRotation;
        const hx = cx + Math.cos(hitAngle) * radius;
        const hy = cy + Math.sin(hitAngle) * radius;

        const outsideLoop = hasLoopRegion && (hitPos < loopIn - 0.001 || hitPos > loopOut + 0.001);

        const diff = Math.abs(instProg - hitPos);
        const wrappedDiff = Math.min(diff, 1 - diff);
        const isTriggered = state.isPlaying && !outsideLoop && wrappedDiff < (0.5 / inst.loopSize);

        ctx.beginPath();
        ctx.arc(hx, hy, outsideLoop ? HIT_RADIUS * 0.6 : HIT_RADIUS, 0, TWO_PI);

        if (isTriggered) {
          ctx.fillStyle = '#ffffff';
          ctx.fill();
        } else {
          ctx.fillStyle = rgba(inst.color, outsideLoop ? 0.15 : isMuted ? 0.25 : 0.9);
          ctx.fill();
          if (!outsideLoop) {
            ctx.beginPath();
            ctx.arc(hx, hy, HIT_RADIUS * 0.45, 0, TWO_PI);
            ctx.fillStyle = rgba('#ffffff', isMuted ? 0.1 : 0.35);
            ctx.fill();
          }
        }
      }
    }

    // --- 6. Fixed trigger notch at 12 o'clock ---
    const notchCos = Math.cos(TRIGGER_ANGLE);
    const notchSin = Math.sin(TRIGGER_ANGLE);
    ctx.beginPath();
    ctx.moveTo(cx + notchCos * (radius - 10), cy + notchSin * (radius - 10));
    ctx.lineTo(cx + notchCos * (radius + RING_PADDING - 6), cy + notchSin * (radius + RING_PADDING - 6));
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // --- 7. Center text: hit count (or filled steps for loopers) + loop size ---
    const fontSize = Math.max(14, Math.floor(radius * 0.45));
    let centerCount: number;
    if (inst.type === 'looper') {
      const ls = inst.loopSize;
      const detectedLS = inst.detectedLoopSize || ls;
      const pitchRatio = Math.pow(2, ((inst.looperParams?.pitchSemitones ?? 0) / 12));
      const isStretched = inst.looperParams?.stretchToSteps ?? false;
      const baseScale = isStretched ? 1 : detectedLS / ls;
      const sampleScale = baseScale / pitchRatio;
      centerCount = Math.min(ls, Math.max(0, Math.ceil(sampleScale * ls)));
    } else {
      centerCount = inst.hits;
    }
    ctx.fillStyle = rgba(inst.color, isMuted ? 0.3 : 0.8);
    ctx.font = `bold ${fontSize}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(centerCount), cx, cy - fontSize * 0.25);

    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = `${Math.floor(fontSize * 0.5)}px monospace`;
    ctx.fillText(`/${inst.loopSize}`, cx, cy + fontSize * 0.6);
  }

  // --- LED mode render ---

  private renderLED(state: ReturnType<typeof useStore.getState>): void {
    if (state.instruments !== this._lastInstrRef) {
      this._lastInstrRef = state.instruments;
      this._cachedInst = state.instruments.find((i) => i.id === this.instrumentId) ?? null;
    }
    const inst = this._cachedInst;
    if (!inst) return;

    const w = this._rectW;
    const h = this._rectH;
    if (w <= 0 || h <= 0) return;
    const ctx = this.ctx;
    const { cx, cy, radius } = this.getLayout();
    if (radius <= 0) return;

    ctx.clearRect(0, 0, w, h);

    // Transport
    const transport = Tone.getTransport();
    const stepsPerBeatGlobal = state.stepsPerBeat ?? 8;
    const secondsPerStep = 60 / state.bpm / stepsPerBeatGlobal;
    const totalSteps = state.isPlaying ? transport.seconds / secondsPerStep : 0;

    const isSelected = state.selectedInstrumentId === this.instrumentId;
    const effectivelyMuted = isInstrumentEffectivelyMuted(state, this.instrumentId, inst.muted, inst.solo);
    const isMuted = effectivelyMuted;

    const instProg = state.isPlaying && !effectivelyMuted
      ? (totalSteps % inst.loopSize) / inst.loopSize : 0;
    const currentStep = Math.floor(instProg * inst.loopSize) % inst.loopSize;

    // Background
    const bgRadius = Math.min(cx, cy) - 2;
    ctx.beginPath();
    ctx.arc(cx, cy, bgRadius, 0, TWO_PI);
    ctx.fillStyle = isSelected ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.35)';
    ctx.fill();

    // Ring
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TWO_PI);
    ctx.strokeStyle = rgba(inst.color, isMuted ? 0.15 : 0.25);
    ctx.lineWidth = 1;
    ctx.stroke();

    // LED dots — one per step, 3 passes: empty, active, triggered
    const loopSize = inst.loopSize;
    const stepsPerBeat = Math.round(loopSize / 4);

    // Determine which steps are active
    let isStepActive: (g: number) => boolean;
    if (inst.type === 'looper') {
      const detectedLS = inst.detectedLoopSize || loopSize;
      const pitchRatio = Math.pow(2, ((inst.looperParams?.pitchSemitones ?? 0) / 12));
      const isStretched = inst.looperParams?.stretchToSteps ?? false;
      const baseScale = isStretched ? 1 : detectedLS / loopSize;
      const sampleScale = baseScale / pitchRatio;
      const filledSteps = Math.min(loopSize, Math.max(0, Math.ceil(sampleScale * loopSize)));
      isStepActive = (g) => g < filledSteps;
    } else {
      // Build hit step set (cached)
      if (inst.hitPositions !== this._ledHitRef) {
        this._ledHitRef = inst.hitPositions;
        this._ledHitSteps.clear();
        for (const hp of inst.hitPositions) {
          this._ledHitSteps.add(Math.round(hp * loopSize) % loopSize);
        }
      }
      isStepActive = (g) => this._ledHitSteps.has(g);
    }

    // Pass 1: empty steps (dim dots)
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    for (let g = 0; g < loopSize; g++) {
      if (isStepActive(g)) continue;
      const angle = TRIGGER_ANGLE - (g / loopSize) * TWO_PI;
      ctx.moveTo(cx + Math.cos(angle) * radius + 2.5, cy + Math.sin(angle) * radius);
      ctx.arc(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 2.5, 0, TWO_PI);
    }
    ctx.fill();

    // Pass 2: active steps (colored dots)
    const activeColor = rgba(inst.color, isMuted ? 0.3 : 0.85);
    ctx.fillStyle = activeColor;
    ctx.beginPath();
    for (let g = 0; g < loopSize; g++) {
      if (!isStepActive(g)) continue;
      if (state.isPlaying && g === currentStep) continue; // skip triggered — drawn in pass 3
      const angle = TRIGGER_ANGLE - (g / loopSize) * TWO_PI;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      ctx.moveTo(x + 4.5, y);
      ctx.arc(x, y, 4.5, 0, TWO_PI);
    }
    ctx.fill();

    // Pass 3: triggered step (white)
    if (state.isPlaying && isStepActive(currentStep)) {
      const angle = TRIGGER_ANGLE - (currentStep / loopSize) * TWO_PI;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      ctx.beginPath();
      ctx.arc(x, y, 5.5, 0, TWO_PI);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }

    // Playhead indicator (small moving dot on the ring when playing)
    if (state.isPlaying) {
      const playAngle = TRIGGER_ANGLE - instProg * TWO_PI;
      const px = cx + Math.cos(playAngle) * (radius + 12);
      const py = cy + Math.sin(playAngle) * (radius + 12);
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, TWO_PI);
      ctx.fillStyle = rgba(inst.color, 0.6);
      ctx.fill();
    }

    // Beat markers (thin ticks at beat positions)
    ctx.beginPath();
    for (let g = 0; g < loopSize; g += stepsPerBeat) {
      const angle = TRIGGER_ANGLE - (g / loopSize) * TWO_PI;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      ctx.moveTo(cx + cos * (radius - 8), cy + sin * (radius - 8));
      ctx.lineTo(cx + cos * (radius + 8), cy + sin * (radius + 8));
    }
    ctx.strokeStyle = rgba(inst.color, 0.2);
    ctx.lineWidth = 1;
    ctx.stroke();

    // Center text
    const fontSize = Math.max(14, Math.floor(radius * 0.45));
    let centerCount: number;
    if (inst.type === 'looper') {
      const detectedLS = inst.detectedLoopSize || loopSize;
      const pitchRatio = Math.pow(2, ((inst.looperParams?.pitchSemitones ?? 0) / 12));
      const isStretched = inst.looperParams?.stretchToSteps ?? false;
      const baseScale = isStretched ? 1 : detectedLS / loopSize;
      const sampleScale = baseScale / pitchRatio;
      centerCount = Math.min(loopSize, Math.max(0, Math.ceil(sampleScale * loopSize)));
    } else {
      centerCount = inst.hits;
    }
    ctx.fillStyle = rgba(inst.color, isMuted ? 0.3 : 0.8);
    ctx.font = `bold ${fontSize}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(centerCount), cx, cy - fontSize * 0.25);

    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = `${Math.floor(fontSize * 0.5)}px monospace`;
    ctx.fillText(`/${inst.loopSize}`, cx, cy + fontSize * 0.6);
  }

  // --- Rotate mode render: fixed dots, pattern rotates clockwise past bottom indicator ---

  private renderRotate(state: ReturnType<typeof useStore.getState>): void {
    if (state.instruments !== this._lastInstrRef) {
      this._lastInstrRef = state.instruments;
      this._cachedInst = state.instruments.find((i) => i.id === this.instrumentId) ?? null;
    }
    const inst = this._cachedInst;
    if (!inst) return;

    const w = this._rectW;
    const h = this._rectH;
    if (w <= 0 || h <= 0) return;
    const ctx = this.ctx;
    const { cx, cy, radius } = this.getLayout();
    if (radius <= 0) return;

    ctx.clearRect(0, 0, w, h);

    // Transport
    const transport = Tone.getTransport();
    const stepsPerBeatGlobal = state.stepsPerBeat ?? 8;
    const secondsPerStep = 60 / state.bpm / stepsPerBeatGlobal;
    const totalSteps = state.isPlaying ? transport.seconds / secondsPerStep : 0;

    const isSelected = state.selectedInstrumentId === this.instrumentId;
    const effectivelyMuted = isInstrumentEffectivelyMuted(state, this.instrumentId, inst.muted, inst.solo);
    const isMuted = effectivelyMuted;

    const instProg = state.isPlaying && !effectivelyMuted
      ? (totalSteps % inst.loopSize) / inst.loopSize : 0;
    const currentStep = Math.floor(instProg * inst.loopSize) % inst.loopSize;

    const loopSize = inst.loopSize;

    // Determine active steps (looper: sample coverage, others: hit positions)
    let isStepActive: (g: number) => boolean;
    if (inst.type === 'looper') {
      const detectedLS = inst.detectedLoopSize || loopSize;
      const pitchRatio = Math.pow(2, ((inst.looperParams?.pitchSemitones ?? 0) / 12));
      const isStretched = inst.looperParams?.stretchToSteps ?? false;
      const baseScale = isStretched ? 1 : detectedLS / loopSize;
      const sampleScale = baseScale / pitchRatio;
      const filledSteps = Math.min(loopSize, Math.max(0, Math.ceil(sampleScale * loopSize)));
      isStepActive = (g) => g < filledSteps;
    } else {
      // Build hit step set (cached)
      if (inst.hitPositions !== this._ledHitRef) {
        this._ledHitRef = inst.hitPositions;
        this._ledHitSteps.clear();
        for (const hp of inst.hitPositions) {
          this._ledHitSteps.add(Math.round(hp * loopSize) % loopSize);
        }
      }
      isStepActive = (g) => this._ledHitSteps.has(g);
    }

    // Background
    const bgRadius = Math.min(cx, cy) - 2;
    ctx.beginPath();
    ctx.arc(cx, cy, bgRadius, 0, TWO_PI);
    ctx.fillStyle = isSelected ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.35)';
    ctx.fill();

    // Ring
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TWO_PI);
    ctx.strokeStyle = rgba(inst.color, isMuted ? 0.15 : 0.25);
    ctx.lineWidth = 1;
    ctx.stroke();

    // Rotated active set: shift positions by currentStep
    const rotatedHits = new Set<number>();
    for (let g = 0; g < loopSize; g++) {
      if (isStepActive(g)) {
        rotatedHits.add((g - currentStep + loopSize) % loopSize);
      }
    }

    // The step at the indicator (bottom) that is currently being triggered
    const triggerDisplayStep = 0;
    const isTriggerHit = state.isPlaying && rotatedHits.has(triggerDisplayStep);

    // Pass 1: empty steps (dim dots) — fixed positions
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    for (let g = 0; g < loopSize; g++) {
      if (rotatedHits.has(g)) continue;
      const angle = TRIGGER_ANGLE - (g / loopSize) * TWO_PI;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      ctx.moveTo(x + 2.5, y);
      ctx.arc(x, y, 2.5, 0, TWO_PI);
    }
    ctx.fill();

    // Pass 2: active dots (colored) — skip the one at trigger position
    ctx.fillStyle = rgba(inst.color, isMuted ? 0.3 : 0.85);
    ctx.beginPath();
    for (let g = 0; g < loopSize; g++) {
      if (!rotatedHits.has(g)) continue;
      if (state.isPlaying && g === triggerDisplayStep) continue;
      const angle = TRIGGER_ANGLE - (g / loopSize) * TWO_PI;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      ctx.moveTo(x + 4.5, y);
      ctx.arc(x, y, 4.5, 0, TWO_PI);
    }
    ctx.fill();

    // Pass 3: triggered dot at indicator (white flash)
    if (isTriggerHit) {
      const angle = TRIGGER_ANGLE;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      ctx.beginPath();
      ctx.arc(x, y, 5.5, 0, TWO_PI);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }

    // Fixed indicator notch at bottom
    const notchCos = Math.cos(TRIGGER_ANGLE);
    const notchSin = Math.sin(TRIGGER_ANGLE);
    ctx.beginPath();
    ctx.moveTo(cx + notchCos * (radius + 4), cy + notchSin * (radius + 4));
    ctx.lineTo(cx + notchCos * (radius + RING_PADDING - 6), cy + notchSin * (radius + RING_PADDING - 6));
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Beat markers
    const stepsPerBeat = Math.round(loopSize / 4);
    ctx.beginPath();
    for (let g = 0; g < loopSize; g += stepsPerBeat) {
      const angle = TRIGGER_ANGLE - (g / loopSize) * TWO_PI;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      ctx.moveTo(cx + cos * (radius - 8), cy + sin * (radius - 8));
      ctx.lineTo(cx + cos * (radius + 8), cy + sin * (radius + 8));
    }
    ctx.strokeStyle = rgba(inst.color, 0.2);
    ctx.lineWidth = 1;
    ctx.stroke();

    // Center text
    const fontSize = Math.max(14, Math.floor(radius * 0.45));
    let centerCount: number;
    if (inst.type === 'looper') {
      const detectedLS = inst.detectedLoopSize || loopSize;
      const pitchRatio = Math.pow(2, ((inst.looperParams?.pitchSemitones ?? 0) / 12));
      const isStretched = inst.looperParams?.stretchToSteps ?? false;
      const baseScale = isStretched ? 1 : detectedLS / loopSize;
      const sampleScale = baseScale / pitchRatio;
      centerCount = Math.min(loopSize, Math.max(0, Math.ceil(sampleScale * loopSize)));
    } else {
      centerCount = inst.hits;
    }
    ctx.fillStyle = rgba(inst.color, isMuted ? 0.3 : 0.8);
    ctx.font = `bold ${fontSize}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(centerCount), cx, cy - fontSize * 0.25);

    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = `${Math.floor(fontSize * 0.5)}px monospace`;
    ctx.fillText(`/${inst.loopSize}`, cx, cy + fontSize * 0.6);
  }

  private renderChase(state: ReturnType<typeof useStore.getState>): void {
    if (state.instruments !== this._lastInstrRef) {
      this._lastInstrRef = state.instruments;
      this._cachedInst = state.instruments.find((i) => i.id === this.instrumentId) ?? null;
    }
    const inst = this._cachedInst;
    if (!inst) return;

    const w = this._rectW;
    const h = this._rectH;
    if (w <= 0 || h <= 0) return;
    const ctx = this.ctx;
    const { cx, cy, radius } = this.getLayout();
    if (radius <= 0) return;

    ctx.clearRect(0, 0, w, h);

    const transport = Tone.getTransport();
    const stepsPerBeatGlobal = state.stepsPerBeat ?? 8;
    const secondsPerStep = 60 / state.bpm / stepsPerBeatGlobal;
    const totalSteps = state.isPlaying ? transport.seconds / secondsPerStep : 0;

    const effectivelyMuted = isInstrumentEffectivelyMuted(state, this.instrumentId, inst.muted, inst.solo);
    const isMuted = effectivelyMuted;

    const instProg = state.isPlaying && !effectivelyMuted
      ? (totalSteps % inst.loopSize) / inst.loopSize : 0;
    const currentStep = Math.floor(instProg * inst.loopSize) % inst.loopSize;

    const loopSize = inst.loopSize;

    // Determine which steps are active (looper: sample coverage, others: hit positions)
    let isStepActive: (g: number) => boolean;
    let hitsChanged: boolean;
    if (inst.type === 'looper') {
      const detectedLS = inst.detectedLoopSize || loopSize;
      const pitchRatio = Math.pow(2, ((inst.looperParams?.pitchSemitones ?? 0) / 12));
      const isStretched = inst.looperParams?.stretchToSteps ?? false;
      const baseScale = isStretched ? 1 : detectedLS / loopSize;
      const sampleScale = baseScale / pitchRatio;
      const filledSteps = Math.min(loopSize, Math.max(0, Math.ceil(sampleScale * loopSize)));
      isStepActive = (g) => g < filledSteps;
      hitsChanged = true; // always rebuild rotated set for loopers (filledSteps may change)
    } else {
      // Build hit step set (cached)
      hitsChanged = inst.hitPositions !== this._ledHitRef;
      if (hitsChanged) {
        this._ledHitRef = inst.hitPositions;
        this._ledHitSteps.clear();
        for (const hp of inst.hitPositions) {
          this._ledHitSteps.add(Math.round(hp * loopSize) % loopSize);
        }
      }
      isStepActive = (g) => this._ledHitSteps.has(g);
    }

    // Rotated active set: reuse cached set, only rebuild when step or hits change
    if (currentStep !== this._chaseLastStep || hitsChanged) {
      this._chaseRotated.clear();
      for (let g = 0; g < loopSize; g++) {
        if (isStepActive(g)) {
          this._chaseRotated.add((g - currentStep + loopSize) % loopSize);
        }
      }
      this._chaseLastStep = currentStep;
    }
    const rotatedHits = this._chaseRotated;

    const triggerDisplayStep = 0;
    const isTriggerHit = state.isPlaying && rotatedHits.has(triggerDisplayStep);

    // Dot sizing — all dots are visible, hits slightly larger
    const baseDotR = Math.max(3, radius * 0.065);
    const hitDotR = baseDotR * 1.35;
    const triggerDotR = baseDotR * 1.55;

    // Pass 1: non-active dots (visible gray)
    ctx.fillStyle = 'rgba(180,180,190,0.35)';
    ctx.beginPath();
    for (let g = 0; g < loopSize; g++) {
      if (rotatedHits.has(g)) continue;
      const angle = TRIGGER_ANGLE - (g / loopSize) * TWO_PI;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      ctx.moveTo(x + baseDotR, y);
      ctx.arc(x, y, baseDotR, 0, TWO_PI);
    }
    ctx.fill();

    // Pass 2: active dots (instrument color)
    ctx.fillStyle = rgba(inst.color, isMuted ? 0.35 : 0.9);
    ctx.beginPath();
    for (let g = 0; g < loopSize; g++) {
      if (!rotatedHits.has(g)) continue;
      if (state.isPlaying && g === triggerDisplayStep) continue;
      const angle = TRIGGER_ANGLE - (g / loopSize) * TWO_PI;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      ctx.moveTo(x + hitDotR, y);
      ctx.arc(x, y, hitDotR, 0, TWO_PI);
    }
    ctx.fill();

    // Pass 3: triggered dot (white)
    if (isTriggerHit) {
      const x = cx + Math.cos(TRIGGER_ANGLE) * radius;
      const y = cy + Math.sin(TRIGGER_ANGLE) * radius;
      ctx.beginPath();
      ctx.arc(x, y, triggerDotR, 0, TWO_PI);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }

    // Indicator notch at bottom
    const notchCos = Math.cos(TRIGGER_ANGLE);
    const notchSin = Math.sin(TRIGGER_ANGLE);
    ctx.beginPath();
    ctx.moveTo(cx + notchCos * (radius + 4), cy + notchSin * (radius + 4));
    ctx.lineTo(cx + notchCos * (radius + RING_PADDING - 6), cy + notchSin * (radius + RING_PADDING - 6));
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Center text: filled steps (looper) or hits
    const fontSize = Math.max(14, Math.floor(radius * 0.45));
    let centerCount: number;
    if (inst.type === 'looper') {
      const detectedLS = inst.detectedLoopSize || loopSize;
      const pitchRatio = Math.pow(2, ((inst.looperParams?.pitchSemitones ?? 0) / 12));
      const isStretched = inst.looperParams?.stretchToSteps ?? false;
      const baseScale = isStretched ? 1 : detectedLS / loopSize;
      const sampleScale = baseScale / pitchRatio;
      centerCount = Math.min(loopSize, Math.max(0, Math.ceil(sampleScale * loopSize)));
    } else {
      centerCount = inst.hits;
    }
    ctx.fillStyle = rgba(inst.color, isMuted ? 0.3 : 0.8);
    ctx.font = `bold ${fontSize}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(centerCount), cx, cy - fontSize * 0.25);

    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = `${Math.floor(fontSize * 0.5)}px monospace`;
    ctx.fillText(`/${inst.loopSize}`, cx, cy + fontSize * 0.6);
  }

  // --- Hit detection ---

  getHitAt(mouseX: number, mouseY: number): number | null {
    const state = useStore.getState();
    const inst = state.instruments.find((i) => i.id === this.instrumentId);
    if (!inst) return null;

    const { cx, cy, radius } = this.getLayout();
    const transport = Tone.getTransport();
    const stepsPerBeatGlobal = state.stepsPerBeat ?? 8;
    const secondsPerStep = 60 / state.bpm / stepsPerBeatGlobal;
    const totalSteps = state.isPlaying ? transport.seconds / secondsPerStep : 0;
    const effectivelyMuted = isInstrumentEffectivelyMuted(state, this.instrumentId, inst.muted, inst.solo);
    const instProg = state.isPlaying && !effectivelyMuted
      ? (totalSteps % inst.loopSize) / inst.loopSize : 0;
    const dotRotation = instProg * TWO_PI;

    for (let i = 0; i < inst.hitPositions.length; i++) {
      const hitAngle = TRIGGER_ANGLE - inst.hitPositions[i] * TWO_PI - dotRotation;
      const hx = cx + Math.cos(hitAngle) * radius;
      const hy = cy + Math.sin(hitAngle) * radius;
      const dx = mouseX - hx;
      const dy = mouseY - hy;
      if (dx * dx + dy * dy < (HIT_RADIUS + 8) * (HIT_RADIUS + 8)) return i;
    }
    return null;
  }

  isOnRing(mouseX: number, mouseY: number): boolean {
    const { cx, cy, radius } = this.getLayout();
    const dx = mouseX - cx;
    const dy = mouseY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    return Math.abs(dist - radius) < 15;
  }

  getAngleAt(mouseX: number, mouseY: number): number {
    const state = useStore.getState();
    const inst = state.instruments.find((i) => i.id === this.instrumentId);
    const { cx, cy } = this.getLayout();

    const transport = Tone.getTransport();
    const stepsPerBeatGlobal = state.stepsPerBeat ?? 8;
    const secondsPerStep = 60 / state.bpm / stepsPerBeatGlobal;
    const totalSteps = state.isPlaying ? transport.seconds / secondsPerStep : 0;
    const effectivelyMuted = inst ? isInstrumentEffectivelyMuted(state, this.instrumentId, inst.muted, inst.solo) : false;
    const instProg = state.isPlaying && inst && !effectivelyMuted
      ? (totalSteps % inst.loopSize) / inst.loopSize : 0;
    const dotRotation = instProg * TWO_PI;

    const angle = Math.atan2(mouseY - cy, mouseX - cx);
    const normalizedPos = (TRIGGER_ANGLE - angle - dotRotation) / TWO_PI;
    return ((normalizedPos % 1) + 1) % 1;
  }
}
