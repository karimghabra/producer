/**
 * Click scanner.
 *
 * Hunting clicks by ear-and-guess does not converge. This renders every voice
 * offline and scores it, so a regression shows up as a number instead of a
 * complaint.
 *
 * The metric: a click is a discontinuity, and bandlimited audio has a bounded
 * second difference. `x[n] - 2x[n-1] + x[n-2]` spikes at a step and stays small
 * through even very bright material, and scoring each spike against the local
 * RMS of that same quantity makes the test adapt to how sharp the source
 * already is — a hi-hat is allowed to be sharp, a sine bass is not.
 *
 * Interpreting the score:
 *   under ~8   clean
 *   8 - 15     a fast but continuous transient; normal for percussion
 *   over ~25   worth investigating
 *
 * Scores in the teens on plucks and stabs are the filter envelope doing its
 * job. What matters is the trend: run it before and after a change.
 *
 * From the browser console:
 *   const { scanAll } = await import('/src/dev/clickScan.ts');
 *   console.table(await scanAll());
 */

import { SynthVoice } from '../audio/synth';
import { triggerDrum } from '../audio/drums';
import { DRUM_PRESETS, SYNTH_PRESETS, instrumentFromPreset } from '@shared/presets';

const SR = 48000;

export interface ScanResult {
  kind: 'drum' | 'synth';
  name: string;
  engine: string;
  /** Absolute peak. Anything at or above 1 clips at the output device. */
  peak: number;
  /** Worst discontinuity, relative to the material's own local roughness. */
  score: number;
  /** Where it happened, in ms from the start of the render. */
  atMs: number;
}

function score(d: Float32Array): { peak: number; score: number; atMs: number } {
  const n = d.length;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak < 1e-4) return { peak: 0, score: 0, atMs: 0 };

  const dd = new Float32Array(n);
  for (let i = 2; i < n; i++) dd[i] = d[i] - 2 * d[i - 1] + d[i - 2];

  const W = 2048;
  let worst = 0;
  let worstAt = 0;
  for (let i = 2; i < n; i++) {
    // Skip near-silence, where the ratio is meaningless.
    if (Math.abs(d[i]) < peak * 0.02 && Math.abs(dd[i]) < peak * 0.02) continue;
    const lo = Math.max(2, i - W);
    const hi = Math.min(n, i + W);
    let sum = 0;
    let count = 0;
    for (let j = lo; j < hi; j += 8) { sum += dd[j] * dd[j]; count++; }
    const rms = Math.sqrt(sum / Math.max(1, count));
    const s = rms > 1e-9 ? Math.abs(dd[i]) / rms : 0;
    if (s > worst) { worst = s; worstAt = i; }
  }
  return {
    peak: Number(peak.toFixed(4)),
    score: Number(worst.toFixed(1)),
    atMs: Number(((worstAt / SR) * 1000).toFixed(1)),
  };
}

/** Render every preset once and score it. Nothing is sent to the speakers. */
export async function scanAll(): Promise<ScanResult[]> {
  const out: ScanResult[] = [];

  for (const preset of DRUM_PRESETS) {
    const ctx = new OfflineAudioContext(1, SR * 2.5, SR);
    triggerDrum(preset.engine, {
      ctx: ctx as unknown as AudioContext,
      dest: ctx.destination,
      time: 0.05,
      params: instrumentFromPreset(preset).drum,
      velocity: 1,
      semis: 0,
    });
    const rendered = (await ctx.startRendering()).getChannelData(0);
    out.push({ kind: 'drum', name: preset.name, engine: preset.engine, ...score(rendered) });
  }

  for (const preset of SYNTH_PRESETS) {
    const ctx = new OfflineAudioContext(1, SR * 3, SR);
    const voice = new SynthVoice({
      ctx: ctx as unknown as AudioContext,
      dest: ctx.destination,
      engine: preset.engine,
      params: instrumentFromPreset(preset).synth,
      midi: 57,
      velocity: 0.9,
      time: 0.05,
      glideFrom: null,
    });
    // Release it as a sixteenth at 128 BPM would be.
    voice.release(0.05 + 0.108);
    const rendered = (await ctx.startRendering()).getChannelData(0);
    out.push({ kind: 'synth', name: preset.name, engine: preset.engine, ...score(rendered) });
  }

  return out.sort((a, b) => b.score - a.score);
}

/** Anything that clips at the device, which is never acceptable. */
export async function scanForClipping(): Promise<ScanResult[]> {
  return (await scanAll()).filter((r) => r.peak >= 1);
}

// ---------------------------------------------------------------------------
// Fuzzing
// ---------------------------------------------------------------------------

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const oneOf = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

