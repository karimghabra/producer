/**
 * Pulse — the maths.
 *
 * Nothing here touches audio. These are the pure functions that make the
 * musical decisions: where onsets land, which pitches are legal, how a stack
 * of detuned oscillators should be spaced.
 */

import { SCALES, type ScaleName, type KeyCenter, type EuclidSpec } from './types.ts';

// ---------------------------------------------------------------------------
// Euclidean rhythm
// ---------------------------------------------------------------------------

/**
 * Bjorklund's algorithm: distribute `pulses` onsets across `steps` slots as
 * evenly as possible. This is the same recursion Euclid used for the GCD, and
 * it happens to generate a startling number of the world's traditional
 * rhythms — E(3,8) is the tresillo, E(5,8) the cinquillo, E(7,16) a samba.
 *
 * For EDM it means one integer pair gives you a groove that is *almost*
 * four-on-the-floor but breathes.
 */
export function euclid(pulses: number, steps: number): boolean[] {
  const n = Math.max(0, Math.floor(steps));
  const k = Math.max(0, Math.min(n, Math.floor(pulses)));
  if (n === 0) return [];
  if (k === 0) return new Array(n).fill(false);
  if (k === n) return new Array(n).fill(true);

  // Build two groups of sequences and repeatedly fold the remainder into the
  // front group, exactly as the subtractive Euclidean GCD would.
  let a: boolean[][] = Array.from({ length: k }, () => [true]);
  let b: boolean[][] = Array.from({ length: n - k }, () => [false]);

  while (b.length > 1) {
    const pairs = Math.min(a.length, b.length);
    const merged: boolean[][] = [];
    for (let i = 0; i < pairs; i++) merged.push([...a[i], ...b[i]]);
    const remainder = a.length > b.length ? a.slice(pairs) : b.slice(pairs);
    a = merged;
    b = remainder;
  }

  return [...a, ...b].flat();
}

/** Euclidean pattern with rotation and inversion applied. */
export function euclidPattern(spec: EuclidSpec, steps: number): boolean[] {
  const base = euclid(spec.pulses, steps);
  if (base.length === 0) return base;
  const rot = ((spec.rotation % base.length) + base.length) % base.length;
  const rotated = base.map((_, i) => base[(i + rot) % base.length]);
  return spec.invert ? rotated.map((v) => !v) : rotated;
}

/** Greatest common divisor. */
export function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a || 1;
}

/** Least common multiple — how long before polymetric tracks realign. */
export function lcm(a: number, b: number): number {
  if (!a || !b) return 0;
  return Math.abs(a * b) / gcd(a, b);
}

/** Steps until every pattern length lines up again. Capped to stay sane. */
export function polymeterCycle(lengths: number[], cap = 4096): number {
  const cycle = lengths.filter((n) => n > 0).reduce((acc, n) => lcm(acc, n), 1);
  return Math.min(cycle, cap);
}

// ---------------------------------------------------------------------------
// Pitch
// ---------------------------------------------------------------------------

export const A4 = 440;

/** MIDI note number -> Hz, twelve-tone equal temperament. */
export function mtof(midi: number): number {
  return A4 * Math.pow(2, (midi - 69) / 12);
}

export function ftom(hz: number): number {
  return 69 + 12 * Math.log2(hz / A4);
}

/**
 * Map a scale degree to a MIDI note in the given key. Degrees outside one
 * octave wrap and carry an octave, so degree 7 is the tonic an octave up and
 * degree -1 is the leading tone below.
 */
export function degreeToMidi(key: KeyCenter, degree: number, octave = 0, baseOctave = 4): number {
  const scale = SCALES[key.scale] ?? SCALES.minor;
  const n = scale.length;
  const wrapped = ((degree % n) + n) % n;
  const octShift = Math.floor(degree / n);
  return 12 * (baseOctave + 1 + octave + octShift) + key.root + scale[wrapped];
}

