import { createPortal } from 'react-dom';
import { useStore } from '../../state/store';
import { useDraggable } from '../../hooks/useDraggable';
import { useFloatResize } from '../../hooks/useFloatResize';

const EDGE_SIZE = 6;

const edgeStyles: Record<string, React.CSSProperties> = {
  n:  { position: 'absolute', top: -EDGE_SIZE / 2, left: EDGE_SIZE, right: EDGE_SIZE, height: EDGE_SIZE, cursor: 'ns-resize' },
  s:  { position: 'absolute', bottom: -EDGE_SIZE / 2, left: EDGE_SIZE, right: EDGE_SIZE, height: EDGE_SIZE, cursor: 'ns-resize' },
  e:  { position: 'absolute', right: -EDGE_SIZE / 2, top: EDGE_SIZE, bottom: EDGE_SIZE, width: EDGE_SIZE, cursor: 'ew-resize' },
  w:  { position: 'absolute', left: -EDGE_SIZE / 2, top: EDGE_SIZE, bottom: EDGE_SIZE, width: EDGE_SIZE, cursor: 'ew-resize' },
  ne: { position: 'absolute', top: -EDGE_SIZE / 2, right: -EDGE_SIZE / 2, width: EDGE_SIZE * 2, height: EDGE_SIZE * 2, cursor: 'nesw-resize' },
  nw: { position: 'absolute', top: -EDGE_SIZE / 2, left: -EDGE_SIZE / 2, width: EDGE_SIZE * 2, height: EDGE_SIZE * 2, cursor: 'nwse-resize' },
  se: { position: 'absolute', bottom: -EDGE_SIZE / 2, right: -EDGE_SIZE / 2, width: EDGE_SIZE * 2, height: EDGE_SIZE * 2, cursor: 'nwse-resize' },
  sw: { position: 'absolute', bottom: -EDGE_SIZE / 2, left: -EDGE_SIZE / 2, width: EDGE_SIZE * 2, height: EDGE_SIZE * 2, cursor: 'nesw-resize' },
};

const EDGES = Object.keys(edgeStyles) as Array<'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'>;

interface FloatingPanelProps {
  title: string;
  color: string;
  headerCenter?: React.ReactNode;
  children: React.ReactNode;
}

export function FloatingPanel({ title, color, headerCenter, children }: FloatingPanelProps) {
  const pos = useStore((s) => s.synthFloatPos);
  const size = useStore((s) => s.synthFloatSize);
  const minimized = useStore((s) => s.synthFloatMinimized);
  const setSynthPanelMode = useStore((s) => s.setSynthPanelMode);
  const setSynthFloatMinimized = useStore((s) => s.setSynthFloatMinimized);
  const { onMouseDown: onDragStart } = useDraggable();
  const { onEdgeMouseDown } = useFloatResize();

  const panel = (
    <div
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: size.w,
        height: minimized ? 36 : size.h,
        zIndex: 30,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 8,
        overflow: 'hidden',
        border: '1px solid rgba(255,255,255,0.06)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)',
        background: '#0e0e14',
      }}
    >
      {/* Title bar — glass gradient */}
      <div
        onMouseDown={onDragStart}
        onDoubleClick={() => setSynthFloatMinimized(!minimized)}
        className="flex items-center px-3 shrink-0 select-none"
        style={{
          height: 36,
          background: 'linear-gradient(180deg, #16161e 0%, #12121a 100%)',
          borderBottom: minimized ? 'none' : '1px solid rgba(255,255,255,0.04)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
          cursor: 'grab',
        }}
      >
        {/* Left: title + mode toggle */}
        <div className="flex items-center gap-2 min-w-0 shrink-0">
          <div className="w-2 h-2 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 6px ${color}60` }} />
          <span
            className="text-[11px] truncate"
            style={{ color, letterSpacing: '0.15em', fontWeight: 500 }}
          >
            {title}
          </span>
          {/* Portal target for OSC/FM mode toggle */}
          <div id="synth-float-header-mode" className="flex items-center gap-0.5 ml-1" />
        </div>

        {/* Center: preset browser slot (also portal target for SynthPanel) */}
        <div id="synth-float-header-center" className="flex-1 flex justify-center items-center min-w-0 mx-4">
          {headerCenter}
        </div>

        {/* Right: extra header buttons + window controls */}
        <div className="flex items-center gap-1 shrink-0 ml-auto">
          {/* Portal target for FX toggle etc. */}
          <div id="synth-float-header-right" className="flex items-center gap-0.5" />
          {/* Minimize */}
          <button
            onClick={(e) => { e.stopPropagation(); setSynthFloatMinimized(!minimized); }}
            className="p-1 hover:bg-white/10 rounded transition-colors"
            title={minimized ? 'Restore' : 'Minimize'}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#8888a0" strokeWidth="1.5">
              {minimized ? (
                <rect x="2" y="2" width="8" height="8" rx="1" strokeLinecap="round" />
              ) : (
                <line x1="2" y1="6" x2="10" y2="6" strokeLinecap="round" />
              )}
            </svg>
          </button>
          {/* Dock (return to inline sidebar) — arrow points bottom-right */}
          <button
            onClick={(e) => { e.stopPropagation(); setSynthPanelMode('inline'); }}
            className="p-1 hover:bg-white/10 rounded transition-colors"
            title="Dock to sidebar"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#8888a0" strokeWidth="1.5">
              <polyline points="5 11 11 11 11 5" strokeLinecap="round" strokeLinejoin="round" />
              <line x1="1" y1="1" x2="11" y2="11" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content */}
      {!minimized && (
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          {children}
        </div>
      )}

      {/* Resize handles */}
      {!minimized && EDGES.map((edge) => (
        <div
          key={edge}
          style={edgeStyles[edge]}
          onMouseDown={(e) => onEdgeMouseDown(edge, e)}
        />
      ))}
    </div>
  );

  return createPortal(panel, document.body);
}
