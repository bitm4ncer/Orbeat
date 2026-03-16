/**
 * FM Algorithm definitions for 4-operator FM synthesis.
 *
 * Each algorithm defines:
 * - connections[mod][car]: operator `mod` modulates operator `car`'s frequency
 * - outputs[i]: operator `i` is a carrier (summed to audio output)
 *
 * Operators are numbered 0-3 (displayed as 1-4 in UI).
 */

export interface FMAlgorithm {
  id: number;
  name: string;
  connections: boolean[][];  // 4×4 modulation matrix
  outputs: boolean[];        // which operators output audio
}

// Helper: create a 4×4 false matrix
function matrix(): boolean[][] {
  return [
    [false, false, false, false],
    [false, false, false, false],
    [false, false, false, false],
    [false, false, false, false],
  ];
}

/**
 * 8 preset algorithms covering common FM topologies.
 *
 * Visual legend: → = modulates, [out] = carrier output
 *   Op numbers in comments are 1-indexed (UI display)
 */
export const FM_ALGORITHMS: FMAlgorithm[] = [
  // 1. Stack: 4→3→2→1→[out]
  (() => {
    const c = matrix();
    c[3][2] = true; // 4→3
    c[2][1] = true; // 3→2
    c[1][0] = true; // 2→1
    return { id: 0, name: 'Stack', connections: c, outputs: [true, false, false, false] };
  })(),

  // 2. Branch: 3→1→[out], 4→2→[out]
  (() => {
    const c = matrix();
    c[2][0] = true; // 3→1
    c[3][1] = true; // 4→2
    return { id: 1, name: 'Branch', connections: c, outputs: [true, true, false, false] };
  })(),

  // 3. Y-Split: 4→3→1→[out], 4→2→[out]
  (() => {
    const c = matrix();
    c[3][2] = true; // 4→3
    c[2][0] = true; // 3→1
    c[3][1] = true; // 4→2
    return { id: 2, name: 'Y-Split', connections: c, outputs: [true, true, false, false] };
  })(),

  // 4. Parallel: 1→[out], 2→[out], 3→[out], 4→[out] (additive)
  (() => {
    const c = matrix();
    return { id: 3, name: 'Parallel', connections: c, outputs: [true, true, true, true] };
  })(),

  // 5. Fork: 2→1, 3→1, 4→1→[out] (3 modulators into 1 carrier)
  (() => {
    const c = matrix();
    c[1][0] = true; // 2→1
    c[2][0] = true; // 3→1
    c[3][0] = true; // 4→1
    return { id: 4, name: 'Fork', connections: c, outputs: [true, false, false, false] };
  })(),

  // 6. Stack+1: 4→3→2→[out], 1→[out]
  (() => {
    const c = matrix();
    c[3][2] = true; // 4→3
    c[2][1] = true; // 3→2
    return { id: 5, name: 'Stack+1', connections: c, outputs: [true, true, false, false] };
  })(),

  // 7. 2+2 Shared: 3→1→[out], 3→2→[out], 4→2 (shared modulator)
  (() => {
    const c = matrix();
    c[2][0] = true; // 3→1
    c[2][1] = true; // 3→2
    c[3][1] = true; // 4→2
    return { id: 6, name: '2+2 Shared', connections: c, outputs: [true, true, false, false] };
  })(),

  // 8. Dual Stack: 4→3→[out], 2→1→[out]
  (() => {
    const c = matrix();
    c[3][2] = true; // 4→3
    c[1][0] = true; // 2→1
    return { id: 7, name: 'Dual Stack', connections: c, outputs: [true, false, true, false] };
  })(),
];
