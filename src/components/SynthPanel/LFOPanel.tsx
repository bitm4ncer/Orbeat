/**
 * LFOPanel — Each LFO gets its own collapsible card.
 * Number buttons in the header toggle visibility AND enabled state.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { LFOSlotParams, SynthParams, LFOShape, LFOTriggerMode, LFOMode } from '../../audio/synth/types';
import { DEFAULT_LFO_SLOT } from '../../audio/synth/types';
import { SYNC_DIVS, SYNC_DIV_LABELS, LFO_SHAPE_LABELS, sampleLFOShape, syncDivToHz } from '../../audio/synth/modConstants';
import { useModulation } from './ModulationContext';
import type { LFOSourceId } from '../../audio/synth/ModulationEngine';
import { EffectKnob } from '../EffectsSidebar/EffectKnob';
import { useStore } from '../../state/store';
import { useAnimationLoop } from '../../hooks/useAnimationLoop';

// ── Waveform display ────────────────────────────────────────────────────────

const DISPLAY_H = 72;

function LFOWaveDisplay({ shape, rate, color, triggerMode, isPlaying }: {
  shape: LFOShape; rate: number; color: string; triggerMode: LFOTriggerMode; isPlaying: boolean;
}) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const widthRef     = useRef(220);
  const ctxRef       = useRef<CanvasRenderingContext2D | null>(null);
  const propsRef     = useRef({ shape, rate, color, triggerMode, isPlaying });

  useEffect(() => { propsRef.current = { shape, rate, color, triggerMode, isPlaying }; }, [shape, rate, color, triggerMode, isPlaying]);

  // ResizeObserver + cache canvas context
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    ctxRef.current = canvas.getContext('2d');

    const syncSize = () => {
      const W = Math.round(container.clientWidth) || 220;
      if (W === widthRef.current) return;
      widthRef.current = W;
      canvas.width = W;
      canvas.height = DISPLAY_H;
    };
    syncSize();

    const ro = new ResizeObserver(() => syncSize());
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  const drawFrame = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const W = widthRef.current;
    const { shape, rate, color, triggerMode, isPlaying } = propsRef.current;

    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, W, DISPLAY_H);

    const pad = 6;
    const mid = DISPLAY_H / 2;
    const amp = mid - pad;

    ctx.strokeStyle = '#1a1a2a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid); ctx.lineTo(W, mid);
    ctx.moveTo(0, pad); ctx.lineTo(W, pad);
    ctx.moveTo(0, DISPLAY_H - pad); ctx.lineTo(W, DISPLAY_H - pad);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, mid);
    for (let i = 0; i <= W; i++) {
      const t = i / W;
      ctx.lineTo(i, mid - sampleLFOShape(t, shape) * amp);
    }
    ctx.lineTo(W, mid);
    ctx.closePath();
    ctx.fillStyle = `${color}15`;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i <= W; i++) {
      const t = i / W;
      const y = mid - sampleLFOShape(t, shape) * amp;
      i === 0 ? ctx.moveTo(i, y) : ctx.lineTo(i, y);
    }
    ctx.strokeStyle = `${color}88`;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    if (triggerMode === 'envelope') {
      if (!isPlaying) {
        ctx.fillStyle = `${color}60`;
        ctx.font = '7px sans-serif';
        ctx.fillText('ENV', 4, DISPLAY_H - 2);
      } else {
        const now = performance.now() / 1000;
        const rawPhase = (now * rate) % 1.4;
        const phase = Math.min(1, rawPhase);

        ctx.strokeStyle = `${color}40`;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, DISPLAY_H);
        ctx.stroke();
        ctx.setLineDash([]);

        const phaseX = phase * W;
        if (phase < 1) {
          ctx.fillStyle = '#0a0a14cc';
          ctx.fillRect(phaseX, 0, W - phaseX, DISPLAY_H);
        } else {
          ctx.fillStyle = '#0a0a1488';
          ctx.fillRect(0, 0, W, DISPLAY_H);
        }

        const phaseY = mid - sampleLFOShape(phase, shape) * amp;

        ctx.save();
        ctx.filter = 'blur(6px)';
        ctx.strokeStyle = `${color}50`;
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(phaseX, 0);
        ctx.lineTo(phaseX, DISPLAY_H);
        ctx.stroke();
        ctx.restore();

        ctx.strokeStyle = `${color}30`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(phaseX, 0);
        ctx.lineTo(phaseX, DISPLAY_H);
        ctx.stroke();

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(phaseX, phaseY, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(phaseX, phaseY, 1.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = `${color}60`;
        ctx.font = '7px sans-serif';
        ctx.fillText('ENV', 4, DISPLAY_H - 2);
      }
    } else {
      const phase = (performance.now() / 1000 * rate) % 1;
      const phaseX = phase * W;
      const phaseY = mid - sampleLFOShape(phase, shape) * amp;

      ctx.save();
      ctx.filter = 'blur(6px)';
      ctx.strokeStyle = `${color}50`;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(phaseX, 0);
      ctx.lineTo(phaseX, DISPLAY_H);
      ctx.stroke();
      ctx.restore();

      ctx.strokeStyle = `${color}30`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(phaseX, 0);
      ctx.lineTo(phaseX, DISPLAY_H);
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(phaseX, phaseY, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(phaseX, phaseY, 1.5, 0, Math.PI * 2);
      ctx.fill();

      if (triggerMode === 'retrig') {
        ctx.fillStyle = `${color}40`;
        ctx.font = '7px sans-serif';
        ctx.fillText('RETRIG', 4, DISPLAY_H - 2);
      }
    }
  }, []);

  // Animated loop at 24fps — only when playing
  useAnimationLoop(drawFrame, {
    targetFps: 24,
    visibilityRef: containerRef,
    enabled: isPlaying,
  });

  // Static render when stopped or on prop changes while stopped
  useEffect(() => {
    if (isPlaying) return;
    drawFrame();
  }, [shape, rate, color, triggerMode, isPlaying, drawFrame]);

  return (
    <div ref={containerRef} className="w-full rounded overflow-hidden" style={{ height: DISPLAY_H }}>
      <canvas ref={canvasRef} height={DISPLAY_H} className="block" />
    </div>
  );
}

// ── Button helpers ──────────────────────────────────────────────────────────

const STANDARD_SHAPES: LFOShape[] = ['sine', 'triangle', 'square', 'sawtooth'];
const CUSTOM_SHAPES: LFOShape[] = ['expDecay', 'expRise', 'punch', 'halfSine', 'staircase'];
const TRIGGER_MODES = ['free', 'retrig', 'envelope'] as const;
const TRIGGER_LABELS = ['FREE', 'RETRIG', 'ENV'];

function SmallButtons<T extends string>({
  labels, values, active, color, onChange,
}: { labels: string[]; values: T[]; active: T; color: string; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-0.5 w-full">
      {labels.map((label, i) => {
        const isActive = values[i] === active;
        return (
          <button
            key={i}
            onClick={() => onChange(values[i])}
            className="flex-1 text-[7px] uppercase tracking-wider py-0.5 rounded transition-all"
            style={{
              background: isActive ? `${color}28` : 'transparent',
              border: `1px solid ${isActive ? color : '#2a2a3a'}`,
              color: isActive ? color : '#8888a0',
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ── Step Sequencer display ──────────────────────────────────────────────────

const NUM_STEPS = 16;

function StepSequencerDisplay({ steps, color, onChange }: {
  steps: number[]; color: string;
  onChange: (newSteps: number[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const setStep = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const stepIdx = Math.floor((x / rect.width) * NUM_STEPS);
    if (stepIdx < 0 || stepIdx >= NUM_STEPS) return;
    const val = Math.max(-1, Math.min(1, 1 - (y / rect.height) * 2));
    const rounded = Math.round(val * 20) / 20;
    const newSteps = [...steps];
    newSteps[stepIdx] = rounded;
    onChange(newSteps);
  }, [steps, onChange]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    draggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setStep(e.clientX, e.clientY);
  }, [setStep]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    setStep(e.clientX, e.clientY);
  }, [setStep]);

  const handlePointerUp = useCallback(() => {
    draggingRef.current = false;
  }, []);

  return (
    <div
      ref={containerRef}
      className="w-full rounded overflow-hidden cursor-crosshair select-none"
      style={{ height: DISPLAY_H, background: '#0a0a14' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onContextMenu={(e) => {
        e.preventDefault();
        const el = containerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const stepIdx = Math.floor(((e.clientX - rect.left) / rect.width) * NUM_STEPS);
        if (stepIdx >= 0 && stepIdx < NUM_STEPS) {
          const newSteps = [...steps];
          newSteps[stepIdx] = 0;
          onChange(newSteps);
        }
      }}
    >
      <svg width="100%" height={DISPLAY_H} viewBox={`0 0 ${NUM_STEPS * 10} ${DISPLAY_H}`} preserveAspectRatio="none">
        <line x1="0" y1={DISPLAY_H / 2} x2={NUM_STEPS * 10} y2={DISPLAY_H / 2} stroke="#1a1a2a" strokeWidth="0.5" />
        {steps.map((val, i) => {
          const barW = 10;
          const x = i * barW;
          const mid = DISPLAY_H / 2;
          const barH = Math.abs(val) * (DISPLAY_H / 2 - 4);
          const y = val >= 0 ? mid - barH : mid;
          return (
            <rect
              key={i}
              x={x + 0.5}
              y={y}
              width={barW - 1}
              height={Math.max(barH, 0.5)}
              fill={`${color}60`}
              stroke={color}
              strokeWidth="0.3"
              rx="0.5"
            />
          );
        })}
      </svg>
    </div>
  );
}

// ── Single LFO Card ─────────────────────────────────────────────────────────

function LFOCard({ idx, lfo, color, assignments, bpm, compact, isPlaying, onUpdate }: {
  idx: number;
  lfo: LFOSlotParams;
  color: string;
  assignments: { id: string; source: string; target: string; depth: number }[];
  bpm: number;
  compact?: boolean;
  isPlaying: boolean;
  onUpdate: (patch: Partial<LFOSlotParams>) => void;
}) {
  const [collapsed, setCollapsed] = useState(idx > 0);
  const { startDrag, endDrag, removeMod, updateModDepth } = useModulation();
  const sourceId = `lfo${idx + 1}` as LFOSourceId;
  const enabled = lfo.enabled !== false;
  const displayRate = lfo.tempoSync ? syncDivToHz(lfo.syncDiv, bpm) : lfo.rate;
  const myAssignments = assignments.filter((a) => a.source === sourceId);

  return (
    <div style={{ border: `1px solid rgba(255,255,255,0.06)`, borderRadius: 4 }}>
      {/* Header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-3 py-1 select-none"
        style={{ borderBottom: collapsed ? 'none' : '1px solid rgba(255,255,255,0.06)' }}
      >
        <div className="flex items-center gap-2">
          <span
            onClick={(e) => { e.stopPropagation(); onUpdate({ enabled: !enabled }); }}
            className="w-[6px] h-[6px] rounded-full shrink-0 transition-all cursor-pointer"
            style={{
              background: enabled ? color : '#3a3a4a',
              boxShadow: enabled ? `0 0 4px ${color}80` : 'none',
            }}
            title={enabled ? `Disable LFO ${idx + 1}` : `Enable LFO ${idx + 1}`}
          />
          <span className="text-[9px] font-medium uppercase" style={{ color: enabled ? color : '#8888a0', letterSpacing: '0.1em' }}>
            lfo {idx + 1}
          </span>
          {myAssignments.length > 0 && (
            <span className="text-[7px]" style={{ color: `${color}60` }}>{myAssignments.length} mod{myAssignments.length > 1 ? 's' : ''}</span>
          )}
        </div>
        <span className="text-[8px]" style={{ color: '#8888a0' }}>{collapsed ? '▶' : '▼'}</span>
      </button>

      {!collapsed && (
        <div className={`${compact ? 'px-2 pb-2' : 'px-3 pb-3'} flex flex-col gap-2 pt-2`}>
          {/* Mode toggle: LFO / StepSeq */}
          <div className="flex gap-0.5 w-full">
            {(['lfo', 'stepseq'] as LFOMode[]).map((m) => (
              <button
                key={m}
                onClick={() => onUpdate({ mode: m })}
                className="flex-1 text-[7px] uppercase tracking-wider py-0.5 rounded transition-all"
                style={{
                  background: (lfo.mode ?? 'lfo') === m ? `${color}28` : 'transparent',
                  border: `1px solid ${(lfo.mode ?? 'lfo') === m ? color : '#2a2a3a'}`,
                  color: (lfo.mode ?? 'lfo') === m ? color : '#8888a0',
                }}
              >
                {m === 'lfo' ? 'LFO' : 'STEP SEQ'}
              </button>
            ))}
          </div>

          {/* Waveform display / Step editor + drag handle */}
          <div className="relative">
            {(lfo.mode ?? 'lfo') === 'stepseq' ? (
              <StepSequencerDisplay
                steps={lfo.steps ?? Array(NUM_STEPS).fill(0)}
                color={color}
                onChange={(newSteps) => onUpdate({ steps: newSteps })}
              />
            ) : (
              <LFOWaveDisplay shape={lfo.shape} rate={displayRate} color={color} triggerMode={lfo.triggerMode} isPlaying={isPlaying} />
            )}
            {/* Drag handle */}
            <div
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('lfo-source', sourceId);
                e.dataTransfer.effectAllowed = 'link';
                startDrag(sourceId);
              }}
              onDragEnd={() => endDrag()}
              className="absolute top-1 right-1 w-5 h-5 rounded-full cursor-grab active:cursor-grabbing flex items-center justify-center"
              style={{
                background: `${color}60`,
                border: `2px solid ${color}`,
              }}
              title="Drag onto any knob to modulate"
            >
              <span className="text-[7px] font-bold" style={{ color }}>{idx + 1}</span>
            </div>
          </div>

          {/* Shape selector — only in LFO mode */}
          {(lfo.mode ?? 'lfo') === 'lfo' && (
            <>
              <SmallButtons
                labels={STANDARD_SHAPES.map(s => LFO_SHAPE_LABELS[s])}
                values={STANDARD_SHAPES as unknown as string[]}
                active={lfo.shape}
                color={color}
                onChange={(v) => onUpdate({ shape: v as LFOShape })}
              />
              <SmallButtons
                labels={CUSTOM_SHAPES.map(s => LFO_SHAPE_LABELS[s])}
                values={CUSTOM_SHAPES as unknown as string[]}
                active={lfo.shape}
                color={color}
                onChange={(v) => onUpdate({ shape: v as LFOShape })}
              />
            </>
          )}

          {/* Trigger mode */}
          <SmallButtons
            labels={TRIGGER_LABELS}
            values={TRIGGER_MODES as unknown as ('free' | 'retrig' | 'envelope')[]}
            active={lfo.triggerMode}
            color={color}
            onChange={(v) => onUpdate({ triggerMode: v as LFOSlotParams['triggerMode'] })}
          />

          {/* Rate + Tempo Sync */}
          <div className="flex items-end gap-1">
            {!lfo.tempoSync && (
              <EffectKnob
                value={lfo.rate}
                min={0.05} max={20} step={0.05} defaultValue={1}
                label="Rate" color={color} unit="Hz" size="sm"
                onChange={(v) => onUpdate({ rate: v })}
              />
            )}
            <div className="flex flex-col gap-0.5">
              <button
                onClick={() => onUpdate({ tempoSync: !lfo.tempoSync })}
                className="text-[7px] uppercase tracking-wider px-2 py-0.5 rounded transition-all"
                style={{
                  background: lfo.tempoSync ? `${color}28` : 'transparent',
                  border: `1px solid ${lfo.tempoSync ? color : '#2a2a3a'}`,
                  color: lfo.tempoSync ? color : '#8888a0',
                }}
              >
                Sync
              </button>
              {lfo.tempoSync && (
                <select
                  value={lfo.syncDiv}
                  onChange={(e) => onUpdate({ syncDiv: e.target.value })}
                  className="text-[7px] py-0.5 px-1 rounded border bg-transparent outline-none"
                  style={{ borderColor: `${color}40`, color }}
                >
                  {SYNC_DIVS.map((d) => (
                    <option key={d} value={d} style={{ background: '#0e0e18', color: '#ccc' }}>{SYNC_DIV_LABELS[d] ?? d}</option>
                  ))}
                </select>
              )}
            </div>
            {lfo.tempoSync && (
              <span className="text-[8px] self-center" style={{ color: `${color}80` }}>
                {displayRate.toFixed(2)} Hz
              </span>
            )}
          </div>

          {/* Smooth, Delay, Phase */}
          <div className="flex justify-around items-end gap-1">
            <EffectKnob
              value={lfo.smooth} min={0} max={1} step={0.01} defaultValue={0}
              label="Smooth" color={color} size="sm"
              onChange={(v) => onUpdate({ smooth: v })}
            />
            <EffectKnob
              value={lfo.delay} min={0} max={2} step={0.01} defaultValue={0}
              label="Delay" color={color} unit="s" size="sm"
              onChange={(v) => onUpdate({ delay: v })}
            />
            <EffectKnob
              value={lfo.phase} min={0} max={1} step={0.01} defaultValue={0}
              label="Phase" color={color} size="sm"
              onChange={(v) => onUpdate({ phase: v })}
            />
          </div>

          {/* Active assignments for this LFO */}
          {myAssignments.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <span className="text-[7px] text-text-secondary/50 uppercase tracking-wider">Assignments</span>
              {myAssignments.map((a) => (
                <div key={a.id} className="flex items-center gap-1 text-[8px]">
                  <span style={{ color }} className="truncate flex-1">{a.target}</span>
                  <input
                    type="range"
                    min={-1} max={1} step={0.01}
                    value={a.depth}
                    onChange={(e) => updateModDepth(a.id, parseFloat(e.target.value))}
                    className="w-16 h-1 appearance-none rounded cursor-pointer"
                    style={{ accentColor: color }}
                  />
                  <span className="text-text-secondary/60 w-8 text-right">{a.depth > 0 ? '+' : ''}{(a.depth * 100).toFixed(0)}%</span>
                  <button
                    onClick={() => removeMod(a.id)}
                    className="text-[7px] text-text-secondary/40 hover:text-red-400 transition-colors px-0.5"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

interface Props {
  lfos: [LFOSlotParams, LFOSlotParams, LFOSlotParams, LFOSlotParams];
  onLFOChange: (idx: number, params: LFOSlotParams) => void;
  assignments: { id: string; source: string; target: string; depth: number }[];
  instrumentColor: string;
  bpm: number;
  compact?: boolean;
  noBorder?: boolean;
}

export function LFOPanel({ lfos, onLFOChange, assignments, instrumentColor, bpm, compact, noBorder }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const isPlaying = useStore((s) => s.isPlaying);
  const color = instrumentColor;

  return (
    <div style={noBorder ? {} : { border: `1px solid ${color}80`, borderRadius: 6, background: 'rgba(0,0,0,0.15)' }}>
      {/* Header with LFO title + number toggles aligned right */}
      <div className="flex items-center px-3 py-1" style={{ borderBottom: collapsed ? 'none' : '1px solid rgba(255,255,255,0.06)' }}>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="text-[9px] uppercase tracking-wider font-medium select-none"
          style={{ color }}
        >
          LFO
        </button>
        <div className="ml-auto flex items-center gap-0.5">
          {[0, 1, 2, 3].map((i) => {
            const enabled = lfos[i]?.enabled !== false;
            return (
              <button
                key={i}
                onClick={() => onLFOChange(i, { ...(lfos[i] ?? DEFAULT_LFO_SLOT), enabled: !enabled })}
                className="text-[8px] px-2 py-0.5 rounded transition-all"
                style={{
                  background: enabled ? `${color}28` : `${color}10`,
                  border: `1px solid ${enabled ? color : `${color}50`}`,
                  color: enabled ? color : `${color}80`,
                }}
                title={enabled ? `Disable LFO ${i + 1}` : `Enable LFO ${i + 1}`}
              >
                {i + 1}
              </button>
            );
          })}
          <span className="text-[8px] px-1 cursor-pointer select-none ml-1" style={{ color: '#8888a0' }} onClick={() => setCollapsed(!collapsed)}>{collapsed ? '▶' : '▼'}</span>
        </div>
      </div>

      {!collapsed && (
        <div className={`${compact ? 'p-2' : 'p-3'} flex flex-col gap-1`}>
          {[0, 1, 2, 3].map((i) => (
            <LFOCard
              key={i}
              idx={i}
              lfo={lfos[i] ?? DEFAULT_LFO_SLOT}
              color={color}
              assignments={assignments}
              bpm={bpm}
              compact={compact}
              isPlaying={isPlaying}
              onUpdate={(patch) => onLFOChange(i, { ...(lfos[i] ?? DEFAULT_LFO_SLOT), ...patch })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
