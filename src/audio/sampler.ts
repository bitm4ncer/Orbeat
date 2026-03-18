import * as Tone from 'tone';
import { SAMPLE_BASE_URL } from './sampleBaseUrl';

const players: Map<string, { player: Tone.Player; url: string }> = new Map();
let output: Tone.Gain | null = null;
let previewPlayer: Tone.Player | null = null;

// Legacy aliases for default instruments
const LEGACY_ALIASES: Record<string, string> = {
  kick: 'samples/Akei/MPC-3000/Drums/MPC-3000_Kick_001.wav',
  snare: 'samples/Akei/MPC-3000/Drums/MPC-3000_Snare_001.wav',
  hihat: 'samples/Akei/MPC-3000/Drums/MPC-3000_HiHat_001.wav',
  clap: 'samples/Akei/MPC-3000/Drums/MPC-3000_Clap_001.wav',
};

function ensureOutput(): Tone.Gain {
  const ctx = Tone.getContext();
  const isStale = !output || output.disposed || output.context !== ctx;

  if (isStale) {
    // Context changed — all existing players are stale, clear them
    if (output && output.context !== ctx) {
      for (const [, entry] of players) {
        try { entry.player.dispose(); } catch { /* ok */ }
      }
      players.clear();
    }
    if (output && !output.disposed) {
      try { output.dispose(); } catch { /* ok */ }
    }
    output = new Tone.Gain(1).toDestination();
  }
  return output;
}

export async function loadSample(key: string, url: string): Promise<void> {
  const out = ensureOutput();
  const existing = players.get(key);

  // Already loaded with same URL
  if (existing && existing.url === url) return;

  // Dispose old player if different URL
  if (existing) {
    existing.player.stop();
    existing.player.disconnect();
    existing.player.dispose();
  }

  return new Promise<void>((resolve) => {
    const player = new Tone.Player({
      url,
      onload: () => resolve(),
      onerror: () => resolve(), // Don't block on load errors
    }).connect(out);
    players.set(key, { player, url });
  });
}

export async function loadSamples(): Promise<void> {
  ensureOutput();
  const promises = Object.entries(LEGACY_ALIASES).map(([key, url]) => loadSample(key, url));
  await Promise.all(promises);
}

export function triggerSample(name: string, time?: number, volume = 0, playbackRate = 1.0): void {
  // Resolve legacy alias
  const key = LEGACY_ALIASES[name] ? name : name;
  const entry = players.get(key);
  if (!entry || !entry.player.loaded) return;
  entry.player.volume.value = volume;
  entry.player.playbackRate = playbackRate;
  entry.player.start(time);
}

export function previewSample(url: string): void {
  stopPreview();
  Tone.start(); // ensure AudioContext is resumed
  const out = ensureOutput();
  const resolved = url.startsWith('blob:') || url.startsWith('http')
    ? url
    : SAMPLE_BASE_URL + url;
  previewPlayer = new Tone.Player({
    url: resolved,
    autostart: true,
    onload: () => {
      // Player auto-starts after loading
    },
  }).connect(out);
}

export function stopPreview(): void {
  if (previewPlayer) {
    try {
      previewPlayer.stop();
    } catch {
      // Ignore if not started
    }
    previewPlayer.disconnect();
    previewPlayer.dispose();
    previewPlayer = null;
  }
}

export function getSampleNames(): string[] {
  return Object.keys(LEGACY_ALIASES);
}
