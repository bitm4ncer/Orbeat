import { useState, useRef } from 'react';
import type { SynthParams } from '../../audio/synth/types';
import { ALL_WAVE_SHAPES, ALL_WAVE_LABELS } from '../../audio/synth/wavetables';
import { WAVETABLE_BANKS } from '../../audio/synth/wavetableBanks';
import { WARP_MODE_NAMES } from '../../audio/synth/wavetableEngine';
import { EffectKnob } from '../EffectsSidebar/EffectKnob';
import type { KnobModulation, KnobContextItem } from '../EffectsSidebar/EffectKnob';
import { OscDisplay } from './OscDisplay';
import { StringDisplay } from './StringDisplay';
import { WavetableDisplay3D } from './WavetableDisplay3D';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Safely convert a param value to number, handling undefined/NaN */
function safeNum(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ─── Types ──────────────────────────────────────────────────────────────────

const WAVE_TYPES: OscillatorType[] = ['sine', 'triangle', 'square', 'sawtooth'];
const WAVE_LABELS = ['SIN', 'TRI', 'SQR', 'SAW'];

type ModPropsResult = {
  modulations: KnobModulation[];
  contextItems: KnobContextItem[];
  onLfoDrop: (lfoSource: string) => void;
  onModDepthChange: (modIndex: number, newDepth: number) => void;
};

interface OscillatorSectionProps {
  oscIndex: 1 | 2 | 3;
  params: SynthParams;
  color: string;
  set: <K extends keyof SynthParams>(key: K, value: SynthParams[K]) => void;
  modProps: (key: keyof SynthParams, label: string) => ModPropsResult;
  compact?: boolean;
  children?: React.ReactNode;
  /** Optional callback for live LFO-modulated wavetable position feedback. */
  getWtPosition?: () => number;
}

// ─── Param key mapping ──────────────────────────────────────────────────────

function getOscKeys(oscIndex: 1 | 2 | 3) {
  if (oscIndex === 1) {
    return {
      type: 'vcoType' as keyof SynthParams,
      gain: 'vcoGain' as keyof SynthParams,
      pan: 'vcoPan' as keyof SynthParams,
      detune: 'vcoDetune' as keyof SynthParams,
      octave: 'vcoOctave' as keyof SynthParams,
      unisonVoices: 'unisonVoices' as keyof SynthParams,
      unisonDetune: 'unisonDetune' as keyof SynthParams,
      unisonSpread: 'unisonSpread' as keyof SynthParams,
      unisonDrift: 'unisonDrift' as keyof SynthParams,
      wtPosition: 'wtPosition' as keyof SynthParams,
      wtWarpMode: 'wtWarpMode' as keyof SynthParams,
      wtWarpAmount: 'wtWarpAmount' as keyof SynthParams,
      stringDamping: 'stringDamping' as keyof SynthParams,
      stringDecay: 'stringDecay' as keyof SynthParams,
    };
  }
  const prefix = oscIndex === 2 ? 'sub1' : 'sub2';
  return {
    type: `${prefix}Type` as keyof SynthParams,
    gain: `${prefix}Gain` as keyof SynthParams,
    pan: `${prefix}Pan` as keyof SynthParams,
    detune: null,
    octave: `${prefix}Offset` as keyof SynthParams,
    unisonVoices: null,
    unisonDetune: null,
    unisonSpread: null,
    unisonDrift: null,
    wtPosition: null,
    wtWarpMode: null,
    wtWarpAmount: null,
    stringDamping: null,
    stringDecay: null,
  };
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const basePanelCardStyle: React.CSSProperties = {
  borderRadius: 6,
  background: 'rgba(0,0,0,0.25)',
};

const displayStyle: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 4,
  overflow: 'hidden',
};

const sectionHeaderStyle: React.CSSProperties = {
  borderBottom: '1px solid rgba(255,255,255,0.06)',
};

// ─── Component ──────────────────────────────────────────────────────────────

export function OscillatorSection({ oscIndex, params, color, set, modProps, compact, children, getWtPosition }: OscillatorSectionProps) {
  const keys = getOscKeys(oscIndex);
  const isMain = oscIndex === 1;
  const initialGain = safeNum(params[keys.gain], isMain ? 1 : 0);
  const [collapsed, setCollapsed] = useState(!isMain && initialGain === 0);
  const [showDisplay, setShowDisplay] = useState(true);
  const savedGain = useRef<number>(0);
  const oscType = String(params[keys.type] ?? 'sawtooth');

  // Main osc: supports classic, wavetable, string
  // Sub oscs: classic only (for now — Phase 4 will upgrade)
  const isWT = isMain && oscType.startsWith('wt:');
  const isString = isMain && oscType === 'string';
  const isClassic = !isWT && !isString;
  const bankId = isWT ? oscType.slice(3) : 'basic_shapes';

  const gain = safeNum(params[keys.gain], isMain ? 1 : 0);
  const oscActive = gain > 0;

  const toggleOsc = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (oscActive) {
      savedGain.current = gain;
      set(keys.gain, 0 as never);
    } else {
      set(keys.gain, (savedGain.current || (isMain ? 1 : 0.5)) as never);
    }
  };
  const pan = safeNum(params[keys.pan], 0);
  const detune = isMain ? safeNum(params[keys.detune!], 0) : 0;

  // Octave for main, semitone offset for subs
  const octaveValue = safeNum(params[keys.octave!], 0);

  // Unison (main only)
  const unisonVoices = isMain ? Math.round(safeNum(params[keys.unisonVoices!], 1)) : 1;
  const unisonDetune = isMain ? safeNum(params[keys.unisonDetune!], 10) : 0;
  const unisonSpread = isMain ? safeNum(params[keys.unisonSpread!], 0.7) : 0;
  const unisonDrift = isMain ? safeNum(params[keys.unisonDrift!], 0) : 0;

  const TypeBtn = ({ labels, value, onChange }: { labels: string[]; value: number; onChange: (i: number) => void }) => (
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

  return (
    <div style={{ ...basePanelCardStyle, border: `1px solid ${color}80` }} className="mb-1">
      {/* Header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-3 py-1.5 select-none"
        style={sectionHeaderStyle}
      >
        <div className="flex items-center gap-2">
          <span
            onClick={toggleOsc}
            className="w-[7px] h-[7px] rounded-full shrink-0 transition-all cursor-pointer"
            style={{
              background: oscActive ? color : '#3a3a4a',
              boxShadow: oscActive ? `0 0 4px ${color}80` : 'none',
            }}
            title={oscActive ? `Mute OSC ${oscIndex}` : `Enable OSC ${oscIndex}`}
          />
          <span className="text-[10px] font-medium uppercase" style={{ color, letterSpacing: '0.12em' }}>
            osc {oscIndex}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!collapsed && (
            <span
              onClick={(e) => { e.stopPropagation(); setShowDisplay(!showDisplay); }}
              className="text-[9px] cursor-pointer select-none transition-all"
              style={{ color: showDisplay ? color : '#3a3a4a' }}
              title={showDisplay ? 'Hide wave display' : 'Show wave display'}
            >
              &#9788;
            </span>
          )}
          <span className="text-[8px]" style={{ color: '#8888a0' }}>{collapsed ? '▶' : '▼'}</span>
        </div>
      </button>

      {!collapsed && (
        <div className="px-3 pb-3 flex flex-col gap-2 pt-2">
          {/* Slot for inline envelope or other children */}
          {children}

          {/* Divider between ENV and wave selection */}
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', margin: '2px 0' }} />

          {/* Mode selector (main osc only) */}
          {isMain && (
            <div className="flex gap-0.5 w-full">
              <button
                onClick={() => { if (!isClassic) set(keys.type, 'sawtooth' as never); }}
                className="flex-1 text-[8px] uppercase tracking-wider py-0.5 rounded transition-all"
                style={{
                  background: isClassic ? `${color}28` : 'transparent',
                  border: `1px solid ${isClassic ? color : '#2a2a3a'}`,
                  color: isClassic ? color : '#8888a0',
                }}
              >Classic</button>
              <button
                onClick={() => { if (!isWT) set(keys.type, `wt:${bankId}` as never); }}
                className="flex-1 text-[8px] uppercase tracking-wider py-0.5 rounded transition-all"
                style={{
                  background: isWT ? `${color}28` : 'transparent',
                  border: `1px solid ${isWT ? color : '#2a2a3a'}`,
                  color: isWT ? color : '#8888a0',
                }}
              >Wavetable</button>
              <button
                onClick={() => set(keys.type, 'string' as never)}
                className="flex-1 text-[8px] uppercase tracking-wider py-0.5 rounded transition-all"
                style={{
                  background: isString ? `${color}28` : 'transparent',
                  border: `1px solid ${isString ? color : '#2a2a3a'}`,
                  color: isString ? color : '#8888a0',
                }}
              >String</button>
            </div>
          )}

          {/* Wave shape selection */}
          {isString ? (
            <>
              <div className="text-[8px] text-text-secondary/50 px-1 py-1">Karplus-Strong physical modeling</div>
              <div className="flex justify-around items-end gap-1">
                <EffectKnob label="Damp" value={safeNum(params[keys.stringDamping!], 4000)} min={200} max={12000} step={50} unit="Hz" defaultValue={4000} color={color} size="sm" onChange={(v) => set(keys.stringDamping!, v as never)} {...modProps(keys.stringDamping!, 'Damp')} />
                <EffectKnob label="Decay" value={safeNum(params[keys.stringDecay!], 0.995)} min={0.9} max={0.999} step={0.001} defaultValue={0.995} color={color} size="sm" onChange={(v) => set(keys.stringDecay!, v as never)} {...modProps(keys.stringDecay!, 'Decay')} />
              </div>
            </>
          ) : isWT ? (
            <>
              <select
                value={bankId}
                onChange={(e) => set(keys.type, `wt:${e.target.value}` as never)}
                className="w-full text-[9px] py-1 px-2 rounded border bg-transparent outline-none cursor-pointer"
                style={{ borderColor: `${color}40`, color }}
              >
                {WAVETABLE_BANKS.map((b) => (
                  <option key={b.id} value={b.id} style={{ background: '#0e0e18', color: '#ccc' }}>{b.name}</option>
                ))}
              </select>
              {/* Warp mode selector */}
              <select
                value={safeNum(params[keys.wtWarpMode!], 0)}
                onChange={(e) => set(keys.wtWarpMode!, Number(e.target.value) as never)}
                className="w-full text-[9px] py-1 px-2 rounded border bg-transparent outline-none cursor-pointer"
                style={{ borderColor: `${color}40`, color }}
              >
                {WARP_MODE_NAMES.map((name, i) => (
                  <option key={i} value={i} style={{ background: '#0e0e18', color: '#ccc' }}>{name}</option>
                ))}
              </select>
            </>
          ) : (
            <>
              {isMain ? (
                /* Main osc: full wave shape grid */
                <>
                  {[0, 1].map((row) => (
                    <div key={row} className="flex gap-0.5 w-full">
                      {ALL_WAVE_SHAPES.slice(row * 5, row * 5 + 5).map((shape, i) => {
                        const idx = row * 5 + i;
                        const active = oscType === shape;
                        return (
                          <button
                            key={shape}
                            onClick={() => set(keys.type, shape as never)}
                            className="flex-1 text-[8px] uppercase tracking-wider py-0.5 rounded transition-all"
                            style={{
                              background: active ? `${color}28` : 'transparent',
                              border: `1px solid ${active ? color : '#2a2a3a'}`,
                              color: active ? color : '#8888a0',
                            }}
                          >
                            {ALL_WAVE_LABELS[idx]}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </>
              ) : (
                /* Sub oscs: basic 4 waveforms */
                <TypeBtn
                  labels={WAVE_LABELS}
                  value={WAVE_TYPES.indexOf(oscType as OscillatorType)}
                  onChange={(i) => set(keys.type, WAVE_TYPES[i] as never)}
                />
              )}
            </>
          )}

          {/* Wave display */}
          {showDisplay && (
            isWT ? (
              <div className="flex gap-1.5 items-stretch">
                <div style={displayStyle} className="flex-1 min-w-0">
                  <WavetableDisplay3D
                    bankId={bankId}
                    position={safeNum(params[keys.wtPosition!], 0)}
                    warpMode={safeNum(params[keys.wtWarpMode!], 0)}
                    warpAmount={safeNum(params[keys.wtWarpAmount!], 0)}
                    color={color}
                    height={compact ? 90 : 120}
                    getPosition={getWtPosition}
                  />
                </div>
                <div className="flex flex-col justify-center gap-2">
                  <EffectKnob label="Pos" value={safeNum(params[keys.wtPosition!], 0)} min={0} max={1} step={0.005} defaultValue={0} color={color} size="sm" onChange={(v) => set(keys.wtPosition!, v as never)} {...modProps(keys.wtPosition!, 'Pos')} />
                  <EffectKnob label="Warp" value={safeNum(params[keys.wtWarpAmount!], 0)} min={0} max={1} step={0.005} defaultValue={0} color={color} size="sm" onChange={(v) => set(keys.wtWarpAmount!, v as never)} {...modProps(keys.wtWarpAmount!, 'Warp')} />
                </div>
              </div>
            ) : isString ? (
              <div style={displayStyle}>
                <StringDisplay
                  damping={safeNum(params[keys.stringDamping!], 4000)}
                  decay={safeNum(params[keys.stringDecay!], 0.995)}
                  color={color}
                  height={compact ? 72 : 90}
                />
              </div>
            ) : (
              <div style={displayStyle}>
                <OscDisplay waveType={oscType} color={color} height={compact ? 56 : 72} />
              </div>
            )
          )}

          {/* Octave + Unison */}
          <div className="flex gap-2 items-end">
            <div className="flex-1 min-w-0">
              <span className="text-[8px] text-text-secondary/60 uppercase tracking-wider">Octave</span>
              <div className="flex gap-0.5 mt-1">
                {[-2, -1, 0, 1, 2].map((oct) => {
                  const storeVal = isMain ? oct : oct * 12;
                  const active = Math.round(octaveValue) === storeVal;
                  return (
                    <button key={oct} onClick={() => set(keys.octave!, storeVal as never)}
                      className="flex-1 text-[8px] py-0.5 rounded transition-all"
                      style={{
                        background: active ? `${color}28` : 'transparent',
                        border: `1px solid ${active ? color : '#2a2a3a'}`,
                        color: active ? color : '#8888a0',
                      }}
                    >{oct > 0 ? `+${oct}` : oct}</button>
                  );
                })}
              </div>
            </div>
          </div>
          {isMain && (
            <div className="flex items-end gap-3">
              <EffectKnob label="Uni" value={unisonVoices} min={1} max={7} step={1} defaultValue={1} color={color} onChange={(v) => set(keys.unisonVoices!, Math.round(v) as never)} />
              {unisonVoices > 1 && (
                <>
                  <EffectKnob label="Det" value={unisonDetune} min={0} max={50} unit="¢" defaultValue={10} color={color} size="sm" onChange={(v) => set(keys.unisonDetune!, v as never)} {...modProps(keys.unisonDetune!, 'Det')} />
                  <EffectKnob label="Sprd" value={unisonSpread} min={0} max={1} defaultValue={0.7} color={color} size="sm" onChange={(v) => set(keys.unisonSpread!, v as never)} {...modProps(keys.unisonSpread!, 'Sprd')} />
                  <EffectKnob label="Drift" value={unisonDrift} min={0} max={1} defaultValue={0} color={color} size="sm" onChange={(v) => set(keys.unisonDrift!, v as never)} {...modProps(keys.unisonDrift!, 'Drift')} />
                </>
              )}
            </div>
          )}

          {/* Tune, Pan, Level — bottom of card */}
          <div className="flex items-end gap-1">
            {isMain && keys.detune && (
              <EffectKnob label="Tune" value={detune} min={-100} max={100} step={1} unit="¢" defaultValue={0} color={color} size="sm" onChange={(v) => set(keys.detune!, v as never)} {...modProps(keys.detune!, 'Tune')} />
            )}
            <div className="flex-1 flex flex-col gap-0.5 min-w-0 pb-1">
              <span className="text-[7px] uppercase tracking-wider text-center" style={{ color: '#8888a0' }}>Pan</span>
              <div className="relative flex items-center h-4">
                <input
                  type="range"
                  min={-1}
                  max={1}
                  step={0.01}
                  value={pan}
                  onChange={(e) => set(keys.pan, Number(e.target.value) as never)}
                  onDoubleClick={() => set(keys.pan, 0 as never)}
                  className="w-full h-1 appearance-none rounded-full cursor-pointer"
                  style={{
                    background: `linear-gradient(to right, transparent, ${color}40 ${(pan + 1) * 50}%, transparent)`,
                    accentColor: color,
                  }}
                />
                <div
                  className="absolute top-1/2 w-px h-2.5 -translate-y-1/2 pointer-events-none"
                  style={{ left: '50%', background: `${color}50` }}
                />
              </div>
              <div className="flex justify-between text-[6px]" style={{ color: '#555' }}>
                <span>L</span>
                <span>{pan === 0 ? 'C' : pan < 0 ? `L${Math.round(Math.abs(pan) * 100)}` : `R${Math.round(pan * 100)}`}</span>
                <span>R</span>
              </div>
            </div>
            <EffectKnob label="Level" value={gain} min={0} max={1} defaultValue={isMain ? 1 : 0} color={color} onChange={(v) => set(keys.gain, v as never)} {...modProps(keys.gain, 'Level')} />
          </div>

        </div>
      )}
    </div>
  );
}
