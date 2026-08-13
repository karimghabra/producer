/**
 * Preset library and parameter help.
 *
 * The knobs are all one-line summaries of a synthesis technique, which is not
 * much use if you do not already know the technique. Presets let you find a
 * sound by ear first and reverse-engineer it afterwards — which is how most
 * people actually learn what a filter envelope does.
 */

import type {
  DrumEngine, SynthEngine, DrumParams, SynthParams, Instrument,
} from './types.ts';
import { drumParams, synthParams } from './defaults.ts';

export interface DrumPreset {
  kind: 'drum';
  name: string;
  engine: DrumEngine;
  /** One line on what this is for. */
  blurb: string;
  params: Partial<DrumParams>;
}

export interface SynthPreset {
  kind: 'synth';
  name: string;
  engine: SynthEngine;
  blurb: string;
  params: Partial<SynthParams>;
}

export type Preset = DrumPreset | SynthPreset;

const d = (
  name: string, engine: DrumEngine, blurb: string, params: Partial<DrumParams>,
): DrumPreset => ({ kind: 'drum', name, engine, blurb, params });

const s = (
  name: string, engine: SynthEngine, blurb: string, params: Partial<SynthParams>,
): SynthPreset => ({ kind: 'synth', name, engine, blurb, params });

// ---------------------------------------------------------------------------
// Drums
// ---------------------------------------------------------------------------

