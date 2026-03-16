import { useState, useCallback } from 'react';
import { EffectKnob } from '../EffectsSidebar/EffectKnob';
import type { KnobModulation, KnobContextItem } from '../EffectsSidebar/EffectKnob';
import { FilterCurveDisplay } from '../EffectsSidebar/FilterCurveDisplay';
import type { SynthParams } from '../../audio/synth/types';

type ModPropsResult = {
  modulations: KnobModulation[];
  contextItems: KnobContextItem[];
  onLfoDrop: (lfoSource: string) => void;
  onModDepthChange: (modIndex: number, newDepth: number) => void;
};

const FILTER_TYPES: string[] = ['lowpass', 'highpass', 'bandpass', 'notch', 'ladder', 'comb+', 'comb-'];
const FILTER_LABELS = ['LP', 'HP', 'BP', 'NT', 'LDR', 'CMB+', 'CMB-'];

interface FilterSectionProps {
  params: SynthParams;
  color: string;
  set: <K extends keyof SynthParams>(key: K, value: SynthParams[K]) => void;
  modProps: (key: keyof SynthParams, label: string) => ModPropsResult;
  getModulatedValue?: (target: keyof SynthParams) => number | null;
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

export function FilterSection({ params, color, set, modProps, getModulatedValue }: FilterSectionProps) {
  const [collapsed, setCollapsed] = useState(false);
  const filterTypeIdx = FILTER_TYPES.indexOf(params.filterType);

  const getModulatedFilterValues = useCallback(() => {
    if (!getModulatedValue) return { frequency: null, q: null };
    return {
      frequency: getModulatedValue('filterFreq'),
      q: getModulatedValue('filterQ'),
    };
  }, [getModulatedValue]);

  return (
    <div style={{ ...basePanelCardStyle, border: `1px solid ${color}80` }}>
      {/* Header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-3 py-1.5 select-none"
        style={sectionHeaderStyle}
      >
        <span className="text-[10px] font-medium uppercase" style={{ color, letterSpacing: '0.12em' }}>filter</span>
        <span className="text-[8px]" style={{ color: '#8888a0' }}>{collapsed ? '▶' : '▼'}</span>
      </button>

      {!collapsed && <div className="px-3 pb-3 flex flex-col gap-2 pt-2">
        {/* Filter type buttons */}
        <div className="flex gap-0.5 w-full">
          {FILTER_LABELS.map((label, i) => (
            <button
              key={i}
              onClick={() => set('filterType', FILTER_TYPES[i] as SynthParams['filterType'])}
              className="flex-1 text-[8px] uppercase tracking-wider py-0.5 rounded transition-all"
              style={{
                background: (filterTypeIdx >= 0 ? filterTypeIdx : 0) === i ? `${color}28` : 'transparent',
                border: `1px solid ${(filterTypeIdx >= 0 ? filterTypeIdx : 0) === i ? color : '#2a2a3a'}`,
                color: (filterTypeIdx >= 0 ? filterTypeIdx : 0) === i ? color : '#8888a0',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Filter curve display + Freq/Q knobs */}
        <div className="flex items-center gap-2">
          <EffectKnob label="Freq" value={params.filterFreq} min={20} max={20000} step={10} unit="Hz" defaultValue={8000} color={color} size="md" onChange={(v) => set('filterFreq', v)} {...modProps('filterFreq', 'Freq')} />
          <div style={displayStyle} className="flex-1 min-w-0">
            <FilterCurveDisplay filterType={filterTypeIdx >= 0 ? filterTypeIdx : 0} frequency={params.filterFreq} q={params.filterQ} color={color} getModulatedValues={getModulatedValue ? getModulatedFilterValues : undefined} />
          </div>
          <EffectKnob label="Q" value={params.filterQ} min={0} max={20} defaultValue={0} color={color} size="md" onChange={(v) => set('filterQ', v)} {...modProps('filterQ', 'Q')} />
        </div>

        {/* Filter knobs */}
        <div className="flex justify-around items-end gap-1">
          <EffectKnob label="Env" value={params.filterEnvAmount} min={-12000} max={12000} step={10} unit="¢" defaultValue={0} color={color} size="sm" onChange={(v) => set('filterEnvAmount', v)} {...modProps('filterEnvAmount', 'Env')} />
          <EffectKnob label="Atk" value={params.filterAttack} min={0} max={2} unit="s" defaultValue={0} color={color} size="sm" onChange={(v) => set('filterAttack', v)} />
          <EffectKnob label="Dec" value={params.filterDecay} min={0.001} max={2} unit="s" defaultValue={0.1} color={color} size="sm" onChange={(v) => set('filterDecay', v)} />
        </div>

        {/* Ring Mod */}
        <div className="mt-1 flex items-center gap-2" style={{ borderTop: '1px solid rgba(255,255,255,0.03)', paddingTop: 8 }}>
          <button
            onClick={() => set('ringModEnabled', !params.ringModEnabled)}
            className="text-[8px] uppercase tracking-wider px-2 py-0.5 rounded transition-all"
            style={{
              background: params.ringModEnabled ? `${color}28` : 'transparent',
              border: `1px solid ${params.ringModEnabled ? color : '#2a2a3a'}`,
              color: params.ringModEnabled ? color : '#8888a0',
            }}
          >
            Ring Mod
          </button>
          {params.ringModEnabled && (
            <EffectKnob label="Mix" value={params.ringModMix ?? 0.5} min={0} max={1} defaultValue={0.5} color={color} size="sm" onChange={(v) => set('ringModMix', v)} />
          )}
        </div>
      </div>}
    </div>
  );
}
