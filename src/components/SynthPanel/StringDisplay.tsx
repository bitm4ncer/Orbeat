import { useEffect, useRef } from 'react';

const BG = '#0e0e18';
const SNAPSHOTS = 10;     // number of time-decay snapshots
const SAMPLES = 300;      // horizontal resolution

interface Props {
  damping: number;   // 200–12000 Hz
  decay: number;     // 0.9–0.999
  color: string;
  height?: number;
}

/**
 * Karplus-Strong string visualization.
 *
 * Shows a plucked string decaying over time: the initial noisy excitation
 * progressively smooths into a pure sinusoid as harmonics are filtered away.
 * Multiple time-snapshots are stacked (newest=front, oldest=back) to show
 * the decay process — like a stroboscopic photo of a vibrating string.
 */
export function StringDisplay({ damping, decay, color, height = 90 }: Props) {
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

      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);

      // Simulate the string's frequency content at different time steps.
      // damping controls how fast high harmonics decay (low = dark/fast, high = bright/slow).
      // decay controls overall amplitude envelope.

      // Normalize damping to 0–1 range for our harmonic rolloff model
      const dampNorm = Math.max(0, Math.min(1, (damping - 200) / (12000 - 200)));
      // How many harmonics survive: high damping = many, low = few
      const maxHarmonics = Math.round(3 + dampNorm * 25);

      const padX = 12;
      const padY = 14;
      const waveW = W - padX * 2;
      const centerY = H * 0.5;
      const maxAmp = (H - padY * 2) * 0.4;

      // Fixed bridge points at each end
      const bridgeL = padX;
      const bridgeR = padX + waveW;

      // Draw bridge lines (string endpoints)
      ctx.strokeStyle = `${color}25`;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(bridgeL, padY);
      ctx.lineTo(bridgeL, H - padY);
      ctx.moveTo(bridgeR, padY);
      ctx.lineTo(bridgeR, H - padY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Rest position line
      ctx.strokeStyle = '#1a1a2a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bridgeL, centerY);
      ctx.lineTo(bridgeR, centerY);
      ctx.stroke();

      // Deterministic seed for "noise" initial state
      function hash(n: number): number {
        let x = Math.sin(n * 12.9898 + n * 78.233) * 43758.5453;
        return (x - Math.floor(x)) * 2 - 1;
      }

      // Generate snapshots from newest (most decayed) to oldest
      // Draw back-to-front: oldest first (large amplitude, noisy), newest last (smooth, quiet)
      for (let s = SNAPSHOTS - 1; s >= 0; s--) {
        // Time progression: s=0 is the "just plucked" state, s=SNAPSHOTS-1 is nearly silent
        const timeFactor = s / (SNAPSHOTS - 1); // 0 = fresh pluck, 1 = fully decayed
        const ampDecay = Math.pow(decay, timeFactor * 200); // amplitude at this time step
        // Harmonics surviving at this time: high harmonics die first
        const harmonicDecayRate = 1 - dampNorm * 0.6; // how fast upper harmonics vanish

        if (ampDecay < 0.01) continue;

        const points: { x: number; y: number }[] = [];
        for (let j = 0; j <= SAMPLES; j++) {
          const t = j / SAMPLES; // 0–1 along string
          let val = 0;
          // Sum standing wave harmonics with time-dependent decay
          for (let k = 1; k <= maxHarmonics; k++) {
            // Each harmonic decays faster with k (higher harmonics filtered by damping LPF)
            const harmonicSurvival = Math.pow(harmonicDecayRate, (k - 1) * timeFactor * 3);
            // Initial amplitude: noise-like distribution weighted by 1/k
            const initAmp = hash(k * 137 + 7) / k;
            val += initAmp * harmonicSurvival * Math.sin(Math.PI * k * t);
          }
          val *= ampDecay;

          const x = bridgeL + t * waveW;
          const y = centerY - val * maxAmp;
          points.push({ x, y });
        }

        // Ensure endpoints are pinned to bridge (string is fixed at both ends)
        points[0].y = centerY;
        points[points.length - 1].y = centerY;

        const isFront = s === 0;
        const opacity = isFront ? 1.0 : Math.max(0.06, 0.35 * (1 - timeFactor));

        // Occluder for back layers
        if (!isFront) {
          ctx.beginPath();
          ctx.moveTo(points[0].x, points[0].y);
          for (let j = 1; j < points.length; j++) ctx.lineTo(points[j].x, points[j].y);
          ctx.lineTo(bridgeR, centerY + 2);
          ctx.lineTo(bridgeL, centerY + 2);
          ctx.closePath();
          ctx.fillStyle = BG;
          ctx.fill();
        }

        // Colored fill for front snapshot
        if (isFront) {
          ctx.beginPath();
          ctx.moveTo(bridgeL, centerY);
          for (const p of points) ctx.lineTo(p.x, p.y);
          ctx.lineTo(bridgeR, centerY);
          ctx.closePath();
          ctx.fillStyle = `${color}15`;
          ctx.fill();
        }

        // Stroke
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let j = 1; j < points.length; j++) ctx.lineTo(points[j].x, points[j].y);

        if (isFront) {
          ctx.strokeStyle = `${color}dd`;
          ctx.lineWidth = 2;
          ctx.shadowColor = color;
          ctx.shadowBlur = 6;
        } else {
          const hex = Math.round(opacity * 255).toString(16).padStart(2, '0');
          ctx.strokeStyle = `${color}${hex}`;
          ctx.lineWidth = 0.8;
          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;
        }
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
      }

      // Bridge dots at string endpoints
      for (const bx of [bridgeL, bridgeR]) {
        ctx.beginPath();
        ctx.arc(bx, centerY, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = `${color}60`;
        ctx.fill();
      }
    };

    render();

    const ro = new ResizeObserver(() => render());
    ro.observe(container);
    return () => ro.disconnect();
  }, [damping, decay, color, height]);

  return (
    <div ref={containerRef} className="w-full rounded overflow-hidden" style={{ height }}>
      <canvas ref={canvasRef} height={height} className="block" />
    </div>
  );
}
