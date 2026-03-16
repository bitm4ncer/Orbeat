import { useState } from 'react';
import { EffectKnob } from '../EffectsSidebar/EffectKnob';
import type { KnobModulation, KnobContextItem } from '../EffectsSidebar/EffectKnob';
import { EnvelopeDisplay } from './EnvelopeDisplay';

type ModPropsResult = {
  modulations: KnobModulation[];
  contextItems: KnobContextItem[];
  onLfoDrop: (lfoSource: string) => void;
  onModDepthChange: (modIndex: number, newDepth: number) => void;
};

interface EnvelopeSectionProps {
  envIndex: 1 | 2 | 3;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  color: string;
  onChange: (key: 'attack' | 'decay' | 'sustain' | 'release', value: number) => void;
  modProps?: (paramKey: string, label: string) => ModPropsResult;
  readOnly?: boolean;
}

const basePanelCardStyle: React.CSSProperties = {
  borderRadius: 6,
  background: 'rgba(0,0,0,0.25)',
};

const sectionHeaderStyle: React.CSSProperties = {
  borderBottom: '1px solid rgba(255,255,255,0.06)',
};

const displayStyle: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 4,
  overflow: 'hidden',
};

export function EnvelopeSection({ envIndex, attack, decay, sustain, release, color, onChange, modProps, readOnly }: EnvelopeSectionProps) {
  const [expanded, setExpanded] = useState(envIndex === 1);

  return (
    <div style={{ ...basePanelCardStyle, border: `1px solid ${color}80` }} className="mb-1">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-1.5 select-none"
        style={sectionHeaderStyle}
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-medium uppercase" style={{ color: readOnly ? '#8888a0' : color, letterSpacing: '0.12em' }}>
            env {envIndex}
          </span>
          {readOnly && <span className="text-[7px] text-text-secondary/40">(shared)</span>}
        </div>
        <span className="text-[8px]" style={{ color: '#8888a0' }}>{expanded ? '▼' : '▶'}</span>
      </button>

      {/* Always show the curve */}
      <div className="px-3 py-1">
        <div style={displayStyle}>
          <EnvelopeDisplay attack={attack} decay={decay} sustain={sustain} release={release} color={readOnly ? '#8888a0' : color} height={expanded ? 52 : 36} />
        </div>
      </div>

      {/* Knobs (expanded only, interactive only) */}
      {expanded && !readOnly && (
        <div className="px-3 pb-3 pt-1">
          <div className="flex justify-around items-end gap-1">
            <EffectKnob label="Atk" value={attack} min={0} max={2} unit="s" defaultValue={0.001} color={color} size="sm" onChange={(v) => onChange('attack', v)} {...(modProps?.('gainAttack', 'Atk') ?? {})} />
            <EffectKnob label="Dec" value={decay} min={0.001} max={2} unit="s" defaultValue={0.1} color={color} size="sm" onChange={(v) => onChange('decay', v)} {...(modProps?.('gainDecay', 'Dec') ?? {})} />
            <EffectKnob label="Sus" value={sustain} min={0} max={1} defaultValue={0.7} color={color} size="sm" onChange={(v) => onChange('sustain', v)} {...(modProps?.('gainSustain', 'Sus') ?? {})} />
            <EffectKnob label="Rel" value={release} min={0.01} max={3} unit="s" defaultValue={0.15} color={color} size="sm" onChange={(v) => onChange('release', v)} {...(modProps?.('gainRelease', 'Rel') ?? {})} />
          </div>
        </div>
      )}
    </div>
  );
}
