import { useState, useMemo, useReducer, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../state/store';
import { getSynthEngine } from '../../audio/synthManager';
import type { SynthParams } from '../../audio/synth/types';
import { DEFAULT_LFO_SLOT } from '../../audio/synth/types';
import { ALL_WAVE_SHAPES, ALL_WAVE_LABELS } from '../../audio/synth/wavetables';
import { DISTORTION_TYPE_LABELS } from '../../audio/synth/nodes/Distortion';
import { WAVETABLE_BANKS } from '../../audio/synth/wavetableBanks';
import { WARP_MODE_NAMES } from '../../audio/synth/wavetableEngine';
import { EffectKnob } from '../EffectsSidebar/EffectKnob';
import type { KnobModulation, KnobContextItem } from '../EffectsSidebar/EffectKnob';
import { FilterCurveDisplay } from '../EffectsSidebar/FilterCurveDisplay';
import { EnvelopeDisplay } from './EnvelopeDisplay';
import { OscDisplay } from './OscDisplay';
import { StringDisplay } from './StringDisplay';
import { WavetableDisplay3D } from './WavetableDisplay3D';
import { SynthVisualizer } from './SynthVisualizer';
import { PresetBrowser } from './PresetBrowser';
import { LFOPanel } from './LFOPanel';
import { ModulationProvider } from './ModulationContext';
import { OscillatorSection } from './OscillatorSection';
import { EnvelopeSection } from './EnvelopeSection';
import { FilterSection } from './FilterSection';
import { FXSection } from './FXSection';
import { FMSection } from './FMSection';
import { usePresetStore } from '../../state/presetStore';
import { useMidiLearn } from '../../hooks/useMidiLearn';

// ─── Shared sub-components ───────────────────────────────────────────────────

function SynthKnob({
  label, value, min, max, step = 0.01, unit, color, defaultValue, onChange,
  size = 'sm', modulations, contextItems, onLfoDrop, onModDepthChange,
}: {
  label: string; value: number; min: number; max: number; step?: number;
  unit?: string; color: string; defaultValue: number;
  onChange: (v: number) => void; size?: 'sm' | 'md' | 'lg';
  modulations?: KnobModulation[]; contextItems?: KnobContextItem[];
  onLfoDrop?: (lfoSource: string) => void;
  onModDepthChange?: (modIndex: number, newDepth: number) => void;
}) {
  return (
    <EffectKnob
      value={value} min={min} max={max} step={step}
      defaultValue={defaultValue} label={label} color={color}
      unit={unit} size={size} onChange={onChange}
      modulations={modulations} contextItems={contextItems}
      onLfoDrop={onLfoDrop} onModDepthChange={onModDepthChange}
    />
  );
}

/** Segmented button row (waveform, filter type, etc.) */
function TypeButtons({
  labels, value, color, onChange,
}: { labels: string[]; value: number; color: string; onChange: (i: number) => void }) {
  return (
    <div className="flex gap-0.5 w-full">
      {labels.map((label, i) => (
        <button
          key={i}
          onClick={() => onChange(i)}
          className="flex-1 text-[8px] uppercase tracking-wider py-0.5 rounded transition-all"
          style={{
            background: value === i ? `${color}28` : 'transparent',
            border: `1px solid ${value === i ? color : '#2a2a3a'}`,
            color: value === i ? color : '#8888a0',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Collapsible section with colored header. */
function Section({
  label, color, defaultOpen = false, children,
}: { label: string; color: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderBottom: `1px solid ${color}20` }}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-1.5 text-[9px] uppercase tracking-wider font-medium hover:opacity-80 transition-colors"
        style={{ color }}
      >
        {label}
        <span className="text-text-secondary/40 text-[8px]">{open ? '▼' : '▶'}</span>
      </button>
      {open && <div className="px-4 pb-3 flex flex-col gap-2">{children}</div>}
    </div>
  );
}

/** Evenly spaced knob row */
function KnobRow({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-around items-end gap-1">{children}</div>;
}

// Waveform type → index helpers
const WAVE_TYPES: OscillatorType[] = ['sine', 'triangle', 'square', 'sawtooth'];
const WAVE_LABELS = ['SIN', 'TRI', 'SQR', 'SAW'];
const FILTER_TYPES: string[] = ['lowpass', 'highpass', 'bandpass', 'notch', 'ladder', 'comb+', 'comb-'];
const FILTER_LABELS = ['LP', 'HP', 'BP', 'NT', 'LDR', 'CMB+', 'CMB-'];

// Per-envelope param key map (shared by narrow + floating layouts)
const ENV_PARAM_MAPS = {
  1: { attack: 'gainAttack', decay: 'gainDecay', sustain: 'gainSustain', release: 'gainRelease' },
  2: { attack: 'env2Attack', decay: 'env2Decay', sustain: 'env2Sustain', release: 'env2Release' },
  3: { attack: 'env3Attack', decay: 'env3Decay', sustain: 'env3Sustain', release: 'env3Release' },
} as const;

// ─── Inline envelope for floating OSC sections ─────────────────────────────

const envDisplayStyle: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,0.04)',
  borderRadius: 4,
  boxShadow: 'inset 0 0 12px rgba(0,0,0,0.4)',
  background: 'linear-gradient(180deg, rgba(0,0,0,0.2), transparent)',
  overflow: 'hidden',
};

function InlineEnvelope({
  label, attack, decay, sustain, release, color, onChange, modProps: mp,
}: {
  label: string;
  attack: number; decay: number; sustain: number; release: number;
  color: string;
  onChange: (k: 'attack' | 'decay' | 'sustain' | 'release', v: number) => void;
  modProps?: (key: string, label: string) => {
    modulations: KnobModulation[];
    contextItems: KnobContextItem[];
    onLfoDrop: (lfoSource: string) => void;
    onModDepthChange: (modIndex: number, newDepth: number) => void;
  };
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div style={{ borderTop: '1px solid rgba(255,255,255,0.03)', marginTop: 4, paddingTop: 6 }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 mb-1 select-none"
      >
        <span className="text-[9px] font-medium uppercase" style={{ color, letterSpacing: '0.12em', opacity: 0.7 }}>{label}</span>
        <span className="text-[7px]" style={{ color: '#8888a0' }}>{expanded ? '▼' : '▶'}</span>
      </button>
      {expanded && (
        <div style={envDisplayStyle}>
          <EnvelopeDisplay attack={attack} decay={decay} sustain={sustain} release={release} color={color} height={44} />
        </div>
      )}
      {expanded && (
        <div className="flex justify-around items-end gap-1 mt-1">
          <EffectKnob label="Atk" value={attack} min={0} max={2} unit="s" defaultValue={0.001} color={color} size="sm" onChange={(v) => onChange('attack', v)} {...(mp?.('gainAttack', 'Atk') ?? {})} />
          <EffectKnob label="Dec" value={decay} min={0.001} max={2} unit="s" defaultValue={0.1} color={color} size="sm" onChange={(v) => onChange('decay', v)} {...(mp?.('gainDecay', 'Dec') ?? {})} />
          <EffectKnob label="Sus" value={sustain} min={0} max={1} defaultValue={0.7} color={color} size="sm" onChange={(v) => onChange('sustain', v)} {...(mp?.('gainSustain', 'Sus') ?? {})} />
          <EffectKnob label="Rel" value={release} min={0.01} max={3} unit="s" defaultValue={0.15} color={color} size="sm" onChange={(v) => onChange('release', v)} {...(mp?.('gainRelease', 'Rel') ?? {})} />
        </div>
      )}
    </div>
  );
}

// ─── Floating layout (extracted to use useLayoutEffect for header portal) ────

function FloatingLayout({
  params, color, set, modProps, engine, instrument, currentPresetName,
  updateEngineParams, forceUpdate, lfoContent, getWtPosition, envOnChange,
}: {
  params: SynthParams;
  color: string;
  set: <K extends keyof SynthParams>(key: K, value: SynthParams[K]) => void;
  modProps: (key: keyof SynthParams, label: string) => {
    modulations: KnobModulation[];
    contextItems: KnobContextItem[];
    onLfoDrop: (lfoSource: string) => void;
    onModDepthChange: (modIndex: number, newDepth: number) => void;
  };
  engine: { getParams: () => SynthParams; loadPreset: (p: SynthParams) => void; getModulatedValue: (target: keyof SynthParams) => number | null };
  instrument: { id: string; orbitIndex: number };
  currentPresetName: string;
  updateEngineParams: (id: string, params: SynthParams) => void;
  forceUpdate: () => void;
  lfoContent: (compact?: boolean) => React.ReactNode;
  getWtPosition: () => number;
  envOnChange: (envIndex: 1 | 2 | 3, k: 'attack' | 'decay' | 'sustain' | 'release', v: number) => void;
}) {
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null);
  const [modeTarget, setModeTarget] = useState<HTMLElement | null>(null);
  const [rightTarget, setRightTarget] = useState<HTMLElement | null>(null);
  const [showFilter, setShowFilter] = useState(true);
  const [showFx, setShowFx] = useState(true);
  const [showLfo, setShowLfo] = useState(true);

  useLayoutEffect(() => {
    const el = document.getElementById('synth-float-header-center');
    if (el) setHeaderTarget(el);
    const modeEl = document.getElementById('synth-float-header-mode');
    if (modeEl) setModeTarget(modeEl);
    const rightEl = document.getElementById('synth-float-header-right');
    if (rightEl) setRightTarget(rightEl);
  }, []);

  const toggleEnvSync = () => {
    const newSync = !params.envSync;
    if (newSync) {
      // Copy env1 values to env2 and env3
      set('env2Attack', params.gainAttack);
      set('env2Decay', params.gainDecay);
      set('env2Sustain', params.gainSustain);
      set('env2Release', params.gainRelease);
      set('env3Attack', params.gainAttack);
      set('env3Decay', params.gainDecay);
      set('env3Sustain', params.gainSustain);
      set('env3Release', params.gainRelease);
    }
    set('envSync', newSync as any);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Portal PresetBrowser into FloatingPanel header */}
      {headerTarget && createPortal(
        <PresetBrowser
          engine={engine as any} color={color} currentPresetName={currentPresetName}
          onPresetLoaded={() => { updateEngineParams(instrument.id, engine.getParams()); forceUpdate(); }}
        />,
        headerTarget,
      )}

      {/* Portal OSC/FM mode toggle into FloatingPanel header */}
      {modeTarget && createPortal(
        <>
          {(['osc', 'fm'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => set('synthMode', mode)}
              className="text-[8px] uppercase tracking-wider px-2 py-0.5 rounded font-medium transition-all"
              style={{
                background: params.synthMode === mode ? `${color}28` : 'transparent',
                border: `1px solid ${params.synthMode === mode ? color : '#2a2a3a'}`,
                color: params.synthMode === mode ? color : '#8888a0',
              }}
            >
              {mode}
            </button>
          ))}
        </>,
        modeTarget,
      )}

      {/* Portal Filter/FX/LFO toggles into FloatingPanel header right */}
      {rightTarget && createPortal(
        <>
          {([
            { label: 'flt', shown: showFilter, toggle: () => setShowFilter(!showFilter) },
            { label: 'fx', shown: showFx, toggle: () => setShowFx(!showFx) },
            { label: 'lfo', shown: showLfo, toggle: () => setShowLfo(!showLfo) },
          ] as const).map(({ label, shown, toggle }) => (
            <button
              key={label}
              onClick={toggle}
              className="text-[8px] uppercase tracking-wider px-2 py-0.5 rounded font-medium transition-all"
              style={{
                background: shown ? `${color}28` : `${color}10`,
                border: `1px solid ${shown ? color : `${color}50`}`,
                color: shown ? color : `${color}80`,
              }}
            >
              {label}
            </button>
          ))}
        </>,
        rightTarget,
      )}

      {/* Visualizer strip — full width below header */}
      <div className="shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', height: 100 }}>
        <SynthVisualizer orbitIndex={instrument.orbitIndex} color={color} />
      </div>

      {/* Main content — 2-column grid with independent scroll per column */}
      <div className="flex-1 min-h-0">
        {params.synthMode === 'fm' ? (
          <div className="grid gap-0 h-full" style={{ gridTemplateColumns: '1fr 1fr' }}>
            {/* Left column: FM operators */}
            <div className="p-2 pt-7 flex flex-col gap-1 overflow-y-auto" style={{ borderRight: '1px solid rgba(255,255,255,0.03)' }}>
              <FMSection params={params} color={color} set={set} />
            </div>
            {/* Right column: Filter, FX, LFO */}
            <div className="p-2 pt-7 flex flex-col gap-1 overflow-y-auto">
              {showFilter && <FilterSection params={params} color={color} set={set} modProps={modProps} getModulatedValue={(t) => engine.getModulatedValue(t)} />}
              {showLfo && lfoContent(true)}
              {showFx && <FXSection params={params} color={color} set={set} modProps={modProps} />}
            </div>
          </div>
        ) : (
          <div className="grid gap-0 h-full" style={{ gridTemplateColumns: '1fr 1fr' }}>
            {/* Left column: Oscillators */}
            <div className="p-2 pt-7 flex flex-col gap-1 overflow-y-auto" style={{ borderRight: '1px solid rgba(255,255,255,0.03)' }}>
              {/* Envelope sync toggle */}
              <div className="flex items-center justify-end px-1 mb-0.5">
                <button
                  onClick={toggleEnvSync}
                  className="text-[8px] uppercase tracking-wider px-2 py-0.5 rounded font-medium transition-all"
                  style={{
                    background: params.envSync ? `${color}28` : `${color}10`,
                    border: `1px solid ${params.envSync ? color : `${color}50`}`,
                    color: params.envSync ? color : `${color}80`,
                  }}
                >
                  env sync
                </button>
              </div>
              <OscillatorSection oscIndex={1} params={params} color={color} set={set} modProps={modProps} getWtPosition={getWtPosition}>
                <InlineEnvelope
                  label="env 1" color={color}
                  attack={params.gainAttack} decay={params.gainDecay}
                  sustain={params.gainSustain} release={params.gainRelease}
                  onChange={(k, v) => envOnChange(1, k, v)}
                  modProps={(key, label) => modProps(key as keyof SynthParams, label)}
                />
              </OscillatorSection>
              <OscillatorSection oscIndex={2} params={params} color={color} set={set} modProps={modProps}>
                <InlineEnvelope
                  label="env 2" color={color}
                  attack={params.env2Attack} decay={params.env2Decay}
                  sustain={params.env2Sustain} release={params.env2Release}
                  onChange={(k, v) => envOnChange(2, k, v)}
                  modProps={params.envSync ? undefined : (key, label) => {
                    const map: Record<string, string> = { gainAttack: 'env2Attack', gainDecay: 'env2Decay', gainSustain: 'env2Sustain', gainRelease: 'env2Release' };
                    return modProps((map[key] ?? key) as keyof SynthParams, label);
                  }}
                />
              </OscillatorSection>
              <OscillatorSection oscIndex={3} params={params} color={color} set={set} modProps={modProps}>
                <InlineEnvelope
                  label="env 3" color={color}
                  attack={params.env3Attack} decay={params.env3Decay}
                  sustain={params.env3Sustain} release={params.env3Release}
                  onChange={(k, v) => envOnChange(3, k, v)}
                  modProps={params.envSync ? undefined : (key, label) => {
                    const map: Record<string, string> = { gainAttack: 'env3Attack', gainDecay: 'env3Decay', gainSustain: 'env3Sustain', gainRelease: 'env3Release' };
                    return modProps((map[key] ?? key) as keyof SynthParams, label);
                  }}
                />
              </OscillatorSection>
            </div>

            {/* Right column: Filter, LFO, FX */}
            <div className="p-2 pt-7 flex flex-col gap-1 overflow-y-auto">
              {showFilter && <FilterSection params={params} color={color} set={set} modProps={modProps} getModulatedValue={(t) => engine.getModulatedValue(t)} />}
              {showLfo && lfoContent(true)}
              {showFx && <FXSection params={params} color={color} set={set} modProps={modProps} />}
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export function SynthPanel() {
  const selectedId = useStore((s) => s.selectedInstrumentId);
  const instruments = useStore((s) => s.instruments);
  const instrument = instruments.find((i) => i.id === selectedId);

  // useMemo so engine creation (side-effect: starts oscillators) only runs
  // when the instrument id/orbit actually changes, not on every render.
  const engine = useMemo(() => {
    if (!instrument || instrument.type !== 'synth') return null;
    try { return getSynthEngine(instrument.id, instrument.orbitIndex, instrument.engineParams); }
    catch (e) { console.error('[SynthPanel] Failed to create engine:', e); return null; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument?.id, instrument?.orbitIndex]);

  // Force re-render when a param is mutated directly on the engine.
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  const updateEngineParams = useStore((s) => s.updateEngineParams);
  const synthCollapsed = useStore((s) => s.synthPanelCollapsed);
  const setSynthCollapsed = useStore((s) => s.setSynthPanelCollapsed);
  const synthPanelMode = useStore((s) => s.synthPanelMode);
  const setSynthPanelMode = useStore((s) => s.setSynthPanelMode);
  const isFloating = synthPanelMode !== 'inline';

  // Track the engineParams ref we last wrote, so we can detect external changes
  // (undo/redo/preset load) and sync them back to the live engine.
  const lastWrittenParams = useRef<SynthParams | null>(null);
  const storeEngineParams = instrument?.type === 'synth' ? instrument.engineParams : undefined;

  useEffect(() => {
    if (!engine || !storeEngineParams) return;
    // If the store's engineParams changed but we didn't write them, it's an external
    // update (undo/redo/set load) — re-apply all params to the live engine.
    if (storeEngineParams !== lastWrittenParams.current) {
      for (const key of Object.keys(storeEngineParams) as (keyof SynthParams)[]) {
        engine.setParam(key, storeEngineParams[key] as never);
      }
      lastWrittenParams.current = storeEngineParams;
      forceUpdate();
    }
  }, [engine, storeEngineParams]);

  // Track selected preset name from presetStore
  const selectedPresetId = usePresetStore((s) => s.selectedPresetId);
  const presets = usePresetStore((s) => s.presets);
  const currentPresetName = presets.find((p) => p.id === selectedPresetId)?.name ?? 'INIT';

  // BPM for LFO tempo sync display
  const bpm = useStore((s) => s.bpm);

  // MIDI learn
  const { startLearn: startMidiLearn, cancelLearn: cancelMidiLearn, learningTarget: midiLearning, removeCCMapping } = useMidiLearn();
  const midiMappings = useStore((s) => s.midiSettings.ccMappings);

  if (!instrument || instrument.type !== 'synth' || !engine) return null;

  const params = engine.getParams();
  const color = instrument.color;

  // Debounced store persist — apply to audio engine immediately (no lag),
  // but batch the expensive store update (which remaps ALL instruments and
  // triggers React re-renders) to max ~12 Hz instead of 60+ fps on knob drag.
  const storeFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingStoreFlush = useRef(false);

  const flushToStore = () => {
    if (!engine || !instrument) return;
    const newParams = engine.getParams();
    lastWrittenParams.current = newParams;
    updateEngineParams(instrument.id, newParams);
    pendingStoreFlush.current = false;
    storeFlushTimer.current = null;
  };

  // Cleanup debounce timer on unmount
  useEffect(() => () => {
    if (storeFlushTimer.current) { clearTimeout(storeFlushTimer.current); flushToStore(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = <K extends keyof SynthParams>(key: K, value: SynthParams[K]) => {
    // 1. Apply to audio engine immediately (smooth, uses setTargetAtTime)
    engine.setParam(key, value);
    // 2. Local re-render for knob visuals
    forceUpdate();
    // 3. Debounce the store update (expensive: clones params, remaps instruments array)
    if (!storeFlushTimer.current) {
      storeFlushTimer.current = setTimeout(flushToStore, 80);
      pendingStoreFlush.current = true;
    }
  };

  const envOnChange = (envIndex: 1 | 2 | 3, k: 'attack' | 'decay' | 'sustain' | 'release', v: number) => {
    if (params.envSync) {
      set(ENV_PARAM_MAPS[1][k], v);
      set(ENV_PARAM_MAPS[2][k], v);
      set(ENV_PARAM_MAPS[3][k], v);
    } else {
      set(ENV_PARAM_MAPS[envIndex][k], v);
    }
  };

  const filterTypeIdx = FILTER_TYPES.indexOf(params.filterType);

  // Modulation: get assignments and build knob modulation indicators
  const lfos = params.lfos ?? [DEFAULT_LFO_SLOT, DEFAULT_LFO_SLOT, DEFAULT_LFO_SLOT, DEFAULT_LFO_SLOT] as [typeof DEFAULT_LFO_SLOT, typeof DEFAULT_LFO_SLOT, typeof DEFAULT_LFO_SLOT, typeof DEFAULT_LFO_SLOT];
  const modAssignments = params.modAssignments ?? [];

  const getModsForParam = (key: keyof SynthParams): KnobModulation[] => {
    return modAssignments
      .filter((a) => a.target === key)
      .map((a) => ({ color: color, depth: a.depth }));
  };

  const handleModAssignmentsChange = (newAssignments: typeof modAssignments) => {
    set('modAssignments' as keyof SynthParams, newAssignments as never);
  };

  const assignLfo = (key: keyof SynthParams, lfoSource: string) => {
    const existing = modAssignments.find((a) => a.source === lfoSource && a.target === key);
    if (existing) return;
    const newAssignment = {
      id: `mod_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      source: lfoSource as 'lfo1' | 'lfo2' | 'lfo3' | 'lfo4',
      target: key,
      depth: 0.5,
    };
    set('modAssignments' as keyof SynthParams, [...modAssignments, newAssignment] as never);
  };

  const removeLfo = (key: keyof SynthParams, lfoSource: string) => {
    set('modAssignments' as keyof SynthParams,
      modAssignments.filter((a) => !(a.source === lfoSource && a.target === key)) as never);
  };

  /** Handle LFO drag-drop onto a knob */
  const handleLfoDrop = (key: keyof SynthParams, lfoSource: string) => {
    assignLfo(key, lfoSource);
  };

  /** Handle depth ring drag on a modulated knob */
  const handleModDepthChange = (key: keyof SynthParams, modIndex: number, newDepth: number) => {
    // Find the assignment for this param at the given modulation index
    const paramAssignments = modAssignments.filter((a) => a.target === key);
    if (modIndex < 0 || modIndex >= paramAssignments.length) return;
    const target = paramAssignments[modIndex];
    set('modAssignments' as keyof SynthParams,
      modAssignments.map((a) => a.id === target.id ? { ...a, depth: newDepth } : a) as never);
  };

  /** Get all modulation-related props for a knob */
  const modProps = (key: keyof SynthParams, knobLabel: string) => ({
    modulations: getModsForParam(key),
    contextItems: getContextItems(key, knobLabel),
    onLfoDrop: (lfoSource: string) => handleLfoDrop(key, lfoSource),
    onModDepthChange: (modIndex: number, newDepth: number) => handleModDepthChange(key, modIndex, newDepth),
  });

  const getContextItems = (key: keyof SynthParams, knobLabel: string): KnobContextItem[] => {
    const lfoIds = ['lfo1', 'lfo2', 'lfo3', 'lfo4'] as const;
    const items: KnobContextItem[] = [];

    // LFO assignments
    for (const lfo of lfoIds) {
      const assigned = modAssignments.some((a) => a.source === lfo && a.target === key);
      items.push({
        label: assigned ? `Remove ${lfo.toUpperCase()}` : `Assign ${lfo.toUpperCase()}`,
        icon: assigned ? 'remove' : 'lfo',
        active: assigned,
        color,
        onClick: () => assigned ? removeLfo(key, lfo) : assignLfo(key, lfo),
      });
    }

    // Separator via disabled item
    items.push({ label: '—', disabled: true, onClick: () => {} });

    // MIDI Learn
    items.push({
      label: midiLearning?.paramName === key ? 'Cancel MIDI Learn' : 'MIDI Learn',
      icon: 'midi',
      active: midiLearning?.paramName === key,
      onClick: () => {
        if (midiLearning?.paramName === key) {
          cancelMidiLearn();
        } else {
          startMidiLearn({
            targetType: 'synthParam',
            paramName: key,
            label: knobLabel,
            minValue: undefined,
            maxValue: undefined,
          });
        }
      },
    });

    // Show existing MIDI CC mapping
    const ccMapping = midiMappings.find((m) => m.targetType === 'synthParam' && m.paramName === key);
    if (ccMapping) {
      items.push({
        label: `Remove CC ${ccMapping.cc}`,
        icon: 'remove',
        onClick: () => {
          const idx = midiMappings.indexOf(ccMapping);
          if (idx >= 0) removeCCMapping(idx);
        },
      });
    }

    return items;
  };

  // Stable callback for WavetableDisplay3D to poll modulated WT position at ~30Hz
  const getWtPosition = useCallback(() => {
    if (!engine) return params.wtPosition ?? 0;
    return engine.getModulatedValue('wtPosition') ?? params.wtPosition ?? 0;
  }, [engine, params.wtPosition]);

  // ─── Shared section content renderers (used by both narrow & wide layouts) ──

  const oscContent = () => {
    const isWT = params.vcoType.startsWith('wt:');
    const isString = params.vcoType === 'string';
    const isClassic = !isWT && !isString;
    const bankId = isWT ? params.vcoType.slice(3) : 'basic_shapes';
    const uniVoices = Math.round(params.unisonVoices);
    const pan = params.vcoPan;
    return (
      <>
        {/* Mode selector */}
        <div className="flex gap-0.5 w-full">
          <button onClick={() => { if (!isClassic) set('vcoType', 'sawtooth'); }}
            className="flex-1 text-[8px] uppercase tracking-wider py-0.5 rounded transition-all"
            style={{ background: isClassic ? `${color}28` : 'transparent', border: `1px solid ${isClassic ? color : '#2a2a3a'}`, color: isClassic ? color : '#8888a0' }}
          >Classic</button>
          <button onClick={() => { if (!isWT) set('vcoType', `wt:${bankId}`); }}
            className="flex-1 text-[8px] uppercase tracking-wider py-0.5 rounded transition-all"
            style={{ background: isWT ? `${color}28` : 'transparent', border: `1px solid ${isWT ? color : '#2a2a3a'}`, color: isWT ? color : '#8888a0' }}
          >Wavetable</button>
          <button onClick={() => set('vcoType', 'string')}
            className="flex-1 text-[8px] uppercase tracking-wider py-0.5 rounded transition-all"
            style={{ background: isString ? `${color}28` : 'transparent', border: `1px solid ${isString ? color : '#2a2a3a'}`, color: isString ? color : '#8888a0' }}
          >String</button>
        </div>

        {/* Wave shape / bank selection */}
        {isString ? (
          <>
            <div className="text-[8px] text-text-secondary/50 px-1 py-1">Karplus-Strong physical modeling</div>
            <KnobRow>
              <SynthKnob label="Damp" value={params.stringDamping ?? 4000} min={200} max={12000} step={50} unit="Hz" defaultValue={4000} color={color} onChange={(v) => set('stringDamping', v)} {...modProps('stringDamping', 'Damp')} />
              <SynthKnob label="Decay" value={params.stringDecay ?? 0.995} min={0.9} max={0.999} step={0.001} defaultValue={0.995} color={color} onChange={(v) => set('stringDecay', v)} {...modProps('stringDecay', 'Decay')} />
            </KnobRow>
          </>
        ) : isWT ? (
          <>
            <select value={bankId} onChange={(e) => set('vcoType', `wt:${e.target.value}`)}
              className="w-full text-[9px] py-1 px-2 rounded border bg-transparent outline-none cursor-pointer"
              style={{ borderColor: `${color}40`, color }}>
              {WAVETABLE_BANKS.map((b) => (
                <option key={b.id} value={b.id} style={{ background: '#0e0e18', color: '#ccc' }}>{b.name}</option>
              ))}
            </select>
            <select value={params.wtWarpMode ?? 0} onChange={(e) => set('wtWarpMode', Number(e.target.value))}
              className="w-full text-[9px] py-1 px-2 rounded border bg-transparent outline-none cursor-pointer"
              style={{ borderColor: `${color}40`, color }}>
              {WARP_MODE_NAMES.map((name, i) => (
                <option key={i} value={i} style={{ background: '#0e0e18', color: '#ccc' }}>{name}</option>
              ))}
            </select>
          </>
        ) : (
          <>
            {[0, 1].map((row) => (
              <div key={row} className="flex gap-0.5 w-full">
                {ALL_WAVE_SHAPES.slice(row * 5, row * 5 + 5).map((shape, i) => {
                  const idx = row * 5 + i;
                  const active = params.vcoType === shape;
                  return (
                    <button key={shape} onClick={() => set('vcoType', shape)}
                      className="flex-1 text-[8px] uppercase tracking-wider py-0.5 rounded transition-all"
                      style={{ background: active ? `${color}28` : 'transparent', border: `1px solid ${active ? color : '#2a2a3a'}`, color: active ? color : '#8888a0' }}
                    >{ALL_WAVE_LABELS[idx]}</button>
                  );
                })}
              </div>
            ))}
          </>
        )}

        {/* Display */}
        {isWT ? (
          <div className="flex gap-1.5 items-stretch">
            <div className="flex-1 min-w-0" style={{ border: '1px solid rgba(255,255,255,0.06)', borderRadius: 4, overflow: 'hidden' }}>
              <WavetableDisplay3D bankId={bankId} position={params.wtPosition ?? 0} warpMode={params.wtWarpMode ?? 0} warpAmount={params.wtWarpAmount ?? 0} color={color} height={100} getPosition={getWtPosition} />
            </div>
            <div className="flex flex-col justify-center gap-2">
              <SynthKnob label="Pos" value={params.wtPosition ?? 0} min={0} max={1} step={0.005} defaultValue={0} color={color} onChange={(v) => set('wtPosition', v)} {...modProps('wtPosition', 'Pos')} />
              <SynthKnob label="Warp" value={params.wtWarpAmount ?? 0} min={0} max={1} step={0.005} defaultValue={0} color={color} onChange={(v) => set('wtWarpAmount', v)} {...modProps('wtWarpAmount', 'Warp')} />
            </div>
          </div>
        ) : isString ? (
          <div style={{ border: '1px solid rgba(255,255,255,0.06)', borderRadius: 4, overflow: 'hidden' }}>
            <StringDisplay damping={params.stringDamping ?? 4000} decay={params.stringDecay ?? 0.995} color={color} height={80} />
          </div>
        ) : (
          <div style={{ border: '1px solid rgba(255,255,255,0.06)', borderRadius: 4, overflow: 'hidden' }}>
            <OscDisplay waveType={params.vcoType} color={color} />
          </div>
        )}

        {/* Octave */}
        <div>
          <span className="text-[8px] text-text-secondary/60 uppercase tracking-wider">Octave</span>
          <div className="flex gap-0.5 mt-1">
            {[-2, -1, 0, 1, 2].map((n) => (
              <button key={n} onClick={() => set('vcoOctave', n)}
                className="flex-1 text-[8px] py-0.5 rounded transition-all"
                style={{
                  background: Math.round(params.vcoOctave ?? 0) === n ? `${color}28` : 'transparent',
                  border: `1px solid ${Math.round(params.vcoOctave ?? 0) === n ? color : '#2a2a3a'}`,
                  color: Math.round(params.vcoOctave ?? 0) === n ? color : '#8888a0',
                }}
              >{n > 0 ? `+${n}` : n}</button>
            ))}
          </div>
        </div>

        {/* Unison knob + settings */}
        <div className="flex items-end gap-3">
          <SynthKnob label="Uni" value={uniVoices} min={1} max={7} step={1} defaultValue={1} color={color} size="md" onChange={(v) => set('unisonVoices', Math.round(v))} />
          {uniVoices > 1 && (
            <>
              <SynthKnob label="Det" value={params.unisonDetune} min={0} max={50} unit="¢" defaultValue={10} color={color} onChange={(v) => set('unisonDetune', v)} {...modProps('unisonDetune', 'Det')} />
              <SynthKnob label="Sprd" value={params.unisonSpread} min={0} max={1} defaultValue={0.7} color={color} onChange={(v) => set('unisonSpread', v)} {...modProps('unisonSpread', 'Sprd')} />
              <SynthKnob label="Drift" value={params.unisonDrift ?? 0} min={0} max={1} defaultValue={0} color={color} onChange={(v) => set('unisonDrift', v)} {...modProps('unisonDrift', 'Drift')} />
            </>
          )}
        </div>

        {/* Tune, Pan slider, Level */}
        <div className="flex items-end gap-1">
          <SynthKnob label="Tune" value={params.vcoDetune} min={-100} max={100} step={1} unit="¢" defaultValue={0} color={color} onChange={(v) => set('vcoDetune', v)} {...modProps('vcoDetune', 'Tune')} />
          <div className="flex-1 flex flex-col gap-0.5 min-w-0 pb-1">
            <span className="text-[7px] uppercase tracking-wider text-center" style={{ color: '#8888a0' }}>Pan</span>
            <div className="relative flex items-center h-4">
              <input type="range" min={-1} max={1} step={0.01} value={pan}
                onChange={(e) => set('vcoPan', Number(e.target.value))}
                onDoubleClick={() => set('vcoPan', 0)}
                className="w-full h-1 appearance-none rounded-full cursor-pointer"
                style={{ background: `linear-gradient(to right, transparent, ${color}40 ${(pan + 1) * 50}%, transparent)`, accentColor: color }}
              />
              <div className="absolute top-1/2 w-px h-2.5 -translate-y-1/2 pointer-events-none" style={{ left: '50%', background: `${color}50` }} />
            </div>
            <div className="flex justify-between text-[6px]" style={{ color: '#555' }}>
              <span>L</span>
              <span>{pan === 0 ? 'C' : pan < 0 ? `L${Math.round(Math.abs(pan) * 100)}` : `R${Math.round(pan * 100)}`}</span>
              <span>R</span>
            </div>
          </div>
          <SynthKnob label="Level" value={params.vcoGain} min={0} max={1} defaultValue={1} color={color} size="md" onChange={(v) => set('vcoGain', v)} {...modProps('vcoGain', 'Level')} />
        </div>
      </>
    );
  };

  const subOscContent = () => (
    <>
      <span className="text-[8px] text-text-secondary/60 uppercase tracking-wider">Sub 1</span>
      <TypeButtons labels={WAVE_LABELS} value={WAVE_TYPES.indexOf(params.sub1Type)} color={color} onChange={(i) => set('sub1Type', WAVE_TYPES[i])} />
      <div>
        <span className="text-[8px] text-text-secondary/60 uppercase tracking-wider">Octave</span>
        <div className="flex gap-0.5 mt-1">
          {[-2, -1, 0, 1, 2].map((oct) => {
            const storeVal = oct * 12;
            const active = Math.round(params.sub1Offset) === storeVal;
            return (
              <button key={oct} onClick={() => set('sub1Offset', storeVal)}
                className="flex-1 text-[8px] py-0.5 rounded transition-all"
                style={{ background: active ? `${color}28` : 'transparent', border: `1px solid ${active ? color : '#2a2a3a'}`, color: active ? color : '#8888a0' }}
              >{oct > 0 ? `+${oct}` : oct}</button>
            );
          })}
        </div>
      </div>
      <KnobRow>
        <SynthKnob label="Level" value={params.sub1Gain} min={0} max={1} defaultValue={0} color={color} onChange={(v) => set('sub1Gain', v)} {...modProps('sub1Gain', 'Level')} />
        <SynthKnob label="Pan" value={params.sub1Pan} min={-1} max={1} defaultValue={0} color={color} onChange={(v) => set('sub1Pan', v)} {...modProps('sub1Pan', 'Pan')} />
      </KnobRow>
      {/* Ring Modulation (Sub1 × Main) */}
      <div className="flex items-center gap-2">
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
          <SynthKnob label="Mix" value={params.ringModMix ?? 0.5} min={0} max={1} defaultValue={0.5} color={color} onChange={(v) => set('ringModMix', v)} {...modProps('ringModMix', 'Mix')} />
        )}
      </div>
      <span className="text-[8px] text-text-secondary/60 uppercase tracking-wider mt-1">Sub 2</span>
      <TypeButtons labels={WAVE_LABELS} value={WAVE_TYPES.indexOf(params.sub2Type)} color={color} onChange={(i) => set('sub2Type', WAVE_TYPES[i])} />
      <div>
        <span className="text-[8px] text-text-secondary/60 uppercase tracking-wider">Octave</span>
        <div className="flex gap-0.5 mt-1">
          {[-2, -1, 0, 1, 2].map((oct) => {
            const storeVal = oct * 12;
            const active = Math.round(params.sub2Offset) === storeVal;
            return (
              <button key={oct} onClick={() => set('sub2Offset', storeVal)}
                className="flex-1 text-[8px] py-0.5 rounded transition-all"
                style={{ background: active ? `${color}28` : 'transparent', border: `1px solid ${active ? color : '#2a2a3a'}`, color: active ? color : '#8888a0' }}
              >{oct > 0 ? `+${oct}` : oct}</button>
            );
          })}
        </div>
      </div>
      <KnobRow>
        <SynthKnob label="Level" value={params.sub2Gain} min={0} max={1} defaultValue={0} color={color} onChange={(v) => set('sub2Gain', v)} {...modProps('sub2Gain', 'Level')} />
        <SynthKnob label="Pan" value={params.sub2Pan} min={-1} max={1} defaultValue={0} color={color} onChange={(v) => set('sub2Pan', v)} {...modProps('sub2Pan', 'Pan')} />
      </KnobRow>
    </>
  );

  const envelopeContent = () => (
    <>
      <EnvelopeDisplay attack={params.gainAttack} decay={params.gainDecay} sustain={params.gainSustain} release={params.gainRelease} color={color} />
      <KnobRow>
        <SynthKnob label="Atk" value={params.gainAttack} min={0} max={2} unit="s" defaultValue={0.001} color={color} onChange={(v) => envOnChange(1, 'attack', v)} {...modProps('gainAttack', 'Atk')} />
        <SynthKnob label="Dec" value={params.gainDecay} min={0.001} max={2} unit="s" defaultValue={0.1} color={color} onChange={(v) => envOnChange(1, 'decay', v)} {...modProps('gainDecay', 'Dec')} />
        <SynthKnob label="Sus" value={params.gainSustain} min={0} max={1} defaultValue={0.7} color={color} onChange={(v) => envOnChange(1, 'sustain', v)} {...modProps('gainSustain', 'Sus')} />
        <SynthKnob label="Rel" value={params.gainRelease} min={0.01} max={3} unit="s" defaultValue={0.15} color={color} onChange={(v) => envOnChange(1, 'release', v)} {...modProps('gainRelease', 'Rel')} />
      </KnobRow>
    </>
  );

  const filterContent = () => (
    <>
      <TypeButtons labels={FILTER_LABELS} value={filterTypeIdx >= 0 ? filterTypeIdx : 0} color={color} onChange={(i) => set('filterType', FILTER_TYPES[i] as SynthParams['filterType'])} />
      <FilterCurveDisplay filterType={filterTypeIdx >= 0 ? filterTypeIdx : 0} frequency={params.filterFreq} q={params.filterQ} color={color} getModulatedValues={() => ({ frequency: engine.getModulatedValue('filterFreq'), q: engine.getModulatedValue('filterQ') })} />
      <KnobRow>
        <SynthKnob label="Freq" value={params.filterFreq} min={20} max={20000} step={10} unit="Hz" defaultValue={8000} color={color} onChange={(v) => set('filterFreq', v)} {...modProps('filterFreq', 'Freq')} />
        <SynthKnob label="Q" value={params.filterQ} min={0} max={20} defaultValue={0} color={color} onChange={(v) => set('filterQ', v)} {...modProps('filterQ', 'Q')} />
        <SynthKnob label="Env" value={params.filterEnvAmount} min={-12000} max={12000} step={10} unit="¢" defaultValue={0} color={color} onChange={(v) => set('filterEnvAmount', v)} {...modProps('filterEnvAmount', 'Env')} />
      </KnobRow>
      <KnobRow>
        <SynthKnob label="Atk" value={params.filterAttack} min={0} max={2} unit="s" defaultValue={0} color={color} onChange={(v) => set('filterAttack', v)} {...modProps('filterAttack', 'Atk')} />
        <SynthKnob label="Dec" value={params.filterDecay} min={0.001} max={2} unit="s" defaultValue={0.1} color={color} onChange={(v) => set('filterDecay', v)} {...modProps('filterDecay', 'Dec')} />
      </KnobRow>
    </>
  );

  const lfoContent = (compact?: boolean, noBorder?: boolean) => (
    <LFOPanel
      lfos={lfos as [typeof DEFAULT_LFO_SLOT, typeof DEFAULT_LFO_SLOT, typeof DEFAULT_LFO_SLOT, typeof DEFAULT_LFO_SLOT]}
      onLFOChange={(idx, lfoParams) => {
        const newLfos = [...lfos] as typeof lfos;
        newLfos[idx] = lfoParams;
        set('lfos' as keyof SynthParams, newLfos as never);
      }}
      assignments={modAssignments}
      instrumentColor={color}
      bpm={bpm}
      compact={compact}
      noBorder={noBorder}
    />
  );

  const fmContent = () => (
    <>
      <div className="flex items-center gap-2">
        <button
          onClick={() => set('fmEnabled', !params.fmEnabled)}
          className="text-[9px] uppercase tracking-wider px-2 py-0.5 rounded transition-all"
          style={{
            background: params.fmEnabled ? `${color}28` : 'transparent',
            border: `1px solid ${params.fmEnabled ? color : '#2a2a3a'}`,
            color: params.fmEnabled ? color : '#8888a0',
          }}
        >
          {params.fmEnabled ? 'On' : 'Off'}
        </button>
        <span className="text-[8px] text-text-secondary/50">FM mod → carrier freq</span>
      </div>
      <KnobRow>
        <SynthKnob label="Ratio" value={params.fmRatio} min={0.5} max={8} step={0.1} defaultValue={2} color={color} onChange={(v) => set('fmRatio', v)} {...modProps('fmRatio', 'Ratio')} />
        <SynthKnob label="Depth" value={params.fmDepth} min={0} max={500} step={5} unit="Hz" defaultValue={0} color={color} onChange={(v) => set('fmDepth', v)} {...modProps('fmDepth', 'Depth')} />
      </KnobRow>
    </>
  );

  const fxContent = () => (
    <>
      <span className="text-[8px] text-text-secondary/60 uppercase tracking-wider">Delay</span>
      <KnobRow>
        <SynthKnob label="Amt" value={params.delayAmount} min={0} max={1} defaultValue={0} color={color} onChange={(v) => set('delayAmount', v)} {...modProps('delayAmount', 'Amt')} />
        <SynthKnob label="Time" value={params.delayTime} min={0} max={1} unit="s" defaultValue={0} color={color} onChange={(v) => set('delayTime', v)} {...modProps('delayTime', 'Time')} />
        <SynthKnob label="FB" value={params.delayFeedback} min={0} max={0.95} defaultValue={0} color={color} onChange={(v) => set('delayFeedback', v)} {...modProps('delayFeedback', 'FB')} />
        <SynthKnob label="Tone" value={params.delayTone} min={200} max={12000} step={50} unit="Hz" defaultValue={4400} color={color} onChange={(v) => set('delayTone', v)} {...modProps('delayTone', 'Tone')} />
      </KnobRow>
      <span className="text-[8px] text-text-secondary/60 uppercase tracking-wider mt-1">Reverb</span>
      <KnobRow>
        <SynthKnob label="Amt" value={params.reverbAmount} min={0} max={1} defaultValue={0} color={color} onChange={(v) => set('reverbAmount', v)} {...modProps('reverbAmount', 'Amt')} />
      </KnobRow>
      <span className="text-[8px] text-text-secondary/60 uppercase tracking-wider mt-1">Distortion</span>
      <TypeButtons labels={DISTORTION_TYPE_LABELS} value={params.distortionType ?? 0} color={color} onChange={(i) => set('distortionType', i)} />
      <KnobRow>
        <SynthKnob label="Drive" value={params.distortionDist} min={0} max={50} step={0.5} defaultValue={0} color={color} onChange={(v) => set('distortionDist', v)} {...modProps('distortionDist', 'Drive')} />
        <SynthKnob label="Amt" value={params.distortionAmount} min={0} max={1} defaultValue={0} color={color} onChange={(v) => set('distortionAmount', v)} {...modProps('distortionAmount', 'Amt')} />
      </KnobRow>
      <span className="text-[8px] text-text-secondary/60 uppercase tracking-wider mt-1">Bit Crush</span>
      <KnobRow>
        <SynthKnob label="Bits" value={params.bitCrushDepth} min={1} max={16} step={1} defaultValue={8} color={color} onChange={(v) => set('bitCrushDepth', v)} {...modProps('bitCrushDepth', 'Bits')} />
        <SynthKnob label="Amt" value={params.bitCrushAmount} min={0} max={1} defaultValue={0} color={color} onChange={(v) => set('bitCrushAmount', v)} {...modProps('bitCrushAmount', 'Amt')} />
      </KnobRow>
    </>
  );

  const PORTA_CURVES = ['lin', 'log', 'exp'] as const;
  const PORTA_LABELS = ['LIN', 'LOG', 'EXP'];

  const masterContent = () => (
    <>
      <KnobRow>
        <SynthKnob label="Vol" value={params.masterVolume} min={0} max={1} defaultValue={0.75} color={color} size="md" onChange={(v) => set('masterVolume', v)} {...modProps('masterVolume', 'Vol')} />
        <SynthKnob label="Glide" value={params.portamentoSpeed} min={0} max={0.5} unit="s" defaultValue={0} color={color} size="md" onChange={(v) => set('portamentoSpeed', v)} {...modProps('portamentoSpeed', 'Glide')} />
      </KnobRow>
      {params.portamentoSpeed > 0 && (
        <>
          <TypeButtons
            labels={PORTA_LABELS}
            value={PORTA_CURVES.indexOf(params.portamentoCurve ?? 'exp')}
            color={color}
            onChange={(i) => set('portamentoCurve', PORTA_CURVES[i])}
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => set('portamentoLegato', !params.portamentoLegato)}
              className="text-[8px] uppercase tracking-wider px-2 py-0.5 rounded transition-all"
              style={{
                background: params.portamentoLegato ? `${color}28` : 'transparent',
                border: `1px solid ${params.portamentoLegato ? color : '#2a2a3a'}`,
                color: params.portamentoLegato ? color : '#8888a0',
              }}
            >
              Legato
            </button>
            <span className="text-[7px] text-text-secondary/40">Glide only on overlap</span>
          </div>
        </>
      )}
    </>
  );

  // ─── Wide mode section header (non-collapsible) ──────────────────────────

  const WideSection = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="px-3 pb-2" style={{ borderBottom: `1px solid ${color}15` }}>
      <div className="text-[9px] uppercase tracking-wider font-medium py-1.5" style={{ color }}>{label}</div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <ModulationProvider assignments={modAssignments} onAssignmentsChange={handleModAssignmentsChange}>
    <div
      className={`synth-panel bg-bg-secondary ${isFloating ? 'flex-1 min-h-0' : 'border-l border-border shrink-0 h-full'} flex flex-col w-full overflow-hidden`}
    >
      {/* ─── Header: name + float toggle + collapse ──────────────────── */}
      {!isFloating && (
      <div
        className="flex items-center justify-between px-4 py-2 shrink-0 bg-bg-secondary z-10"
        style={{ borderBottom: `1px solid ${color}30` }}
      >
        <span className="text-[11px] font-semibold uppercase tracking-wider truncate" style={{ color }}>
          {instrument.name}
        </span>
        <div className="flex items-center gap-0.5">
          {/* Float / detach toggle */}
          <button
            onClick={() => setSynthPanelMode('floating')}
            title="Detach as floating panel"
            className="flex-shrink-0 p-1 hover:bg-white/10 rounded transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"
              className="text-text-secondary/60 hover:text-text-primary transition-colors">
              <polyline points="10 1 13 1 13 4" strokeLinecap="round" strokeLinejoin="round" />
              <line x1="13" y1="1" x2="8" y2="6" strokeLinecap="round" />
              <rect x="1" y="5" width="8" height="8" rx="1" strokeLinecap="round" />
            </svg>
          </button>
          {/* Collapse toggle */}
          <button
            onClick={() => setSynthCollapsed(!synthCollapsed)}
            title={synthCollapsed ? 'Expand synth' : 'Collapse synth'}
            className="flex-shrink-0 p-1 hover:bg-white/10 rounded transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"
              className="text-text-secondary/60 hover:text-text-primary transition-colors"
              style={{ transform: `rotate(${synthCollapsed ? 180 : 0}deg)`, transition: 'transform 0.2s' }}>
              <polyline points="3 10 7 6 11 10" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
      )}

      {!synthCollapsed && <>
        {isFloating ? (
          /* ═══════════════════ WIDE MODE: Vital-inspired layout ═══════════════════ */
          <FloatingLayout
            params={params} color={color} set={set} modProps={modProps}
            engine={engine} instrument={instrument}
            currentPresetName={currentPresetName}
            updateEngineParams={updateEngineParams}
            forceUpdate={forceUpdate}
            lfoContent={lfoContent}
            getWtPosition={getWtPosition}
            envOnChange={envOnChange}
          />
        ) : (
          /* ═══════════════════ NARROW MODE: original stacked layout ═════════════ */
          <div className="flex flex-col flex-1 min-h-0">
            <div className="shrink-0" style={{ borderBottom: `1px solid ${color}20`, height: 80 }}>
              <SynthVisualizer orbitIndex={instrument.orbitIndex} color={color} />
            </div>
            <div className="flex items-center gap-2 px-4 py-2 shrink-0 bg-bg-secondary z-10" style={{ borderBottom: `1px solid ${color}30` }}>
              {(['osc', 'fm'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => set('synthMode', mode)}
                  className="text-[9px] uppercase tracking-wider px-3 py-1 rounded font-medium transition-all shrink-0"
                  style={{
                    background: params.synthMode === mode ? `${color}28` : 'transparent',
                    border: `1px solid ${params.synthMode === mode ? color : '#2a2a3a'}`,
                    color: params.synthMode === mode ? color : '#8888a0',
                  }}
                >
                  {mode}
                </button>
              ))}
              <PresetBrowser
                engine={engine} color={color} currentPresetName={currentPresetName}
                onPresetLoaded={() => { updateEngineParams(instrument.id, engine.getParams()); forceUpdate(); }}
              />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {params.synthMode === 'fm' ? (
                <>
                  <Section label="FM Operators" color={color} defaultOpen>
                    <FMSection params={params} color={color} set={set} />
                  </Section>
                  <Section label="Filter" color={color}>{filterContent()}</Section>
                  {lfoContent(false, true)}
                  <Section label="FX" color={color}>{fxContent()}</Section>
                  <Section label="Master" color={color} defaultOpen>{masterContent()}</Section>
                </>
              ) : (
                <>
                  <Section label="Envelope" color={color} defaultOpen>{envelopeContent()}</Section>
                  <Section label="Oscillator" color={color} defaultOpen>{oscContent()}</Section>
                  <Section label="Sub Oscillators" color={color}>{subOscContent()}</Section>
                  <Section label="Filter" color={color}>{filterContent()}</Section>
                  {lfoContent(false, true)}
                  <Section label="FM Synthesis" color={color}>{fmContent()}</Section>
                  <Section label="FX" color={color}>{fxContent()}</Section>
                  <Section label="Master" color={color} defaultOpen>{masterContent()}</Section>
                </>
              )}
            </div>
          </div>
        )}
      </>}
    </div>
    </ModulationProvider>
  );
}
