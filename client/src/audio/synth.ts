/**
 * Polyphonic synth voices.
 *
 * A voice is a short-lived object: it builds an oscillator stack, a filter and
 * an amplifier, schedules its attack, and waits to be released. The interesting
 * part is the unison stack, which uses the JP-8000's measured detune curve
 * (see shared/theory.ts) rather than an even spread — that non-linearity is
 * what separates a supersaw from seven saws.
 */

import type { SynthParams, SynthEngine } from '@shared/types';
import { clamp, mtof, unisonCents } from '@shared/theory';
import { saturationCurve, applyAttackDecay, applyRelease, adsrValueAt, SILENCE } from './dsp';

export interface VoiceOptions {
  ctx: AudioContext;
  dest: AudioNode;
  engine: SynthEngine;
  params: SynthParams;
  midi: number;
  velocity: number;
  time: number;
  /** Portamento origin, in MIDI note numbers. */
  glideFrom?: number | null;
}

/** How many oscillators an engine actually wants, given the patch. */
function voiceCount(engine: SynthEngine, p: SynthParams): number {
  switch (engine) {
    case 'sub': return 1;
    case 'fm': return 1;
    case 'reese': return clamp(Math.round(p.voices), 2, 5);
    case 'pluck': return clamp(Math.round(p.voices), 1, 5);
    default: return clamp(Math.round(p.voices), 1, 9);
  }
}

function oscWave(engine: SynthEngine): OscillatorType {
  switch (engine) {
    case 'sub': return 'sine';
    case 'fm': return 'sine';
    case 'pluck': return 'sawtooth';
    default: return 'sawtooth';
  }
}

export class SynthVoice {
  readonly midi: number;
  readonly startTime: number;
  /** Set once release is scheduled — the time this voice goes silent. */
  endTime = Infinity;
  private released = false;
  private disposed = false;

  private ctx: AudioContext;
  private params: SynthParams;
  private engine: SynthEngine;
  private oscs: OscillatorNode[] = [];
  private modOsc: OscillatorNode | null = null;
  private modGain: GainNode | null = null;
  private amp: GainNode;
  private filter: BiquadFilterNode;
  private pitchNodes: AudioParam[] = [];
  /** Envelope peak, kept so a future release can be anchored correctly. */
  private peak = 0;
  private modPeak = 0;

  constructor(opts: VoiceOptions) {
    const { ctx, dest, engine, params: p, midi, velocity, time } = opts;
    this.ctx = ctx;
    this.params = p;
    this.engine = engine;
    this.midi = midi;
    this.startTime = time;

    const baseMidi = midi + p.octave * 12;
    const freq = mtof(baseMidi);
    const glideFrom = opts.glideFrom != null ? mtof(opts.glideFrom + p.octave * 12) : null;
    const glide = Math.max(0, p.glide);

    // --- amplifier -------------------------------------------------------
    this.amp = ctx.createGain();
    this.amp.gain.value = 0;

    // --- filter ----------------------------------------------------------
    this.filter = ctx.createBiquadFilter();
    this.filter.type = p.filterType;
    this.filter.Q.value = clamp(p.resonance, 0.0001, 30);

    // Key tracking: the cutoff follows the played pitch so high notes stay as
    // bright as low ones instead of vanishing.
    const trackMul = Math.pow(2, (p.keyTrack * (baseMidi - 60)) / 12);
    const baseCut = clamp(p.cutoff * trackMul, 30, 20000);
    const peakCut = clamp(baseCut * Math.pow(2, p.filterEnv), 30, 20000);
    applyAttackDecay(
      this.filter.frequency, time, peakCut,
      p.filt.attack, p.filt.decay,
      clamp((baseCut + (peakCut - baseCut) * p.filt.sustain) / peakCut, 0.001, 1),
    );

    // --- oscillator stack -------------------------------------------------
    const n = voiceCount(engine, p);
    const wave = oscWave(engine);
    const cents = unisonCents(n, engine === 'reese' ? p.detune * 0.35 : p.detune);
    const mix = ctx.createGain();
    mix.gain.value = 1 / Math.sqrt(Math.max(1, n));

    for (let i = 0; i < n; i++) {
      const osc = ctx.createOscillator();
      osc.type = wave;
      if (glideFrom !== null && glide > 0.001) {
        osc.frequency.setValueAtTime(glideFrom, time);
        osc.frequency.exponentialRampToValueAtTime(freq, time + glide);
      } else {
        osc.frequency.setValueAtTime(freq, time);
      }
      osc.detune.value = cents[i] ?? 0;
      this.pitchNodes.push(osc.detune);

      // Symmetric stereo placement; the centre voice stays centred.
      const spread = clamp(p.spread, 0, 1);
      const pos = n === 1 ? 0 : ((i / (n - 1)) * 2 - 1) * spread;
      const panner = ctx.createStereoPanner();
      panner.pan.value = clamp(pos, -1, 1);

      // The JP-8000 mixes side oscillators below the centre one; approximate
      // that by weighting voices by their distance from the middle.
      const centreDist = n === 1 ? 0 : Math.abs(i - (n - 1) / 2) / ((n - 1) / 2);
      const g = ctx.createGain();
      g.gain.value = 1 - centreDist * 0.25;

      osc.connect(g).connect(panner).connect(mix);
      osc.start(time);
      this.oscs.push(osc);
    }

    // --- FM ---------------------------------------------------------------
    if (engine === 'fm') {
      const carrier = this.oscs[0];
      const mod = ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.value = freq * clamp(p.fmRatio, 0.25, 24);
      const mg = ctx.createGain();
      // Modulation index is expressed in multiples of the carrier frequency,
      // so the timbre stays consistent as you play up and down the keyboard.
      this.modPeak = freq * clamp(p.fmIndex, 0, 24);
      mg.gain.setValueAtTime(this.modPeak, time);
      mg.gain.exponentialRampToValueAtTime(
        Math.max(SILENCE, this.modPeak * clamp(p.filt.sustain, 0.01, 1)),
        time + Math.max(0.01, p.filt.decay),
      );
      mod.connect(mg).connect(carrier.frequency);
      mod.start(time);
      this.modOsc = mod;
      this.modGain = mg;
    }

    // --- sub oscillator ---------------------------------------------------
    if (p.sub > 0.001 && engine !== 'sub') {
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(freq * 0.5, time);
      const sg = ctx.createGain();
      sg.gain.value = clamp(p.sub, 0, 1) * 0.7;
      sub.connect(sg).connect(mix);
      sub.start(time);
      this.oscs.push(sub);
      this.pitchNodes.push(sub.detune);
    }

    // --- wiring -----------------------------------------------------------
    let tail: AudioNode = mix;
    tail.connect(this.filter);
    tail = this.filter;

    if (p.drive > 0.01) {
      const shaper = ctx.createWaveShaper();
      shaper.curve = saturationCurve(p.drive);
      shaper.oversample = '2x';
      tail.connect(shaper);
      tail = shaper;
    }

    tail.connect(this.amp);
    this.amp.connect(dest);

    // --- amplitude envelope ------------------------------------------------
    this.peak = clamp(velocity, 0, 1.4) * 0.5;
    applyAttackDecay(this.amp.gain, time, this.peak, p.amp.attack, p.amp.decay, p.amp.sustain);
  }