export const DRUM_PRESETS: DrumPreset[] = [
  // --- kicks ---
  d('909 Kick', 'kick', 'The house and techno standard. Punchy, gets out of the way.',
    { tune: 50, decay: 0.45, pitchMod: 28, pitchTime: 0.035, noise: 0, drive: 0.35, cutoff: 8000, resonance: 0.7, snap: 0.5 }),
  d('808 Boom', 'kick', 'Long sub tail. Trap and hip-hop — sits under everything.',
    { tune: 40, decay: 1.4, pitchMod: 20, pitchTime: 0.065, noise: 0, drive: 0.18, cutoff: 5500, resonance: 0.5, snap: 0.22 }),
  d('Tech Thump', 'kick', 'Short and tight. Leaves room for a busy groove.',
    { tune: 55, decay: 0.28, pitchMod: 26, pitchTime: 0.022, noise: 0, drive: 0.45, cutoff: 9000, resonance: 0.8, snap: 0.6 }),
  d('Trance Kick', 'kick', 'Clicky top, fast decay. Built to cut through supersaws.',
    { tune: 52, decay: 0.36, pitchMod: 33, pitchTime: 0.028, noise: 0, drive: 0.5, cutoff: 11000, resonance: 0.9, snap: 0.7 }),
  d('Hardstyle', 'kick', 'Distorted and pitched. The kick *is* the bassline.',
    { tune: 62, decay: 0.75, pitchMod: 40, pitchTime: 0.03, noise: 0.05, drive: 0.92, cutoff: 12000, resonance: 1.6, snap: 0.75 }),

  // --- snares ---
  d('909 Snare', 'snare', 'Bright, noisy, classic. Backbeat duty.',
    { tune: 190, decay: 0.2, noise: 0.7, cutoff: 11000, resonance: 0.8, drive: 0.25, snap: 0.7 }),
  d('Trap Snare', 'snare', 'High and snappy, very short. For rolls and rushes.',
    { tune: 260, decay: 0.15, noise: 0.82, cutoff: 13000, resonance: 1, drive: 0.3, snap: 0.8 }),
  d('Deep Snare', 'snare', 'More body than hiss. Warmer, sits lower.',
    { tune: 145, decay: 0.32, noise: 0.5, cutoff: 7500, resonance: 0.9, drive: 0.3, snap: 0.5 }),
  d('Ghost Snare', 'snare', 'Barely there. Use quietly between the backbeats.',
    { tune: 200, decay: 0.075, noise: 0.88, cutoff: 9000, resonance: 1.2, drive: 0.1, snap: 0.4 }),

  // --- claps ---
  d('909 Clap', 'clap', 'Three bursts then a tail. The sound of house music.',
    { tune: 1100, decay: 0.32, noise: 1, cutoff: 6500, resonance: 2, drive: 0.15 }),
  d('Tight Clap', 'clap', 'Cropped short. Layers under a snare without mud.',
    { tune: 1450, decay: 0.15, noise: 1, cutoff: 7500, resonance: 3.2, drive: 0.2 }),
  d('Big Room Clap', 'clap', 'Long and wide. Wants reverb behind it.',
    { tune: 900, decay: 0.62, noise: 1, cutoff: 5500, resonance: 1.4, drive: 0.28 }),

  // --- hats ---
  d('909 Closed', 'hat', 'Standard closed hat. Offbeats and sixteenths.',
    { tune: 320, decay: 0.055, noise: 0, cutoff: 9000, resonance: 1.2, drive: 0.15 }),
  d('808 Tick', 'hat', 'Tiny and dry. Almost a click.',
    { tune: 410, decay: 0.028, noise: 0, cutoff: 11000, resonance: 1, drive: 0.1 }),
  d('Open Hat', 'hat', 'Rings on. Put it on the offbeat and stop worrying.',
    { tune: 300, decay: 0.36, noise: 0, cutoff: 8000, resonance: 1, drive: 0.2 }),
  d('Trap Hat', 'hat', 'Ultra short, bright. Survives 1/32 rolls.',
    { tune: 460, decay: 0.02, noise: 0, cutoff: 12500, resonance: 0.9, drive: 0.12 }),
  d('Sizzle', 'hat', 'Noisy and loose. More like a small cymbal.',
    { tune: 275, decay: 0.5, noise: 0.32, cutoff: 7000, resonance: 0.8, drive: 0.25 }),

  // --- cymbals ---
  d('Crash', 'cymbal', 'Long wash. One per eight bars is usually plenty.',
    { tune: 220, decay: 1.7, noise: 0.25, cutoff: 6000, resonance: 0.6, drive: 0.15 }),
  d('Ride', 'cymbal', 'Shorter and more defined. Can carry a groove.',
    { tune: 350, decay: 0.85, noise: 0.1, cutoff: 9000, resonance: 0.7, drive: 0.12 }),

  // --- toms & percussion ---
  d('Low Tom', 'tom', 'Deep and round. Good for fills and tribal patterns.',
    { tune: 90, decay: 0.52, pitchMod: 14, pitchTime: 0.08, noise: 0.1, cutoff: 6000, drive: 0.2 }),
  d('High Tom', 'tom', 'Tighter and higher. Pairs with the low tom.',
    { tune: 185, decay: 0.34, pitchMod: 12, pitchTime: 0.05, noise: 0.1, cutoff: 8000, drive: 0.2 }),
  d('Rim Click', 'rim', 'Short wooden tick. Great as a quiet offbeat.',
    { tune: 820, decay: 0.03, noise: 0, cutoff: 12000, resonance: 4, drive: 0.1 }),
  d('Noise Sweep', 'noise', 'Filtered noise. Build-ups, transitions, risers.',
    { tune: 200, decay: 0.9, noise: 1, cutoff: 2200, resonance: 8, drive: 0.15 }),
  d('Snare Rush', 'noise', 'Fast noise burst. Stack it into 1/32 rolls.',
    { tune: 200, decay: 0.11, noise: 1, cutoff: 4200, resonance: 3, drive: 0.2 }),
];

// ---------------------------------------------------------------------------
// Synths
// ---------------------------------------------------------------------------

