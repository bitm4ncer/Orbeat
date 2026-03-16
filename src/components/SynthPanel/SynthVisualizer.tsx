import { useEffect, useRef, useState, useCallback } from 'react';
import { getOrbitAnalyser } from '../../audio/orbitEffects';
import { useAnimationLoop } from '../../hooks/useAnimationLoop';

const CANVAS_H = 80;
const MIN_FREQ = 20;
const MAX_FREQ = 20000;

type VisMode = 'bands' | 'wave' | 'line' | 'spec' | 'marq' | 'orb';
const MODES:  VisMode[] = ['bands', 'wave', 'line', 'spec', 'marq', 'orb'];
const LABELS: string[]  = ['Bands', 'Wave', 'Line', 'Spec', 'Marq', 'Orb'];

const N_PILLARS  = 16;
const PILLAR_GAP = 3;
const MARQ_SPEED = 3; // pixels scrolled per frame

function freqToX(f: number, W: number): number {
  return (Math.log10(f / MIN_FREQ) / Math.log10(MAX_FREQ / MIN_FREQ)) * W;
}

/** Darken a hex color to ~10% brightness for use as background */
function colorToBg(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  const f = 0.08; // 8% of original brightness
  return `rgb(${Math.round(r * f)},${Math.round(g * f)},${Math.round(b * f)})`;
}

function makeOffscreen(W: number, bg: string): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = W; c.height = CANVAS_H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, CANVAS_H);
  return [c, ctx];
}

interface Props {
  orbitIndex: number;
  color:      string;
}

