import { useRef, useCallback, useState, useEffect, memo } from 'react';
import { createPortal } from 'react-dom';

const SIZE_MAP = { sm: 38, md: 50, lg: 64 } as const;

// Knob sweep: 270° arc starting at 7 o'clock (-225° from positive X axis)
const START_DEG = -225;
const RANGE_DEG = 270;

function toRad(deg: number) {
  return (deg * Math.PI) / 180;
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const s = toRad(startDeg);
  const e = toRad(endDeg);
  const x1 = cx + r * Math.cos(s);
  const y1 = cy + r * Math.sin(s);
  const x2 = cx + r * Math.cos(e);
  const y2 = cy + r * Math.sin(e);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

function snapToStep(value: number, step: number, min: number, max: number): number {
  const snapped = Math.round((value - min) / step) * step + min;
  return Math.max(min, Math.min(max, parseFloat(snapped.toFixed(10))));
}

function formatValue(v: number, step: number, unit?: string): string {
  const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const s = v.toFixed(decimals);
  return unit ? `${s} ${unit}` : s;
}

export interface KnobModulation {
  color: string;
  depth: number; // -1 to +1
}

/** Context menu item for LFO/MIDI assignment */
export interface KnobContextItem {
  label: string;
  icon?: 'lfo' | 'midi' | 'remove';
  active?: boolean;
  disabled?: boolean;
  color?: string;
  onClick: () => void;
}

interface EffectKnobProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  label: string;
  color: string;
  unit?: string;
  format?: (v: number) => string;
  size?: 'sm' | 'md' | 'lg';
  onChange: (v: number) => void;
  /** Modulation indicators — colored rings showing mod depth per LFO */
  modulations?: KnobModulation[];
  /** Context menu items (LFO assign, MIDI learn, etc.) */
  contextItems?: KnobContextItem[];
  /** Called when an LFO drag handle is dropped onto this knob */
  onLfoDrop?: (lfoSource: string) => void;
  /** Called when mod ring is dragged to adjust depth */
  onModDepthChange?: (modIndex: number, newDepth: number) => void;
}

// ── Context menu rendered via portal ────────────────────────────────────────

