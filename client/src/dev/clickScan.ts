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