export const SYNTH_PRESETS: SynthPreset[] = [
  // --- supersaw ---
  s('Trance Lead', 'supersaw', 'Seven detuned saws, wide and bright. The big one.',
    { voices: 7, detune: 0.42, spread: 0.9, octave: 0, sub: 0.15, cutoff: 6000, resonance: 3, filterEnv: 2.2, keyTrack: 0.4, drive: 0.25,
      amp: { attack: 0.01, decay: 0.4, sustain: 0.7, release: 0.4 }, filt: { attack: 0.005, decay: 0.4, sustain: 0.45, release: 0.35 } }),
  s('Big Room Stab', 'supersaw', 'Short, hard, no sustain. Play it on the offbeats.',
    { voices: 7, detune: 0.5, spread: 1, octave: 0, sub: 0.1, cutoff: 7000, resonance: 2, filterEnv: 3, keyTrack: 0.35, drive: 0.35,
      amp: { attack: 0.004, decay: 0.18, sustain: 0, release: 0.15 }, filt: { attack: 0.002, decay: 0.15, sustain: 0.1, release: 0.12 } }),
  s('Anthem Lead', 'supersaw', 'Narrower and rounder. Sits better under vocals.',
    { voices: 5, detune: 0.28, spread: 0.6, octave: 0, sub: 0.2, cutoff: 4800, resonance: 2.5, filterEnv: 1.8, keyTrack: 0.45, drive: 0.2,
      amp: { attack: 0.02, decay: 0.5, sustain: 0.85, release: 0.5 }, filt: { attack: 0.01, decay: 0.5, sustain: 0.5, release: 0.4 } }),

  // --- reese / bass ---
  s('Classic Reese', 'reese', 'Two saws beating against each other. Moving low end.',
    { voices: 3, detune: 0.14, spread: 0.25, octave: -2, sub: 0.5, cutoff: 620, resonance: 7, filterEnv: 1.8, keyTrack: 0.35, drive: 0.45,
      amp: { attack: 0.004, decay: 0.15, sustain: 0.85, release: 0.1 }, filt: { attack: 0.002, decay: 0.16, sustain: 0.25, release: 0.1 } }),
  s('DnB Growl', 'reese', 'Wider detune, screaming filter. Nasty on purpose.',
    { voices: 4, detune: 0.24, spread: 0.4, octave: -2, sub: 0.35, cutoff: 430, resonance: 13, filterEnv: 2.6, keyTrack: 0.3, drive: 0.72,
      amp: { attack: 0.004, decay: 0.2, sustain: 0.9, release: 0.12 }, filt: { attack: 0.004, decay: 0.3, sustain: 0.3, release: 0.15 } }),
  s('Sub Reese', 'reese', 'Mostly sub with a hint of movement. Very clean low end.',
    { voices: 2, detune: 0.07, spread: 0.15, octave: -2, sub: 0.8, cutoff: 340, resonance: 4, filterEnv: 1.2, keyTrack: 0.4, drive: 0.28,
      amp: { attack: 0.005, decay: 0.2, sustain: 0.9, release: 0.1 }, filt: { attack: 0.003, decay: 0.2, sustain: 0.4, release: 0.1 } }),

  // --- fm ---
  s('FM Bass', 'fm', 'Hard, focused, cuts through anything. Whole-number ratio.',
    { fmRatio: 2, fmIndex: 4, octave: -2, sub: 0.25, cutoff: 1200, resonance: 2, filterEnv: 1.5, keyTrack: 0.3, drive: 0.32,
      amp: { attack: 0.003, decay: 0.22, sustain: 0.7, release: 0.1 }, filt: { attack: 0.002, decay: 0.16, sustain: 0.2, release: 0.1 } }),
  s('Bell', 'fm', 'Non-integer ratio, long tail. Bright and glassy.',
    { fmRatio: 3.5, fmIndex: 6, octave: 0, sub: 0, cutoff: 12000, resonance: 1, filterEnv: 0.8, keyTrack: 0.5, drive: 0.1,
      amp: { attack: 0.002, decay: 1.3, sustain: 0.08, release: 1.1 }, filt: { attack: 0.001, decay: 0.9, sustain: 0.2, release: 0.7 } }),
  s('Metal Stab', 'fm', 'High ratio, heavy modulation. Clangy and percussive.',
    { fmRatio: 5.5, fmIndex: 8, octave: 0, sub: 0, cutoff: 6500, resonance: 2, filterEnv: 1.5, keyTrack: 0.4, drive: 0.25,
      amp: { attack: 0.002, decay: 0.26, sustain: 0, release: 0.2 }, filt: { attack: 0.001, decay: 0.2, sustain: 0.1, release: 0.15 } }),

  // --- sub ---
  s('Pure Sub', 'sub', 'One sine, nothing else. Felt more than heard.',
    { octave: -2, sub: 0, cutoff: 420, resonance: 0.7, filterEnv: 0.4, keyTrack: 0.5, drive: 0.15,
      amp: { attack: 0.006, decay: 0.2, sustain: 0.92, release: 0.12 }, filt: { attack: 0.005, decay: 0.2, sustain: 0.6, release: 0.1 } }),
  s('808 Slide', 'sub', 'Sub with glide. Play overlapping notes for the slide.',
    { octave: -2, sub: 0, glide: 0.09, cutoff: 520, resonance: 1.2, filterEnv: 0.8, keyTrack: 0.4, drive: 0.36,
      amp: { attack: 0.004, decay: 0.9, sustain: 0.55, release: 0.6 }, filt: { attack: 0.003, decay: 0.5, sustain: 0.4, release: 0.4 } }),

  // --- plucks ---
  s('House Pluck', 'pluck', 'Resonant blip, no sustain. Chords on the offbeat.',
    { voices: 3, detune: 0.16, spread: 0.5, octave: 0, sub: 0.1, cutoff: 3500, resonance: 9, filterEnv: 2.8, keyTrack: 0.4, drive: 0.2,
      amp: { attack: 0.002, decay: 0.22, sustain: 0, release: 0.2 }, filt: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.1 } }),
  s('Wood Pluck', 'pluck', 'Softer and duller. More marimba than synth.',
    { voices: 1, detune: 0, spread: 0, octave: 0, sub: 0.2, cutoff: 2400, resonance: 3, filterEnv: 2, keyTrack: 0.5, drive: 0.12,
      amp: { attack: 0.002, decay: 0.36, sustain: 0, release: 0.3 }, filt: { attack: 0.001, decay: 0.22, sustain: 0, release: 0.2 } }),

  // --- pads ---
  s('Warm Pad', 'pad', 'Slow, wide, dark. Fills the space behind everything.',
    { voices: 5, detune: 0.28, spread: 1, octave: -1, sub: 0.1, cutoff: 2200, resonance: 1.5, filterEnv: 1, keyTrack: 0.2, drive: 0.1,
      amp: { attack: 0.6, decay: 1.2, sustain: 0.8, release: 1.6 }, filt: { attack: 0.9, decay: 1.5, sustain: 0.6, release: 1.4 } }),
  s('Choir Pad', 'pad', 'Brighter and slower still. Very long release.',
    { voices: 7, detune: 0.36, spread: 1, octave: 0, sub: 0.05, cutoff: 3100, resonance: 2.2, filterEnv: 1.2, keyTrack: 0.3, drive: 0.08,
      amp: { attack: 1.0, decay: 1.5, sustain: 0.85, release: 2.2 }, filt: { attack: 1.2, decay: 1.8, sustain: 0.65, release: 1.8 } }),
  s('Dark Drone', 'pad', 'Low, slow and slightly dirty. Tension under a breakdown.',
    { voices: 4, detune: 0.18, spread: 0.85, octave: -2, sub: 0.3, cutoff: 900, resonance: 4, filterEnv: 1.4, keyTrack: 0.15, drive: 0.26,
      amp: { attack: 1.4, decay: 2, sustain: 0.9, release: 2.5 }, filt: { attack: 1.6, decay: 2.2, sustain: 0.7, release: 2 } }),
];

