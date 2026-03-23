import { useState, useRef, useEffect, useCallback } from 'react';
import { EffectKnob } from '../EffectsSidebar/EffectKnob';
import type { KnobModulation, KnobContextItem } from '../EffectsSidebar/EffectKnob';
import { DISTORTION_TYPE_LABELS } from '../../audio/synth/nodes/Distortion';
import type { SynthParams } from '../../audio/synth/types';
import { useStore } from '../../state/store';

type ModPropsResult = {
  modulations: KnobModulation[];
  contextItems: KnobContextItem[];
  onLfoDrop: (lfoSource: string) => void;
  onModDepthChange: (modIndex: number, newDepth: number) => void;
};

type FXTab = 'delay' | 'reverb' | 'dist' | 'crush';

interface FXSectionProps {
  params: SynthParams;
  color: string;
  set: <K extends keyof SynthParams>(key: K, value: SynthParams[K]) => void;
  modProps: (key: keyof SynthParams, label: string) => ModPropsResult;
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

const FX_TABS: { key: FXTab; label: string; amtKey: keyof SynthParams; defaultOn: number }[] = [
  { key: 'delay', label: 'Delay', amtKey: 'delayAmount', defaultOn: 0.3 },
  { key: 'reverb', label: 'Reverb', amtKey: 'reverbAmount', defaultOn: 0.3 },
  { key: 'dist', label: 'Dist', amtKey: 'distortionAmount', defaultOn: 0.5 },
  { key: 'crush', label: 'Crush', amtKey: 'bitCrushAmount', defaultOn: 0.5 },
];

const REVERB_TYPES = ['reverb1', 'reverb2', 'reverb3', 'reverb4', 'reverb5', 'reverb6'];
const REVERB_LABELS = ['Small', 'Med', 'Tight', 'Large', 'Hall', 'Cave'];
// Approximate decay multipliers for each reverb type (for visualization)
const REVERB_DECAY = [0.6, 0.75, 0.5, 0.88, 0.92, 0.96];

const PORTA_CURVES = ['lin', 'log', 'exp'] as const;
const PORTA_LABELS = ['LIN', 'LOG', 'EXP'];

const DISPLAY_H = 48;

// ─── Canvas display components ──────────────────────────────────────────────

function useCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    const cvs = ref.current;
    if (!cvs) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = cvs.getBoundingClientRect();
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (w === 0 || h === 0) return;
    cvs.width = w;
    cvs.height = h;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    drawRef.current(ctx, rect.width, rect.height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}

/** Delay: echo pulses on a timeline, decaying by feedback */
function DelayDisplay({ time, feedback, amount, tone, color }: { time: number; feedback: number; amount: number; tone: number; color: string }) {
  const draw = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    ctx.clearRect(0, 0, w, h);

    const maxEchoes = 8;
    const tNorm = Math.max(0.02, time); // normalized delay time
    const fb = Math.min(feedback, 0.95);
    const amt = Math.max(0, amount);
    // Tone mapped to brightness of echoes (low tone = darker)
    const toneNorm = Math.max(0, Math.min(1, (tone - 200) / 11800));

    // Draw grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (h * i) / 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    if (amt <= 0) return;

    // Draw original pulse (dry)
    const pulseW = Math.max(3, w * 0.015);
    ctx.fillStyle = `rgba(255,255,255,0.3)`;
    const dryH = h * 0.8;
    ctx.fillRect(4, h - dryH, pulseW, dryH);

    // Draw echo pulses
    let amplitude = amt;
    for (let i = 1; i <= maxEchoes; i++) {
      amplitude *= fb;
      if (amplitude < 0.02) break;
      const x = 4 + (i * tNorm * (w - 8)) / (tNorm * maxEchoes + 0.1);
      if (x > w - 2) break;
      const echoH = h * 0.8 * amplitude;
      // Tone affects color brightness per echo
      const toneFade = Math.pow(toneNorm, i * 0.3);
      const alpha = amplitude * 0.9 * (0.4 + 0.6 * toneFade);
      ctx.fillStyle = color + Math.round(alpha * 255).toString(16).padStart(2, '0');
      ctx.fillRect(x, h - echoH, pulseW, echoH);
    }

    // Feedback envelope line
    ctx.beginPath();
    ctx.strokeStyle = color + '60';
    ctx.lineWidth = 1;
    let envAmp = amt;
    ctx.moveTo(4, h - h * 0.8 * envAmp);
    for (let i = 1; i <= maxEchoes; i++) {
      envAmp *= fb;
      if (envAmp < 0.01) break;
      const x = 4 + (i * tNorm * (w - 8)) / (tNorm * maxEchoes + 0.1);
      if (x > w - 2) break;
      ctx.lineTo(x, h - h * 0.8 * envAmp);
    }
    ctx.stroke();
  }, [time, feedback, amount, tone, color]);

  const ref = useCanvas(draw, [time, feedback, amount, tone, color]);
  return <canvas ref={ref} style={{ width: '100%', height: DISPLAY_H }} />;
}

