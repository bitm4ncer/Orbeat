import { useEffect, useRef, useCallback, useState } from 'react';
import { useStore } from '../../state/store';
import { KnobRenderer } from '../../canvas/KnobRenderer';
import { getOrbitAnalyser } from '../../audio/orbitEffects';
import { fetchSampleTree, type SampleEntry } from '../../audio/sampleApi';
import { previewSample } from '../../audio/sampler';
import { findSiblings, preloadNeighbors } from '../../audio/sampleCache';
import { SamplePickerPopup } from '../SampleBank/SamplePickerPopup';
import { EFFECT_PARAM_DEFS, QUICK_PARAM_KEYS } from '../../audio/effectParams';
import { EFFECT_COLORS, EFFECT_ICONS } from '../EffectsSidebar/EffectBlock';
import { EffectKnob } from '../EffectsSidebar/EffectKnob';
import { DotRingOrb } from './DotRingOrb';
import type { Effect } from '../../types/effects';

// ── EffectPill ───────────────────────────────────────────────────────────────

function EffectPill({ effect, instrumentId }: { effect: Effect; instrumentId: string }) {
  const toggleEffectEnabled = useStore((s) => s.toggleEffectEnabled);
  const setEffectParam = useStore((s) => s.setEffectParam);
  const [hovered, setHovered] = useState(false);
  const [showPopup, setShowPopup] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const color = EFFECT_COLORS[effect.type] ?? '#94a3b8';
  const icon = EFFECT_ICONS[effect.type] ?? '?';
  const quickKeys = QUICK_PARAM_KEYS[effect.type] ?? [];
  const defs = EFFECT_PARAM_DEFS[effect.type as keyof typeof EFFECT_PARAM_DEFS] ?? [];

  const handleEnter = useCallback(() => {
    if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; }
    setHovered(true);
    hoverTimer.current = setTimeout(() => setShowPopup(true), 300);
  }, []);

  const handleLeave = useCallback(() => {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
    setHovered(false);
    leaveTimer.current = setTimeout(() => setShowPopup(false), 200);
  }, []);

  const handlePopupEnter = useCallback(() => {
    if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; }
  }, []);

  const handlePopupLeave = useCallback(() => {
    leaveTimer.current = setTimeout(() => { setShowPopup(false); setHovered(false); }, 200);
  }, []);

  useEffect(() => {
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
    };
  }, []);

  return (
    <div className="relative" style={{ zIndex: showPopup ? 50 : 'auto' }}>
      <button
        onClick={(e) => { e.stopPropagation(); toggleEffectEnabled(instrumentId, effect.id); }}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        className="flex items-center justify-center rounded-full transition-all cursor-pointer"
        style={{
          width: 18, height: 18,
          background: effect.enabled ? color : `${color}44`,
          border: `1px solid ${effect.enabled ? color : `${color}66`}`,
          boxShadow: effect.enabled && hovered ? `0 0 6px ${color}60` : 'none',
          transform: hovered ? 'scale(1.15)' : 'scale(1)',
          opacity: effect.enabled ? 1 : 0.5,
        }}
        title={`${effect.label} — click to ${effect.enabled ? 'disable' : 'enable'}`}
      >
        <span className="select-none font-bold flex items-center justify-center" style={{
          fontSize: 9, color: 'rgba(0,0,0,0.6)', width: 18, height: 18, lineHeight: 1,
        }}>{icon}</span>
      </button>

      {/* Quick-access popup */}
      {showPopup && quickKeys.length > 0 && (
        <div
          ref={(el) => {
            if (!el) return;
            // Native wheel listener to block cellRef's hits/volume handler
            el.onwheel = (ev) => { ev.stopPropagation(); };
          }}
          onMouseEnter={handlePopupEnter}
          onMouseLeave={handlePopupLeave}
          className="absolute left-1/2 rounded shadow-xl border border-border"
          style={{
            top: 'calc(100% + 6px)',
            transform: 'translateX(-50%)',
            background: '#1a1a28',
            borderTop: `2px solid ${color}`,
            padding: '8px 10px 6px',
            minWidth: 100,
            animation: 'fxPopIn 150ms ease-out',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Arrow */}
          <div style={{
            position: 'absolute', top: -6, left: '50%', transform: 'translateX(-50%)',
            width: 0, height: 0,
            borderLeft: '5px solid transparent', borderRight: '5px solid transparent',
            borderBottom: `5px solid ${color}`,
          }} />
          {/* Effect label */}
          <div className="text-[8px] uppercase tracking-wider text-center mb-1.5 font-medium"
            style={{ color: `${color}cc` }}>{effect.label}</div>
          {/* Knobs */}
          <div className="flex gap-1 justify-center">
            {quickKeys.map((key) => {
              const def = defs.find((d) => d.key === key);
              if (!def) return null;
              const val = effect.params[key] ?? def.defaultValue;
              return (
                <EffectKnob
                  key={key}
                  value={val} min={def.min} max={def.max} step={def.step}
                  defaultValue={def.defaultValue}
                  label={def.label} color={color} unit={def.unit}
                  size="sm"
                  onChange={(v) => setEffectParam(instrumentId, effect.id, key, v)}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── EffectStrip ──────────────────────────────────────────────────────────────

function EffectStrip({ instrumentId }: { instrumentId: string }) {
  const effects = useStore((s) => s.instrumentEffects[instrumentId]);

  return (
    <div
      className="flex flex-wrap gap-1 justify-center w-full px-1 min-h-[20px]"
      onClick={(e) => e.stopPropagation()}
    >
      {effects?.map((fx) => (
        <EffectPill key={fx.id} effect={fx} instrumentId={instrumentId} />
      ))}
    </div>
  );
}

// ── SceneBadge ───────────────────────────────────────────────────────────────

function SceneBadges({ instrumentId }: { instrumentId: string }) {
  const scenes = useStore((s) => s.scenes);
  const selectedSceneId = useStore((s) => s.selectedSceneId);
  const memberScenes = scenes.filter((g) => g.instrumentIds.includes(instrumentId));
  const selectedScene = selectedSceneId ? scenes.find((g) => g.id === selectedSceneId) : null;
  const canAdd = selectedScene && !selectedScene.instrumentIds.includes(instrumentId);

  return (
    <div className="inline-flex items-center gap-1 flex-wrap justify-center">
      {memberScenes.map((scene) => (
        <span
          key={scene.id}
          className="inline-flex items-center gap-0.5 text-[7px] font-medium tracking-wider uppercase px-1.5 py-0.5 rounded-full select-none cursor-pointer"
          style={{ color: scene.color, background: `${scene.color}18`, border: `1px solid ${scene.color}33` }}
          onClick={(e) => { e.stopPropagation(); useStore.getState().selectScene(scene.id); }}
        >
          {scene.name}
          <button
            className="ml-0.5 rounded-full hover:bg-white/20 transition-colors leading-none"
            style={{ width: 10, height: 10, fontSize: 8, color: scene.color }}
            title="Remove from scene"
            onClick={(e) => {
              e.stopPropagation();
              useStore.getState().removeInstrumentFromScene(instrumentId, scene.id);
            }}
          >
            ×
          </button>
        </span>
      ))}
      {canAdd && (
        <button
          className="inline-flex items-center justify-center rounded-full hover:bg-white/10 transition-colors cursor-pointer"
          style={{
            width: 14, height: 14,
            fontSize: 10, fontWeight: 'bold',
            color: selectedScene.color,
            border: `1px dashed ${selectedScene.color}55`,
          }}
          title={`Add to ${selectedScene.name}`}
          onClick={(e) => {
            e.stopPropagation();
            useStore.getState().addInstrumentToScene(instrumentId, selectedSceneId!);
          }}
        >
          +
        </button>
      )}
    </div>
  );
}

// ── KnobCanvas ───────────────────────────────────────────────────────────────

interface Props {
  instrumentId: string;
  isResizing?: boolean;
}

export function KnobCanvas({ instrumentId, isResizing }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cellRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<KnobRenderer | null>(null);
  const isDragging = useRef(false);
  const hasDragged = useRef(false);
  const dragHitIndex = useRef<number | null>(null);
  const levelBarRef = useRef<HTMLDivElement>(null);
  const levelStateRef = useRef({ level: 0 });
  const isResizingRef = useRef(false);

  // Sample picker popup
  const [popupOpen, setPopupOpen] = useState(false);
  const [popupAnchor, setPopupAnchor] = useState<DOMRect | null>(null);
  const [tree, setTree] = useState<SampleEntry[]>([]);
  const nameSpanRef = useRef<HTMLSpanElement>(null);
  const isHoveringName = useRef(false);
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isSelected = useStore((s) => s.selectedInstrumentId === instrumentId);
  const isMultiSelected = useStore((s) => s.selectedInstrumentIds.includes(instrumentId));
  const displayMode = useStore((s) => s.orbitDisplayMode);
  const isDotRing = displayMode === 'rotate';
  const sceneColorsKey = useStore(useCallback((s: { scenes: { instrumentIds: string[]; color: string }[] }) => {
    let key = '';
    for (const g of s.scenes) {
      if (g.instrumentIds.includes(instrumentId)) key += (key ? ',' : '') + g.color;
    }
    return key;
  }, [instrumentId]));
  const sceneColors = sceneColorsKey ? sceneColorsKey.split(',') : [];
  const inAnyScene = sceneColors.length > 0;
  const highlightSelector = useCallback((s: { selectedSceneId: string | null; scenes: { id: string; instrumentIds: string[] }[] }) => {
    if (!s.selectedSceneId) return false;
    const scene = s.scenes.find((sc) => sc.id === s.selectedSceneId);
    return scene?.instrumentIds.includes(instrumentId) ?? false;
  }, [instrumentId]);
  const isInHighlightedScene = useStore(highlightSelector);
  const selectedSceneId = useStore((s) => s.selectedSceneId);
  const selectedSceneColor = useStore((s) => {
    if (!s.selectedSceneId) return null;
    const sc = s.scenes.find((g) => g.id === s.selectedSceneId);
    return sc?.color ?? null;
  });
  const canAssignToScene = selectedSceneId != null && !inAnyScene;
  const inst = useStore((s) => s.instruments.find((i) => i.id === instrumentId));

  useEffect(() => {
    if (isDotRing) return; // DotRingOrb handles its own rendering
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new KnobRenderer(canvas, instrumentId);
    rendererRef.current = renderer;
    renderer.resize();
    renderer.start();

    // Debounce ResizeObserver with requestAnimationFrame to prevent flickering
    let rafId: number | null = null;
    const handleResize = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        renderer.resize();
        rafId = null;
      });
    };
    const observer = new ResizeObserver(handleResize);
    observer.observe(canvas);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      renderer.stop();
      observer.disconnect();
    };
  }, [instrumentId, isDotRing]);

  // Stop/start RAF loops during panel resize to prevent layout thrashing
  useEffect(() => {
    isResizingRef.current = !!isResizing;
    if (isResizing) {
      rendererRef.current?.stop();
    } else {
      rendererRef.current?.resize();
      rendererRef.current?.start();
    }
  }, [isResizing]);

  // Fetch sample tree once (module-level cached, near-instant on repeat calls)
  useEffect(() => {
    fetchSampleTree().then(setTree).catch(() => {/* silently ignore */});
  }, []);

  // Wheel on name span: browse siblings without triggering the cellRef handler
  useEffect(() => {
    const span = nameSpanRef.current;
    if (!span || tree.length === 0) return;

    const onNameWheel = (e: WheelEvent) => {
      if (!isHoveringName.current) return;
      e.stopPropagation(); // block cellRef's hits/volume/loop handler
      e.preventDefault();  // block page scroll

      // Read live store to avoid stale-closure issues on rapid scrolling
      const liveInst = useStore.getState().instruments.find((i) => i.id === instrumentId);
      const currentPath = liveInst?.samplePath ?? '';
      if (!currentPath) return; // no path to browse from yet

      const siblings = findSiblings(currentPath, tree);
      if (siblings.length === 0) return;

      const idx = siblings.findIndex((s) => s.path === currentPath);
      const delta = e.deltaY < 0 ? -1 : 1;
      const nextIdx = Math.max(0, Math.min(siblings.length - 1, (idx < 0 ? 0 : idx) + delta));
      const next = siblings[nextIdx];
      if (!next || next.path === currentPath) return;

      const displayName = next.name.replace(/\.[^.]+$/, '');
      useStore.getState().assignSample(instrumentId, next.path, displayName);

      // Debounced preview so rapid scroll doesn't spam audio
      if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
      previewDebounceRef.current = setTimeout(() => previewSample(next.path), 150);

      // Preload neighbors around the new position
      preloadNeighbors(next.path, tree);
    };

    span.addEventListener('wheel', onNameWheel, { passive: false });
    return () => span.removeEventListener('wheel', onNameWheel);
  }, [instrumentId, tree]);

  const handleNameClick = useCallback((e: React.MouseEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    setPopupAnchor(e.currentTarget.getBoundingClientRect());
    setPopupOpen(true);
  }, []);

  const handleNameMouseEnter = useCallback(() => {
    isHoveringName.current = true;
    const liveInst = useStore.getState().instruments.find((i) => i.id === instrumentId);
    if (liveInst?.samplePath && tree.length > 0) {
      preloadNeighbors(liveInst.samplePath, tree);
    }
  }, [instrumentId, tree]);

  const handleNameMouseLeave = useCallback(() => {
    isHoveringName.current = false;
  }, []);

  const handleNameWheelPassthrough = useCallback((e: React.WheelEvent) => {
    // Prevent React's synthetic wheel from propagating while native listener handles it
    e.stopPropagation();
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    isDragging.current = true;
    hasDragged.current = false;
    dragHitIndex.current = renderer.getHitAt(x, y);
    if (e.shiftKey) {
      useStore.getState().toggleSelectInstrument(instrumentId);
    } else {
      useStore.getState().selectInstrument(instrumentId);
    }
  }, [instrumentId]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDragging.current || dragHitIndex.current === null) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    hasDragged.current = true;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const angle = renderer.getAngleAt(x, y);
    useStore.getState().setHitPosition(instrumentId, dragHitIndex.current, angle);
  }, [instrumentId]);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    dragHitIndex.current = null;
  }, []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (hasDragged.current) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // Add hit only if clicking near the ring and not on an existing hit
    if (renderer.isOnRing(x, y) && renderer.getHitAt(x, y) === null) {
      const angle = renderer.getAngleAt(x, y);
      const store = useStore.getState();
      const inst = store.instruments.find((i) => i.id === instrumentId);
      if (inst?.type === 'sampler') {
        store.addSamplerHit(instrumentId, angle);
      } else {
        store.addHit(instrumentId, angle);
      }
    }
  }, [instrumentId]);

  useEffect(() => {
    const cell = cellRef.current;
    if (!cell) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const store = useStore.getState();
      const inst = store.instruments.find((i) => i.id === instrumentId);
      if (!inst) return;
      const delta = e.deltaY < 0 ? 1 : -1;
      if (e.ctrlKey) {
        store.setLoopSize(instrumentId, inst.loopSize + delta);
      } else if (e.altKey) {
        const newVol = Math.max(-20, Math.min(20, inst.volume + delta));
        store.updateInstrument(instrumentId, { volume: newVol });
      } else if (inst.type !== 'looper') {
        const newHits = Math.max(0, Math.min(inst.loopSize, inst.hits + delta));
        store.setHitCount(instrumentId, newHits);
      }
    };
    cell.addEventListener('wheel', onWheel, { passive: false });
    return () => cell.removeEventListener('wheel', onWheel);
  }, [instrumentId]);

  const handleDoubleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hitIndex = renderer.getHitAt(x, y);
    if (hitIndex !== null) {
      e.stopPropagation();
      useStore.getState().removeHit(instrumentId, hitIndex);
    }
  }, [instrumentId]);

  const orbitIndex = inst?.orbitIndex ?? -1;
  useEffect(() => {
    if (orbitIndex < 0) return;
    const data = new Float32Array(1024);
    let rafId: number;
    const draw = () => {
      const analyser = getOrbitAnalyser(orbitIndex);
      if (analyser && levelBarRef.current && !isResizingRef.current) {
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        const db = 20 * Math.log10(Math.max(rms, 1e-9));
        const raw = Math.max(0, Math.min(1, (db + 48) / 48));
        const s = levelStateRef.current;
        s.level = raw > s.level ? raw : Math.max(0, s.level - 0.02);
        levelBarRef.current.style.clipPath = `inset(${(1 - s.level) * 100}% 0 0 0)`;
      }
      rafId = requestAnimationFrame(draw);
    };
    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [orbitIndex]);

  if (!inst) return null;

  return (
    <div
      ref={cellRef}
      onClick={(e) => e.stopPropagation()}
      className={`knob-cell scene/card relative flex flex-col items-center gap-1 p-2 rounded-lg select-none transition-all
                  ${isSelected ? 'ring-1 ring-white/20 bg-white/5' : isMultiSelected ? 'ring-1 ring-white/10 bg-white/[0.03]' : 'hover:bg-white/[0.02]'}`}
      style={{
        border: canAssignToScene
          ? `1px dashed ${selectedSceneColor}66`
          : isInHighlightedScene
            ? `1px solid ${sceneColors[0]}88`
            : `1px solid ${inst.color}22`,
        '--inst-color': inst.color,
      } as React.CSSProperties}
      onDoubleClick={canAssignToScene ? (e) => {
        e.stopPropagation();
        useStore.getState().addInstrumentToScene(instrumentId, selectedSceneId!);
      } : undefined}
    >
      {/* Scene color indicator — 1px line(s) at bottom, split per scene */}
      {inAnyScene && (
        <div
          className="absolute pointer-events-none flex"
          style={{ bottom: 1, left: 6, right: 6, height: 1, gap: 1, borderRadius: 0.5 }}
        >
          {sceneColors.map((c, i) => (
            <div key={i} style={{ flex: 1, height: '100%', background: c, borderRadius: 0.5 }} />
          ))}
        </div>
      )}

      {/* Per-orbit level indicator — 2px bar centered on right border */}
      <div
        className="absolute top-0 overflow-hidden pointer-events-none"
        style={{ right: -1, width: 2, height: '100%', borderRadius: '0 8px 8px 0' }}
      >
        <div
          ref={levelBarRef}
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(to top, #16a34a, #22c55e 55%, #f59e0b 75%, #f97316 88%, #ef4444)',
            clipPath: 'inset(100% 0 0 0)',
          }}
        />
      </div>

      {/* Card name — above the orbit; click to mute/unmute */}
      <span
        className="card-name text-[11px] truncate w-full px-6 font-medium transition-colors duration-150 cursor-pointer text-center"
        style={{
          color: isSelected ? inst.color : `rgba(255,255,255,0.25)`,
          opacity: inst.muted ? 0.4 : 1,
        }}
        title={`${inst.name} — click to ${inst.muted ? 'unmute' : 'mute'}`}
        onClick={(e) => { e.stopPropagation(); useStore.getState().toggleMute(instrumentId); }}
      >
        {inst.name}
      </span>

      {/* Solo (top-left) */}
      <button
        className="absolute top-1 left-1 w-[18px] h-[18px] rounded-full border border-white/20 cursor-pointer z-10 flex items-center justify-center transition-all hover:!opacity-90 hover:![background:#ffd700]"
        style={{ background: inst.solo ? '#ffd700' : inst.color, opacity: inst.solo ? 0.9 : 0.4 }}
        title="Solo"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); useStore.getState().toggleSolo(instrumentId); }}
      >
        <span className="text-[9px] font-bold text-black/70 leading-none select-none">S</span>
      </button>
      {/* Mute (top-right) */}
      <button
        className="absolute top-1 right-1 w-[18px] h-[18px] rounded-full border border-white/20 cursor-pointer z-10 flex items-center justify-center transition-all hover:opacity-70"
        style={{ background: inst.color, opacity: inst.muted ? 0.3 : 1 }}
        title="Mute"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); useStore.getState().toggleMute(instrumentId); }}
      >
        <span className="text-[9px] font-bold text-black/70 leading-none select-none">M</span>
      </button>
      {/* Delete (bottom-left) */}
      <button
        className="absolute bottom-5 left-1 w-[18px] h-[18px] rounded-full border border-white/20 cursor-pointer z-10 flex items-center justify-center transition-all hover:!bg-red-500 hover:!opacity-90"
        style={{ background: '#444', opacity: 0.4 }}
        title="Delete"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); useStore.getState().removeInstrument(instrumentId); }}
      >
        <span className="text-[11px] font-bold text-white/70 leading-none select-none">×</span>
      </button>
      {/* Duplicate (bottom-right) */}
      <button
        className="absolute bottom-5 right-1 w-[18px] h-[18px] rounded-full border border-white/20 cursor-pointer z-10 flex items-center justify-center transition-all hover:!bg-emerald-500 hover:!opacity-90"
        style={{ background: '#444', opacity: 0.4 }}
        title="Duplicate (muted)"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); useStore.getState().duplicateInstrument(instrumentId); }}
      >
        <span className="text-[11px] font-bold text-white/70 leading-none select-none">+</span>
      </button>
      {isDotRing ? (
        <DotRingOrb instrumentId={instrumentId} size={160} />
      ) : (
        <canvas
          ref={canvasRef}
          className="w-full aspect-square cursor-pointer my-1"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
        />
      )}
      {/* Sample selector — bordered, analogue synth style */}
      <span
        ref={nameSpanRef}
        className="text-[8px] text-text-secondary truncate max-w-full px-2 py-0.5 rounded cursor-pointer hover:text-text-primary transition-colors mt-1"
        style={{
          border: '1px solid rgba(255,255,255,0.10)',
          background: 'rgba(0,0,0,0.2)',
          letterSpacing: '0.02em',
        }}
        title="Click to pick sample · Scroll to browse"
        onClick={handleNameClick}
        onMouseEnter={handleNameMouseEnter}
        onMouseLeave={handleNameMouseLeave}
        onWheel={handleNameWheelPassthrough}
      >
        {inst.samplePath
          ? inst.samplePath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? inst.name
          : inst.name}
      </span>
      {/* Scene badge or assign hint */}
      {inAnyScene ? (
        <div className="mt-1">
          <SceneBadges instrumentId={instrumentId} />
        </div>
      ) : canAssignToScene ? (
        <div className="mt-1">
          <span
            className="text-[7px] font-medium tracking-wider uppercase px-1.5 py-0.5 rounded-full select-none cursor-pointer hover:bg-white/10 transition-colors"
            style={{ color: `${selectedSceneColor}88`, border: `1px dashed ${selectedSceneColor}44` }}
            title="Double-click to add to scene"
            onClick={(e) => {
              e.stopPropagation();
              useStore.getState().addInstrumentToScene(instrumentId, selectedSceneId!);
            }}
          >
            + scene
          </span>
        </div>
      ) : null}
      {/* Effect quick-access strip */}
      <div className="mt-1 w-full">
        <EffectStrip instrumentId={instrumentId} />
      </div>
      {popupOpen && popupAnchor && tree.length > 0 && (
        <SamplePickerPopup
          instrumentId={instrumentId}
          anchorRect={popupAnchor}
          tree={tree}
          onClose={() => setPopupOpen(false)}
        />
      )}
    </div>
  );
}
