import { useStore } from '../state/store';
import { createRNG } from './rng';
import type {
  GenerationParams,
  GenerationContext,
  GeneratedPattern,
  OctaveOverride,
} from './types';
import { generateRandom } from './generators/random';
import { generateScaleBased } from './generators/scaleBased';
import { generateChordBased } from './generators/chordBased';
import { generateBassline } from './generators/bassline';
import { generateDrumPattern } from './generators/drumPattern';
import { classifyInstrument } from './sampleClassifier';

/**
 * Run the selected generator and return a pattern (does NOT apply to store).
 * Note: 'prompt' mode is async and must be handled separately via generateFromPrompt.
 */
export function runGenerator(
  ctx: GenerationContext,
  genParams: GenerationParams,
  seed: number,
  sampleName?: string,
): GeneratedPattern {
  const rng = createRNG(seed);

  switch (genParams.mode) {
    case 'random':
      return generateRandom(ctx, genParams.params, rng);
    case 'scaleBased':
      return generateScaleBased(ctx, genParams.params, rng);
    case 'chordBased':
      return generateChordBased(ctx, genParams.params, rng);
    case 'bassline':
      return generateBassline(ctx, genParams.params, rng);
    case 'drumPattern':
      return generateDrumPattern(ctx, genParams.params, rng, sampleName);
    case 'prompt':
      // Prompt mode is async — return empty pattern, UI handles LLM call separately
      return { events: [] };
    default:
      return { events: [] };
  }
}

/**
 * Build a GenerationContext from current store state for a given instrument.
 */
export function buildContext(
  instrumentId: string,
  octaveOverride?: OctaveOverride,
): GenerationContext | null {
  const s = useStore.getState();
  const inst = s.instruments.find((i) => i.id === instrumentId);
  if (!inst) return null;

  // Determine octave range: use override if provided, else use global offset
  const octaveBase = octaveOverride?.base ?? s.octaveOffset + 1;
  const octaveSpan = octaveOverride?.span ?? 2;
  const startNote = octaveBase * 12;
  const octaveRange: [number, number] = [startNote, startNote + octaveSpan * 12 - 1];

  // Classify the instrument for role-aware generation
  const instrumentRole = classifyInstrument(inst.sampleName ?? '', inst.name);

  return {
    scaleRoot: s.scaleRoot,
    scaleType: s.scaleType,
    loopSize: inst.loopSize,
    gridResolution: s.gridResolution,
    instrumentType: inst.type === 'looper' ? 'sampler' : inst.type as 'synth' | 'sampler',
    octaveRange,
    instrumentRole,
    octaveBase,
    octaveSpan,
  };
}

/**
 * Apply a generated pattern to an instrument, replacing its current notes.
 * Snapshots old state for undo, then does a SINGLE atomic setState.
 */
export function applyPattern(
  instrumentId: string,
  pattern: GeneratedPattern,
): void {
  // Snapshot first (uses its own setState)
  useStore.getState().snapshotForUndo(instrumentId);

  // Now build the new state atomically
  useStore.setState((s) => {
    const inst = s.instruments.find((i) => i.id === instrumentId);
    if (!inst) return s;

    // Sort events by step
    const sorted = [...pattern.events].sort((a, b) => a.step - b.step);

    // Build new hitPositions, gridNotes, gridLengths, gridGlide from scratch
    const newPositions: number[] = [];
    const newNotes: number[][] = [];
    const newLengths: number[][] = [];
    const newGlide: boolean[] = [];

    for (const event of sorted) {
      const position = event.step / inst.loopSize;
      newPositions.push(position);
      newNotes.push(event.notes);
      newLengths.push(event.notes.map(() => event.length ?? 1));
      newGlide.push(event.glide ?? false);
    }

    return {
      instruments: s.instruments.map((i) => {
        if (i.id !== instrumentId) return i;
        return { ...i, hits: newPositions.length, hitPositions: newPositions };
      }),
      gridNotes: { ...s.gridNotes, [instrumentId]: newNotes },
      gridLengths: { ...s.gridLengths, [instrumentId]: newLengths },
      gridGlide: { ...s.gridGlide, [instrumentId]: newGlide },
    };
  });
}

/**
 * One-call: generate + apply. Returns the pattern for inspection.
 */
export function generateAndApply(
  instrumentId: string,
  genParams: GenerationParams,
  seed: number,
  octaveOverride?: OctaveOverride,
): GeneratedPattern | null {
  const ctx = buildContext(instrumentId, octaveOverride);
  if (!ctx) { console.warn('[generateAndApply] buildContext returned null for', instrumentId); return null; }

  const inst = useStore.getState().instruments.find((i) => i.id === instrumentId);
  const sampleName = inst?.sampleName ?? '';

  const pattern = runGenerator(ctx, genParams, seed, sampleName);
  console.log('[generateAndApply] ctx:', ctx, 'pattern events:', pattern.events.length, pattern.events.slice(0, 3));
  applyPattern(instrumentId, pattern);
  return pattern;
}