function KnobContextMenu({
  x, y, items, onClose,
}: { x: number; y: number; items: KnobContextItem[]; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handle);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handle);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  // Clamp to viewport
  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(x, window.innerWidth - 180),
    top: Math.min(y, window.innerHeight - items.length * 28 - 16),
    zIndex: 9999,
  };

  return createPortal(
    <div
      ref={menuRef}
      style={style}
      className="min-w-[160px] py-1 rounded-md border border-border bg-bg-secondary shadow-xl"
    >
      {items.map((item, i) => (
        <button
          key={i}
          onClick={() => { item.onClick(); onClose(); }}
          disabled={item.disabled}
          className="w-full flex items-center gap-2 px-3 py-1 text-[11px] text-left transition-colors hover:bg-white/5 disabled:opacity-30 disabled:pointer-events-none"
          style={{ color: item.active ? (item.color ?? '#6d8cff') : item.icon === 'remove' ? '#ef4444' : '#c8c8d8' }}
        >
          {item.icon === 'lfo' && (
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 8c2-6 4-6 6 0s4 6 6 0" />
            </svg>
          )}
          {item.icon === 'midi' && (
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="3" width="12" height="10" rx="1" />
              <circle cx="8" cy="8" r="1.5" fill="currentColor" />
            </svg>
          )}
          {item.icon === 'remove' && (
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="4" y1="4" x2="12" y2="12" /><line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          )}
          {!item.icon && <span className="w-[10px]" />}
          <span className="flex-1">{item.label}</span>
          {item.active && <span className="text-[9px] opacity-60">assigned</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}

// ── Main knob component ─────────────────────────────────────────────────────

export const EffectKnob = memo(function EffectKnob({
  value, min, max, step = 0.01, defaultValue, label, color, unit, format,
  size = 'md', onChange, modulations, contextItems, onLfoDrop, onModDepthChange,
}: EffectKnobProps) {
  const px = SIZE_MAP[size];
  const cx = px / 2;
  const cy = px / 2;
  const trackR = px * 0.38;
  const bodyR  = px * 0.30;
  const dotR   = px * 0.05;

  const safeValue = Number.isFinite(value) ? value : (defaultValue ?? min);
  const t = Math.max(0, Math.min(1, (safeValue - min) / (max - min)));
  const valueDeg = START_DEG + t * RANGE_DEG;

  // Indicator dot position
  const indR = px * 0.20;
  const dotX = cx + indR * Math.cos(toRad(valueDeg));
  const dotY = cy + indR * Math.sin(toRad(valueDeg));

  const [dragging, setDragging] = useState(false);
  const [dragOverLfo, setDragOverLfo] = useState(false);
  const [depthDragIdx, setDepthDragIdx] = useState<number | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ startY: number; startVal: number } | null>(null);
  const depthDragRef = useRef<{ startY: number; startDepth: number; idx: number } | null>(null);
  const knobRef = useRef<HTMLDivElement>(null);

  const SENSITIVITY = 180; // px for full range

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Don't start knob drag if a depth drag is in progress
    if (depthDragRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const startVal = Number.isFinite(value) ? value : (defaultValue ?? min);
    dragRef.current = { startY: e.clientY, startVal };
    setDragging(true);
    e.preventDefault();
  }, [value, defaultValue, min]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    // Depth ring drag
    if (depthDragRef.current && onModDepthChange) {
      const sens = e.shiftKey ? SENSITIVITY * 5 : SENSITIVITY;
      const delta = -(e.clientY - depthDragRef.current.startY) / sens * 2; // -1 to +1 range
      const newDepth = Math.max(-1, Math.min(1, depthDragRef.current.startDepth + delta));
      onModDepthChange(depthDragRef.current.idx, Math.round(newDepth * 100) / 100);
      return;
    }
    // Normal knob drag
    if (!dragRef.current) return;
    const sens = e.shiftKey ? SENSITIVITY * 5 : SENSITIVITY;
    const delta = -(e.clientY - dragRef.current.startY) / sens * (max - min);
    const raw = dragRef.current.startVal + delta;
    onChange(snapToStep(raw, step, min, max));
  }, [min, max, step, onChange, onModDepthChange]);

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
    depthDragRef.current = null;
    setDragging(false);
    setDepthDragIdx(null);
  }, []);

  const handleDoubleClick = useCallback(() => {
    onChange(defaultValue ?? min);
  }, [defaultValue, min, onChange]);

  // Native wheel handler registered with { passive: false } to allow preventDefault
  const wheelPropsRef = useRef({ value, defaultValue, min, max, step, onChange });
  wheelPropsRef.current = { value, defaultValue, min, max, step, onChange };

  useEffect(() => {
    const el = knobRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const { value: v, defaultValue: dv, min: mn, max: mx, step: st, onChange: cb } = wheelPropsRef.current;
      const dir = e.deltaY < 0 ? 1 : -1;
      const base = Number.isFinite(v) ? v : (dv ?? mn);
      cb(snapToStep(base + dir * st, st, mn, mx));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!contextItems?.length) return;
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, [contextItems]);

  // Drag-drop handlers for LFO assignment
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!onLfoDrop) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'link';
    setDragOverLfo(true);
  }, [onLfoDrop]);

  const handleDragLeave = useCallback(() => {
    setDragOverLfo(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOverLfo(false);
    if (!onLfoDrop) return;
    const lfoSource = e.dataTransfer.getData('lfo-source');
    if (lfoSource) {
      onLfoDrop(lfoSource);
    }
  }, [onLfoDrop]);

  // Depth ring pointer down — start depth drag on a mod arc
  const handleModRingPointerDown = useCallback((e: React.PointerEvent, modIdx: number, currentDepth: number) => {
    if (!onModDepthChange) return;
    e.preventDefault();
    e.stopPropagation();
    // Capture pointer on the parent container so moves are tracked
    const container = (e.currentTarget as SVGElement).closest('div');
    if (container) container.setPointerCapture(e.pointerId);
    depthDragRef.current = { startY: e.clientY, startDepth: currentDepth, idx: modIdx };
    setDepthDragIdx(modIdx);
  }, [onModDepthChange]);

  const displayVal = format ? format(safeValue) : formatValue(safeValue, step, unit);
  const dimColor = `${color}40`; // 25% opacity for track
  const activeColor = color;

  // Modulation ring arcs
  const modR = trackR + (size === 'lg' ? 4 : size === 'md' ? 3.5 : 3);
  const modStroke = size === 'lg' ? 2.5 : size === 'md' ? 2 : 1.5;
  const modHitStroke = 8; // wider invisible hit area for depth drag

  // Depth drag tooltip
  const depthTooltip = depthDragIdx !== null && modulations?.[depthDragIdx]
    ? `${modulations[depthDragIdx].depth > 0 ? '+' : ''}${(modulations[depthDragIdx].depth * 100).toFixed(0)}%`
    : null;

  return (
    <div
      className="flex flex-col items-center gap-0.5 select-none"
      style={{ width: px }}
    >
      <div
        ref={knobRef}
        style={{
          width: px, height: px,
          cursor: depthDragIdx !== null ? 'ns-resize' : 'ns-resize',
          position: 'relative',
          borderRadius: '50%',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        title={`${label}: ${displayVal}${dragging ? '' : '\nDrag to adjust · Shift = fine · Dbl-click = reset\nRight-click for LFO / MIDI'}`}
      >
        <svg width={px} height={px} style={{ display: 'block' }} overflow="visible">
          <defs>
            <radialGradient id={`kg-${label.replace(/\W+/g, '_')}-body`} cx="40%" cy="35%" r="60%">
              <stop offset="0%" stopColor="#3a3a50" />
              <stop offset="100%" stopColor="#141420" />
            </radialGradient>
          </defs>

          {/* Track background arc (full 270°) */}
          <path
            d={arcPath(cx, cy, trackR, START_DEG, START_DEG + RANGE_DEG)}
            fill="none"
            stroke={dimColor}
            strokeWidth={size === 'lg' ? 3.5 : size === 'md' ? 3 : 2.5}
            strokeLinecap="round"
          />

          {/* Modulation range arcs + invisible hit areas for depth drag */}
          {modulations && modulations.map((mod, i) => {
            const depthDeg = Math.abs(mod.depth) * RANGE_DEG;
            const modStart = mod.depth >= 0
              ? valueDeg
              : Math.max(START_DEG, valueDeg - depthDeg);
            const modEnd = mod.depth >= 0
              ? Math.min(START_DEG + RANGE_DEG, valueDeg + depthDeg)
              : valueDeg;
            if (modEnd - modStart < 0.5) return null;
            const arcD = arcPath(cx, cy, modR, modStart, modEnd);
            const isDraggingThis = depthDragIdx === i;
            return (
              <g key={i}>
                {/* Visible mod arc */}
                <path
                  d={arcD}
                  fill="none"
                  stroke={`${mod.color}${isDraggingThis ? 'cc' : '70'}`}
                  strokeWidth={isDraggingThis ? modStroke + 1 : modStroke}
                  strokeLinecap="round"
                  style={isDraggingThis ? { filter: `drop-shadow(0 0 3px ${mod.color})` } : undefined}
                />
                {/* Invisible wider hit area for depth ring drag */}
                {onModDepthChange && (
                  <path
                    d={arcD}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={modHitStroke}
                    strokeLinecap="round"
                    style={{ cursor: 'ns-resize' }}
                    onPointerDown={(e) => handleModRingPointerDown(e, i, mod.depth)}
                  />
                )}
              </g>
            );
          })}

          {/* Drag-over LFO highlight */}
          {dragOverLfo && (
            <circle
              cx={cx} cy={cy} r={trackR + 2}
              fill="none"
              stroke={color}
              strokeWidth={2}
              opacity={0.6}
              style={{ filter: `drop-shadow(0 0 4px ${color})` }}
            />
          )}

          {/* Active arc */}
          {t > 0.001 && (
            <path
              d={arcPath(cx, cy, trackR, START_DEG, valueDeg)}
              fill="none"
              stroke={activeColor}
              strokeWidth={size === 'lg' ? 3.5 : size === 'md' ? 3 : 2.5}
              strokeLinecap="round"
              style={{ filter: dragging ? `drop-shadow(0 0 3px ${color})` : undefined }}
            />
          )}

          {/* Knob body */}
          <circle
            cx={cx} cy={cy} r={bodyR}
            fill={`url(#kg-${label.replace(/\W+/g, '_')}-body)`}
            stroke="#2a2a3c"
            strokeWidth={1}
          />

          {/* Indicator dot */}
          <circle
            cx={dotX} cy={dotY} r={dotR}
            fill={dragging ? activeColor : '#d0d0e0'}
            style={{ filter: dragging ? `drop-shadow(0 0 2px ${color})` : undefined }}
          />
        </svg>

        {/* Depth drag tooltip */}
        {depthTooltip && (
          <div
            className="absolute text-[8px] font-mono px-1 py-0.5 rounded pointer-events-none"
            style={{
              top: -14, left: '50%', transform: 'translateX(-50%)',
              background: '#1a1a2a', color, border: `1px solid ${color}40`,
              whiteSpace: 'nowrap',
            }}
          >
            {depthTooltip}
          </div>
        )}
      </div>

      {/* Label + mod dots */}
      <div className="flex items-center justify-center gap-0.5 w-full" style={{ maxWidth: px }}>
        <span
          className={`fx-knob-label ${size === 'lg' ? 'fx-knob-label-lg' : ''} truncate`}
        >
          {label}
        </span>
        {modulations && modulations.map((mod, i) => (
          <span
            key={i}
            className="inline-block rounded-full shrink-0"
            style={{ width: 4, height: 4, background: mod.color }}
          />
        ))}
      </div>

      {/* Value */}
      <span
        className={`fx-knob-value ${size === 'lg' ? 'fx-knob-value-lg' : ''} truncate w-full`}
        style={{ color: dragging ? color : '#6060a0', maxWidth: px }}
      >
        {displayVal}
      </span>

      {/* Context menu */}
      {ctxMenu && contextItems && contextItems.length > 0 && (
        <KnobContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={contextItems}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
});
