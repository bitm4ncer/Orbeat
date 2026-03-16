/**
 * DotRingOrb — Canvas-based orbit display.
 *
 * A ring of dots drawn on a <canvas>.  Hit-coloured dots rotate clockwise
 * through the fixed grid; when one reaches the bottom indicator it flashes white.
 * All per-frame work is pure Canvas 2D — zero DOM mutations, zero allocations.
 */

import { useEffect, useRef } from 'react';
import * as Tone from 'tone';
import { useStore } from '../../state/store';
import { isInstrumentEffectivelyMuted } from '../../canvas/renderUtils';
import { useAnimationLoop } from '../../hooks/useAnimationLoop';

const TWO_PI = Math.PI * 2;
const TRIGGER_ANGLE = Math.PI / 2; // 6 o'clock (bottom)
const MAX_DOTS = 64; // max loopSize we'll ever see

interface Props {
  instrumentId: string;
  /** Rendered size in CSS px */
  size: number;
}

export function DotRingOrb({ instrumentId, size }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  // Store refs — updated via subscribe, zero re-renders during playback
  const instRef = useRef(useStore.getState().instruments.find((i) => i.id === instrumentId));
  const stateRef = useRef(useStore.getState());

  useEffect(() => {
    const unsub = useStore.subscribe((s) => {
      stateRef.current = s;
      instRef.current = s.instruments.find((i) => i.id === instrumentId);
    });
    return unsub;
  }, [instrumentId]);

  // React-driven values (re-render only when these change)
  const inst = useStore((s) => s.instruments.find((i) => i.id === instrumentId));
  const loopSize = inst?.loopSize ?? 16;
  const color = inst?.color ?? '#6d8cff';

  // Parse color once
  const rgbRef = useRef({ r: 0, g: 0, b: 0 });
  const lastColorRef = useRef('');
  if (color !== lastColorRef.current) {
    lastColorRef.current = color;
    rgbRef.current = {
      r: parseInt(color.slice(1, 3), 16),
      g: parseInt(color.slice(3, 5), 16),
      b: parseInt(color.slice(5, 7), 16),
    };
  }

  // Pre-computed dot positions — rebuilt only when loopSize or size changes
  const dotXYRef = useRef(new Float32Array(MAX_DOTS * 2));
  const layoutRef = useRef({ loopSize: 0, size: 0, cx: 0, cy: 0, radius: 0, fontSize: 0 });

  if (loopSize !== layoutRef.current.loopSize || size !== layoutRef.current.size) {
    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2 - 22;
    const fontSize = Math.max(14, Math.floor(radius * 0.45));
    layoutRef.current = { loopSize, size, cx, cy, radius, fontSize };

    const xy = dotXYRef.current;
    for (let g = 0; g < loopSize; g++) {
      const angle = TRIGGER_ANGLE - (g / loopSize) * TWO_PI;
      xy[g * 2] = cx + Math.cos(angle) * radius;
      xy[g * 2 + 1] = cy + Math.sin(angle) * radius;
    }
  }

  // Pre-allocated hit-step lookup — avoids Set allocations per frame
  const hitStepsRef = useRef(new Uint8Array(MAX_DOTS));
  const lastHitPosRef = useRef<unknown>(null);

  // Previous frame state — skip redraw when nothing changed
  const prevStepRef = useRef(-1);
  const prevMutedRef = useRef(false);
  const prevPlayingRef = useRef(false);
  const prevHitsRef = useRef(-1);

  // Init canvas context
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctxRef.current = ctx;
    }
  }, [size]);

  // Animation loop via shared hook
  useAnimationLoop(
    () => {
      const ctx = ctxRef.current;
      const state = stateRef.current;
      const inst = instRef.current;
      if (!ctx || !inst) return;

      const { cx, cy, radius, fontSize } = layoutRef.current;
      const ls = inst.loopSize;
      const cr = rgbRef.current.r, cg = rgbRef.current.g, cb = rgbRef.current.b;

      // Compute transport progress
      const transport = Tone.getTransport();
      const stepsPerBeat = state.stepsPerBeat ?? 8;
      const secondsPerStep = 60 / state.bpm / stepsPerBeat;
      const totalSteps = state.isPlaying ? transport.seconds / secondsPerStep : 0;
      const effectivelyMuted = isInstrumentEffectivelyMuted(state, inst.id, inst.muted, inst.solo);
      const instProg = state.isPlaying && !effectivelyMuted
        ? (totalSteps % ls) / ls : 0;
      const currentStep = Math.floor(instProg * ls) % ls;
      const isMuted = inst.muted;

      // ── Clear ──
      ctx.clearRect(0, 0, size, size);

      // ── Looper: rotation gradient arc ──
      if (inst.type === 'looper') {
        // Faint full ring
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, TWO_PI);
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.15)`;
        ctx.lineWidth = 4;
        ctx.stroke();

        // Progress arc with conic gradient
        if (state.isPlaying && !effectivelyMuted && instProg > 0) {
          const startAngle = -Math.PI / 2; // 12 o'clock
          const endAngle = startAngle + instProg * TWO_PI;

          // Draw gradient arc using multiple segments for smooth color fade
          const segments = Math.max(8, Math.ceil(instProg * 60));
          const alpha = isMuted ? 0.3 : 0.85;
          for (let s = 0; s < segments; s++) {
            const t0 = s / segments;
            const t1 = (s + 1) / segments;
            const a0 = startAngle + t0 * instProg * TWO_PI;
            const a1 = startAngle + t1 * instProg * TWO_PI;
            const segAlpha = (t0 * 0.1 + (1 - t0) * 0.02) * alpha; // fade from dim to bright
            ctx.beginPath();
            ctx.arc(cx, cy, radius, a0, a1);
            ctx.strokeStyle = `rgba(${cr},${cg},${cb},${(t1 * alpha).toFixed(2)})`;
            ctx.lineWidth = 4;
            ctx.stroke();
          }

          // Bright dot at current position
          const headAngle = endAngle;
          const hx = cx + Math.cos(headAngle) * radius;
          const hy = cy + Math.sin(headAngle) * radius;
          ctx.beginPath();
          ctx.arc(hx, hy, 5, 0, TWO_PI);
          ctx.fillStyle = isMuted ? `rgba(${cr},${cg},${cb},0.4)` : '#ffffff';
          ctx.fill();
        }

        // Indicator line at top (12 o'clock — start position)
        const indAngle = -Math.PI / 2;
        const indX = cx + Math.cos(indAngle) * radius;
        const indY1 = indX === cx ? cy - radius - 6 : cy + Math.sin(indAngle) * radius - 6;
        ctx.beginPath();
        ctx.moveTo(cx, cy - radius - 6);
        ctx.lineTo(cx, cy - radius - 18);
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.stroke();

        // Center text: instrument name
        const displayName = inst.name.length > 8 ? inst.name.slice(0, 8) : inst.name;
        ctx.fillStyle = `rgba(${cr},${cg},${cb},0.8)`;
        ctx.font = `bold ${Math.floor(fontSize * 0.55)}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(displayName, cx, cy - fontSize * 0.15);

        // Center text: loopSize
        const smallFont = Math.floor(fontSize * 0.45);
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.font = `${smallFont}px monospace`;
        ctx.fillText(`${inst.loopSize} steps`, cx, cy + fontSize * 0.6);

      } else {
        // ── Synth/Sampler: dot ring (original behavior) ──

        // Rebuild hit lookup only when hitPositions reference changes
        if (inst.hitPositions !== lastHitPosRef.current) {
          lastHitPosRef.current = inst.hitPositions;
          hitStepsRef.current.fill(0);
          for (const hp of inst.hitPositions) {
            hitStepsRef.current[Math.round(hp * ls) % ls] = 1;
          }
        }

        // Skip full redraw check for synths/samplers
        if (
          currentStep === prevStepRef.current &&
          isMuted === prevMutedRef.current &&
          state.isPlaying === prevPlayingRef.current &&
          inst.hits === prevHitsRef.current &&
          inst.hitPositions === lastHitPosRef.current
        ) {
          return; // identical frame — skip
        }
        prevStepRef.current = currentStep;
        prevMutedRef.current = isMuted;
        prevPlayingRef.current = state.isPlaying;
        prevHitsRef.current = inst.hits;

        const hitArr = hitStepsRef.current;
        const xy = dotXYRef.current;

        // Ring stroke
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, TWO_PI);
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.15)`;
        ctx.lineWidth = 1;
        ctx.stroke();

        // Dots
        const activeAlpha = isMuted ? 0.35 : 0.9;

        for (let g = 0; g < ls; g++) {
          const srcStep = (g + currentStep) % ls;
          const isHit = hitArr[srcStep] === 1;
          const isTriggered = state.isPlaying && isHit && g === 0;

          let dotR: number;
          let fillStyle: string;

          if (isTriggered) {
            dotR = 6;
            fillStyle = '#ffffff';
          } else if (isHit) {
            dotR = 4.5;
            fillStyle = `rgba(${cr},${cg},${cb},${activeAlpha})`;
          } else {
            dotR = 2.5;
            fillStyle = 'rgba(255,255,255,0.07)';
          }

          ctx.beginPath();
          ctx.arc(xy[g * 2], xy[g * 2 + 1], dotR, 0, TWO_PI);
          ctx.fillStyle = fillStyle;
          ctx.fill();
        }

        // Indicator line at bottom (6 o'clock)
        const indX = cx + Math.cos(TRIGGER_ANGLE) * radius;
        const indY1 = cy + Math.sin(TRIGGER_ANGLE) * radius + 6;
        const indY2 = indY1 + 14;
        ctx.beginPath();
        ctx.moveTo(indX, indY1);
        ctx.lineTo(indX, indY2);
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.stroke();

        // Center text: hits
        ctx.fillStyle = `rgba(${cr},${cg},${cb},0.8)`;
        ctx.font = `bold ${fontSize}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(inst.hits), cx, cy - fontSize * 0.15);

        // Center text: /loopSize
        const smallFont = Math.floor(fontSize * 0.5);
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.font = `${smallFont}px monospace`;
        ctx.fillText(`/${inst.loopSize}`, cx, cy + fontSize * 0.7);
      }
    },
    { targetFps: 60, visibilityRef: containerRef },
  );

  if (!inst) return null;

  return (
    <div ref={containerRef} className="w-full aspect-square">
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ imageRendering: 'auto' }}
      />
    </div>
  );
}
