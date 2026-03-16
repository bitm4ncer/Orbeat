import { useState } from 'react';
import { EffectKnob } from '../EffectsSidebar/EffectKnob';
import { EnvelopeDisplay } from './EnvelopeDisplay';
import type { SynthParams, FMParams, FMOperatorParams } from '../../audio/synth/types';
import { FM_ALGORITHMS } from '../../audio/synth/fmAlgorithms';
import type { FMAlgorithm } from '../../audio/synth/fmAlgorithms';

// ── Styles ─────────────────────────────────────────────────────────────────

const basePanelCardStyle: React.CSSProperties = {
  borderRadius: 6,
  background: 'rgba(0,0,0,0.25)',
};

const sectionHeaderStyle: React.CSSProperties = {
  background: 'linear-gradient(180deg, rgba(255,255,255,0.03), transparent)',
  borderBottom: '1px solid rgba(255,255,255,0.03)',
};

const envDisplayStyle: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,0.04)',
  borderRadius: 4,
  boxShadow: 'inset 0 0 12px rgba(0,0,0,0.4)',
  background: 'linear-gradient(180deg, rgba(0,0,0,0.2), transparent)',
  overflow: 'hidden',
};

// ── Algorithm Diagram ──────────────────────────────────────────────────────

function AlgorithmDiagram({ algo, color }: { algo: FMAlgorithm; color: string }) {
  const w = 120;
  const h = 56;
  const opW = 20;
  const opH = 14;
  // Position operators in a 2×2 grid: top row = modulators, bottom = carriers
  // Adaptive layout based on algorithm
  const positions: { x: number; y: number }[] = [];
  const outputs = algo.outputs;

  // Simple layout: carriers at bottom, modulators at top
  const carriers = outputs.map((o, i) => o ? i : -1).filter(i => i >= 0);
  const modulators = outputs.map((o, i) => !o ? i : -1).filter(i => i >= 0);

  // Spread carriers along bottom
  carriers.forEach((idx, i) => {
    positions[idx] = {
      x: (w / (carriers.length + 1)) * (i + 1) - opW / 2,
      y: h - opH - 2,
    };
  });

  // Spread modulators along top
  modulators.forEach((idx, i) => {
    positions[idx] = {
      x: (w / (modulators.length + 1)) * (i + 1) - opW / 2,
      y: 2,
    };
  });

  // Fill any missing (shouldn't happen but safety)
  for (let i = 0; i < 4; i++) {
    if (!positions[i]) positions[i] = { x: 10 + i * 28, y: 20 };
  }

  return (
    <svg width={w} height={h} className="block">
      {/* Connection arrows */}
      {algo.connections.map((row, mod) =>
        row.map((connected, car) => {
          if (!connected) return null;
          const from = positions[mod];
          const to = positions[car];
          const x1 = from.x + opW / 2;
          const y1 = from.y + opH;
          const x2 = to.x + opW / 2;
          const y2 = to.y;
          return (
            <line
              key={`${mod}-${car}`}
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={`${color}60`} strokeWidth={1.5}
              markerEnd="none"
            />
          );
        }),
      )}
      {/* Operator boxes */}
      {positions.map((pos, i) => (
        <g key={i}>
          <rect
            x={pos.x} y={pos.y} width={opW} height={opH} rx={2}
            fill={outputs[i] ? `${color}30` : 'rgba(255,255,255,0.05)'}
            stroke={outputs[i] ? color : '#8888a040'}
            strokeWidth={1}
          />
          <text
            x={pos.x + opW / 2} y={pos.y + opH / 2 + 1}
            textAnchor="middle" dominantBaseline="middle"
            fill={outputs[i] ? color : '#8888a0'}
            fontSize={8} fontWeight={600}
          >
            {i + 1}
          </text>
        </g>
      ))}
      {/* Output arrows for carriers */}
      {carriers.map(idx => {
        const pos = positions[idx];
        const cx = pos.x + opW / 2;
        const cy = pos.y + opH;
        return (
          <line
            key={`out-${idx}`}
            x1={cx} y1={cy} x2={cx} y2={cy + 4}
            stroke={color} strokeWidth={1.5}
          />
        );
      })}
    </svg>
  );
}

