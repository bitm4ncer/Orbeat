import type { OrbitrackSet, SetMeta, EmbeddedSample } from '../types/storage';
import type { Instrument } from '../types/instrument';
import type { Effect } from '../types/effects';
import type { InstrumentScene } from '../types/scene';
import type { ArrangementStep } from '../types/arrangement';

// ── Helpers ──────────────────────────────────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

export async function sampleToBase64(blobUrl: string): Promise<{ base64: string; mimeType: string }> {
  const resp = await fetch(blobUrl);
  const blob = await resp.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      const [header, data] = dataUrl.split(',');
      const mimeType = header.match(/data:(.*?);/)?.[1] ?? 'audio/wav';
      resolve({ base64: data, mimeType });
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mimeType });
}

// ── Serialize ────────────────────────────────────────────────────────────────

export interface SerializeOptions {
  name: string;
  embedSamples: boolean;
  includeInstruments: boolean;
  includeEffects: boolean;
  includeSynthParams: boolean;
}

export interface SerializableState {
  bpm: number;
  masterVolume: number;
  instruments: Instrument[];
  gridNotes: Record<string, number[][]>;
  gridGlide: Record<string, boolean[]>;
  gridLengths: Record<string, number[] | number[][]>;
  gridVelocities?: Record<string, number[]>;
  instrumentEffects: Record<string, Effect[]>;
  masterEffects?: Effect[];
  scenes?: InstrumentScene[];
  sceneEffects?: Record<string, Effect[]>;
  customSamples: { key: string; url: string; name: string }[];
  gridResolution?: number;
  scaleRoot?: number;
  scaleType?: string;
  trackMode?: boolean;
  arrangement?: ArrangementStep[];
}

export async function serializeSet(
  state: SerializableState,
  options: SerializeOptions,
): Promise<OrbitrackSet> {
  const now = Date.now();
  const meta: SetMeta = {
    id: uid(),
    name: options.name,
    createdAt: now,
    updatedAt: now,
  };

  let embedded: EmbeddedSample[] | undefined;
  if (options.embedSamples && state.customSamples.length > 0) {
    embedded = await Promise.all(
      state.customSamples.map(async (s) => {
        const { base64, mimeType } = await sampleToBase64(s.url);
        return { key: s.key, name: s.name, mimeType, base64 };
      }),
    );
  }

  // Optionally strip sections the user unchecked
  const instruments = options.includeInstruments
    ? state.instruments
    : [];
  const effects = options.includeEffects
    ? state.instrumentEffects
    : {};
  const gridNotes = options.includeInstruments ? state.gridNotes : {};
  const gridGlide = options.includeInstruments ? state.gridGlide : {};
  const gridLengths = options.includeInstruments ? state.gridLengths : {};

  // Strip synthParams if unchecked
  const finalInstruments = options.includeSynthParams
    ? instruments
    : instruments.map((i) => ({ ...i, synthParams: undefined }));

  return {
    id: meta.id,
    version: 1,
    meta,
    bpm: state.bpm,
    masterVolume: state.masterVolume,
    instruments: finalInstruments,
    gridNotes,
    gridGlide,
    gridLengths,
    gridVelocities: state.gridVelocities,
    instrumentEffects: effects,
    masterEffects: state.masterEffects,
    scenes: state.scenes,
    sceneEffects: state.sceneEffects,
    customSamples: embedded,
    gridResolution: state.gridResolution,
    scaleRoot: state.scaleRoot,
    scaleType: state.scaleType,
    trackMode: state.trackMode,
    arrangement: state.arrangement,
  };
}

// ── Deserialize ──────────────────────────────────────────────────────────────

export function deserializeSet(json: unknown): OrbitrackSet {
  const obj = json as Record<string, unknown>;
  if (!obj || typeof obj !== 'object') throw new Error('Invalid .orb file');
  if (obj.version !== 1) throw new Error(`Unsupported version: ${obj.version}`);
  // Ensure top-level id exists (older exports may lack it)
  const set = obj as unknown as OrbitrackSet;
  if (!set.id && set.meta?.id) set.id = set.meta.id;
  return set;
}

// ── File I/O ─────────────────────────────────────────────────────────────────

export function exportSetToFile(set: OrbitrackSet): void {
  const json = JSON.stringify(set, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${set.meta.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.orb`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function importSetFromFile(file: File): Promise<OrbitrackSet> {
  const text = await file.text();
  const json = JSON.parse(text);
  return deserializeSet(json);
}
