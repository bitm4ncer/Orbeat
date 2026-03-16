import { useCallback } from 'react';

export function Knob({ label, value, min, max, step = 0.001, decimals = 2, unit = '', color, size = 36, log = false, onChange }: {
  label: string; value: number; min: number; max: number;
  step?: number; decimals?: number; unit?: string; color: string; size?: number;
  log?: boolean; // logarithmic scale (for frequency knobs)
  onChange: (v: number) => void;
}) {
  // For log scale: map value to 0-1 using log, then back
  const toNorm = log
    ? (v: number) => Math.log(v / min) / Math.log(max / min)
    : (v: number) => (v - min) / (max - min);
  const fromNorm = log
    ? (n: number) => min * Math.pow(max / min, n)
    : (n: number) => min + n * (max - min);

  const norm = Math.max(0, Math.min(1, toNorm(value)));
  const angleDeg = -135 + norm * 270;
  const angleRad = (angleDeg * Math.PI) / 180;
  const lineX = Math.sin(angleRad) * 0.62;
  const lineY = -Math.cos(angleRad) * 0.62;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startNorm = toNorm(value);
    const onMove = (ev: MouseEvent) => {
      const dy = startY - ev.clientY;
      const deltaNorm = dy / 120; // normalized 0-1 change
      const newNorm = Math.max(0, Math.min(1, startNorm + deltaNorm));
      const raw = fromNorm(newNorm);
      const clamped = Math.max(min, Math.min(max, raw));
      const snapped = Math.round(clamped / step) * step;
      onChange(parseFloat(snapped.toFixed(decimals)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [value, min, max, step, decimals, onChange, toNorm, fromNorm]);

  return (
    <div className="flex flex-col items-center gap-0.5 select-none">
      <span className="text-[8px] text-text-secondary uppercase tracking-wider">{label}</span>
      <svg width={size} height={size} viewBox="-1 -1 2 2" onMouseDown={handleMouseDown}
        style={{ display: 'block', cursor: 'ns-resize' }}>
        <circle cx="0" cy="0" r="0.80" fill="none" stroke={color} strokeWidth="0.10" opacity="0.6" />
        <line x1="0" y1="0" x2={lineX} y2={lineY} stroke={color} strokeWidth="0.14" strokeLinecap="round" />
      </svg>
      <span className="text-[8px] text-text-secondary font-mono">
        {value.toFixed(decimals)}{unit}
      </span>
    </div>
  );
}
