import { KnobGrid } from './components/Orbits/KnobGrid';
import { TransportBar } from './components/Transport/TransportBar';
import { InstrumentRack } from './components/InstrumentRack/InstrumentRack';
import { GridSequencer } from './components/GridSequencer/GridSequencer';
import { SynthPanel } from './components/SynthPanel/SynthPanel';
import { FloatingPanel } from './components/SynthPanel/FloatingPanel';
import { SampleBank } from './components/SampleBank/SampleBank';
import { LooperEditor } from './components/LooperPanel/LooperEditor';
import { LoopBrowser } from './components/LooperPanel/LoopBrowser';
import { EffectsSidebar } from './components/EffectsSidebar/EffectsSidebar';
import { TrackTimeline } from './components/TrackMode/TrackTimeline';
import { LiveBar } from './components/LiveMode/LiveBar';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { usePianoKeyboard } from './hooks/usePianoKeyboard';
import { useResizable } from './hooks/useResizable';
import { useMidiSetup } from './hooks/useMidiSetup';
import { useMidiClock } from './hooks/useMidiClock';
import { useStore } from './state/store';
import { fetchSampleTree, type SampleEntry } from './audio/sampleApi';
import { useEffect, useRef, useState } from 'react';
import * as Tone from 'tone';
import { seedFactory } from './storage/seedFactory';
import { seedEffectFactory } from './storage/seedEffectFactory';
import { initRecordingSync } from './storage/recordingSync';
import { restoreFromSetId, restoreLegacyAutosave, initSessionAutosave, getLastSetId, restoreEmergencySnapshot, clearEmergencySnapshot } from './storage/sessionAutosave';
import { initUndoHistory } from './state/undoHistory';
import { parseShareHash, decodeSetFromUrl } from './storage/urlShare';
import { perfMonitor, countStoreUpdate } from './debug/perfMonitor';
import { LogConsole } from './components/LogConsole/LogConsole';

function flattenFiles(entries: SampleEntry[]): SampleEntry[] {
  const result: SampleEntry[] = [];
  for (const e of entries) {
    if (e.type === 'file') result.push(e);
    else if (e.children) result.push(...flattenFiles(e.children));
  }
  return result;
}

