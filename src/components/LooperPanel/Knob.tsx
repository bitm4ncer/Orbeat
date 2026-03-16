import { useCallback } from 'react';

export function Knob({ label, value, min, max, step = 0.001, decimals = 2, unit = '', color, size = 36, onChange }: {
  label: string; value: number; min: number; max: number;
  step?: number; decimals?: number; unit?: string; color: string; size?: number;
  onChange: (v: number) => void;
}) {
  const norm = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const angleDeg = -135 + norm * 270;
  const angleRad = (angleDeg * Math.PI) / 180;
  const lineX = Math.sin(angleRad) * 0.62;
  const lineY = -Math.cos(angleRad) * 0.62;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startValue = value;
    const range = max - min;
    const onMove = (ev: MouseEvent) => {
      const dy = startY - ev.clientY;
      const delta = (dy / 120) * range;
      const raw = Math.max(min, Math.min(max, startValue + delta));
      const snapped = Math.round(raw / step) * step;
      onChange(parseFloat(snapped.toFixed(decimals)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [value, min, max, step, decimals, onChange]);

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