/** Reverb: impulse response decay visualization */
function ReverbDisplay({ amount, reverbType, color }: { amount: number; reverbType: string; color: string }) {
  const draw = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    ctx.clearRect(0, 0, w, h);

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (h * i) / 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    if (amount <= 0) return;

    const typeIdx = REVERB_TYPES.indexOf(reverbType);
    const decay = REVERB_DECAY[typeIdx >= 0 ? typeIdx : 0];
    const tailLen = 0.3 + decay * 0.7; // how much of the canvas the tail fills

    // Draw impulse burst + decay tail
    const steps = Math.round(w * 0.8);
    ctx.beginPath();
    ctx.moveTo(2, h);

    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const x = 2 + t * (w - 4);

      // Envelope: sharp attack, exponential decay
      let env: number;
      if (t < 0.02) {
        env = t / 0.02; // attack
      } else {
        const decayT = (t - 0.02) / tailLen;
        env = Math.exp(-decayT * (3 + (1 - decay) * 8));
      }

      // Add some "diffusion" noise texture
      const noise = 1 - Math.random() * 0.3 * (1 - t);
      const amplitude = env * amount * noise;
      const y = h / 2 - amplitude * (h * 0.4) * (Math.random() > 0.5 ? 1 : -1);

      ctx.lineTo(x, y);
    }

    ctx.lineTo(w - 2, h / 2);
    ctx.strokeStyle = color + '50';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Fill under the envelope
    ctx.beginPath();
    ctx.moveTo(2, h / 2);
    for (let i = 0; i < 80; i++) {
      const t = i / 80;
      const x = 2 + t * (w - 4);
      let env: number;
      if (t < 0.02) {
        env = t / 0.02;
      } else {
        const decayT = (t - 0.02) / tailLen;
        env = Math.exp(-decayT * (3 + (1 - decay) * 8));
      }
      ctx.lineTo(x, h / 2 - env * amount * h * 0.38);
    }
    ctx.lineTo(w - 2, h / 2);
    // Mirror bottom
    for (let i = 80; i >= 0; i--) {
      const t = i / 80;
      const x = 2 + t * (w - 4);
      let env: number;
      if (t < 0.02) {
        env = t / 0.02;
      } else {
        const decayT = (t - 0.02) / tailLen;
        env = Math.exp(-decayT * (3 + (1 - decay) * 8));
      }
      ctx.lineTo(x, h / 2 + env * amount * h * 0.38);
    }
    ctx.closePath();
    ctx.fillStyle = color + '15';
    ctx.fill();
  }, [amount, reverbType, color]);

  const ref = useCanvas(draw, [amount, reverbType, color]);
  return <canvas ref={ref} style={{ width: '100%', height: DISPLAY_H }} />;
}

