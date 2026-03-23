import { useEffect, useRef, useCallback } from 'react';
import { getAudioContext } from 'superdough';
import { useAnimationLoop } from '../../hooks/useAnimationLoop';

const N_FREQS = 200;
const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const DB_MIN = -48;
const DB_MAX = 12;
const H = 64;

const FILTER_TYPES: BiquadFilterType[] = ['lowpass', 'highpass', 'bandpass', 'notch'];
const GRID_FREQS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

const FREQS = new Float32Array(N_FREQS).map((_, i) =>
  MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, i / (N_FREQS - 1))
);

// Pre-allocated output buffers (reused across all instances — single-threaded so safe)
const magBuf = new Float32Array(N_FREQS);
const phaseBuf = new Float32Array(N_FREQS);
const dbBuf = new Float32Array(N_FREQS);

function freqToX(f: number, W: number): number {
  return (Math.log10(f / MIN_FREQ) / Math.log10(MAX_FREQ / MIN_FREQ)) * W;
}

function dbToY(db: number): number {
  return H - ((db - DB_MIN) / (DB_MAX - DB_MIN)) * H;
}

interface FilterCurveDisplayProps {
  filterType: number;
  frequency: number;
  q: number;
  color: string;
  /** Optional callback returning live modulated values { frequency, q }. When provided, the display animates at ~30fps. */
  getModulatedValues?: () => { frequency: number | null; q: number | null };
  /** Filter envelope amount in cents (-12000 to +12000) */
  filterEnvAmount?: number;
  /** Filter envelope attack time in seconds */
  filterAttack?: number;
  /** Filter envelope decay time in seconds */
  filterDecay?: number;
  /** Whether ring modulation is enabled */
  ringModEnabled?: boolean;
}