export function SynthVisualizer({ orbitIndex, color }: Props) {
  const [mode, setMode]  = useState<VisMode>('bands');
  const canvasRef        = useRef<HTMLCanvasElement>(null);
  const containerRef     = useRef<HTMLDivElement>(null);
  const modeRef          = useRef<VisMode>(mode);
  const widthRef         = useRef(280);
  // Separate rolling buffers for spec and marq
  const specRef          = useRef<[HTMLCanvasElement, CanvasRenderingContext2D] | null>(null);
  const marqRef          = useRef<[HTMLCanvasElement, CanvasRenderingContext2D] | null>(null);
  const marqPrevYRef     = useRef<number>(CANVAS_H / 2);

  useEffect(() => { modeRef.current = mode; }, [mode]);

  const bgColor = '#0d0d12';

  // Track container width via ResizeObserver
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const syncSize = () => {
      const W = Math.round(container.clientWidth) || 280;
      if (W === widthRef.current) return;
      widthRef.current = W;
      canvas.width = W;
      canvas.height = CANVAS_H;
      specRef.current = makeOffscreen(W, bgColor);
      marqRef.current = makeOffscreen(W, bgColor);
    };

    syncSize();

    const ro = new ResizeObserver(() => syncSize());
    ro.observe(container);
    return () => ro.disconnect();
  }, [bgColor]);

  // Cached canvas context
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    ctxRef.current = canvas.getContext('2d');
  }, []);

  // Pre-allocate buffers once
  const fftBufRef = useRef(new Uint8Array(1024));
  const timeBufRef = useRef(new Uint8Array(512));

  const drawFrame = useCallback(({ frame }: { frame: number }) => {
      const W = widthRef.current;
      const curMode = modeRef.current;
      const analyser = getOrbitAnalyser(orbitIndex);

      // Skip frame entirely when no analyser — keeps last drawn frame visible
      if (!analyser) return;

      // Spec and Marq run every frame; others throttle to ~30fps
      const isScroll = curMode === 'spec' || curMode === 'marq';
      if (!isScroll && frame % 2 !== 0) return;

      const ctx = ctxRef.current;
      if (!ctx) return;

      const fftBuf = fftBufRef.current;
      const timeBuf = timeBufRef.current;
      const bg = bgColor;

      ctx.clearRect(0, 0, W, CANVAS_H);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, CANVAS_H);

      // ── Bands — 16 log-spaced pillars ──────────────────────────────────────
      if (curMode === 'bands') {
        const binCount = analyser.frequencyBinCount;
        analyser.getByteFrequencyData(fftBuf);
        const nyquist  = analyser.context.sampleRate / 2;
        const pillarW  = (W - (N_PILLARS - 1) * PILLAR_GAP) / N_PILLARS;

        for (let p = 0; p < N_PILLARS; p++) {
          const f1 = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ,  p      / N_PILLARS);
          const f2 = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, (p + 1) / N_PILLARS);
          let sum = 0, cnt = 0;
          for (let b = 1; b < binCount; b++) {
            const f = (b / binCount) * nyquist;
            if (f >= f1 && f < f2) { sum += fftBuf[b]; cnt++; }
          }
          const mag  = cnt > 0 ? sum / cnt / 255 : 0;
          const barH = Math.max(1, mag * (CANVAS_H - 4));
          const x    = p * (pillarW + PILLAR_GAP);
          const y    = CANVAS_H - barH;
          const r    = Math.min(3, pillarW / 2);

          ctx.fillStyle = `${color}55`;
          ctx.beginPath();
          ctx.roundRect(x, y, pillarW, barH, [r, r, 0, 0]);
          ctx.fill();

          // Bright top cap
          ctx.fillStyle = `${color}cc`;
          ctx.fillRect(x, y, pillarW, Math.min(2, barH));
        }
      }

      // ── Wave — static oscilloscope ──────────────────────────────────────────
      else if (curMode === 'wave') {
        analyser.getByteTimeDomainData(timeBuf);
        const bufLen = timeBuf.length;

        // Center line
        ctx.strokeStyle = '#2a2a3a';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(0, CANVAS_H / 2);
        ctx.lineTo(W, CANVAS_H / 2);
        ctx.stroke();

        ctx.beginPath();
        for (let i = 0; i < bufLen; i++) {
          const x = (i / bufLen) * W;
          const y = CANVAS_H / 2 - ((timeBuf[i] - 128) / 128) * (CANVAS_H / 2 - 4);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `${color}cc`;
        ctx.lineWidth   = 1.5;
        ctx.lineJoin    = 'round';
        ctx.stroke();
      }

      // ── Line — smooth frequency spectrum stroke ─────────────────────────────
      else if (curMode === 'line') {
        const binCount = analyser.frequencyBinCount;
        analyser.getByteFrequencyData(fftBuf);
        const nyquist = analyser.context.sampleRate / 2;

        ctx.beginPath();
        let first = true;
        for (let i = 1; i < binCount; i++) {
          const freq = (i / binCount) * nyquist;
          if (freq < MIN_FREQ || freq > MAX_FREQ) continue;
          const x = freqToX(freq, W);
          const y = CANVAS_H - (fftBuf[i] / 255) * CANVAS_H;
          first ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          first = false;
        }
        ctx.strokeStyle = `${color}dd`;
        ctx.lineWidth   = 2;
        ctx.lineJoin    = 'round';
        ctx.stroke();
      }

      // ── Spectrograph — rolling frequency waterfall ──────────────────────────
      else if (curMode === 'spec') {
        const sp = specRef.current;
        if (!sp) return;
        const [offCanvas, offCtx] = sp;

        if (analyser) {
          const binCount = analyser.frequencyBinCount;
          analyser.getByteFrequencyData(fftBuf);

          const imgData = offCtx.getImageData(1, 0, W - 1, CANVAS_H);
          offCtx.fillStyle = bg;
          offCtx.fillRect(0, 0, W, CANVAS_H);
          offCtx.putImageData(imgData, 0, 0);

          for (let y = 0; y < CANVAS_H; y++) {
            const frac   = 1 - y / CANVAS_H;
            const freq   = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, frac);
            const binIdx = Math.min(binCount - 1, Math.floor((freq / (analyser.context.sampleRate / 2)) * binCount));
            const mag    = fftBuf[binIdx] / 255;
            if (mag > 0.01) {
              offCtx.fillStyle = `${color}${Math.round(mag * 220).toString(16).padStart(2, '0')}`;
              offCtx.fillRect(W - 1, y, 1, 1);
            }
          }
        }
        ctx.drawImage(offCanvas, 0, 0);
      }

      // ── Marq — scrolling time-domain waveform ───────────────────────────────
      else if (curMode === 'marq') {
        const mq = marqRef.current;
        if (!mq) return;
        const [offCanvas, offCtx] = mq;

        if (analyser) {
          analyser.getByteTimeDomainData(timeBuf);
          const N = timeBuf.length;

          // Use the center sample as the stable "current" amplitude
          const sample = timeBuf[Math.floor(N / 2)];
          const newY   = CANVAS_H / 2 - ((sample - 128) / 128) * (CANVAS_H / 2 - 3);
          const prevY  = marqPrevYRef.current;

          // Shift left by MARQ_SPEED pixels
          const imgData = offCtx.getImageData(MARQ_SPEED, 0, W - MARQ_SPEED, CANVAS_H);
          offCtx.fillStyle = bg;
          offCtx.fillRect(0, 0, W, CANVAS_H);
          offCtx.putImageData(imgData, 0, 0);

          // Draw one connecting line segment into the new strip
          offCtx.strokeStyle = `${color}cc`;
          offCtx.lineWidth   = 1.5;
          offCtx.lineJoin    = 'round';
          offCtx.beginPath();
          offCtx.moveTo(W - MARQ_SPEED - 1, prevY);
          offCtx.lineTo(W - 1, newY);
          offCtx.stroke();

          marqPrevYRef.current = newY;
        }
        ctx.drawImage(offCanvas, 0, 0);
      }

      // ── Orb — oval with bright core, iris, and blurry halo ─────────────────
      else if (curMode === 'orb') {
        const cx   = W / 2;
        const cy   = CANVAS_H / 2;
        const RX   = Math.min(W * 0.38, CANVAS_H * 0.70);   // wider x
        const RY   = RX * 0.52;                              // narrower y (oval)

        if (analyser) {
          const binCount = analyser.frequencyBinCount;
          analyser.getByteFrequencyData(fftBuf);
          const N = 128;

          // Radial bars — extend from iris surface outward
          for (let i = 0; i < N; i++) {
            const angle  = (i / N) * Math.PI * 2 - Math.PI / 2;
            const binIdx = Math.min(binCount - 1, Math.floor((i / N) * (binCount * 0.6)));
            const mag    = fftBuf[binIdx] / 255;
            const barLen = mag * RX * 0.55;
            if (barLen < 0.8) continue;

            const cosA = Math.cos(angle), sinA = Math.sin(angle);
            // Ellipse surface point
            const sx = cx + cosA * RX * 0.55;
            const sy = cy + sinA * RY * 0.55;
            // Bar tip (extends in the polar direction, scaled for oval)
            const ex = cx + cosA * (RX * 0.55 + barLen * Math.abs(cosA) + barLen * 0.4 * Math.abs(sinA));
            const ey = cy + sinA * (RY * 0.55 + barLen * Math.abs(sinA) + barLen * 0.4 * Math.abs(cosA));

            const alpha = Math.round(mag * 180 + 50).toString(16).padStart(2, '0');
            ctx.strokeStyle = `${color}${alpha}`;
            ctx.lineWidth   = 1.5;
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(ex, ey);
            ctx.stroke();
          }
        }

        // Layer 2 — iris (dark, semi-transparent ring)
        ctx.beginPath();
        ctx.ellipse(cx, cy, RX * 0.55, RY * 0.55, 0, 0, Math.PI * 2);
        ctx.fillStyle = `${color}08`;
        ctx.fill();
        ctx.strokeStyle = `${color}40`;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Layer 3 — bright core (scale transform to make gradient oval)
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(RX / RY, 1);
        const coreR = RY * 0.32;
        const grd   = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR * 2);
        grd.addColorStop(0,    '#ffffff');
        grd.addColorStop(0.15, color);
        grd.addColorStop(0.5,  `${color}70`);
        grd.addColorStop(1,    `${color}00`);
        ctx.beginPath();
        ctx.arc(0, 0, coreR * 2, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();
        ctx.restore();
      }
  }, [orbitIndex, color, bgColor]);

  useAnimationLoop(drawFrame, {
    targetFps: 60,
    visibilityRef: containerRef,
  });

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full">
        <canvas
          ref={canvasRef}
          height={CANVAS_H}
          className="block w-full h-full"
          style={{ imageRendering: 'pixelated', background: bgColor }}
        />
      </div>
      {/* Mode button — top right corner */}
      <div ref={menuRef} className="absolute top-1 right-1">
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="text-[7px] uppercase tracking-wider px-1.5 py-0.5 rounded transition-all"
          style={{
            background: `${color}20`,
            border: `1px solid ${color}40`,
            color,
          }}
        >
          {LABELS[MODES.indexOf(mode)]}
        </button>
        {menuOpen && (
          <div
            className="absolute top-full right-0 mt-0.5 flex flex-col rounded overflow-hidden"
            style={{
              background: bgColor,
              border: `1px solid ${color}40`,
              zIndex: 50,
            }}
          >
            {MODES.map((m, i) => (
              <button
                key={m}
                onClick={() => { setMode(m); setMenuOpen(false); }}
                className="text-[8px] uppercase tracking-wider px-3 py-1 text-left transition-all"
                style={{
                  background: mode === m ? `${color}28` : 'transparent',
                  color: mode === m ? color : '#8888a0',
                }}
              >
                {LABELS[i]}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
