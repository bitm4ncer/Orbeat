import { useEffect, useRef } from 'react';
import { sampleWTWaveShape } from '../../audio/synth/wavetableEngine';

const DISPLAY_FRAMES = 16;
const SAMPLES = 200;
const BG = '#0e0e18';

// Pre-allocated sample buffers — reused on every render to avoid GC pressure
const _sampleBuffers: Float32Array[] = [];
for (let i = 0; i < DISPLAY_FRAMES; i++) _sampleBuffers.push(new Float32Array(SAMPLES));

interface Props {
  bankId: string;
  position: number;
  warpMode: number;
  warpAmount: number;
  color: string;
  height?: number;
  /** Optional callback polled at ~30Hz for live LFO-modulated position feedback. */
  getPosition?: () => number;
}

export function WavetableDisplay3D({ bankId, position, warpMode, warpAmount, color, height = 120, getPosition }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Cache pre-sampled waveform data so rAF loop only redraws
  const samplesCache = useRef<{ bankId: string; warpMode: number; warpAmount: number; globalPeak: number } | null>(null);

  // Pre-sample when bank/warp changes
  useEffect(() => {
    let globalPeak = 0;
    for (let f = 0; f < DISPLAY_FRAMES; f++) {
      const framePos = f / (DISPLAY_FRAMES - 1);
      const samples = _sampleBuffers[f];
      for (let j = 0; j < SAMPLES; j++) {
        const t = j / SAMPLES;
        samples[j] = sampleWTWaveShape(bankId, framePos, t, warpMode, warpAmount);
        const absV = Math.abs(samples[j]);
        if (absV > globalPeak) globalPeak = absV;
      }
    }
    if (globalPeak < 0.001) globalPeak = 1;
    samplesCache.current = { bankId, warpMode, warpAmount, globalPeak };
  }, [bankId, warpMode, warpAmount]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const draw = (pos: number) => {
      const cache = samplesCache.current;
      if (!cache) return;

      const W = Math.round(container.clientWidth) || 260;
      const H = height;
      canvas.width = W;
      canvas.height = H;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);

      const padX = 8;
      const padTop = 12;
      const padBottom = 10;
      const totalXSkew = W * 0.08;
      const xSkew = totalXSkew / (DISPLAY_FRAMES - 1);
      const yStep = (H - padTop - padBottom) / (DISPLAY_FRAMES + 2);
      const waveAmp = yStep * 1.8;
      const rightEdge = W - padX;

      const activeIdx = Math.round(pos * (DISPLAY_FRAMES - 1));

      for (let f = 0; f < DISPLAY_FRAMES; f++) {
        const isActive = f === activeIdx;
        const samples = _sampleBuffers[f];
        const xOff = padX + (DISPLAY_FRAMES - 1 - f) * xSkew;
        const yBase = H - padBottom - f * yStep;

        const frameWidth = rightEdge - xOff;
        const points: { x: number; y: number }[] = [];
        for (let j = 0; j <= SAMPLES; j++) {
          const jc = Math.min(j, SAMPLES - 1);
          const t = jc / SAMPLES;
          const val = samples[jc] / cache.globalPeak;
          const x = xOff + t * frameWidth;
          const y = yBase - val * waveAmp;
          points.push({ x, y });
        }

        const depthAlpha = 0.12 + 0.28 * (f / (DISPLAY_FRAMES - 1));
        const hexAlpha = Math.round(depthAlpha * 255).toString(16).padStart(2, '0');

        if (isActive) {
          ctx.beginPath();
          ctx.moveTo(points[0].x, yBase);
          for (const p of points) ctx.lineTo(p.x, p.y);
          ctx.lineTo(points[points.length - 1].x, yBase);
          ctx.closePath();
          ctx.fillStyle = `${color}18`;
          ctx.fill();
        }

        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let j = 1; j < points.length; j++) {
          ctx.lineTo(points[j].x, points[j].y);
        }
        if (isActive) {
          ctx.strokeStyle = `${color}dd`;
          ctx.lineWidth = 2;
          ctx.shadowColor = color;
          ctx.shadowBlur = 6;
        } else {
          ctx.strokeStyle = `${color}${hexAlpha}`;
          ctx.lineWidth = 0.8;
          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;
        }
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
      }
    };

    // Initial draw
    draw(getPosition ? getPosition() : position);

    // rAF loop for live modulation feedback
    let rafId = 0;
    let lastActiveIdx = -1;
    if (getPosition) {
      const tick = () => {
        const pos = getPosition();
        const idx = Math.round(pos * (DISPLAY_FRAMES - 1));
        if (idx !== lastActiveIdx) {
          lastActiveIdx = idx;
          draw(pos);
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    }

    const ro = new ResizeObserver(() => draw(getPosition ? getPosition() : position));
    ro.observe(container);
    return () => {
      ro.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [bankId, position, warpMode, warpAmount, color, height, getPosition]);

  return (
    <div ref={containerRef} className="w-full rounded overflow-hidden" style={{ height }}>
      <canvas ref={canvasRef} height={height} className="block" />
    </div>
  );
}