export const ALL_PRESETS: Preset[] = [...DRUM_PRESETS, ...SYNTH_PRESETS];

/** The preset the Reset button restores, per engine. */
const INIT_BY_ENGINE: Record<string, string> = {
  kick: '909 Kick', snare: '909 Snare', clap: '909 Clap', hat: '909 Closed',
  cymbal: 'Crash', tom: 'Low Tom', rim: 'Rim Click', noise: 'Noise Sweep',
  supersaw: 'Trance Lead', reese: 'Classic Reese', fm: 'FM Bass',
  sub: 'Pure Sub', pluck: 'House Pluck', pad: 'Warm Pad',
};

export function presetsFor(kind: 'drum' | 'synth'): Preset[] {
  return kind === 'drum' ? DRUM_PRESETS : SYNTH_PRESETS;
}

export function findPreset(name: string): Preset | undefined {
  return ALL_PRESETS.find((p) => p.name === name);
}

/** The factory sound for an engine — what Reset goes back to. */
export function initPresetFor(engine: string): Preset | undefined {
  const name = INIT_BY_ENGINE[engine];
  return name ? findPreset(name) : undefined;
}

/**
 * Build a complete Instrument from a preset, filling any unspecified field
 * from the factory defaults so a preset only has to state what it cares about.
 */
