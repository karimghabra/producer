/**
 * Pulse — factory defaults.
 *
 * Opening the app should drop you into something that already grooves. This
 * builds a full eight-track EDM kit, four scenes, and a keyboard map where
 * every one of the four layers does something worth pressing.
 */

import {
  type Project, type Track, type Pattern, type Step, type Cell, type KeyMap,
  type Instrument, type DrumEngine, type SynthEngine, type Scene,
  type DrumParams, type SynthParams, type MasterFx,
  CELLS_PER_LAYER, LAYER_COUNT, GRID_COLS,
} from './types.ts';

export function uid(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/** Mutate a freshly built value inline and hand it back. */
function tap<T>(value: T, fn: (v: T) => void): T {
  fn(value);
  return value;
}

// ---------------------------------------------------------------------------
// Steps & patterns
// ---------------------------------------------------------------------------

export function emptyStep(): Step {
  return {
    on: false,
    velocity: 0.8,
    degree: 0,
    octave: 0,
    length: 1,
    ratchet: 1,
    nudge: 0,
    slide: false,
    accent: false,
    cond: { type: 'always' },
  };
}

export function makePattern(name: string, length = 16, resolution = 4): Pattern {
  return {
    id: uid('pat'),
    name,
    length,
    resolution,
    mode: 'manual',
    euclid: { pulses: Math.max(1, Math.round(length / 4)), rotation: 0, invert: false },
    steps: Array.from({ length }, emptyStep),
  };
}

/** Turn a "x..x..x." string into a pattern. `x` hit, `X` accent, `.` rest. */
export function patternFromString(name: string, s: string, resolution = 4): Pattern {
  const chars = s.replace(/\s/g, '').split('');
  const p = makePattern(name, chars.length, resolution);
  chars.forEach((c, i) => {
    if (c === 'x' || c === 'X' || c === 'o') {
      p.steps[i].on = true;
      p.steps[i].accent = c === 'X';
      p.steps[i].velocity = c === 'X' ? 1 : c === 'o' ? 0.5 : 0.8;
    }
  });
  return p;
}

/** Melodic pattern from degree numbers; `.` is a rest. */
export function melodyFromArray(
  name: string,
  degrees: (number | null)[],
  opts: { octave?: number; length?: number; resolution?: number } = {},
): Pattern {
  const p = makePattern(name, opts.length ?? degrees.length, opts.resolution ?? 4);
  degrees.forEach((d, i) => {
    if (d === null || i >= p.steps.length) return;
    p.steps[i].on = true;
    p.steps[i].degree = d;
    p.steps[i].octave = opts.octave ?? 0;
    p.steps[i].velocity = 0.85;
  });
  return p;
}

// ---------------------------------------------------------------------------
// Instrument presets
// ---------------------------------------------------------------------------

export function drumParams(over: Partial<DrumParams> = {}): DrumParams {
  return {
    tune: 55, decay: 0.4, pitchMod: 24, pitchTime: 0.045,
    noise: 0, drive: 0.3, cutoff: 18000, resonance: 0.7, snap: 0.5,
    ...over,
  };
}

export function synthParams(over: Partial<SynthParams> = {}): SynthParams {
  return {
    voices: 7, detune: 0.35, spread: 0.7, octave: 0, sub: 0,
    fmRatio: 2, fmIndex: 3,
    filterType: 'lowpass', cutoff: 4000, resonance: 4, filterEnv: 2, keyTrack: 0.3,
    amp: { attack: 0.005, decay: 0.2, sustain: 0.7, release: 0.25 },
    filt: { attack: 0.002, decay: 0.25, sustain: 0.35, release: 0.2 },
    glide: 0, drive: 0.2,
    ...over,
  };
}

export function drumInstrument(engine: DrumEngine, over: Partial<DrumParams> = {}): Instrument {
  return {
    kind: 'drum', engine,
    drum: drumParams(over),
    synth: synthParams(),
  };
}

export function synthInstrument(engine: SynthEngine, over: Partial<SynthParams> = {}): Instrument {
  return {
    kind: 'synth', engine,
    drum: drumParams(),
    synth: synthParams(over),
  };
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

interface TrackSeed {
  name: string;
  color: string;
  instrument: Instrument;
  patterns: Pattern[];
  mixer?: Partial<Track['mixer']>;
}

function makeTrack(seed: TrackSeed): Track {
  return {
    id: uid('trk'),
    name: seed.name,
    color: seed.color,
    instrument: seed.instrument,
    mixer: {
      gain: 0.85, pan: 0, mute: false, solo: false,
      reverb: 0, delay: 0, duck: 0,
      ...seed.mixer,
    },
    patterns: seed.patterns,
    activePattern: 0,
    queuedPattern: null,
    seqEnabled: true,
  };
}

export function defaultTracks(): Track[] {
  return [
    makeTrack({
      name: 'Kick', color: '#ff4d6d',
      instrument: drumInstrument('kick', {
        tune: 50, decay: 0.55, pitchMod: 30, pitchTime: 0.04, drive: 0.45, snap: 0.45, cutoff: 9000,
      }),
      patterns: [
        patternFromString('Four', 'x...x...x...x...'),
        patternFromString('Broken', 'x...x..x..x.x...'),
        patternFromString('Half', 'x.......x.......'),
        patternFromString('Rolling', 'x..xx...x...x.xx'),
      ],
      mixer: { gain: 1.0 },
    }),
    makeTrack({
      name: 'Clap', color: '#ffd166',
      instrument: drumInstrument('clap', { tune: 1100, decay: 0.32, noise: 1, cutoff: 6500, resonance: 2 }),
      patterns: [
        patternFromString('Backbeat', '....x.......x...'),
        patternFromString('Offbeat', '....x......x.x..'),
        patternFromString('Rare', '............x...'),
        patternFromString('Double', '....x.x.....x.x.'),
      ],
      mixer: { reverb: 0.28, duck: 0.25 },
    }),
    makeTrack({
      name: 'Hats', color: '#8ef6e4',
      instrument: drumInstrument('hat', { tune: 320, decay: 0.055, cutoff: 9000, resonance: 1.2, drive: 0.15 }),
      patterns: [
        patternFromString('Offbeat', '..x...x...x...x.'),
        patternFromString('16ths', 'oxoxoxoxoxoxoxox'),
        patternFromString('Shuffle', '..x..x..x..x..x.'),
        patternFromString('Sparse', '..x.......x.....'),
      ],
      mixer: { gain: 0.6, pan: 0.15, duck: 0.35 },
    }),
    makeTrack({
      name: 'OpenHat', color: '#a0e7a0',
      instrument: drumInstrument('hat', { tune: 300, decay: 0.34, cutoff: 8000, resonance: 1, drive: 0.2 }),
      patterns: [
        patternFromString('Offbeat', '..x...x...x...x.'),
        patternFromString('Anchor', '..............x.'),
        patternFromString('Every2', '..x.......x.....'),
        patternFromString('Off', '................'),
      ],
      mixer: { gain: 0.42, pan: -0.2, reverb: 0.15, duck: 0.5 },
    }),
    makeTrack({
      name: 'Snare', color: '#ffa07a',
      instrument: drumInstrument('snare', { tune: 190, decay: 0.19, noise: 0.72, cutoff: 11000, snap: 0.7 }),
      patterns: [
        patternFromString('Ghost', '..........o.....'),
        patternFromString('Rolls', '..............xx'),
        patternFromString('Backbeat', '....x.......x...'),
        patternFromString('Off', '................'),
      ],
      mixer: { gain: 0.5, reverb: 0.2, duck: 0.3 },
    }),
    makeTrack({
      name: 'Bass', color: '#c77dff',
      instrument: synthInstrument('reese', {
        voices: 3, detune: 0.14, spread: 0.25, octave: -2, sub: 0.5,
        cutoff: 620, resonance: 7, filterEnv: 1.8, keyTrack: 0.35, drive: 0.45,
        amp: { attack: 0.004, decay: 0.14, sustain: 0.85, release: 0.09 },
        filt: { attack: 0.002, decay: 0.16, sustain: 0.25, release: 0.1 },
      }),
      patterns: [
        melodyFromArray('Root', [0, null, 0, 0, null, 0, null, 0, 0, null, 0, 0, null, 0, null, 0]),
        melodyFromArray('Walk', [0, null, 0, 2, null, 0, null, 4, 0, null, 0, 3, null, 2, null, 0]),
        melodyFromArray('Offbeat', [null, null, 0, null, null, null, 0, null, null, null, 0, null, null, null, 0, null]),
        melodyFromArray('Drive', [0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 4, 4, 3, 3, 3, 3]),
      ],
      mixer: { gain: 0.8, duck: 0.62 },
    }),
    makeTrack({
      name: 'Lead', color: '#4cc9f0',
      instrument: synthInstrument('supersaw', {
        voices: 7, detune: 0.42, spread: 0.85, octave: 0, sub: 0.15,
        cutoff: 5200, resonance: 3.5, filterEnv: 2.4, keyTrack: 0.4, drive: 0.25,
        amp: { attack: 0.008, decay: 0.3, sustain: 0.6, release: 0.35 },
        filt: { attack: 0.004, decay: 0.35, sustain: 0.4, release: 0.3 },
      }),
      patterns: [
        melodyFromArray('Hook', [0, null, 2, null, 4, null, 2, null, 3, null, 2, null, 0, null, null, null]),
        melodyFromArray('Stabs', [null, null, 4, null, null, null, 4, null, null, null, 5, null, null, null, 4, null]),
        melodyFromArray('Rise', [0, 1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2, 1, 0, null]),
        melodyFromArray('Long', [4, null, null, null, null, null, null, null, 2, null, null, null, null, null, null, null]),
      ],
      mixer: { gain: 0.62, reverb: 0.34, delay: 0.28, duck: 0.55 },
    }),
    makeTrack({
      name: 'Pad', color: '#b8c0ff',
      instrument: synthInstrument('pad', {
        voices: 5, detune: 0.28, spread: 1, octave: -1, sub: 0.1,
        cutoff: 2200, resonance: 1.5, filterEnv: 1, keyTrack: 0.2, drive: 0.1,
        amp: { attack: 0.6, decay: 1.2, sustain: 0.8, release: 1.6 },
        filt: { attack: 0.9, decay: 1.5, sustain: 0.6, release: 1.4 },
      }),
      patterns: [
        tap(melodyFromArray('Hold', [0, ...Array(15).fill(null)]), (p) => { p.steps[0].length = 16; }),
        tap(melodyFromArray('Move', [0, ...Array(7).fill(null), 5, ...Array(7).fill(null)]), (p) => {
          p.steps[0].length = 8; p.steps[8].length = 8;
        }),
        melodyFromArray('Off', Array(16).fill(null)),
        melodyFromArray('Pulse', [0, null, null, null, 0, null, null, null, 5, null, null, null, 5, null, null, null]),
      ],
      mixer: { gain: 0.4, reverb: 0.6, delay: 0.15, duck: 0.45 },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Key map
// ---------------------------------------------------------------------------

export function emptyCell(): Cell {
  return {
    mode: 'empty', trackId: null, velocity: 0.9,
    degree: 0, octave: 0, chordSize: 3, inversion: 0,
    patternIndex: 0, sceneId: null,
    repeatRate: '1/16', repeatRamp: 0, repeatPitch: 0,
    macro: 'filterDown', macroAmount: 0.7,
    quantize: 'off', behavior: 'trigger', label: '',
  };
}

function cell(over: Partial<Cell>): Cell {
  return { ...emptyCell(), ...over };
}

/**
 * Four layers, each a complete instrument in its own right:
 *   1  DRUMS    — one-shots on the home row, rolls above, fills below
 *   2  MELODY   — two octaves of the scale plus chords
 *   3  CLIPS    — pattern and scene launching
 *   4  FX       — performance macros
 */
export function defaultKeyMap(tracks: Track[], scenes: Scene[]): KeyMap {
  const t = (name: string) => tracks.find((x) => x.name === name)?.id ?? null;
  const layers: Cell[][] = Array.from({ length: LAYER_COUNT }, () =>
    Array.from({ length: CELLS_PER_LAYER }, emptyCell),
  );

  // --- Layer 0: drums -------------------------------------------------------
  const drums = ['Kick', 'Clap', 'Hats', 'OpenHat', 'Snare', 'Kick', 'Clap', 'Snare'];
  const L0 = layers[0];
  // Home row (index 20..29): straight one-shot hits.
  drums.forEach((name, i) => {
    L0[20 + i] = cell({ mode: 'hit', trackId: t(name), velocity: 0.95, label: name });
  });
  L0[28] = cell({ mode: 'hit', trackId: t('Bass'), velocity: 0.9, degree: 0, label: 'Bass' });
  L0[29] = cell({ mode: 'hit', trackId: t('Lead'), velocity: 0.9, degree: 0, label: 'Lead' });
  // Row above (10..19): note-repeat rolls at rising rates.
  const rollRates = ['1/8', '1/8t', '1/16', '1/16t', '1/32', '1/32t', '1/64', '1/16', '1/32', '1/16'] as const;
  const rollTargets = ['Kick', 'Kick', 'Hats', 'Hats', 'Snare', 'Snare', 'Snare', 'Clap', 'Clap', 'OpenHat'];
  rollRates.forEach((rate, i) => {
    L0[10 + i] = cell({
      mode: 'repeat', trackId: t(rollTargets[i]), repeatRate: rate,
      repeatRamp: i % 3 === 2 ? 0.5 : 0, behavior: 'gate',
      label: `${rollTargets[i]} ${rate}`,
    });
  });
  // Number row (0..9): accented / velocity variations of the kit.
  drums.forEach((name, i) => {
    L0[i] = cell({ mode: 'hit', trackId: t(name), velocity: 0.55, label: `${name} soft` });
  });
  L0[8] = cell({ mode: 'repeat', trackId: t('Snare'), repeatRate: '1/32', repeatRamp: 0.9, behavior: 'gate', label: 'Snare build' });
  L0[9] = cell({ mode: 'macro', macro: 'riser', macroAmount: 0.8, behavior: 'gate', label: 'Riser' });
  // Bottom row (30..39): pitched drum variations — the kick as an instrument.
  for (let i = 0; i < 6; i++) {
    L0[30 + i] = cell({ mode: 'hit', trackId: t('Kick'), degree: i, velocity: 0.9, label: `Kick ${i}` });
  }
  L0[36] = cell({ mode: 'hit', trackId: t('Bass'), degree: 0, octave: 0, label: 'Bass 1' });
  L0[37] = cell({ mode: 'hit', trackId: t('Bass'), degree: 3, octave: 0, label: 'Bass 4' });
  L0[38] = cell({ mode: 'macro', macro: 'stutter', macroAmount: 0.6, behavior: 'gate', label: 'Stutter' });
  L0[39] = cell({ mode: 'macro', macro: 'tapeStop', macroAmount: 0.8, behavior: 'gate', label: 'Tape stop' });

  // --- Layer 1: melody ------------------------------------------------------
  const L1 = layers[1];
  const lead = t('Lead');
  const bass = t('Bass');
  const pad = t('Pad');
  // Home row: one octave of the scale on the lead.
  for (let i = 0; i < 10; i++) {
    L1[20 + i] = cell({ mode: 'note', trackId: lead, degree: i, behavior: 'gate', label: `${i + 1}` });
  }
  // Row above: the octave above.
  for (let i = 0; i < 10; i++) {
    L1[10 + i] = cell({ mode: 'note', trackId: lead, degree: i + 7, behavior: 'gate', label: `${i + 8}` });
  }
  // Bottom row: bass, an octave down.
  for (let i = 0; i < 7; i++) {
    L1[30 + i] = cell({ mode: 'note', trackId: bass, degree: i, octave: -1, behavior: 'gate', label: `B${i + 1}` });
  }
  L1[37] = cell({ mode: 'note', trackId: bass, degree: 7, octave: -1, behavior: 'gate', label: 'B8' });
  L1[38] = cell({ mode: 'record', trackId: lead, behavior: 'toggle', label: 'Rec Lead' });
  L1[39] = cell({ mode: 'record', trackId: bass, behavior: 'toggle', label: 'Rec Bass' });
  // Number row: diatonic chords on the pad, quantized to the beat.
  for (let i = 0; i < 7; i++) {
    L1[i] = cell({
      mode: 'chord', trackId: pad, degree: i, chordSize: 3,
      behavior: 'gate', quantize: 'off', label: `Chord ${i + 1}`,
    });
  }
  L1[7] = cell({ mode: 'chord', trackId: pad, degree: 0, chordSize: 4, behavior: 'gate', label: 'I7' });
  L1[8] = cell({ mode: 'chord', trackId: pad, degree: 3, chordSize: 4, behavior: 'gate', label: 'IV7' });
  L1[9] = cell({ mode: 'chord', trackId: pad, degree: 4, chordSize: 5, behavior: 'gate', label: 'V9' });

  // --- Layer 2: clips -------------------------------------------------------
  const L2 = layers[2];
  // One column per track: the top three rows are pattern slots, the bottom row
  // stops that track. Every track keeps its own stop key.
  const clipCols = Math.min(tracks.length, GRID_COLS - 2);
  tracks.slice(0, clipCols).forEach((track, col) => {
    for (let row = 0; row < 3; row++) {
      L2[row * GRID_COLS + col] = cell({
        mode: 'pattern', trackId: track.id, patternIndex: row,
        quantize: '1bar', label: `${track.name} ${row + 1}`,
      });
    }
    L2[3 * GRID_COLS + col] = cell({
      mode: 'pattern', trackId: track.id, patternIndex: -1,
      quantize: '1bar', behavior: 'toggle', label: `Stop ${track.name}`,
    });
  });
  // Scenes go in the two spare columns on the right, so they never displace a
  // track's own stop key.
  scenes.slice(0, 4).forEach((scene, i) => {
    const row = Math.floor(i / 2);
    const col = GRID_COLS - 2 + (i % 2);
    L2[row * GRID_COLS + col] = cell({
      mode: 'scene', sceneId: scene.id, quantize: '1bar', label: scene.name,
    });
  });

  // --- Layer 3: fx ----------------------------------------------------------
  const L3 = layers[3];
  const macros: Array<[number, Cell['macro'], number, string]> = [
    [20, 'filterDown', 0.8, 'LP sweep'],
    [21, 'filterUp', 0.8, 'HP sweep'],
    [22, 'stutter', 0.5, 'Stutter 1/8'],
    [23, 'stutter', 0.85, 'Stutter 1/32'],
    [24, 'gate', 0.7, 'Gate'],
    [25, 'crush', 0.6, 'Crush'],
    [26, 'reverse', 0.7, 'Reverse'],
    [27, 'tapeStop', 0.8, 'Tape stop'],
    [28, 'wash', 0.9, 'Reverb wash'],
    [29, 'dropout', 1, 'Drop out'],
  ];
  macros.forEach(([idx, macro, amt, label]) => {
    L3[idx] = cell({ mode: 'macro', macro, macroAmount: amt, behavior: 'gate', label });
  });
  // Row above: the same macros latched, so you can set and forget.
  macros.forEach(([idx, macro, amt, label]) => {
    L3[idx - 10] = cell({ mode: 'macro', macro, macroAmount: amt, behavior: 'toggle', label: `${label} ⇄` });
  });
  // Number row: riser intensities for builds.
  for (let i = 0; i < 10; i++) {
    L3[i] = cell({ mode: 'macro', macro: 'riser', macroAmount: (i + 1) / 10, behavior: 'gate', label: `Riser ${i + 1}` });
  }
  // Bottom row: cut toggles per track. Press to drop the track out, press
  // again to bring it back — both edges land on the next beat.
  tracks.slice(0, GRID_COLS).forEach((track, i) => {
    L3[3 * GRID_COLS + i] = cell({
      mode: 'pattern', trackId: track.id, patternIndex: -1,
      quantize: '1/4', behavior: 'toggle', label: `Cut ${track.name}`,
    });
  });

  return {
    layers,
    layerNames: ['Drums', 'Melody', 'Clips', 'FX'],
  };
}

// ---------------------------------------------------------------------------
// Scenes & master
// ---------------------------------------------------------------------------

export function defaultScenes(tracks: Track[]): Scene[] {
  const byName = (n: string) => tracks.find((t) => t.name === n)?.id ?? '';
  const scene = (name: string, slots: Record<string, number>): Scene => ({
    id: uid('scn'), name, slots,
  });
  return [
    scene('Intro', {
      [byName('Kick')]: 2, [byName('Clap')]: 2, [byName('Hats')]: 3, [byName('OpenHat')]: 3,
      [byName('Snare')]: 3, [byName('Bass')]: 2, [byName('Lead')]: 3, [byName('Pad')]: 0,
    }),
    scene('Groove', {
      [byName('Kick')]: 0, [byName('Clap')]: 0, [byName('Hats')]: 0, [byName('OpenHat')]: 0,
      [byName('Snare')]: 0, [byName('Bass')]: 0, [byName('Lead')]: 1, [byName('Pad')]: 1,
    }),
    scene('Build', {
      [byName('Kick')]: 3, [byName('Clap')]: 3, [byName('Hats')]: 1, [byName('OpenHat')]: 2,
      [byName('Snare')]: 1, [byName('Bass')]: 3, [byName('Lead')]: 2, [byName('Pad')]: 3,
    }),
    scene('Drop', {
      [byName('Kick')]: 0, [byName('Clap')]: 0, [byName('Hats')]: 1, [byName('OpenHat')]: 0,
      [byName('Snare')]: 0, [byName('Bass')]: 1, [byName('Lead')]: 0, [byName('Pad')]: 2,
    }),
  ];
}

export function defaultMaster(sidechainSource: string | null): MasterFx {
  return {
    gain: 0.85,
    sidechainSource,
    sidechainAttack: 0.004,
    sidechainRelease: 0.24,
    sidechainCurve: 1.8,
    reverb: { size: 2.4, damp: 0.42, predelay: 0.018, width: 0.85, mix: 0.9 },
    delay: { division: 0.75, feedback: 0.42, tone: 3200, pingpong: 0.8, mix: 0.9 },
    drive: 0.12,
    cutoff: 20000,
    limiter: true,
  };
}

export function createProject(name = 'Untitled'): Project {
  const tracks = defaultTracks();
  const scenes = defaultScenes(tracks);
  const now = Date.now();
  return {
    id: uid('prj'),
    name,
    bpm: 128,
    swing: 0.12,
    swingUnit: 2,
    humanize: 1.5,
    key: { root: 9, scale: 'minor' }, // A minor — the default key of dance music
    tracks,
    scenes,
    keymap: defaultKeyMap(tracks, scenes),
    master: defaultMaster(tracks[0]?.id ?? null),
    barsPerLoop: 4,
    updatedAt: now,
    createdAt: now,
  };
}