/** Distortion: transfer curve (input→output) matching actual engine math */
function DistortionDisplay({ drive, amount, distType, color }: { drive: number; amount: number; distType: number; color: string }) {
  const draw = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    ctx.clearRect(0, 0, w, h);
    const pad = 4;
    const plotW = w - pad * 2;
    const plotH = h - pad * 2;

    // Grid: center cross
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, h / 2);
    ctx.lineTo(w - pad, h / 2);
    ctx.moveTo(w / 2, pad);
    ctx.lineTo(w / 2, h - pad);
    ctx.stroke();

    // Linear reference (no distortion)
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.setLineDash([2, 3]);
    ctx.moveTo(pad, h - pad);
    ctx.lineTo(w - pad, pad);
    ctx.stroke();
    ctx.setLineDash([]);

    if (amount <= 0 && drive <= 0) return;

    const k = Math.max(0.1, drive);
    const type = Math.max(0, Math.min(6, Math.round(distType)));

    // Draw transfer curve — same math as Distortion.ts
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;

    for (let i = 0; i <= plotW; i++) {
      const x = (i / plotW) * 2 - 1; // -1..1 input
      let y: number;

      switch (type) {
        case 0: // Soft clip
          y = ((3 + k) * Math.atan(Math.sinh(x * 0.25) * 5)) / (Math.PI + k * Math.abs(x));
          break;
        case 1: // Hard clip
          y = Math.max(-1, Math.min(1, x * (1 + k * 0.5)));
          break;
        case 2: // Tanh
          y = Math.tanh(x * (1 + k * 0.3));
          break;
        case 3: { // Wavefolder
          const foldAmt = 1 + k * 0.15;
          y = Math.sin(x * foldAmt * Math.PI);
          break;
        }
        case 4: { // Asymmetric
          const drv = 1 + k * 0.2;
          y = x >= 0 ? Math.tanh(x * drv) : Math.tanh(x * drv * 0.5) * 0.8;
          break;
        }
        case 5: // Rectify
          y = Math.abs(x) * 2 - 1;
          break;
        case 6: { // Fuzz
          const fuzzK = 1 + k * 0.3;
          y = Math.sign(x) * (1 - Math.exp(-Math.abs(x * fuzzK)));
          break;
        }
        default:
          y = x;
      }

      // Blend with dry (linear) based on amount
      const blended = x * (1 - amount) + y * amount;
      const px = pad + i;
      const py = pad + plotH / 2 - (blended * plotH) / 2;

      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }, [drive, amount, distType, color]);

  const ref = useCanvas(draw, [drive, amount, distType, color]);
  return <canvas ref={ref} style={{ width: '100%', height: DISPLAY_H }} />;
}

/** Bit Crush: sine wave being quantized to fewer bits */
function CrushDisplay({ bits, amount, color }: { bits: number; amount: number; color: string }) {
  const draw = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    ctx.clearRect(0, 0, w, h);
    const pad = 4;
    const plotH = h - pad * 2;

    // Center line
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, h / 2);
    ctx.lineTo(w - pad, h / 2);
    ctx.stroke();

    // Original sine (dim)
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= w - pad * 2; i++) {
      const t = i / (w - pad * 2);
      const y = Math.sin(t * Math.PI * 4);
      const py = pad + plotH / 2 - (y * plotH * 0.4);
      if (i === 0) ctx.moveTo(pad + i, py);
      else ctx.lineTo(pad + i, py);
    }
    ctx.stroke();

    if (amount <= 0) return;

    // Crushed waveform
    const levels = Math.pow(2, bits);
    const step = 2 / levels;

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;

    let prevQy = 0;
    for (let i = 0; i <= w - pad * 2; i++) {
      const t = i / (w - pad * 2);
      const original = Math.sin(t * Math.PI * 4);
      // Quantize
      const quantized = Math.round(original / step) * step;
      // Blend based on amount
      const blended = original * (1 - amount) + quantized * amount;
      const py = pad + plotH / 2 - (blended * plotH * 0.4);

      if (i === 0) {
        ctx.moveTo(pad, py);
        prevQy = py;
      } else {
        // Step-style drawing for crushed effect when amount is high
        if (amount > 0.3 && Math.abs(py - prevQy) > 1) {
          ctx.lineTo(pad + i, prevQy); // horizontal first
          ctx.lineTo(pad + i, py);     // then vertical
        } else {
          ctx.lineTo(pad + i, py);
        }
        prevQy = py;
      }
    }
    ctx.stroke();

    // Show bit-depth grid lines (quantization levels)
    if (bits <= 6) {
      ctx.strokeStyle = color + '10';
      ctx.lineWidth = 0.5;
      for (let lvl = -levels / 2; lvl <= levels / 2; lvl++) {
        const y = pad + plotH / 2 - ((lvl / (levels / 2)) * plotH * 0.4);
        ctx.beginPath();
        ctx.moveTo(pad, y);
        ctx.lineTo(w - pad, y);
        ctx.stroke();
      }
    }
  }, [bits, amount, color]);

  const ref = useCanvas(draw, [bits, amount, color]);
  return <canvas ref={ref} style={{ width: '100%', height: DISPLAY_H }} />;
}