export function instrumentFromPreset(preset: Preset, previous?: Instrument): Instrument {
  if (preset.kind === 'drum') {
    return {
      kind: 'drum',
      engine: preset.engine,
      drum: { ...drumParams(), ...preset.params },
      synth: previous?.synth ?? synthParams(),
    };
  }
  return {
    kind: 'synth',
    engine: preset.engine,
    drum: previous?.drum ?? drumParams(),
    synth: { ...synthParams(), ...preset.params },
  };
}

// ---------------------------------------------------------------------------
// Parameter help
// ---------------------------------------------------------------------------

/**
 * Plain-English descriptions, keyed by the label shown on the knob. These go
 * into the tooltip so the answer is always one hover away.
 */
export const PARAM_HELP: Record<string, string> = {
  // drums
  'Tune': 'The basic pitch of the drum. Lower is deeper.',
  'Metal base': 'Pitch of the six metallic oscillators. Shifts the whole character rather than a note.',
  'Decay': 'How long it rings before dying away. Short is tight, long is booming.',
  'Punch': 'How far the pitch drops at the very start. This is what makes a kick thump rather than beep.',
  'Punch time': 'How fast that pitch drop happens. Very short reads as a click; longer reads as a boom.',
  'Noise': 'Blends in noise. Down is a pure tone, up is hiss and crack — snares live in the middle.',
  'Snap': 'A tiny click right at the start so the drum cuts through a busy mix.',
  'Cutoff': 'Filters off the top end. Lower is darker and warmer, higher is brighter.',
  'Reso': 'Boosts the frequencies right at the cutoff point. High values start to whistle.',
  'Drive': 'Saturation. Adds harmonics and makes the sound louder, thicker and dirtier.',

  // synths
  'Voices': 'How many oscillators stack up on each note. More is thicker and wider.',
  'Detune': 'How far apart those oscillators are tuned. This one knob is the whole supersaw sound.',
  'Spread': 'How far the stacked voices are spread across the stereo field.',
  'Octave': 'Transposes the whole instrument up or down in octaves.',
  'Sub': 'Adds a plain sine one octave below for weight. Useful on basses.',
  'FM ratio': 'Modulator pitch relative to the note. Whole numbers sound musical; fractions sound like bells and metal.',
  'FM index': 'How much modulation is applied. More is brighter and more clangy.',
  'Env amt': 'How far the filter sweeps when a note starts, in octaves. This is what makes a pluck pluck.',
  'Key track': 'Makes the filter follow the pitch, so high notes stay as bright as low ones.',
  'Glide': 'Slides between notes instead of jumping. Overlap two notes to hear it.',
  'Level': 'Track volume.',
  'Pan': 'Position in the stereo field, left to right.',
  'Reverb': 'How much of this track is sent to the shared reverb.',
  'Delay': 'How much of this track is sent to the shared echo.',
  'Sidechain': 'How far this track ducks each time the kick hits. This is the pump.',

  // envelopes
  'A': 'Attack — how long the sound takes to reach full volume. Zero is instant, high is a slow swell.',
  'D': 'Decay — how long it takes to fall from full volume down to the sustain level.',
  'S': 'Sustain — the level it holds at while you keep the key down. Zero makes every note a pluck.',
  'R': 'Release — how long it takes to fade out after you let go.',
};
