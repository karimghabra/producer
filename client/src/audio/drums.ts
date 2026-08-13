/**
 * Drum voices, synthesised from scratch.
 *
 * These follow the classic analogue topologies — a pitch-swept sine for the
 * kick, a bank of six detuned squares for the metals, the 909's three-burst
 * clap — because those circuits are simple enough to state as maths and they
 * are what dance music is built out of.
 *
 * Every voice is fire-and-forget: it builds its nodes, schedules its whole
 * life, calls stop(), and lets the graph collect itself.
 */

import type { DrumParams, DrumEngine } from '@shared/types';
import { clamp } from '@shared/theory';
import { whiteNoise, percEnv, saturationCurve, SILENCE } from './dsp';

export interface HitContext {
  ctx: AudioContext;
  dest: AudioNode;
  time: number;
  params: DrumParams;
  /** 0..1 */
  velocity: number;
  /** Semitone offset applied to the voice's base pitch. */
  semis: number;
}

/**
 * The 808's hi-hat runs six square oscillators at these mutually inharmonic
 * ratios. Nothing lines up, so the spectrum never resolves into a pitch — it
 * just sounds like metal.
 */
const METAL_RATIOS = [1, 1.4827, 1.8002, 2.5460, 2.6303, 3.8967];

function noiseSource(ctx: AudioContext, time: number, stop: number): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = whiteNoise(ctx);
  src.loop = true;
  // Random offset so consecutive hits do not phase-lock into a tone.
  const offset = Math.random() * (src.buffer.duration - 0.5);
  src.start(time, offset);
  src.stop(stop);
  return src;
}

function driveStage(ctx: AudioContext, amount: number): AudioNode | null {
  if (amount < 0.01) return null;
  const shaper = ctx.createWaveShaper();
  shaper.curve = saturationCurve(amount);
  shaper.oversample = '2x';
  return shaper;
}

/** Chain a list of nodes and return { input, output }. */
function chain(nodes: Array<AudioNode | null>): { input: AudioNode; output: AudioNode } | null {
  const live = nodes.filter((n): n is AudioNode => n !== null);
  if (live.length === 0) return null;
  for (let i = 0; i < live.length - 1; i++) live[i].connect(live[i + 1]);
  return { input: live[0], output: live[live.length - 1] };
}

const semitones = (base: number, semis: number) => base * Math.pow(2, semis / 12);

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

function kick(h: HitContext): number {
  const { ctx, dest, time, params: p, velocity: v } = h;
  const base = clamp(semitones(p.tune, h.semis), 20, 400);
  const end = time + p.decay + 0.05;

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  // Pitch envelope: start pitchMod semitones up, fall exponentially to base.
  const start = base * Math.pow(2, p.pitchMod / 12);
  osc.frequency.setValueAtTime(start, time);
  osc.frequency.exponentialRampToValueAtTime(base, time + Math.max(0.005, p.pitchTime));

  const amp = ctx.createGain();
  amp.gain.value = 0;
  percEnv(amp.gain, time, v, p.decay, 0.002);

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = clamp(p.cutoff, 40, 20000);
  lp.Q.value = clamp(p.resonance, 0.0001, 20);

  const out = chain([amp, driveStage(ctx, p.drive), lp])!;
  osc.connect(out.input);
  out.output.connect(dest);
  osc.start(time);
  osc.stop(end);

  // Transient click — a very short noise burst high-passed well above the body.
  if (p.snap > 0.01) {
    const clickEnd = time + 0.03;
    const n = noiseSource(ctx, time, clickEnd);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1200;
    const cg = ctx.createGain();
    cg.gain.value = 0;
    percEnv(cg.gain, time, v * p.snap * 0.5, 0.012, 0.0005);
    n.connect(hp).connect(cg).connect(dest);
  }

  return end;
}