function App() {
  useKeyboardShortcuts();
  usePianoKeyboard();
  useMidiSetup();
  useMidiClock();
  const trackMode = useStore((s) => s.trackMode);
  const liveMode = useStore((s) => s.liveMode);
  const logEnabled = useStore((s) => s.logEnabled);
  const showLogConsole = useStore((s) => s.showLogConsole);
  const selectedId = useStore((s) => s.selectedInstrumentId);
  const instruments = useStore((s) => s.instruments);
  const selectedInstrument = instruments.find((i) => i.id === selectedId);
  const isSynthSelected = selectedInstrument?.type === 'synth';
  const isSamplerSelected = selectedInstrument?.type === 'sampler';
  const isLooperSelected = selectedInstrument?.type === 'looper';
  const synthPanelMode = useStore((s) => s.synthPanelMode);
  const synthPanelCollapsed = useStore((s) => s.synthPanelCollapsed);
  const isSynthFloating = isSynthSelected && synthPanelMode === 'floating';
  const isSynthHidden = isSynthFloating || (isSynthSelected && synthPanelCollapsed);
  const hasSelection = !!selectedInstrument;

  // Performance monitor — toggle with Ctrl+Shift+P or window.__orbitrackPerf
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__orbitrackPerf = perfMonitor;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyP') {
        e.preventDefault();
        perfMonitor.toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    // Count Zustand store updates for perf monitoring
    const unsub = useStore.subscribe(countStoreUpdate);
    return () => { window.removeEventListener('keydown', onKey); unsub(); };
  }, []);

  const [layerSidebarOpen, setLayerSidebarOpen] = useState(true);
  const [fxSidebarOpen, setFxSidebarOpen] = useState(true);
  const DEFAULT_BOTTOM_H = 24 * 20 + 33;
  const { height: bottomHeight, onMouseDown: onResizeMouseDown } = useResizable(DEFAULT_BOTTOM_H);
  const { size: layerWidth, onMouseDown: onLayerResizeDown, isDragging: layerIsDragging } = useResizable(300, 160, 'x');
  const { size: fxWidth, onMouseDown: onFxResizeDown, isDragging: fxIsDragging } = useResizable(300, 160, 'x');
  // Synth wide mode: measure bottom bar width, override right panel to ~50%
  const synthWideMode = useStore((s) => s.synthWideMode);
  const bottomBarRef = useRef<HTMLDivElement>(null);
  const [bottomBarWidth, setBottomBarWidth] = useState(0);

  useEffect(() => {
    const el = bottomBarRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setBottomBarWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const wideModeOverride = synthWideMode && isSynthSelected
    ? Math.max(500, Math.floor(bottomBarWidth * 0.5))
    : null;
  const { size: rightPanelWidth, onMouseDown: onRightPanelResizeDown, isDragging: rightIsDragging } = useResizable(300, 160, 'x', 1, wideModeOverride);

  // Delayed unmount: keep content rendered during the close animation
  const [bottomContentMounted, setBottomContentMounted] = useState(hasSelection);
  const unmountTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (hasSelection) {
      clearTimeout(unmountTimer.current);
      setBottomContentMounted(true);
    } else {
      // Keep content mounted during the 250ms close animation, then unmount
      unmountTimer.current = setTimeout(() => setBottomContentMounted(false), 260);
    }
    return () => clearTimeout(unmountTimer.current);
  }, [hasSelection]);

  useEffect(() => {
    const startAudio = async () => {
      await Tone.start();
      // Apply saved audio output device
      const savedOutputId = localStorage.getItem('orbitrack_audioOutputDeviceId');
      if (savedOutputId) {
        import('./audio/audioInput').then(({ setAudioOutputDevice }) => {
          setAudioOutputDevice(savedOutputId);
        });
      }
      window.removeEventListener('mousedown', startAudio);
    };
    window.addEventListener('mousedown', startAudio);
    return () => window.removeEventListener('mousedown', startAudio);
  }, []);

  const initDone = useRef(false);
  useEffect(() => {
    if (initDone.current) return;
    initDone.current = true;

    (async () => {
      // Check for shared URL hash first
      const sharedHash = parseShareHash();
      let restored = false;

      if (sharedHash) {
        try {
          const set = await decodeSetFromUrl(sharedHash);
          useStore.getState().loadSet(set);
          restored = true;
          // Clear hash without adding to browser history
          history.replaceState(null, '', window.location.pathname + window.location.search);
        } catch (e) {
          console.error('[App] Failed to load shared URL:', e);
        }
      }

      if (!restored) {
        // Try restoring from last saved set ID
        const lastSetId = getLastSetId();
        if (lastSetId) {
          restored = await restoreFromSetId(lastSetId);
        }
      }

      if (!restored) {
        // Migration: try legacy __autosave__ entry
        restored = await restoreLegacyAutosave();
      }

      if (!restored) {
        // Last resort: check for emergency localStorage snapshot (saved on beforeunload)
        restored = restoreEmergencySnapshot();
      }

      // Clear emergency snapshot now that we've either restored from it or from IDB
      clearEmergencySnapshot();

      // Seed factory presets & hydrate recordings
      seedFactory();
      seedEffectFactory();
      useStore.getState().hydrateRecordings();
      initRecordingSync();
      initSessionAutosave();
      initUndoHistory();

      // Only assign random samples on fresh launch (no saved session)
      if (!restored) {
        const CATEGORIES = [
          { keywords: ['kick'],          index: 0 },
          { keywords: ['snare', 'clap'], index: 1 },
          { keywords: ['hat', 'hh'],     index: 2 },
          { keywords: ['conga'],         index: 3 },
        ];
        const tree = await fetchSampleTree();
        const files = flattenFiles(tree);
        const store = useStore.getState();
        const instruments = store.instruments;
        for (const { keywords, index } of CATEGORIES) {
          const inst = instruments[index];
          if (!inst) continue;
          const matches = files.filter((f) =>
            keywords.some((kw) => f.name.toLowerCase().includes(kw))
          );
          if (matches.length === 0) continue;
          const pick = matches[Math.floor(Math.random() * matches.length)];
          store.assignSample(inst.id, pick.path, pick.name.replace(/\.[^.]+$/, ''));
        }
      }
    })();
  }, []);

  return (
    <div className="app-root flex flex-col h-full bg-bg">
      {/* Main area */}
      <div className="app-main flex flex-1 min-h-0 overflow-hidden">

        {/* Orbit visualization */}
        <div className="orbit-viewport flex-1 relative overflow-hidden min-h-0">
          <KnobGrid isResizing={layerIsDragging || fxIsDragging || rightIsDragging} />
        </div>

        {/* Layers toggle tab */}
        <button
          className="flex items-center justify-center w-4 shrink-0 bg-bg-secondary border-l border-border hover:bg-white/5 transition-colors cursor-pointer"
          onClick={() => setLayerSidebarOpen((o) => !o)}
          title={layerSidebarOpen ? 'Hide layers' : 'Show layers'}
        >
          <span className="text-text-secondary text-[10px] leading-none">
            {layerSidebarOpen ? '›' : '‹'}
          </span>
        </button>

        {/* Resize handle on left edge of layers sidebar */}
        {layerSidebarOpen && (
          <div
            className="resize-handle cursor-ew-resize shrink-0 flex items-center justify-center group hover:bg-accent/10 transition-colors"
            style={{ width: 4, borderRight: '1px solid rgba(255,255,255,0.1)' }}
            onMouseDown={onLayerResizeDown}
          >
            <div className="h-10 w-0.5 rounded-full bg-border/60 group-hover:bg-accent/60 transition-colors" />
          </div>
        )}

        {/* Layers sidebar */}
        <div
          className={`overflow-hidden shrink-0 h-full ${layerIsDragging ? '' : 'transition-[width] duration-300'}`}
          style={{ width: layerSidebarOpen ? layerWidth : 0 }}
        >
          <InstrumentRack />
        </div>

        {/* FX toggle tab */}
        <button
          className="flex items-center justify-center w-4 shrink-0 bg-bg-secondary border-l border-border hover:bg-white/5 transition-colors cursor-pointer"
          onClick={() => setFxSidebarOpen((o) => !o)}
          title={fxSidebarOpen ? 'Hide FX' : 'Show FX'}
        >
          <span className="text-text-secondary text-[10px] leading-none">
            {fxSidebarOpen ? '›' : '‹'}
          </span>
        </button>

        {/* Resize handle on left edge of FX sidebar */}
        {fxSidebarOpen && (
          <div
            className="resize-handle cursor-ew-resize shrink-0 flex items-center justify-center group hover:bg-accent/10 transition-colors"
            style={{ width: 4, borderRight: '1px solid rgba(255,255,255,0.1)' }}
            onMouseDown={onFxResizeDown}
          >
            <div className="h-10 w-0.5 rounded-full bg-border/60 group-hover:bg-accent/60 transition-colors" />
          </div>
        )}

        {/* FX Chain sidebar */}
        <div
          className={`overflow-hidden shrink-0 h-full ${fxIsDragging ? '' : 'transition-[width] duration-300'}`}
          style={{ width: fxSidebarOpen ? fxWidth : 0 }}
        >
          <EffectsSidebar />
        </div>
      </div>

      {/* Grid sequencer + instrument panel — animated slide */}
      <div
        className="grid shrink-0 overflow-hidden"
        style={{
          gridTemplateRows: hasSelection ? '1fr' : '0fr',
          transition: 'grid-template-rows 250ms cubic-bezier(0.25, 0.1, 0.25, 1)',
        }}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            className="resize-handle h-1.5 cursor-ns-resize border-t border-border flex items-center justify-center group shrink-0 hover:bg-accent/10 transition-colors"
            onMouseDown={onResizeMouseDown}
          >
            <div className="w-10 h-0.5 rounded-full bg-border/60 group-hover:bg-accent/60 transition-colors" />
          </div>
          {bottomContentMounted && (
            <div
              ref={bottomBarRef}
              className="synth-bottom-bar flex overflow-hidden min-h-0"
              style={{ height: bottomHeight }}
            >
              {isLooperSelected ? <LooperEditor /> : <GridSequencer />}
              {/* Right panel resize handle + container (hidden when synth is floating or collapsed) */}
              {((isSynthSelected && !isSynthHidden) || isSamplerSelected || isLooperSelected) && (
                <>
                  <div
                    className="resize-handle cursor-ew-resize shrink-0 flex items-center justify-center group hover:bg-accent/10 transition-colors"
                    style={{ width: 4, borderLeft: '1px solid rgba(255,255,255,0.1)' }}
                    onMouseDown={onRightPanelResizeDown}
                  >
                    <div className="h-10 w-0.5 rounded-full bg-border/60 group-hover:bg-accent/60 transition-colors" />
                  </div>
                  <div className={`shrink-0 h-full overflow-hidden ${rightIsDragging ? '' : 'transition-[width] duration-300'}`} style={{ width: rightPanelWidth }}>
                    {isSynthSelected && !isSynthFloating && <SynthPanel />}
                    {isSamplerSelected && <SampleBank />}
                    {isLooperSelected && <LoopBrowser />}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div
        className="overflow-hidden shrink-0 transition-[max-height] duration-300"
        style={{ maxHeight: trackMode ? '500px' : '0px' }}
      >
        {trackMode && <TrackTimeline />}
      </div>

      <div
        className="overflow-hidden shrink-0 transition-[max-height] duration-300"
        style={{ maxHeight: liveMode ? '340px' : '0px' }}
      >
        {liveMode && <LiveBar />}
      </div>

      {logEnabled && showLogConsole && <LogConsole />}

      {/* Floating synth popup */}
      {isSynthFloating && (
        <FloatingPanel title="orbisynth" color={selectedInstrument!.color}>
          <SynthPanel />
        </FloatingPanel>
      )}

      <TransportBar />
    </div>
  );
}

export default App;
