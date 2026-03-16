import { useEffect, useRef } from 'react';
import { sampleWaveShape } from '../../audio/synth/wavetables';
import { sampleWTWaveShape } from '../../audio/synth/wavetableEngine';

const DEFAULT_H = 64;

function ySample(t: number, shape: string, wtPosition?: number, wtWarpMode?: number, wtWarpAmount?: number): number {
  if (shape.startsWith('wt:')) {
    return sampleWTWaveShape(shape.slice(3), wtPosition ?? 0, t, wtWarpMode ?? 0, wtWarpAmount ?? 0);
  }
  switch (shape) {
    case 'sine':     return Math.sin(t * Math.PI * 2);
    case 'triangle': return 1 - 4 * Math.abs(t - Math.round(t));
    case 'square':   return t < 0.5 ? 1 : -1;
    case 'sawtooth': return 2 * (t - Math.floor(t + 0.5));
    default:         return sampleWaveShape(t, shape);
  }
}

// Per-shape peak amplitude cache (for normalization in display)
const peakCache = new Map<string, number>();
function getPeak(shape: string, wtPosition?: number, wtWarpMode?: number, wtWarpAmount?: number): number {
  const wm = wtWarpMode ?? 0;
  const wa = wtWarpAmount ?? 0;
  const key = shape.startsWith('wt:')
    ? `${shape}:${Math.round((wtPosition ?? 0) * 256)}:${wm}:${Math.round(wa * 256)}`
    : shape;
  if (peakCache.has(key)) return peakCache.get(key)!;
  let peak = 0;
  const steps = 512;
  for (let i = 0; i < steps; i++) {
    const v = Math.abs(ySample(i / steps, shape, wtPosition, wtWarpMode, wtWarpAmount));
    if (v > peak) peak = v;
  }
  const p = Math.max(0.001, peak);
  if (shape.startsWith('wt:') && peakCache.size > 128) {
    const firstKey = peakCache.keys().next().value;
    if (firstKey !== undefined) peakCache.delete(firstKey);
  }
  peakCache.set(key, p);
  return p;
}

interface Props {
  waveType: string;
  color:    string;
  wtPosition?: number;
  wtWarpMode?: number;
  wtWarpAmount?: number;
  height?: number;
}

export function OscDisplay({ waveType, color, wtPosition, wtWarpMode, wtWarpAmount, height }: Props) {
  const H = height ?? DEFAULT_H;
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas    = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const render = () => {
      const W = Math.round(container.clientWidth) || 260;
      canvas.width  = W;
      canvas.height = H;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const peak = getPeak(waveType, wtPosition, wtWarpMode, wtWarpAmount);
      const pad  = 4;

      // Background
      ctx.fillStyle = '#0e0e18';
      ctx.fillRect(0, 0, W, H);

      // Center line
      ctx.strokeStyle = '#2a2a3a';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(0, H / 2);
      ctx.lineTo(W, H / 2);
      ctx.stroke();

      // Pre-compute Y values once for both fill and stroke passes
      const halfH = H / 2;
      const scale = (halfH - pad) / peak;
      const yValues = new Float32Array(W + 1);
      for (let i = 0; i <= W; i++) {
        yValues[i] = halfH - ySample(i / W, waveType, wtPosition, wtWarpMode, wtWarpAmount) * scale;
      }

      // Waveform fill
      ctx.beginPath();
      ctx.moveTo(0, halfH);
      for (let i = 0; i <= W; i++) ctx.lineTo(i, yValues[i]);
      ctx.lineTo(W, halfH);
      ctx.closePath();
      ctx.fillStyle = `${color}18`;
      ctx.fill();

      // Waveform stroke
      ctx.beginPath();
      ctx.moveTo(0, yValues[0]);
      for (let i = 1; i <= W; i++) ctx.lineTo(i, yValues[i]);
      ctx.strokeStyle = `${color}cc`;
      ctx.lineWidth   = 1.5;
      ctx.lineJoin    = 'round';
      ctx.stroke();
    };

    render();

    const ro = new ResizeObserver(() => render());
    ro.observe(container);
    return () => ro.disconnect();
  }, [waveType, color, wtPosition, wtWarpMode, wtWarpAmount, H]);

  return (
    <div ref={containerRef} className="w-full rounded overflow-hidden" style={{ height: H }}>
      <canvas
        ref={canvasRef}
        height={H}
        className="block"
        style={{ imageRendering: 'pixelated' }}
      />
    </div>
  );
}
