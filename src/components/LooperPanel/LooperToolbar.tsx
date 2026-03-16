import { useState, useCallback, useEffect, useRef } from 'react';
import { useStore } from '../../state/store';
import { getCaptureDuration, getInputLevel } from '../../audio/audioInput';

interface LooperToolbarProps {
  instrumentId: string;
  color: string;
}

export function LooperToolbar({ instrumentId, color }: LooperToolbarProps) {
  const editor = useStore((s) => s.looperEditors[instrumentId]);
  const instrument = useStore((s) => s.instruments.find((i) => i.id === instrumentId));
  const setLooperLoop = useStore((s) => s.setLooperLoop);
  const updateLooperParams = useStore((s) => s.updateLooperParams);

  const hasLoop = editor != null && (editor.loopIn > 0 || editor.loopOut < 1);

  const isReversed = instrument?.looperParams?.reverse ?? false;
  const isStretchToSteps = instrument?.looperParams?.stretchToSteps ?? false;
  const isKeepPitch = instrument?.looperParams?.keepPitch ?? false;

  const handleClearLoop = () => {
    setLooperLoop(instrumentId, 0, 1);
  };

  const handleReverse = () => {
    updateLooperParams(instrumentId, { reverse: !isReversed });
  };

  const toggleClass = (active: boolean, dimmed?: boolean) => {
    if (dimmed) {
      return `px-2 py-1 text-[10px] font-medium uppercase tracking-wider rounded transition-colors cursor-pointer ${
        active ? 'opacity-40' : 'text-text-secondary/30'
      }`;
    }
    return `px-2 py-1 text-[10px] font-medium uppercase tracking-wider rounded transition-colors cursor-pointer ${
      active ? 'hover:brightness-125' : 'text-text-primary hover:bg-white/10'
    }`;
  };

  const activeStyle = (active: boolean) => active ? { backgroundColor: `${color}20`, color } : undefined;

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border/50 shrink-0 bg-bg-secondary">
      {/* Reverse toggle */}
      <button
        className={toggleClass(isReversed)}
        style={activeStyle(isReversed)}
        onClick={handleReverse}
        title="Reverse playback"
      >
        Rev
      </button>

      {/* Stretch to Steps toggle */}
      <button
        className={toggleClass(isStretchToSteps)}
        style={activeStyle(isStretchToSteps)}
        onClick={() => updateLooperParams(instrumentId, { stretchToSteps: !isStretchToSteps })}
        title="Time-stretch slices to fill grid slots"
      >
        Stretch
      </button>

      {/* Keep Pitch toggle (only meaningful when Stretch is on) */}
      <button
        className={toggleClass(isKeepPitch, !isStretchToSteps)}
        style={activeStyle(isKeepPitch)}
        onClick={() => updateLooperParams(instrumentId, { keepPitch: !isKeepPitch })}
        title="Preserve pitch when stretching"
      >
        Keep Pitch
      </button>

      <div className="w-px h-4 bg-border/40 mx-1" />

      {/* Loop clear */}
      {hasLoop && (
        <button
          className="px-1.5 py-1 text-[10px] font-medium text-amber-400/70 hover:text-amber-400 hover:bg-amber-500/10 rounded transition-colors cursor-pointer"
          onClick={handleClearLoop}
          title="Clear loop region"
        >
          ×
        </button>
      )}

      <div className="w-px h-4 bg-border/40 mx-1" />

      {/* Record audio input */}
      <RecordInputButton instrumentId={instrumentId} />
    </div>
  );
}

/** Thin 2px horizontal level meter for audio input */
function InputLevelMeter() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const gradientRef = useRef<CanvasGradient | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      const dB = getInputLevel();
      const level = Math.max(0, (dB + 48) / 48);

      // Cache gradient
      if (!gradientRef.current) {
        const g = ctx.createLinearGradient(0, 0, w, 0);
        g.addColorStop(0, '#16a34a');
        g.addColorStop(0.55, '#22c55e');
        g.addColorStop(0.75, '#f59e0b');
        g.addColorStop(0.88, '#f97316');
        g.addColorStop(1, '#ef4444');
        gradientRef.current = g;
      }

      ctx.clearRect(0, 0, w, h);
      const fillW = level * w;
      if (fillW > 0) {
        ctx.fillStyle = gradientRef.current;
        ctx.fillRect(0, 0, fillW, h);
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={80}
      height={2}
      className="block"
      style={{ width: 80, height: 2, borderRadius: 1 }}
    />
  );
}

function RecordInputButton({ instrumentId }: { instrumentId: string }) {
  const isCapturingInput = useStore((s) => s.isCapturingInput);
  const startAudioCapture = useStore((s) => s.startAudioCapture);
  const stopAudioCapture = useStore((s) => s.stopAudioCapture);
  const selectInstrument = useStore((s) => s.selectInstrument);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isCapturingInput) { setElapsed(0); return; }
    const id = setInterval(() => setElapsed(getCaptureDuration()), 200);
    return () => clearInterval(id);
  }, [isCapturingInput]);

  const handleClick = () => {
    if (isCapturingInput) {
      stopAudioCapture();
    } else {
      // Select this looper so stopAudioCapture auto-assigns to it
      selectInstrument(instrumentId);
      startAudioCapture();
    }
  };

  const formatTime = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={handleClick}
        className={`flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium uppercase tracking-wider rounded transition-colors cursor-pointer ${
          isCapturingInput
            ? 'bg-red-500/20 text-red-400 animate-pulse'
            : 'text-text-primary hover:bg-white/10'
        }`}
        title={isCapturingInput ? 'Stop recording input' : 'Record from audio input (uses default mic if no device selected in Settings)'}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
        </svg>
        {isCapturingInput ? 'Stop' : 'Rec'}
      </button>
      {isCapturingInput && (
        <span className="text-[9px] font-mono text-red-400">{formatTime(elapsed)}</span>
      )}
      {isCapturingInput && <InputLevelMeter />}
    </div>
  );
}