// ─── Main FX Section ────────────────────────────────────────────────────────

const DELAY_DIVISIONS = [
  { label: '1/1',  beats: 4 },
  { label: '1/2',  beats: 2 },
  { label: '1/4',  beats: 1 },
  { label: '1/8',  beats: 0.5 },
  { label: '1/2D', beats: 3 },
  { label: '1/4D', beats: 1.5 },
  { label: '1/4T', beats: 2 / 3 },
  { label: '1/8T', beats: 1 / 3 },
] as const;

export function FXSection({ params, color, set, modProps }: FXSectionProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<FXTab>('delay');
  const [delaySync, setDelaySync] = useState(false);
  const savedAmts = useRef<Record<FXTab, number>>({ delay: 0.3, reverb: 0.3, dist: 0.5, crush: 0.5 });
  const bpm = useStore((s) => s.bpm);

  const isActive = (tab: typeof FX_TABS[number]) => (params[tab.amtKey] as number) > 0;

  const toggleFx = (tab: typeof FX_TABS[number], e: React.MouseEvent) => {
    e.stopPropagation();
    const amt = params[tab.amtKey] as number;
    if (amt > 0) {
      savedAmts.current[tab.key] = amt;
      set(tab.amtKey, 0 as never);
    } else {
      set(tab.amtKey, (savedAmts.current[tab.key] || tab.defaultOn) as never);
    }
  };

  // Master knobs — always visible on the right side of tab content
  const masterColumn = (
    <div className="flex items-center justify-center gap-2 shrink-0" style={{ borderLeft: '1px solid rgba(255,255,255,0.06)', paddingLeft: 8 }}>
      <div className="flex flex-col items-center gap-1">
        <EffectKnob label="Glide" value={params.portamentoSpeed} min={0} max={0.5} unit="s" defaultValue={0} color={color} size="sm" onChange={(v) => set('portamentoSpeed', v)} {...modProps('portamentoSpeed', 'Glide')} />
        <EffectKnob label="Vol" value={params.masterVolume} min={0} max={1} defaultValue={0.75} color={color} size="sm" onChange={(v) => set('masterVolume', v)} {...modProps('masterVolume', 'Vol')} />
      </div>
      {params.portamentoSpeed > 0 && (
        <div className="flex flex-col gap-0.5">
          {PORTA_LABELS.map((label, i) => (
            <button
              key={i}
              onClick={() => set('portamentoCurve', PORTA_CURVES[i])}
              className="text-[7px] uppercase tracking-wider py-0.5 px-1.5 rounded transition-all"
              style={{
                background: PORTA_CURVES.indexOf(params.portamentoCurve ?? 'exp') === i ? `${color}28` : 'transparent',
                border: `1px solid ${PORTA_CURVES.indexOf(params.portamentoCurve ?? 'exp') === i ? color : '#2a2a3a'}`,
                color: PORTA_CURVES.indexOf(params.portamentoCurve ?? 'exp') === i ? color : '#8888a0',
              }}
            >
              {label}
            </button>
          ))}
          <button
            onClick={() => set('portamentoLegato', !params.portamentoLegato)}
            className="text-[7px] uppercase tracking-wider px-1.5 py-0.5 rounded transition-all"
            style={{
              background: params.portamentoLegato ? `${color}28` : 'transparent',
              border: `1px solid ${params.portamentoLegato ? color : '#2a2a3a'}`,
              color: params.portamentoLegato ? color : '#8888a0',
            }}
          >
            Leg
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div style={{ ...basePanelCardStyle, border: `1px solid ${color}80` }}>
      {/* Header with tabs */}
      <div className="flex items-center gap-0 px-3" style={sectionHeaderStyle}>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="text-[10px] font-medium uppercase px-2 shrink-0 select-none"
          style={{ color, letterSpacing: '0.12em' }}
        >
          fx
        </button>
        {!collapsed && (
          <div className="flex gap-0.5 py-1">
            {FX_TABS.map((tab) => {
              const on = isActive(tab);
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className="flex items-center gap-1 text-[8px] uppercase tracking-wider px-2 py-0.5 rounded transition-all"
                  style={{
                    background: activeTab === tab.key ? `${color}20` : 'transparent',
                    border: `1px solid ${activeTab === tab.key ? `${color}60` : 'transparent'}`,
                    color: activeTab === tab.key ? color : '#8888a0',
                  }}
                >
                  <span
                    onClick={(e) => toggleFx(tab, e)}
                    className="inline-block w-[6px] h-[6px] rounded-full shrink-0 transition-all"
                    style={{
                      background: on ? color : '#3a3a4a',
                      boxShadow: on ? `0 0 4px ${color}80` : 'none',
                      cursor: 'pointer',
                    }}
                    title={on ? `Disable ${tab.label}` : `Enable ${tab.label}`}
                  />
                  {tab.label}
                </button>
              );
            })}
          </div>
        )}
        <span className="ml-auto text-[8px] px-2 cursor-pointer select-none" style={{ color: '#8888a0' }} onClick={() => setCollapsed(!collapsed)}>{collapsed ? '▶' : '▼'}</span>
      </div>

      {/* Tab content + master column */}
      {!collapsed && <div className="px-3 pb-3 pt-2 flex gap-2" style={{ minHeight: 90 }}>
        {/* Tab-specific content (flex-1) */}
        <div className="flex-1 flex flex-col gap-2 min-w-0">
          {activeTab === 'delay' && (() => {
            const beatSec = 60 / (bpm || 120);
            const activeDivIdx = delaySync
              ? DELAY_DIVISIONS.reduce((best, d, i) =>
                  Math.abs(d.beats * beatSec - params.delayTime) < Math.abs(DELAY_DIVISIONS[best].beats * beatSec - params.delayTime) ? i : best, 0)
              : -1;
            return (
              <>
                <div style={displayStyle}>
                  <DelayDisplay
                    time={params.delayTime}
                    feedback={params.delayFeedback}
                    amount={params.delayAmount}
                    tone={params.delayTone}
                    color={color}
                  />
                </div>
                <div className="flex justify-around items-end gap-1 flex-wrap">
                  <EffectKnob label="Amt" value={params.delayAmount} min={0} max={1} defaultValue={0} color={color} size="md" onChange={(v) => set('delayAmount', v)} {...modProps('delayAmount', 'Amt')} />
                  {delaySync ? (
                    <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                      {[0, 1].map((row) => (
                        <div key={row} className="flex gap-0.5">
                          {DELAY_DIVISIONS.slice(row * 4, row * 4 + 4).map((d, i) => {
                            const idx = row * 4 + i;
                            const active = idx === activeDivIdx;
                            return (
                              <button
                                key={d.label}
                                onClick={() => set('delayTime', Math.min(1, d.beats * beatSec))}
                                className="flex-1 text-[7px] py-0.5 rounded transition-all"
                                style={{
                                  background: active ? `${color}28` : 'transparent',
                                  border: `1px solid ${active ? color : '#2a2a3a'}`,
                                  color: active ? color : '#8888a0',
                                }}
                              >{d.label}</button>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EffectKnob label="Time" value={params.delayTime} min={0} max={1} unit="s" defaultValue={0} color={color} size="sm" onChange={(v) => set('delayTime', v)} {...modProps('delayTime', 'Time')} />
                  )}
                  <EffectKnob label="FB" value={params.delayFeedback} min={0} max={0.95} defaultValue={0} color={color} size="sm" onChange={(v) => set('delayFeedback', v)} {...modProps('delayFeedback', 'FB')} />
                  <EffectKnob label="Tone" value={params.delayTone} min={200} max={12000} step={50} unit="Hz" defaultValue={4400} color={color} size="sm" onChange={(v) => set('delayTone', v)} {...modProps('delayTone', 'Tone')} />
                </div>
                <button
                  onClick={() => setDelaySync(!delaySync)}
                  className="text-[7px] uppercase tracking-wider px-2 py-0.5 rounded self-start transition-all"
                  style={{
                    background: delaySync ? `${color}28` : 'transparent',
                    border: `1px solid ${delaySync ? color : '#2a2a3a'}`,
                    color: delaySync ? color : '#8888a0',
                  }}
                >sync</button>
              </>
            );
          })()}

          {activeTab === 'reverb' && (
            <>
              <div style={displayStyle}>
                <ReverbDisplay amount={params.reverbAmount} reverbType={params.reverbType ?? 'reverb1'} color={color} />
              </div>
              <div className="flex gap-3 items-stretch flex-1">
                {/* Left: reverb type buttons, 3 rows of 2 */}
                <div className="flex flex-col gap-0.5 justify-between" style={{ minWidth: 80 }}>
                  {[0, 1, 2].map((row) => (
                    <div key={row} className="flex gap-0.5 flex-1">
                      {REVERB_TYPES.slice(row * 2, row * 2 + 2).map((key, i) => {
                        const idx = row * 2 + i;
                        return (
                          <button
                            key={key}
                            onClick={() => set('reverbType', key)}
                            className="flex-1 text-[8px] uppercase tracking-wider rounded transition-all flex items-center justify-center"
                            style={{
                              background: (params.reverbType ?? 'reverb1') === key ? `${color}28` : 'transparent',
                              border: `1px solid ${(params.reverbType ?? 'reverb1') === key ? color : '#2a2a3a'}`,
                              color: (params.reverbType ?? 'reverb1') === key ? color : '#8888a0',
                            }}
                          >
                            {REVERB_LABELS[idx]}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
                {/* Center: big Amt knob */}
                <div className="flex flex-col items-center justify-center flex-1">
                  <EffectKnob label="Amt" value={params.reverbAmount} min={0} max={1} defaultValue={0} color={color} size="lg" onChange={(v) => set('reverbAmount', v)} {...modProps('reverbAmount', 'Amt')} />
                </div>
              </div>
            </>
          )}

          {activeTab === 'dist' && (
            <>
              <div style={displayStyle}>
                <DistortionDisplay
                  drive={params.distortionDist}
                  amount={params.distortionAmount}
                  distType={params.distortionType ?? 0}
                  color={color}
                />
              </div>
              <div className="flex gap-0.5 w-full">
                {DISTORTION_TYPE_LABELS.map((label, i) => (
                  <button
                    key={i}
                    onClick={() => set('distortionType', i)}
                    className="flex-1 text-[8px] uppercase tracking-wider py-0.5 rounded transition-all"
                    style={{
                      background: (params.distortionType ?? 0) === i ? `${color}28` : 'transparent',
                      border: `1px solid ${(params.distortionType ?? 0) === i ? color : '#2a2a3a'}`,
                      color: (params.distortionType ?? 0) === i ? color : '#8888a0',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex justify-around items-end gap-1">
                <EffectKnob label="Drive" value={params.distortionDist} min={0} max={50} step={0.5} defaultValue={0} color={color} size="lg" onChange={(v) => set('distortionDist', v)} {...modProps('distortionDist', 'Drive')} />
                <EffectKnob label="Amt" value={params.distortionAmount} min={0} max={1} defaultValue={0} color={color} size="sm" onChange={(v) => set('distortionAmount', v)} {...modProps('distortionAmount', 'Amt')} />
              </div>
            </>
          )}

          {activeTab === 'crush' && (
            <>
              <div style={displayStyle}>
                <CrushDisplay bits={params.bitCrushDepth} amount={params.bitCrushAmount} color={color} />
              </div>
              <div className="flex justify-around items-end gap-1">
                <EffectKnob label="Bits" value={params.bitCrushDepth} min={1} max={16} step={1} defaultValue={8} color={color} size="lg" onChange={(v) => set('bitCrushDepth', v)} {...modProps('bitCrushDepth', 'Bits')} />
                <EffectKnob label="Amt" value={params.bitCrushAmount} min={0} max={1} defaultValue={0} color={color} size="sm" onChange={(v) => set('bitCrushAmount', v)} {...modProps('bitCrushAmount', 'Amt')} />
              </div>
            </>
          )}
        </div>

        {/* Master column — always visible */}
        {masterColumn}
      </div>}
    </div>
  );
}