  /** Re-pitch a sustaining voice (used by note-repeat pitch ramps). */
  bend(semitones: number, time: number): void {
    for (const detune of this.pitchNodes) {
      detune.setValueAtTime(detune.value + semitones * 100, time);
    }
  }

  /** Level of the amp envelope at `t`, used to anchor a release smoothly. */
  private ampLevelAt(t: number): number {
    const a = this.params.amp;
    return adsrValueAt(t, this.startTime, this.peak, a.attack, a.decay, a.sustain);
  }

  /** Begin the release stage. Returns the time the voice is fully silent. */
  release(time: number): number {
    if (this.released) return this.endTime;
    this.released = true;
    const t = Math.max(time, this.startTime + 0.001);
    const r = Math.max(0.01, this.params.amp.release);
    applyRelease(this.amp.gain, t, r, this.ampLevelAt(t));
    if (this.modGain) {
      const f = this.params.filt;
      applyRelease(
        this.modGain.gain, t, r,
        adsrValueAt(t, this.startTime, this.modPeak, 0.0005, f.decay, f.sustain),
      );
    }
    this.endTime = t + r + 0.02;
    this.stopAt(this.endTime);
    return this.endTime;
  }

  /** Cut the voice off quickly — used when stealing voices. */
  kill(time: number): number {
    const t = Math.max(time, this.startTime + 0.001);
    this.released = true;
    // Still a real ramp, not a jump: 12 ms is short enough to free the voice
    // immediately and long enough not to click.
    applyRelease(this.amp.gain, t, 0.012, this.ampLevelAt(t));
    this.endTime = t + 0.04;
    this.stopAt(this.endTime);
    return this.endTime;
  }

  private stopAt(t: number): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const osc of this.oscs) {
      try { osc.stop(t); } catch { /* already stopped */ }
    }
    if (this.modOsc) {
      try { this.modOsc.stop(t); } catch { /* already stopped */ }
    }
    // Detach once silent so the graph does not accumulate dead branches.
    const ms = Math.max(0, (t - this.ctx.currentTime) * 1000) + 60;
    setTimeout(() => {
      try { this.amp.disconnect(); } catch { /* gone */ }
    }, ms);
  }
}

export const SYNTH_ENGINES: SynthEngine[] = [
  'supersaw', 'reese', 'fm', 'sub', 'pluck', 'pad',
];