function snare(h: HitContext): number {
  const { ctx, dest, time, params: p, velocity: v } = h;
  const base = clamp(semitones(p.tune, h.semis), 60, 1200);
  const end = time + p.decay + 0.08;
  const toneLevel = 1 - p.noise;

  // Two-tone body. The 1.588 ratio is roughly the 909's pair of triangle
  // oscillators — close to a tritone, deliberately unresolved.
  if (toneLevel > 0.01) {
    for (const [mult, gain] of [[1, 0.7], [1.588, 0.45]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(base * mult * 1.35, time);
      osc.frequency.exponentialRampToValueAtTime(base * mult, time + 0.03);
      const g = ctx.createGain();
      g.gain.value = 0;
      percEnv(g.gain, time, v * toneLevel * gain, p.decay * 0.75, 0.001);
      osc.connect(g).connect(dest);
      osc.start(time);
      osc.stop(end);
    }
  }

  // Noise layer — the "snares" themselves.
  if (p.noise > 0.01) {
    const n = noiseSource(ctx, time, end);
    const bp = ctx.createBiquadFilter();
    bp.type = 'highpass';
    bp.frequency.value = clamp(base * 4, 300, 8000);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = clamp(p.cutoff, 500, 20000);
    lp.Q.value = clamp(p.resonance, 0.0001, 20);
    const g = ctx.createGain();
    g.gain.value = 0;
    percEnv(g.gain, time, v * p.noise * 0.9, p.decay, 0.001);
    const out = chain([bp, lp, g, driveStage(ctx, p.drive)])!;
    n.connect(out.input);
    out.output.connect(dest);
  }

  return end;
}

/**
 * The 909 clap is three fast noise bursts about 10 ms apart followed by a
 * longer tail. That tiny burst spacing is the entire trick — it reads as many
 * hands rather than one, and shifting it changes the size of the room.
 */
function clap(h: HitContext): number {
  const { ctx, dest, time, params: p, velocity: v } = h;
  const end = time + p.decay + 0.1;

  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = clamp(semitones(p.tune, h.semis), 200, 6000);
  bp.Q.value = clamp(1 + p.resonance, 0.3, 12);

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 500;

  const g = ctx.createGain();
  g.gain.value = 0;

  const n = noiseSource(ctx, time, end);
  const out = chain([bp, hp, g, driveStage(ctx, p.drive)])!;
  n.connect(out.input);
  out.output.connect(dest);

  // Three bursts, then the tail.
  const spacing = 0.0095;
  g.gain.setValueAtTime(SILENCE, time);
  for (let i = 0; i < 3; i++) {
    const t = time + i * spacing;
    g.gain.setValueAtTime(v * (0.85 - i * 0.12), t);
    g.gain.exponentialRampToValueAtTime(Math.max(SILENCE, v * 0.18), t + spacing * 0.85);
  }
  const tailStart = time + 3 * spacing;
  g.gain.setValueAtTime(v, tailStart);
  g.gain.exponentialRampToValueAtTime(SILENCE, tailStart + p.decay);

  return end;
}

function metal(h: HitContext, extraHighpass: number): number {
  const { ctx, dest, time, params: p, velocity: v } = h;
  const base = clamp(semitones(p.tune, h.semis), 60, 2000);
  const end = time + p.decay + 0.05;

  const mix = ctx.createGain();
  mix.gain.value = 1 / METAL_RATIOS.length;

  for (const ratio of METAL_RATIOS) {
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = base * ratio;
    osc.connect(mix);
    osc.start(time);
    osc.stop(end);
  }

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = clamp(p.cutoff * extraHighpass, 200, 20000);
  hp.Q.value = clamp(p.resonance, 0.0001, 20);

  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = clamp(p.cutoff * 1.15, 300, 20000);
  bp.Q.value = 0.6;

  const g = ctx.createGain();
  g.gain.value = 0;
  percEnv(g.gain, time, v * 0.8, p.decay, 0.0008);

  // A little noise glues the squares together into something less synthetic.
  if (p.noise > 0.01) {
    const n = noiseSource(ctx, time, end);
    const ng = ctx.createGain();
    ng.gain.value = p.noise * 0.35;
    n.connect(ng).connect(mix);
  }

  const out = chain([hp, bp, g, driveStage(ctx, p.drive)])!;
  mix.connect(out.input);
  out.output.connect(dest);
  return end;
}

function tom(h: HitContext): number {
  const { ctx, dest, time, params: p, velocity: v } = h;
  const base = clamp(semitones(p.tune, h.semis), 40, 800);
  const end = time + p.decay + 0.05;

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(base * Math.pow(2, (p.pitchMod * 0.4) / 12), time);
  osc.frequency.exponentialRampToValueAtTime(base, time + Math.max(0.01, p.pitchTime * 2));

  const g = ctx.createGain();
  g.gain.value = 0;
  percEnv(g.gain, time, v * 0.9, p.decay, 0.002);

  const out = chain([g, driveStage(ctx, p.drive)])!;
  osc.connect(out.input);
  out.output.connect(dest);
  osc.start(time);
  osc.stop(end);

  if (p.noise > 0.01) {
    const n = noiseSource(ctx, time, end);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = base * 3;
    bp.Q.value = 1.5;
    const ng = ctx.createGain();
    ng.gain.value = 0;
    percEnv(ng.gain, time, v * p.noise * 0.4, p.decay * 0.4, 0.001);
    n.connect(bp).connect(ng).connect(dest);
  }
  return end;
}

function rim(h: HitContext): number {
  const { ctx, dest, time, params: p, velocity: v } = h;
  const base = clamp(semitones(p.tune, h.semis), 200, 4000);
  const end = time + 0.06;

  const mix = ctx.createGain();
  mix.gain.value = 0.5;
  for (const ratio of [1, 1.4] as const) {
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = base * ratio;
    osc.connect(mix);
    osc.start(time);
    osc.stop(end);
  }

  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = base * 1.6;
  bp.Q.value = 6;

  const g = ctx.createGain();
  g.gain.value = 0;
  percEnv(g.gain, time, v * 0.7, 0.028, 0.0005);

  mix.connect(bp).connect(g).connect(dest);
  return end;
}

function noiseHit(h: HitContext): number {
  const { ctx, dest, time, params: p, velocity: v } = h;
  const end = time + p.decay + 0.05;
  const n = noiseSource(ctx, time, end);

  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = clamp(semitones(p.cutoff, h.semis), 60, 20000);
  bp.Q.value = clamp(p.resonance, 0.1, 30);

  const g = ctx.createGain();
  g.gain.value = 0;
  percEnv(g.gain, time, v * 0.8, p.decay, 0.002);

  const out = chain([bp, g, driveStage(ctx, p.drive)])!;
  n.connect(out.input);
  out.output.connect(dest);
  return end;
}

// ---------------------------------------------------------------------------

const VOICES: Record<DrumEngine, (h: HitContext) => number> = {
  kick,
  snare,
  clap,
  hat: (h) => metal(h, 1.0),
  cymbal: (h) => metal(h, 0.55),
  tom,
  rim,
  noise: noiseHit,
};

/**
 * Headroom, applied at the voice output.
 *
 * It cannot be folded into the velocity: saturation normalises as
 * tanh(k·x)/tanh(k), which at high drive maps almost any input back up to full
 * scale, so a quieter input comes out just as loud. The body and the transient
 * are also separate branches that can align. Measured peaks were 1.01–1.02,
 * and anything past 1.0 hard-clips at the device, which is heard as static.
 */
const HEADROOM = 0.82;

/** Fire one drum hit. Returns the time the voice finishes. */
export function triggerDrum(engine: DrumEngine, h: HitContext): number {
  const voice = VOICES[engine] ?? kick;
  const trim = h.ctx.createGain();
  trim.gain.value = HEADROOM;
  trim.connect(h.dest);
  const end = voice({ ...h, dest: trim, velocity: clamp(h.velocity, 0, 1.4) });
  // Detach once the voice is silent so the graph does not accumulate.
  const ms = Math.max(0, (end - h.ctx.currentTime) * 1000) + 250;
  setTimeout(() => { try { trim.disconnect(); } catch { /* gone */ } }, ms);
  return end;
}

export const DRUM_ENGINES: DrumEngine[] = [
  'kick', 'snare', 'clap', 'hat', 'cymbal', 'tom', 'rim', 'noise',
];