// ── Operator Card ──────────────────────────────────────────────────────────

const WAVE_LABELS = ['SIN', 'TRI', 'SQR', 'SAW'];
const WAVE_TYPES = ['sine', 'triangle', 'square', 'sawtooth'] as const;

function OperatorCard({
  opIndex, params, isCarrier, color, onChange,
}: {
  opIndex: number;
  params: FMOperatorParams;
  isCarrier: boolean;
  color: string;
  onChange: (patch: Partial<FMOperatorParams>) => void;
}) {
  const [collapsed, setCollapsed] = useState(opIndex > 1); // collapse ops 3-4 by default

  const waveIdx = WAVE_TYPES.indexOf(params.waveform);

  return (
    <div style={{ ...basePanelCardStyle, border: `1px solid ${color}80` }} className="mb-1">
      {/* Header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-3 py-1.5 select-none"
        style={sectionHeaderStyle}
      >
        <div className="flex items-center gap-2">
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: color, opacity: params.level > 0 ? 1 : 0.3 }}
          />
          <span
            className="text-[10px] font-medium uppercase"
            style={{ color, letterSpacing: '0.12em' }}
          >
            op {opIndex + 1}
          </span>
          <span className="text-[8px]" style={{ color: isCarrier ? `${color}90` : '#8888a0' }}>
            {isCarrier ? 'carrier' : 'mod'}
          </span>
        </div>
        <span className="text-[8px]" style={{ color: '#8888a0' }}>
          {collapsed ? '▶' : '▼'}
        </span>
      </button>

      {!collapsed && (
        <div className="px-3 pb-3 flex flex-col gap-2 pt-2">
          {/* Waveform selector */}
          <div className="flex gap-0.5 w-full">
            {WAVE_LABELS.map((label, i) => (
              <button
                key={i}
                onClick={() => onChange({ waveform: WAVE_TYPES[i] })}
                className="flex-1 text-[8px] uppercase tracking-wider py-0.5 rounded transition-all"
                style={{
                  background: waveIdx === i ? `${color}28` : 'transparent',
                  border: `1px solid ${waveIdx === i ? color : '#2a2a3a'}`,
                  color: waveIdx === i ? color : '#8888a0',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Ratio: coarse stepper + fine knob */}
          <div>
            <span className="text-[8px] text-text-secondary/60 uppercase tracking-wider">Ratio</span>
            <div className="flex gap-0.5 mt-1">
              {[1, 2, 3, 4, 5, 6, 7, 8].map(n => (
                <button
                  key={n}
                  onClick={() => onChange({ ratioCoarse: n })}
                  className="flex-1 text-[8px] py-0.5 rounded transition-all"
                  style={{
                    background: params.ratioCoarse === n ? `${color}28` : 'transparent',
                    border: `1px solid ${params.ratioCoarse === n ? color : '#2a2a3a'}`,
                    color: params.ratioCoarse === n ? color : '#8888a0',
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          {/* Knobs: Fine, Level/Index, Feedback */}
          <div className="flex justify-around items-end gap-1">
            <EffectKnob
              label="Fine" value={params.ratioFine} min={-0.99} max={0.99} step={0.01}
              defaultValue={0} color={color} size="sm"
              onChange={v => onChange({ ratioFine: v })}
            />
            <EffectKnob
              label={isCarrier ? 'Level' : 'Index'} value={params.level} min={0} max={1}
              defaultValue={isCarrier ? 1 : 0.5} color={color} size="md"
              onChange={v => onChange({ level: v })}
            />
            <EffectKnob
              label="FB" value={params.feedback} min={0} max={1}
              defaultValue={0} color={color} size="sm"
              onChange={v => onChange({ feedback: v })}
            />
          </div>

          {/* Envelope display + ADSR knobs */}
          <div style={envDisplayStyle}>
            <EnvelopeDisplay
              attack={params.envAttack} decay={params.envDecay}
              sustain={params.envSustain} release={params.envRelease}
              color={color} height={36}
            />
          </div>
          <div className="flex justify-around items-end gap-1">
            <EffectKnob label="Atk" value={params.envAttack} min={0} max={4} step={0.01} unit="s" defaultValue={0.001} color={color} size="sm" onChange={v => onChange({ envAttack: v })} />
            <EffectKnob label="Dec" value={params.envDecay} min={0.001} max={4} step={0.01} unit="s" defaultValue={0.1} color={color} size="sm" onChange={v => onChange({ envDecay: v })} />
            <EffectKnob label="Sus" value={params.envSustain} min={0} max={1} defaultValue={1} color={color} size="sm" onChange={v => onChange({ envSustain: v })} />
            <EffectKnob label="Rel" value={params.envRelease} min={0.01} max={4} step={0.01} unit="s" defaultValue={0.15} color={color} size="sm" onChange={v => onChange({ envRelease: v })} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main FMSection ─────────────────────────────────────────────────────────

interface FMSectionProps {
  params: SynthParams;
  color: string;
  set: <K extends keyof SynthParams>(key: K, value: SynthParams[K]) => void;
}

export function FMSection({ params, color, set }: FMSectionProps) {
  const fm = params.fm;
  const algo = FM_ALGORITHMS[fm.algorithm] ?? FM_ALGORITHMS[0];

  const setFM = (patch: Partial<FMParams>) => {
    set('fm', { ...fm, ...patch });
  };

  const setOp = (opIdx: number, patch: Partial<FMOperatorParams>) => {
    const newOps = [...fm.operators] as FMParams['operators'];
    newOps[opIdx] = { ...newOps[opIdx], ...patch };
    set('fm', { ...fm, operators: newOps });
  };

  return (
    <div className="flex flex-col gap-1">
      {/* Algorithm selector */}
      <div style={{ ...basePanelCardStyle, border: `1px solid ${color}80` }}>
        <div className="px-3 py-1.5" style={sectionHeaderStyle}>
          <span className="text-[10px] font-medium uppercase" style={{ color, letterSpacing: '0.12em' }}>
            algorithm
          </span>
        </div>
        <div className="px-3 pb-3 pt-2 flex flex-col gap-2">
          {/* Algorithm buttons */}
          <div className="flex gap-0.5 w-full">
            {FM_ALGORITHMS.map((a, i) => (
              <button
                key={i}
                onClick={() => setFM({ algorithm: i })}
                className="flex-1 text-[8px] uppercase tracking-wider py-0.5 rounded transition-all"
                style={{
                  background: fm.algorithm === i ? `${color}28` : 'transparent',
                  border: `1px solid ${fm.algorithm === i ? color : '#2a2a3a'}`,
                  color: fm.algorithm === i ? color : '#8888a0',
                }}
                title={a.name}
              >
                {i + 1}
              </button>
            ))}
          </div>
          {/* Algorithm diagram + name */}
          <div className="flex items-center gap-2">
            <AlgorithmDiagram algo={algo} color={color} />
            <span className="text-[9px] text-text-secondary/60">{algo.name}</span>
          </div>
          {/* Master FM level */}
          <div className="flex justify-center">
            <EffectKnob
              label="FM Level" value={fm.masterLevel} min={0} max={1}
              defaultValue={0.75} color={color} size="md"
              onChange={v => setFM({ masterLevel: v })}
            />
          </div>
        </div>
      </div>

      {/* Operator cards */}
      {([0, 1, 2, 3] as const).map(i => (
        <OperatorCard
          key={i}
          opIndex={i}
          params={fm.operators[i]}
          isCarrier={algo.outputs[i]}
          color={color}
          onChange={patch => setOp(i, patch)}
        />
      ))}
    </div>
  );
}