const DRUM_ENGINES = ['kick', 'snare', 'clap', 'hat', 'cymbal', 'tom', 'rim', 'noise'] as const;
const SYNTH_ENGINES = ['supersaw', 'reese', 'fm', 'sub', 'pluck', 'pad'] as const;

export interface FuzzReport {
  tested: number;
  clipping: number;
  clippingRate: string;
  worstPeak: number;
  medianPeak: number;
  /** Parameter averages for the runs that clipped, versus those that did not. */
  profile: Record<string, Record<string, number | null>>;
}

/**
 * Render random points from the whole parameter space and look for peaks at or
 * above full scale.
 *
 * Presets only cover the settings someone chose. Fuzzing covers the settings a
 * user can reach with the knobs, which is the set that actually has to be safe.
 * Comparing the parameter averages of the runs that clipped against those that
 * did not points at the mechanism rather than just the symptom — it is how the
 * summed-parallel-branches problem was found, with drive and noise both high in
 * the clipping group while resonance was, counter-intuitively, lower.
 *
 *   const { fuzzForClipping } = await import('/src/dev/clickScan.ts');
 *   await fuzzForClipping(80);
 */
export async function fuzzForClipping(runs = 60): Promise<FuzzReport> {
  const SR = 24000;
  const T = 0.02;
  const peaks: number[] = [];
  const params: Array<Record<string, number>> = [];

  for (let i = 0; i < runs; i++) {
    const drum = i % 2 === 0;
    const ctx = new OfflineAudioContext(1, SR * 1.2, SR);
    let p: Record<string, number>;

    if (drum) {
      p = {
        tune: rand(20, 1200), decay: rand(0.02, 1.5), pitchMod: rand(0, 48),
        pitchTime: rand(0.002, 0.4), noise: rand(0, 1), drive: rand(0, 1),
        cutoff: rand(60, 20000), resonance: rand(0.1, 18), snap: rand(0, 1),
      };
      triggerDrum(oneOf(DRUM_ENGINES), {
        ctx: ctx as unknown as AudioContext, dest: ctx.destination, time: T,
        params: p as never, velocity: 1, semis: 0,
      });
    } else {
      p = {
        voices: Math.round(rand(1, 9)), detune: rand(0, 1), spread: rand(0, 1),
        octave: Math.round(rand(-3, 3)), sub: rand(0, 1), fmRatio: rand(0.25, 16),
        fmIndex: rand(0, 16), cutoff: rand(30, 20000), resonance: rand(0.1, 28),
        filterEnv: rand(-4, 5), keyTrack: rand(0, 1), drive: rand(0, 1), glide: 0,
      };
      const voice = new SynthVoice({
        ctx: ctx as unknown as AudioContext, dest: ctx.destination,
        engine: oneOf(SYNTH_ENGINES),
        params: {
          ...p,
          filterType: 'lowpass',
          amp: { attack: rand(0.001, 0.3), decay: rand(0.01, 1), sustain: rand(0, 1), release: rand(0.01, 0.5) },
          filt: { attack: rand(0.001, 0.3), decay: rand(0.01, 1), sustain: rand(0, 1), release: rand(0.01, 0.5) },
        } as never,
        midi: Math.round(rand(33, 81)), velocity: 1, time: T, glideFrom: null,
      });
      voice.release(T + 0.3);
    }

    const d = (await ctx.startRendering()).getChannelData(0);
    let peak = 0;
    for (let j = 0; j < d.length; j++) peak = Math.max(peak, Math.abs(d[j]));
    peaks.push(peak);
    params.push(p);
  }

  const clipped = params.filter((_, i) => peaks[i] >= 1);
  const clean = params.filter((_, i) => peaks[i] < 1);
  const avg = (rows: Array<Record<string, number>>, key: string) => {
    const vals = rows.map((r) => r[key]).filter((v) => typeof v === 'number');
    return vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : null;
  };
  const keys = ['drive', 'noise', 'resonance', 'snap', 'sub', 'voices'];
  const sorted = peaks.slice().sort((a, b) => a - b);

  return {
    tested: runs,
    clipping: peaks.filter((p) => p >= 1).length,
    clippingRate: `${Math.round((peaks.filter((p) => p >= 1).length / runs) * 100)}%`,
    worstPeak: Number(Math.max(...peaks).toFixed(3)),
    medianPeak: Number(sorted[Math.floor(sorted.length / 2)].toFixed(3)),
    profile: {
      clipping: Object.fromEntries(keys.map((k) => [k, avg(clipped, k)])),
      clean: Object.fromEntries(keys.map((k) => [k, avg(clean, k)])),
    },
  };
}