export function FilterCurveDisplay({ filterType, frequency, q, color, getModulatedValues, filterEnvAmount, filterAttack, filterDecay, ringModEnabled }: FilterCurveDisplayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const filterNodeRef = useRef<BiquadFilterNode | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const widthRef = useRef(260);

  // Store ALL props in refs so the rAF loop always reads fresh values without restarting
  const propsRef = useRef({ filterType, frequency, q, color, filterEnvAmount, filterAttack, filterDecay, ringModEnabled });
  propsRef.current = { filterType, frequency, q, color, filterEnvAmount, filterAttack, filterDecay, ringModEnabled };
  const getModRef = useRef(getModulatedValues);
  getModRef.current = getModulatedValues;

  const render = useCallback((modFreq?: number | null, modQ?: number | null) => {
    const ctx = ctxRef.current;
    if (!ctx) return;

    const { filterType: ft, frequency: baseFreq, q: baseQ, color: col, filterEnvAmount: envAmt, filterAttack: envAtk, filterDecay: envDec, ringModEnabled: rmOn } = propsRef.current;
    const drawFreq = modFreq ?? baseFreq;
    const drawQ = modQ ?? baseQ;
    const isModulated = modFreq != null || modQ != null;

    const W = widthRef.current;
    const canvas = canvasRef.current;
    if (canvas && (canvas.width !== W || canvas.height !== H)) {
      canvas.width = W;
      canvas.height = H;
    }

    // Reuse a single BiquadFilterNode to avoid creating one per frame
    try {
      if (!filterNodeRef.current) {
        const ac = getAudioContext() as AudioContext;
        filterNodeRef.current = ac.createBiquadFilter();
      }
      const filter = filterNodeRef.current;
      filter.type = FILTER_TYPES[ft] ?? 'lowpass';
      filter.frequency.value = drawFreq;
      filter.Q.value = drawQ;
      filter.getFrequencyResponse(FREQS, magBuf, phaseBuf);
    } catch {
      return;
    }

    for (let i = 0; i < N_FREQS; i++) {
      dbBuf[i] = 20 * Math.log10(Math.max(magBuf[i], 1e-9));
    }

    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = '#0e0e18';
    ctx.fillRect(0, 0, W, H);

    // dB grid
    ctx.strokeStyle = '#2a2a3a';
    ctx.lineWidth = 1;
    for (const db of [-36, -24, -12, 0]) {
      const y = Math.round(dbToY(db)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // Freq grid
    ctx.strokeStyle = '#222232';
    for (const f of GRID_FREQS) {
      const x = Math.round(freqToX(f, W)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }

    // 0 dB line
    const y0 = Math.round(dbToY(0)) + 0.5;
    ctx.strokeStyle = '#3a3a55';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(W, y0); ctx.stroke();

    // Base cutoff marker (dashed, dimmed when modulated)
    const xBase = freqToX(baseFreq, W);
    ctx.strokeStyle = isModulated ? `${col}20` : `${col}40`;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(xBase, 0); ctx.lineTo(xBase, H); ctx.stroke();
    ctx.setLineDash([]);

    // Modulated cutoff marker (solid, brighter)
    if (isModulated) {
      const xMod = freqToX(drawFreq, W);
      ctx.strokeStyle = `${col}80`;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(xMod, 0); ctx.lineTo(xMod, H); ctx.stroke();
    }

    // Curve fill
    ctx.beginPath();
    ctx.moveTo(0, dbToY(dbBuf[0]));
    for (let i = 1; i < N_FREQS; i++) {
      ctx.lineTo(freqToX(FREQS[i], W), dbToY(dbBuf[i]));
    }
    ctx.lineTo(W, y0);
    ctx.lineTo(0, y0);
    ctx.closePath();
    ctx.fillStyle = `${col}22`;
    ctx.fill();

    // Curve stroke
    ctx.beginPath();
    ctx.moveTo(0, dbToY(dbBuf[0]));
    for (let i = 1; i < N_FREQS; i++) {
      ctx.lineTo(freqToX(FREQS[i], W), dbToY(dbBuf[i]));
    }
    ctx.strokeStyle = `${col}cc`;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // dB labels
    ctx.fillStyle = '#4a4a60';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    for (const db of [-24, -12, 0]) {
      const y = dbToY(db);
      if (y > 6 && y < H - 2) {
        ctx.fillText(`${db}`, W - 2, y + 3);
      }
    }

    // Envelope range indicator
    if (envAmt && envAmt !== 0) {
      const envTargetFreq = Math.max(MIN_FREQ, Math.min(MAX_FREQ, baseFreq * Math.pow(2, envAmt / 1200)));
      const xEnv = freqToX(envTargetFreq, W);
      const xLeft = Math.min(xBase, xEnv);
      const xRight = Math.max(xBase, xEnv);
      const bandW = xRight - xLeft;

      // Shaded sweep range band
      ctx.fillStyle = `${col}12`;
      ctx.fillRect(xLeft, 0, bandW, H);

      // Envelope target line (dotted)
      ctx.strokeStyle = `${col}55`;
      ctx.lineWidth = 1;
      ctx.setLineDash([1, 2]);
      ctx.beginPath(); ctx.moveTo(xEnv, 0); ctx.lineTo(xEnv, H); ctx.stroke();
      ctx.setLineDash([]);

      // Mini envelope curve inside the band
      const atk = Math.max(envAtk ?? 0, 0.001);
      const dec = Math.max(envDec ?? 0.1, 0.001);
      const totalT = atk + dec * 3; // 3 time constants for visible decay
      const envH = H * 0.4;
      const envY0 = H - 4; // bottom baseline
      const steps = 30;
      ctx.strokeStyle = `${col}66`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let s = 0; s <= steps; s++) {
        const t = (s / steps) * totalT;
        // Envelope value: linear attack, exponential decay
        let envVal: number;
        if (t < atk) {
          envVal = t / atk;
        } else {
          envVal = Math.exp(-(t - atk) / (dec / 5));
        }
        const x = xLeft + (s / steps) * bandW;
        const y = envY0 - envVal * envH;
        if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Ring mod indicator badge
    if (rmOn) {
      ctx.fillStyle = `${col}cc`;
      ctx.font = 'bold 8px monospace';
      ctx.textAlign = 'left';
      ctx.fillText('RM', 3, 10);
    }
  }, []);

  // ResizeObserver — track container width, cache ctx
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    ctxRef.current = canvas.getContext('2d');

    const syncSize = () => {
      const W = Math.round(container.clientWidth) || 260;
      if (W === widthRef.current) return;
      widthRef.current = W;
      canvas.width = W;
      canvas.height = H;
    };
    syncSize();

    const ro = new ResizeObserver(() => syncSize());
    ro.observe(container);
    return () => {
      ro.disconnect();
      // Clean up BiquadFilterNode
      if (filterNodeRef.current) {
        filterNodeRef.current.disconnect();
        filterNodeRef.current = null;
      }
    };
  }, []);

  // Animated loop — only runs when modulation callback is provided
  useAnimationLoop(
    () => {
      const getMod = getModRef.current;
      if (getMod) {
        const mod = getMod();
        render(mod.frequency, mod.q);
      } else {
        render();
      }
    },
    { targetFps: 30, visibilityRef: containerRef, enabled: !!getModulatedValues },
  );

  // Static render — when no modulation, render once on prop changes
  useEffect(() => {
    if (getModulatedValues) return; // animated loop handles it
    render();
  }, [filterType, frequency, q, color, getModulatedValues, filterEnvAmount, filterAttack, filterDecay, ringModEnabled, render]);

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
