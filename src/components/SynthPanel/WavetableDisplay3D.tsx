import { useEffect, useRef } from 'react';
import { sampleWTWaveShape } from '../../audio/synth/wavetableEngine';

const DISPLAY_FRAMES = 16;
const SAMPLES = 200;
const BG = '#0e0e18';

interface Props {
  bankId: string;
  position: number;
  warpMode: number;
  warpAmount: number;
  color: string;
  height?: number;
}

export function WavetableDisplay3D({ bankId, position, warpMode, warpAmount, color, height = 120 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const render = () => {
      const W = Math.round(container.clientWidth) || 260;
      const H = height;
      canvas.width = W;
      canvas.height = H;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Background
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);

      // Layout constants
      const padX = 8;
      const padTop = 12;
      const padBottom = 10;
      const totalXSkew = W * 0.08;          // total horizontal shift across all layers
      const xSkew = totalXSkew / (DISPLAY_FRAMES - 1);
      const yStep = (H - padTop - padBottom) / (DISPLAY_FRAMES + 2); // vertical spacing per frame
      const waveAmp = yStep * 1.8;          // waveform amplitude
      const waveWidth = W - padX * 2 - totalXSkew;

      // Find which display frame is closest to current position
      const activeIdx = Math.round(position * (DISPLAY_FRAMES - 1));

      // Pre-sample all frames for global peak normalization
      const allSamples: Float32Array[] = [];
      let globalPeak = 0;
      for (let f = 0; f < DISPLAY_FRAMES; f++) {
        const framePos = f / (DISPLAY_FRAMES - 1);
        const samples = new Float32Array(SAMPLES);
        for (let j = 0; j < SAMPLES; j++) {
          const t = j / SAMPLES;
          samples[j] = sampleWTWaveShape(bankId, framePos, t, warpMode, warpAmount);
          const absV = Math.abs(samples[j]);
          if (absV > globalPeak) globalPeak = absV;
        }
        allSamples.push(samples);
      }
      if (globalPeak < 0.001) globalPeak = 1;

      // Draw frames back-to-front (painter's algorithm)
      for (let f = 0; f < DISPLAY_FRAMES; f++) {
        const isActive = f === activeIdx;
        const samples = allSamples[f];
        const xOff = padX + (DISPLAY_FRAMES - 1 - f) * xSkew;
        const yBase = H - padBottom - f * yStep;

        // Build waveform path points
        const points: { x: number; y: number }[] = [];
        for (let j = 0; j <= SAMPLES; j++) {
          const jc = Math.min(j, SAMPLES - 1);
          const t = jc / SAMPLES;
          const val = samples[jc] / globalPeak;
          const x = xOff + t * waveWidth;
          const y = yBase - val * waveAmp;
          points.push({ x, y });
        }

        // Occluder fill: waveform path → bottom edge → fills with bg to hide frames behind
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let j = 1; j < points.length; j++) {
          ctx.lineTo(points[j].x, points[j].y);
        }
        ctx.lineTo(points[points.length - 1].x, yBase + 2);
        ctx.lineTo(points[0].x, yBase + 2);
        ctx.closePath();
        ctx.fillStyle = BG;
        ctx.fill();

        // Active frame: colored fill under waveform
        if (isActive) {
          ctx.beginPath();
          ctx.moveTo(points[0].x, yBase);
          for (const p of points) ctx.lineTo(p.x, p.y);
          ctx.lineTo(points[points.length - 1].x, yBase);
          ctx.closePath();
          ctx.fillStyle = `${color}18`;
          ctx.fill();
        }

        // Waveform stroke
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
          ctx.strokeStyle = `${color}30`;
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

    render();

    const ro = new ResizeObserver(() => render());
    ro.observe(container);
    return () => ro.disconnect();
  }, [bankId, position, warpMode, warpAmount, color, height]);

  return (
    <div ref={containerRef} className="w-full rounded overflow-hidden" style={{ height }}>
      <canvas ref={canvasRef} height={height} className="block" />
    </div>
  );
}
