import { useRef, useState, useEffect } from 'react';
import { useStore } from '../../state/store';
import { toggleTransport, setBpm } from '../../audio/transport';
import { initAudio } from '../../audio/engine';
import { loadSamples } from '../../audio/sampler';
import { FilesMenu } from './FilesMenu';
import { SettingsPopup } from './SettingsPopup';
import { MidiLight } from './MidiLight';
const orbitrackLogo = `${import.meta.env.BASE_URL}orbitrack_logo.svg`;

const audioInitRef = { initialized: false };

async function ensureAudio() {
  if (audioInitRef.initialized) return;
  await initAudio();
  await loadSamples();
  audioInitRef.initialized = true;
}

function FullscreenButton() {
  const [isFs, setIsFs] = useState(!!document.fullscreenElement);

  useEffect(() => {
    const handler = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const toggle = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  };

  return (
    <button
      onClick={toggle}
      className="rounded border border-border text-text-secondary hover:border-white/30 hover:text-text-primary transition-colors flex items-center justify-center cursor-pointer"
      style={{ width: 22, height: 14 }}
      title={isFs ? 'Exit fullscreen' : 'Enter fullscreen'}
    >
      <svg width="14" height="8" viewBox="0 0 16 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {isFs ? (
          <>
            <polyline points="4 9 4 6 0 6" />
            <polyline points="12 0 12 3 16 3" />
            <line x1="0" y1="6" x2="4" y2="3.5" />
            <line x1="16" y1="3" x2="12" y2="5.5" />
          </>
        ) : (
          <>
            <polyline points="0 3 0 0 4 0" />
            <polyline points="12 9 16 9 16 6" />
            <line x1="0" y1="0" x2="4" y2="2.5" />
            <line x1="16" y1="9" x2="12" y2="6.5" />
          </>
        )}
      </svg>
    </button>
  );
}

export function TransportBar() {
  const isPlaying = useStore((s) => s.isPlaying);
  const bpm = useStore((s) => s.bpm);
  const stepsPerBeat = useStore((s) => s.stepsPerBeat);
  const setStepsPerBeat = useStore((s) => s.setStepsPerBeat);
  const trackMode = useStore((s) => s.trackMode);
  const toggleTrackMode = useStore((s) => s.toggleTrackMode);
  const liveMode = useStore((s) => s.liveMode);
  const toggleLiveMode = useStore((s) => s.toggleLiveMode);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const filesRef = useRef<HTMLButtonElement>(null);

  const handlePlayStop = async () => {
    await ensureAudio();
    toggleTransport();
  };

  const tapTimesRef = useRef<number[]>([]);

  const handleTapBpm = () => {
    const now = performance.now();
    const taps = tapTimesRef.current;
    // Reset if last tap was more than 2 seconds ago
    if (taps.length > 0 && now - taps[taps.length - 1] > 2000) {
      tapTimesRef.current = [];
    }
    tapTimesRef.current.push(now);
    const recent = tapTimesRef.current;
    if (recent.length >= 2) {
      const intervals = [];
      for (let i = 1; i < recent.length; i++) {
        intervals.push(recent[i] - recent[i - 1]);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const tappedBpm = Math.round(Math.min(240, Math.max(40, 60000 / avgInterval)));
      setBpm(tappedBpm);
    }
  };

  const handleBpmChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setBpm(Number(e.target.value));
  };

  const handleGridChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setStepsPerBeat(Number(e.target.value));
  };

  return (
    <div className="transport-bar relative flex items-center bg-bg-secondary border-t border-border">
      <div className="transport-logo flex items-center gap-3">
        <img src={orbitrackLogo} alt="orbitrack" className="h-6" />
        <button
          ref={filesRef}
          onClick={() => setFilesOpen((o) => !o)}
          className="text-[10px] uppercase tracking-wider text-text-secondary/60 hover:text-text-primary px-2 py-1 transition-colors"
        >
          Files
        </button>
        {filesOpen && <FilesMenu anchorRef={filesRef} onClose={() => setFilesOpen(false)} />}
      </div>

      <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-3">
        <button
          onClick={toggleTrackMode}
          className={`px-2 py-1 text-xs rounded font-mono tracking-wide transition-colors border cursor-pointer
            ${trackMode ? 'border-current' : 'text-muted-foreground hover:text-foreground border-transparent'}`}
          style={
            trackMode
              ? {
                  backgroundColor: '#c1eeca',
                  color: '#1a1a1a',
                  borderColor: '#a8dab0',
                }
              : {}
          }
          title="Toggle Track Mode"
        >
          TRACK
        </button>
        <button
          onClick={handlePlayStop}
          className="transport-play-btn flex items-center justify-center w-16 h-16 rounded-full
                     bg-bg-tertiary hover:bg-white/10 transition-colors
                     border border-border hover:border-white/30"
        >
          {isPlaying ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <rect x="1" y="1" width="4" height="12" rx="1" />
              <rect x="9" y="1" width="4" height="12" rx="1" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <polygon points="2,0 14,7 2,14" />
            </svg>
          )}
        </button>
        <button
          onClick={toggleLiveMode}
          className={`px-2 py-1 text-xs rounded font-mono tracking-wide transition-colors border cursor-pointer
            ${liveMode ? 'border-current' : 'text-muted-foreground hover:text-[#e7a2aa] border-transparent'}`}
          style={
            liveMode
              ? {
                  backgroundColor: '#e7a2aa',
                  color: '#1a1a1a',
                  borderColor: '#d4868f',
                }
              : {}
          }
          title="Toggle Live Mode"
        >
          LIVE
        </button>
      </div>

      <div className="transport-spacer flex-1" />

      <div className="transport-bpm flex items-center gap-2">
        <button
          onClick={handleTapBpm}
          title="Click to Tap BPM"
          className="transport-bpm-label text-xs text-text-secondary uppercase tracking-wide cursor-pointer hover:text-text-primary transition-colors"
        >BPM</button>
        <input
          type="number"
          min={40}
          max={240}
          value={bpm}
          onChange={handleBpmChange}
          className="transport-bpm-input w-16 bg-bg-tertiary border border-border rounded px-2 py-0.5 text-sm text-text-primary font-mono text-center focus:outline-none focus:border-white/30"
        />
        <select
          value={stepsPerBeat}
          onChange={handleGridChange}
          className="bg-bg-tertiary border border-border rounded px-2 py-0.5 text-xs text-text-primary font-mono focus:outline-none focus:border-white/30"
          title="Grid resolution"
        >
          <option value={4}>16th</option>
          <option value={8}>32nd</option>
          <option value={16}>64th</option>
        </select>
        <MidiLight />
        <button
          onClick={() => setSettingsOpen(true)}
          className="px-2 py-1 rounded border border-border text-text-secondary hover:border-white/30 hover:text-text-primary transition-colors text-[11px] font-semibold cursor-pointer"
          title="Settings"
        >
          Settings
        </button>
        <FullscreenButton />
      </div>

      {settingsOpen && <SettingsPopup onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