/** Snap an arbitrary MIDI note to the nearest note in the key. */
export function snapToScale(key: KeyCenter, midi: number): number {
  const scale = SCALES[key.scale] ?? SCALES.minor;
  const pc = ((midi - key.root) % 12 + 12) % 12;
  const octave = Math.floor((midi - key.root) / 12);
  let best: number = scale[0];
  let bestDist = Infinity;
  for (const s of scale) {
    const d = Math.min(Math.abs(s - pc), 12 - Math.abs(s - pc));
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return key.root + octave * 12 + best;
}

/**
 * Diatonic chord built by stacking scale thirds on a degree, then rotating the
 * voicing up by `inversion`. Stacking thirds inside the scale is what makes a
 * minor key produce i, ii°, III, iv, v, VI, VII automatically — you never pick
 * a chord quality, the scale picks it for you.
 */
export function buildChord(
  key: KeyCenter,
  degree: number,
  size = 3,
  inversion = 0,
  octave = 0,
): number[] {
  const notes: number[] = [];
  for (let i = 0; i < size; i++) {
    notes.push(degreeToMidi(key, degree + i * 2, octave));
  }
  for (let i = 0; i < inversion; i++) {
    const low = notes.shift();
    if (low === undefined) break;
    notes.push(low + 12);
  }
  return notes;
}

export function chordSymbol(key: KeyCenter, degree: number, size: number): string {
  const notes = buildChord(key, degree, Math.max(3, size), 0);
  const root = notes[0] % 12;
  const third = (notes[1] - notes[0] + 120) % 12;
  const fifth = (notes[2] - notes[0] + 120) % 12;
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  let quality = '';
  if (third === 3 && fifth === 6) quality = 'dim';
  else if (third === 3) quality = 'm';
  else if (third === 4 && fifth === 8) quality = 'aug';
  else if (third === 4) quality = '';
  else if (third === 2 || third === 5) quality = 'sus';
  if (size >= 4) {
    const seventh = (notes[3] - notes[0] + 120) % 12;
    quality += seventh === 11 ? 'maj7' : seventh === 10 ? '7' : '6';
  }
  if (size >= 5) quality += '/9';
  return names[root] + quality;
}

// ---------------------------------------------------------------------------
// Supersaw detune — the JP-8000 curves
// ---------------------------------------------------------------------------

/**
 * Adam Szabo reverse-engineered the Roland JP-8000 supersaw and found the
 * detune knob is not linear: it follows an 11th-order polynomial that is very
 * fine near zero and opens up sharply at the top. Using the real curve is the
 * difference between "seven detuned saws" and *that* trance sound.
 */
export function jp8000Detune(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return (
    10028.7312891634 * c ** 11 -
    50818.8652045924 * c ** 10 +
    111363.4808729368 * c ** 9 -
    138150.6761080548 * c ** 8 +
    106649.6679158292 * c ** 7 -
    53046.9642751875 * c ** 6 +
    17019.9518580080 * c ** 5 -
    3425.0836591318 * c ** 4 +
    404.2703938388 * c ** 3 -
    24.1878824391 * c ** 2 +
    0.6717417634 * c +
    0.0030115596
  );
}

/** Relative detune offsets of the seven JP-8000 oscillators. */
export const SUPERSAW_OFFSETS = [
  -0.11002313, -0.06288439, -0.01952356, 0, 0.01952356, 0.06288439, 0.11002313,
];

/** Level of the centre oscillator as the mix knob opens. */
export function supersawCenterGain(mix: number): number {
  const m = Math.max(0, Math.min(1, mix));
  return -0.55366 * m + 0.99785;
}

/** Level of each of the six side oscillators. */
export function supersawSideGain(mix: number): number {
  const m = Math.max(0, Math.min(1, mix));
  return -0.73764 * m * m + 1.2841 * m + 0.044372;
}

/**
 * Detune offsets in cents for an arbitrary voice count, interpolating the
 * JP-8000 spacing so 3, 5 or 9 voices keep the same character.
 */
export function unisonCents(voices: number, detune: number): number[] {
  const n = Math.max(1, Math.floor(voices));
  if (n === 1) return [0];
  const depth = jp8000Detune(detune);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    // Position along the 7-oscillator reference curve, resampled to n voices.
    const t = (i / (n - 1)) * (SUPERSAW_OFFSETS.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(SUPERSAW_OFFSETS.length - 1, lo + 1);
    const frac = t - lo;
    const rel = SUPERSAW_OFFSETS[lo] * (1 - frac) + SUPERSAW_OFFSETS[hi] * frac;
    out.push(rel * depth * 1200);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Groove
// ---------------------------------------------------------------------------

/**
 * Swing, returned as an offset measured in steps.
 *
 * Steps are grouped in `unit`s; the back half of each group is pushed late
 * while the front half stays nailed to the grid. At amount 1 the offset is a
 * third of the group's half-length, which places the swung note exactly on the
 * triplet — the classic shuffle. Anything below that is the continuum between
 * straight and shuffled that house and garage live in.
 *
 * `unit` is the group size in steps: 2 shuffles every other step, 4 shuffles at
 * the next subdivision up for a broader, lazier feel.
 */
export function swingOffset(stepIndex: number, amount: number, unit: number): number {
  if (amount === 0) return 0;
  const group = Math.max(2, Math.round(unit));
  const half = group / 2;
  const pos = ((stepIndex % group) + group) % group;
  if (pos < half) return 0;
  return clamp(amount, -1, 1) * (1 / 3) * half;
}

/** Deterministic pseudo-random in [0,1) from an integer seed — stable humanise. */
export function hashRandom(seed: number): number {
  let x = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// Misc curves
// ---------------------------------------------------------------------------

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Map 0..1 to a frequency range logarithmically — how ears hear cutoff. */
export function expScale(t: number, lo: number, hi: number): number {
  return lo * Math.pow(hi / lo, clamp(t, 0, 1));
}

export function invExpScale(v: number, lo: number, hi: number): number {
  return Math.log(clamp(v, lo, hi) / lo) / Math.log(hi / lo);
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(g: number): number {
  return 20 * Math.log10(Math.max(1e-6, g));
}

/**
 * The logistic map, x -> r·x·(1-x). At r ≈ 3.57 it goes chaotic but stays
 * bounded and structured — used to drift parameters in a way that never
 * repeats yet never wanders off.
 */
export function logisticStep(x: number, r = 3.9): number {
  return clamp(r * x * (1 - x), 0.0001, 0.9999);
}

export const RATE_TO_BEATS: Record<string, number> = {
  '1/4': 1,
  '1/8': 0.5,
  '1/8t': 1 / 3,
  '1/16': 0.25,
  '1/16t': 1 / 6,
  '1/32': 0.125,
  '1/32t': 1 / 12,
  '1/64': 0.0625,
};

export const QUANTIZE_TO_BEATS: Record<string, number> = {
  off: 0,
  '1/16': 0.25,
  '1/8': 0.5,
  '1/4': 1,
  '1/2': 2,
  '1bar': 4,
  '2bar': 8,
  '4bar': 16,
};
