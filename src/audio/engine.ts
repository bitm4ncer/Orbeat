import * as Tone from 'tone';
import { samples, loadBuffer, getAudioContext as getSdAudioContext, loadWorklets, setMaxPolyphony } from 'superdough';
import { initRoutingEngine } from './routingEngine';
import { initSceneBusesFromState } from './sceneBus';
import { SAMPLE_BASE_URL } from './sampleBaseUrl';
import { log, setLogAudioContext } from '../logging/logger';

let initialized = false;

/** Re-initialize scene buses from current store state (called after audio init). */
async function initSceneBusesFromStore(): Promise<void> {
  try {
    const { useStore } = await import('../state/store');
    const s = useStore.getState();
    if (s.scenes && s.scenes.length > 0) {
      initSceneBusesFromState(s.scenes, s.instruments);
    }
  } catch { /* store not ready yet — safe to skip */ }
}

// Suppress superdough's internal "node.onended" deprecation warning — it fires
// from inside the library's own legacy code path, not from our code, and there
// is no API to opt out. The warning goes through console.log, not console.warn.
// All other console calls pass through unchanged.
const _origWarn = console.warn.bind(console);
const _origLog = console.log.bind(console);
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('node.onended')) return;
  _origWarn(...args);
};
console.log = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('node.onended')) return;
  _origLog(...args);
};

// Register the 4 default drum samples with superdough immediately at module load.
// superdough looks up `s: 'kick'` etc. in its internal soundMap — without this
// registration those sounds are never found and playback silently fails.
samples({
  _base: SAMPLE_BASE_URL,
  kick: 'samples/Akei/MPC-3000/Drums/MPC-3000_Kick_001.wav',
  snare: 'samples/Akei/MPC-3000/Drums/MPC-3000_Snare_001.wav',
  hihat: 'samples/Akei/MPC-3000/Drums/MPC-3000_HiHat_001.wav',
  clap: 'samples/Akei/MPC-3000/Drums/MPC-3000_Clap_001.wav',
});

const DEFAULT_SAMPLES: Record<string, string> = {
  kick: 'samples/Akei/MPC-3000/Drums/MPC-3000_Kick_001.wav',
  snare: 'samples/Akei/MPC-3000/Drums/MPC-3000_Snare_001.wav',
  hihat: 'samples/Akei/MPC-3000/Drums/MPC-3000_HiHat_001.wav',
  clap: 'samples/Akei/MPC-3000/Drums/MPC-3000_Clap_001.wav',
};

export async function initAudio(): Promise<void> {
  if (initialized) return;

  // Let superdough own the AudioContext — then tell Tone.js to use it.
  // This guarantees a single AudioContext for everything: superdough orbits,
  // per-note nodes, Tone.js scheduling, our effect chains, and the synth engine.
  // The old approach (Tone creates context → setAudioContext) caused cross-context
  // errors because superdough could create orbit nodes before setAudioContext ran.
  const sdCtx = getSdAudioContext() as AudioContext;
  Tone.setContext(sdCtx);
  await Tone.start();
  setLogAudioContext(sdCtx);
  log.info('engine', 'AudioContext created', { sampleRate: sdCtx.sampleRate, state: sdCtx.state, baseLatency: sdCtx.baseLatency });

  // 200ms lookahead: buffers against brief main-thread blocks without
  // throwing off the step-counter logic in transport.ts (which uses
  // transport.seconds, i.e. current audio time, not the scheduled `time`).
  Tone.getContext().lookAhead = 0.2;

  // Load superdough's AudioWorklet processors (needed for distort, crush, etc.)
  // This also causes superdough to fully initialize its internal gainNode.
  try {
    await loadWorklets();
    log.info('engine', 'Superdough worklets loaded');
  } catch (e) {
    console.warn('[engine] superdough worklets failed to load:', e);
    log.error('engine', 'Superdough worklets failed to load', e);
  }

  // Load our bitcrusher sample-rate-reduction AudioWorklet
  try {
    await sdCtx.audioWorklet.addModule(import.meta.env.BASE_URL + 'bitcrusher-processor.js');
    log.info('engine', 'Bitcrusher worklet loaded');
  } catch (e) {
    console.warn('[engine] bitcrusher worklet failed to load:', e);
    log.error('engine', 'Bitcrusher worklet failed to load', e);
  }

  // Pre-decode all default samples into superdough's buffer cache so the
  // first note plays immediately without a loading delay.
  const base = SAMPLE_BASE_URL;
  const ac = getSdAudioContext();
  await Promise.allSettled(
    Object.entries(DEFAULT_SAMPLES).map(([name, path]) =>
      loadBuffer(`${base}${path}`, ac, name, 0).catch((e) =>
        console.warn(`[engine] default sample "${name}" failed to load:`, e)
      )
    )
  );

  // Cap superdough polyphony — 128 default is too many concurrent AudioNode
  // trees for weak hardware. 48 voices is plenty for a step sequencer.
  setMaxPolyphony(48);
  log.info('engine', 'Polyphony capped at 48 voices');

  // Wire superdough output → masterGain → masterAnalyser → destination.
  // Called after loadWorklets() so superdough's gainNode is guaranteed to exist.
  // getMasterAnalyser() also retries lazily on each VU meter frame as a fallback.
  initRoutingEngine();

  initialized = true;
  log.info('engine', 'Audio engine initialized', { sampleRate: sdCtx.sampleRate, lookAhead: 0.2 });

  // Re-initialize scene buses if scenes exist in store (e.g. from autosave restore)
  initSceneBusesFromStore();
}

export function isAudioReady(): boolean {
  return initialized;
}

/**
 * Convert a sample path (e.g. 'samples/kick.wav' or a blob URL) to a
 * collision-resistant superdough sound key and register it in superdough's
 * soundMap so it can be played via `superdough({ s: key })`.
 *
 * Returns the key that was registered.
 */
const registeredSamples = new Set<string>();

export function registerSampleForPlayback(pathOrUrl: string, blobUrl?: string): string {
  const last = pathOrUrl.split('/').pop() ?? pathOrUrl;
  const key = last.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');

  // Build a dedup key so we only register + log once per unique (key, source) pair.
  // Blob URLs always re-register — each call represents a new buffer version
  // (cut, paste, undo, etc.) that superdough must pick up.
  if (!blobUrl) {
    const dedupKey = `${key}:${pathOrUrl}`;
    if (registeredSamples.has(dedupKey)) return key;
    registeredSamples.add(dedupKey);
  }

  if (blobUrl) {
    // Blob / object URL — must use empty base so superdough stores the URL as-is
    samples({ _base: '', [key]: blobUrl });
  } else {
    samples({
      _base: SAMPLE_BASE_URL,
      [key]: pathOrUrl,
    });
  }

  log.debug('engine', `Sample registered: ${key}`, { path: pathOrUrl, blob: !!blobUrl });
  return key;
}
