/**
 * Pulse — shared domain model.
 *
 * The whole app is a pure-data document (`Project`) plus an audio engine that
 * renders it. Everything the UI, the sequencer, the keyboard layer and the
 * server touch is described here.
 */

// ---------------------------------------------------------------------------
// Musical primitives
// ---------------------------------------------------------------------------

/** Semitone offsets from the root, ascending, one octave. */
export const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  phrygianDominant: [0, 1, 4, 5, 7, 8, 10],
  minorPentatonic: [0, 3, 5, 7, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  blues: [0, 3, 5, 6, 7, 10],
  wholeTone: [0, 2, 4, 6, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
} as const;

export type ScaleName = keyof typeof SCALES;

export const NOTE_NAMES = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
] as const;

export interface KeyCenter {
  /** 0 = C … 11 = B */
  root: number;
  scale: ScaleName;
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

export type DrumEngine =
  | 'kick'
  | 'snare'
  | 'clap'
  | 'hat'
  | 'tom'
  | 'rim'
  | 'cymbal'
  | 'noise';

export type SynthEngine =
  | 'supersaw'
  | 'reese'
  | 'fm'
  | 'sub'
  | 'pluck'
  | 'pad';

export interface ADSR {
  attack: number;   // seconds
  decay: number;    // seconds
  sustain: number;  // 0..1
  release: number;  // seconds
}

export interface DrumParams {
  /** Base pitch in Hz (kick/tom/snare body) or spectral centre (hat/cymbal). */
  tune: number;
  /** Amplitude decay, seconds. */
  decay: number;
  /** How far the pitch envelope sweeps, in semitones (kick punch). */
  pitchMod: number;
  /** Pitch envelope time constant, seconds. */
  pitchTime: number;
  /** Noise vs. tone balance, 0..1. */
  noise: number;
  /** Waveshaper drive, 0..1. */
  drive: number;
  /** Post filter cutoff in Hz. */
  cutoff: number;
  /** Post filter resonance. */
  resonance: number;
  /** Transient click level, 0..1. */
  snap: number;
}

export interface SynthParams {
  /** Unison voice count (supersaw / reese). */
  voices: number;
  /** Unison detune depth, 0..1 — drives the JP-8000 detune curve. */
  detune: number;
  /** Stereo width of the unison stack, 0..1. */
  spread: number;
  /** Octave transpose, -3..+3. */
  octave: number;
  /** Sub-oscillator level, 0..1. */
  sub: number;
  /** FM modulator:carrier frequency ratio. */
  fmRatio: number;
  /** FM modulation index (peak deviation in multiples of carrier freq). */
  fmIndex: number;
  filterType: BiquadFilterType;
  cutoff: number;
  resonance: number;
  /** Filter envelope depth in octaves, can be negative. */
  filterEnv: number;
  /** Filter cutoff tracking of played pitch, 0..1. */
  keyTrack: number;
  amp: ADSR;
  filt: ADSR;
  /** Portamento time in seconds. */
  glide: number;
  drive: number;
}

export interface Instrument {
  kind: 'drum' | 'synth';
  engine: DrumEngine | SynthEngine;
  drum: DrumParams;
  synth: SynthParams;
}

// ---------------------------------------------------------------------------
// Sequencing
// ---------------------------------------------------------------------------

/**
 * Elektron-style trig conditions. `a:b` fires on loop `a` of every `b` loops,
 * which is how a 4-bar pattern grows a 32-bar arrangement for free.
 */
export type TrigCondition =
  | { type: 'always' }
  | { type: 'prob'; chance: number }        // 0..1
  | { type: 'ratio'; hit: number; of: number }
  | { type: 'fill' }
  | { type: 'notFill' }
  | { type: 'first' }                        // first loop only
  | { type: 'notFirst' };

export interface Step {
  on: boolean;
  /** 0..1 */
  velocity: number;
  /** Scale degree offset from the pattern root, for pitched tracks. */
  degree: number;
  /** Extra octaves on top of `degree`. */
  octave: number;
  /** Note length in steps. */
  length: number;
  /** Retriggers inside this step (1 = none). */
  ratchet: number;
  /** Micro-timing nudge as a fraction of a step, -0.5..0.5. */
  nudge: number;
  /** Per-step slide into the next note (synths only). */
  slide: boolean;
  /** Accent multiplier applied on top of velocity. */
  accent: boolean;
  cond: TrigCondition;
}

export type PatternMode = 'manual' | 'euclid';

export interface EuclidSpec {
  /** Onsets to distribute. */
  pulses: number;
  /** Rotation of the resulting necklace. */
  rotation: number;
  /** Invert — play the rests instead of the onsets. */
  invert: boolean;
}

export interface Pattern {
  id: string;
  name: string;
  /** Pattern length in steps. Different lengths across tracks = polymeter. */
  length: number;
  /** Steps per beat: 4 = 16ths, 3 = 8th triplets, 6 = 16th triplets. */
  resolution: number;
  mode: PatternMode;
  euclid: EuclidSpec;
  steps: Step[];
}

export interface TrackMixer {
  gain: number;      // 0..1.5
  pan: number;       // -1..1
  mute: boolean;
  solo: boolean;
  reverb: number;    // send, 0..1
  delay: number;     // send, 0..1
  /** Sidechain ducking depth driven by the sidechain source track, 0..1. */
  duck: number;
}

export interface Track {
  id: string;
  name: string;
  color: string;
  instrument: Instrument;
  mixer: TrackMixer;
  patterns: Pattern[];
  /** Index into `patterns` that is currently playing. */
  activePattern: number;
  /** Queued pattern change, applied at the next quantize boundary. */
  queuedPattern: number | null;
  /** Track is excluded from the sequencer but still playable by hand. */
  seqEnabled: boolean;
}

/** A scene is a snapshot of "which pattern is each track playing". */
export interface Scene {
  id: string;
  name: string;
  /** trackId -> pattern index. Missing entries leave the track alone. */
  slots: Record<string, number>;
}

// ---------------------------------------------------------------------------
// The performance layer — this is the flexible part
// ---------------------------------------------------------------------------

export type Quantize = 'off' | '1/16' | '1/8' | '1/4' | '1/2' | '1bar' | '2bar' | '4bar';

export type CellMode =
  /** Fire the track's instrument once. Velocity from the key's own setting. */
  | 'hit'
  /** Play a pitched note, snapped to the project key. Held = sustained. */
  | 'note'
  /** Play a diatonic chord built on a scale degree. */
  | 'chord'
  /** Launch (or stop) a pattern on a track, quantized. */
  | 'pattern'
  /** Launch a whole scene. */
  | 'scene'
  /** While held, retrigger the target at a rhythmic rate. Note-repeat / rolls. */
  | 'repeat'
  /** While held, apply a performance effect to the master bus. */
  | 'macro'
  /** Toggle recording of live playing into the target track's pattern. */
  | 'record'
  /** Nothing assigned. */
  | 'empty';

export type MacroKind =
  | 'filterDown'   // sweep master lowpass down
  | 'filterUp'     // sweep master highpass up
  | 'stutter'      // beat-repeat a slice of the bar
  | 'tapeStop'     // pitch + slow to a halt
  | 'reverse'      // reverse the last slice
  | 'gate'         // rhythmic amplitude gating
  | 'crush'        // bit / sample-rate reduction
  | 'riser'        // white-noise + pitch riser swell
  | 'dropout'      // kill everything but the kick
  | 'wash';        // dump everything into reverb

export type RepeatRate =
  | '1/4' | '1/8' | '1/8t' | '1/16' | '1/16t' | '1/32' | '1/32t' | '1/64';

export interface Cell {
  mode: CellMode;
  /** Target track for hit / note / chord / repeat / record / pattern. */
  trackId: string | null;
  /** hit: velocity. note/chord: velocity. */
  velocity: number;
  /** note/chord: scale degree relative to the project root (0 = tonic). */
  degree: number;
  /** note/chord: octave offset. */
  octave: number;
  /** chord: number of stacked thirds (3 = triad, 4 = seventh, 5 = ninth). */
  chordSize: number;
  /** chord: rotate the voicing upward by n inversions. */
  inversion: number;
  /** pattern: which pattern index to launch. -1 = stop the track. */
  patternIndex: number;
  /** scene: which scene id to launch. */
  sceneId: string | null;
  /** repeat: rate of retriggering. */
  repeatRate: RepeatRate;
  /** repeat: velocity ramp across the roll, -1..1 (fade out .. build up). */
  repeatRamp: number;
  /** repeat: pitch ramp in semitones across the roll. */
  repeatPitch: number;
  /** macro: which effect. */
  macro: MacroKind;
  /** macro: intensity, 0..1. */
  macroAmount: number;
  /** When the action takes effect. */
  quantize: Quantize;
  /** trigger = one-shot; gate = sounds while held; toggle = press on/press off. */
  behavior: 'trigger' | 'gate' | 'toggle';
  /** Display label override. */
  label: string;
}

/**
 * 4 layers × 40 physical keys. Layers are selected with the modifier keys, so
 * one hand can shift the whole instrument under the other hand.
 */
export interface KeyMap {
  layers: Cell[][];
  layerNames: string[];
}

// ---------------------------------------------------------------------------
// Master chain
// ---------------------------------------------------------------------------

export interface MasterFx {
  gain: number;
  /** Sidechain source track — every hit on it ducks the ducking tracks. */
  sidechainSource: string | null;
  sidechainAttack: number;   // seconds to reach full duck
  sidechainRelease: number;  // seconds to recover
  /** Recovery curve exponent. <1 snappy, >1 deep pump. */
  sidechainCurve: number;
  reverb: {
    size: number;      // seconds of decay
    damp: number;      // 0..1 high-frequency absorption
    predelay: number;  // seconds
    width: number;     // 0..1 stereo decorrelation
    mix: number;       // return level
  };
  delay: {
    /** Delay time as a fraction of a beat. */
    division: number;
    feedback: number;
    /** Feedback-path lowpass, Hz. */
    tone: number;
    /** Ping-pong amount, 0..1. */
    pingpong: number;
    mix: number;
  };
  drive: number;
  /** Master lowpass, Hz — the macro filter sweeps this. */
  cutoff: number;
  limiter: boolean;
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  bpm: number;
  /** 0 = straight, 1 = full triplet shuffle. */
  swing: number;
  /** Group size in steps that swing operates on: 2 = every other step. */
  swingUnit: number;
  /** Global humanisation of timing, in milliseconds of jitter. */
  humanize: number;
  key: KeyCenter;
  tracks: Track[];
  scenes: Scene[];
  keymap: KeyMap;
  master: MasterFx;
  /** Bars per loop cycle, used for `a:b` trig conditions and scene launch. */
  barsPerLoop: number;
  updatedAt: number;
  createdAt: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  bpm: number;
  updatedAt: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Keyboard geometry
// ---------------------------------------------------------------------------

/** Physical `event.code` values, laid out as the 4×10 grid we address. */
export const KEY_GRID: string[][] = [
  ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'],
  ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'],
  ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'],
  ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'],
];

export const KEY_LABELS: Record<string, string> = {
  Semicolon: ';', Comma: ',', Period: '.', Slash: '/',
};

export const GRID_ROWS = 4;
export const GRID_COLS = 10;
export const CELLS_PER_LAYER = GRID_ROWS * GRID_COLS;
export const LAYER_COUNT = 4;

export function keyIndex(code: string): number {
  for (let r = 0; r < KEY_GRID.length; r++) {
    const c = KEY_GRID[r].indexOf(code);
    if (c >= 0) return r * GRID_COLS + c;
  }
  return -1;
}

export function keyLabel(code: string): string {
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  return code.replace(/^(Key|Digit)/, '');
}
