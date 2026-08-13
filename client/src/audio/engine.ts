/**
 * The audio graph.
 *
 *   voices ─▶ track channel ─▶ duck ─▶ pan ─▶ fader ─┬─▶ master bus
 *                                                    ├─▶ reverb bus
 *                                                    └─▶ delay bus
 *
 *   master bus ─▶ macro filters ─▶ crush ─▶ stutter ─▶ drive ─▶ gate
 *              ─▶ limiter ─▶ output gain ─▶ analyser ─▶ speakers
 *
 * The sidechain is not a compressor listening to a signal — it is scheduled.
 * When the sequencer places a kick at time t, it also writes a ducking curve
 * into every subscribed channel at exactly t. That is sample-accurate, costs
 * nothing, and it is why the pump locks perfectly to the grid.
 */

import type {
  Project, Track, MasterFx, DrumParams, SynthParams, SynthEngine, DrumEngine,
} from '@shared/types';
import { clamp, mtof } from '@shared/theory';
import { makeReverbIR, saturationCurve, crushCurve, softClipCurve, whiteNoise } from './dsp';
import { triggerDrum } from './drums';
import { SynthVoice } from './synth';

const MAX_VOICES_PER_TRACK = 12;

interface Channel {
  id: string;
  input: GainNode;
  duck: GainNode;
  panner: StereoPannerNode;
  fader: GainNode;
  dry: GainNode;
  reverbSend: GainNode;
  delaySend: GainNode;
  /** Sidechain depth, mirrored from the mixer for fast access. */
  duckAmount: number;
  /** State of the duck curve in flight, so a new duck can start from the
   *  level the old one will actually have reached. */
  duckStart: number;
  duckFrom: number;
  duckAmt: number;
  voices: SynthVoice[];
  /** Last note played, for portamento. */
  lastMidi: number | null;
}

export interface MeterReading {
  peak: number;
  rms: number;
}

export class AudioEngine {
  readonly ctx: AudioContext;

  // master chain
  private masterBus: GainNode;
  private macroLP: BiquadFilterNode;
  private macroHP: BiquadFilterNode;
  private crushDry: GainNode;
  private crushWet: GainNode;
  private crushShaper: WaveShaperNode;
  private crushSum: GainNode;
  private stutterDry: GainNode;
  private stutterWet: GainNode;
  private stutterDelay: DelayNode;
  private stutterFb: GainNode;
  private stutterSum: GainNode;
  private driveShaper: WaveShaperNode;
  private gateGain: GainNode;
  private limiter: DynamicsCompressorNode;
  private outGain: GainNode;
  private safety: WaveShaperNode;
  private analyser: AnalyserNode;
  private meterBuf: Float32Array<ArrayBuffer>;

  // fx buses
  private reverbBus: GainNode;
  private convolver: ConvolverNode;
  private reverbReturn: GainNode;
  private delayBus: GainNode;
  private delayL: DelayNode;
  private delayR: DelayNode;
  private delayFbL: GainNode;
  private delayFbR: GainNode;
  private delayToneL: BiquadFilterNode;
  private delayToneR: BiquadFilterNode;
  private delayPanL: StereoPannerNode;
  private delayPanR: StereoPannerNode;
  private delayReturn: GainNode;

  // riser
  private riserSrc: AudioBufferSourceNode | null = null;
  private riserFilter: BiquadFilterNode | null = null;
  private riserGain: GainNode | null = null;

  private channels = new Map<string, Channel>();
  private master: MasterFx;
  private bpm = 128;
  private reverbSpecKey = '';

  constructor() {
    const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    const ctx = this.ctx;

    // ---- master chain ----------------------------------------------------
    this.masterBus = ctx.createGain();
    this.masterBus.gain.value = 1;

    this.macroLP = ctx.createBiquadFilter();
    this.macroLP.type = 'lowpass';
    this.macroLP.frequency.value = 20000;
    this.macroLP.Q.value = 0.9;

    this.macroHP = ctx.createBiquadFilter();
    this.macroHP.type = 'highpass';
    this.macroHP.frequency.value = 10;
    this.macroHP.Q.value = 0.9;

    // Bit crusher on a parallel path so it can be fully bypassed.
    this.crushDry = ctx.createGain(); this.crushDry.gain.value = 1;
    this.crushWet = ctx.createGain(); this.crushWet.gain.value = 0;
    this.crushShaper = ctx.createWaveShaper();
    this.crushShaper.curve = crushCurve(0.6);
    this.crushSum = ctx.createGain();

    // Stutter: a delay line with unity feedback loops its own contents, which
    // is a beat-repeat. Sweeping the delay time while it loops pitches the
    // captured slice — that is the tape-stop.
    this.stutterDry = ctx.createGain(); this.stutterDry.gain.value = 1;
    this.stutterWet = ctx.createGain(); this.stutterWet.gain.value = 0;
    this.stutterDelay = ctx.createDelay(4);
    this.stutterDelay.delayTime.value = 0.25;
    this.stutterFb = ctx.createGain(); this.stutterFb.gain.value = 0;
    this.stutterSum = ctx.createGain();

    this.driveShaper = ctx.createWaveShaper();
    this.driveShaper.curve = saturationCurve(0.12);
    this.driveShaper.oversample = '2x';

    this.gateGain = ctx.createGain();
    this.gateGain.gain.value = 1;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 2;
    this.limiter.ratio.value = 16;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.14;

    this.outGain = ctx.createGain();
    this.outGain.gain.value = 0.85;

    // Last thing before the speakers: a transparent-below-knee soft clip, so
    // the graph physically cannot hand the device a sample past full scale.
    this.safety = ctx.createWaveShaper();
    this.safety.curve = softClipCurve(0.7);
    this.safety.oversample = '2x';

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.5;
    this.meterBuf = new Float32Array(this.analyser.fftSize);

    this.masterBus.connect(this.macroLP);
    this.macroLP.connect(this.macroHP);

    this.macroHP.connect(this.crushDry).connect(this.crushSum);
    this.macroHP.connect(this.crushShaper).connect(this.crushWet).connect(this.crushSum);

    this.crushSum.connect(this.stutterDry).connect(this.stutterSum);
    this.crushSum.connect(this.stutterDelay);
    this.stutterDelay.connect(this.stutterFb).connect(this.stutterDelay);
    this.stutterDelay.connect(this.stutterWet).connect(this.stutterSum);

    this.stutterSum.connect(this.driveShaper);
    this.driveShaper.connect(this.gateGain);
    this.gateGain.connect(this.limiter);
    this.limiter.connect(this.outGain);
    this.outGain.connect(this.safety);
    this.safety.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    // ---- reverb ----------------------------------------------------------
    this.reverbBus = ctx.createGain();
    this.convolver = ctx.createConvolver();
    this.convolver.normalize = false;
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 0.9;
    this.reverbBus.connect(this.convolver).connect(this.reverbReturn).connect(this.masterBus);

    // ---- ping-pong delay --------------------------------------------------
    this.delayBus = ctx.createGain();
    this.delayL = ctx.createDelay(4);
    this.delayR = ctx.createDelay(4);
    this.delayFbL = ctx.createGain();
    this.delayFbR = ctx.createGain();
    this.delayToneL = ctx.createBiquadFilter();
    this.delayToneR = ctx.createBiquadFilter();
    this.delayToneL.type = 'lowpass';
    this.delayToneR.type = 'lowpass';
    this.delayPanL = ctx.createStereoPanner();
    this.delayPanR = ctx.createStereoPanner();
    this.delayPanL.pan.value = -0.8;
    this.delayPanR.pan.value = 0.8;
    this.delayReturn = ctx.createGain();
    this.delayReturn.gain.value = 0.9;

    // Input hits the left tap; each tap feeds the other, so repeats alternate.
    this.delayBus.connect(this.delayL);
    this.delayL.connect(this.delayToneL).connect(this.delayFbL).connect(this.delayR);
    this.delayR.connect(this.delayToneR).connect(this.delayFbR).connect(this.delayL);
    this.delayL.connect(this.delayPanL).connect(this.delayReturn);
    this.delayR.connect(this.delayPanR).connect(this.delayReturn);
    this.delayReturn.connect(this.masterBus);

    this.master = {
      gain: 0.85, sidechainSource: null,
      sidechainAttack: 0.004, sidechainRelease: 0.24, sidechainCurve: 1.8,
      reverb: { size: 2.4, damp: 0.42, predelay: 0.018, width: 0.85, mix: 0.9 },
      delay: { division: 0.75, feedback: 0.42, tone: 3200, pingpong: 0.8, mix: 0.9 },
      drive: 0.12, cutoff: 20000, limiter: true,
    };
    this.applyMaster(this.master);
  }

  get currentTime(): number { return this.ctx.currentTime; }
  get state(): AudioContextState { return this.ctx.state; }

  /**
   * Resume the context, but never block the caller indefinitely. On machines
   * with no output device — or a device that is busy — `resume()` can stay
   * pending forever, and an awaited call there would leave the whole app stuck
   * behind its start screen. The graph is perfectly happy to be built while
   * suspended, so a timeout here costs nothing and removes a dead end.
   */
  async resume(): Promise<AudioContextState> {
    if (this.ctx.state === 'running') return 'running';
    try {
      await Promise.race([
        this.ctx.resume(),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
    } catch { /* no output device; stay suspended */ }
    return this.ctx.state;
  }

  // -------------------------------------------------------------------------
  // Channels
  // -------------------------------------------------------------------------

  private makeChannel(id: string): Channel {
    const ctx = this.ctx;
    const input = ctx.createGain();
    const duck = ctx.createGain();
    const panner = ctx.createStereoPanner();
    const fader = ctx.createGain();
    const dry = ctx.createGain();
    const reverbSend = ctx.createGain();
    const delaySend = ctx.createGain();

    reverbSend.gain.value = 0;
    delaySend.gain.value = 0;

    input.connect(duck).connect(panner).connect(fader);
    fader.connect(dry).connect(this.masterBus);
    fader.connect(reverbSend).connect(this.reverbBus);
    fader.connect(delaySend).connect(this.delayBus);

    const ch: Channel = {
      id, input, duck, panner, fader, dry, reverbSend, delaySend,
      duckAmount: 0, duckStart: -1, duckFrom: 1, duckAmt: 0,
      voices: [], lastMidi: null,
    };
    this.channels.set(id, ch);
    return ch;
  }

  private channel(id: string): Channel {
    return this.channels.get(id) ?? this.makeChannel(id);
  }

  /** Reconcile the graph with the project: add channels, drop stale ones. */
  syncProject(project: Project): void {
    this.bpm = project.bpm;
    const live = new Set(project.tracks.map((t) => t.id));
    for (const [id, ch] of this.channels) {
      if (!live.has(id)) {
        for (const v of ch.voices) v.kill(this.ctx.currentTime);
        ch.input.disconnect();
        ch.fader.disconnect();
        this.channels.delete(id);
      }
    }
    const anySolo = project.tracks.some((t) => t.mixer.solo);
    for (const track of project.tracks) {
      this.applyMixer(track, anySolo);
    }
    this.applyMaster(project.master);
  }

  applyMixer(track: Track, anySolo: boolean): void {
    const ch = this.channel(track.id);
    const m = track.mixer;
    const audible = !m.mute && (!anySolo || m.solo);
    const t = this.ctx.currentTime;
    const ramp = 0.015;
    ch.fader.gain.setTargetAtTime(audible ? clamp(m.gain, 0, 1.5) : 0, t, ramp);
    ch.panner.pan.setTargetAtTime(clamp(m.pan, -1, 1), t, ramp);
    ch.reverbSend.gain.setTargetAtTime(clamp(m.reverb, 0, 1), t, ramp);
    ch.delaySend.gain.setTargetAtTime(clamp(m.delay, 0, 1), t, ramp);
    ch.duckAmount = clamp(m.duck, 0, 1);
  }

  applyMaster(m: MasterFx): void {
    const t = this.ctx.currentTime;
    this.master = m;
    this.outGain.gain.setTargetAtTime(clamp(m.gain, 0, 1.5), t, 0.02);
    this.driveShaper.curve = saturationCurve(clamp(m.drive, 0, 1));
    this.macroLP.frequency.setTargetAtTime(clamp(m.cutoff, 30, 20000), t, 0.02);
    this.limiter.threshold.setTargetAtTime(m.limiter ? -3 : 0, t, 0.05);
    this.limiter.ratio.setTargetAtTime(m.limiter ? 16 : 1, t, 0.05);

    // Rebuild the impulse response only when its shape actually changes —
    // it is a few hundred thousand samples of work.
    const key = `${m.reverb.size}|${m.reverb.damp}|${m.reverb.predelay}|${m.reverb.width}`;
    if (key !== this.reverbSpecKey) {
      this.reverbSpecKey = key;
      this.convolver.buffer = makeReverbIR(this.ctx, m.reverb);
    }
    this.reverbReturn.gain.setTargetAtTime(clamp(m.reverb.mix, 0, 1.5), t, 0.03);

    const beat = 60 / Math.max(20, this.bpm);
    const dt = clamp(beat * m.delay.division, 0.01, 3.9);
    this.delayL.delayTime.setTargetAtTime(dt, t, 0.05);
    this.delayR.delayTime.setTargetAtTime(dt, t, 0.05);
    const fb = clamp(m.delay.feedback, 0, 0.92);
    this.delayFbL.gain.setTargetAtTime(fb, t, 0.03);
    this.delayFbR.gain.setTargetAtTime(fb, t, 0.03);
    this.delayToneL.frequency.setTargetAtTime(clamp(m.delay.tone, 200, 18000), t, 0.03);
    this.delayToneR.frequency.setTargetAtTime(clamp(m.delay.tone, 200, 18000), t, 0.03);
    const pp = clamp(m.delay.pingpong, 0, 1);
    this.delayPanL.pan.setTargetAtTime(-pp, t, 0.03);
    this.delayPanR.pan.setTargetAtTime(pp, t, 0.03);
    this.delayReturn.gain.setTargetAtTime(clamp(m.delay.mix, 0, 1.5), t, 0.03);
  }

  setBpm(bpm: number): void {
    this.bpm = bpm;
    const beat = 60 / Math.max(20, bpm);
    const dt = clamp(beat * this.master.delay.division, 0.01, 3.9);
    const t = this.ctx.currentTime;
    this.delayL.delayTime.setTargetAtTime(dt, t, 0.08);
    this.delayR.delayTime.setTargetAtTime(dt, t, 0.08);
  }

  // -------------------------------------------------------------------------
  // Sidechain
  // -------------------------------------------------------------------------

  /**
   * Write a ducking envelope into every subscribed channel at `time`.
   *
   * The recovery is `1 - a·(1 - x)^curve` over the release window, drawn as a
   * handful of linear segments. `curve` above 1 holds the duck down longer
   * before snapping back, which is the deep house pump; below 1 it recovers
   * immediately, which is a subtle tightening.
   */
  duckAll(time: number): void {
    const { sidechainAttack: atk, sidechainRelease: rel, sidechainCurve: curve } = this.master;
    const SEGMENTS = 10;
    for (const ch of this.channels.values()) {
      const a = ch.duckAmount;
      if (a < 0.01) continue;
      const g = ch.duck.gain;
      // Anchor to where the previous duck will actually be at `time`, not to
      // gain.value — that reports the level now, and `time` is up to a
      // lookahead in the future. Stamping the wrong level here steps the gain
      // and clicks on every kick.
      const from = this.duckLevelAt(ch, time);
      ch.duckStart = time;
      ch.duckFrom = from;
      ch.duckAmt = a;

      // Hold rather than cancel, for the same reason as applyRelease: cancelling
      // deletes a ramp whose end time is past `time`, wiping out its effect
      // before `time` too. Only bites when ducks overlap — fast kick patterns,
      // ratchets, long releases — but that is exactly when it would be heard.
      if (typeof g.cancelAndHoldAtTime === 'function') {
        g.cancelAndHoldAtTime(time);
      } else {
        g.cancelScheduledValues(time);
      }
      g.setValueAtTime(from, time);
      g.linearRampToValueAtTime(1 - a, time + Math.max(0.0005, atk));
      const t0 = time + atk;
      for (let i = 1; i <= SEGMENTS; i++) {
        const x = i / SEGMENTS;
        const v = 1 - a * Math.pow(1 - x, curve);
        g.linearRampToValueAtTime(v, t0 + rel * x);
      }
    }
  }

  /** Where a channel's duck curve reaches by time `t`. */
  private duckLevelAt(ch: Channel, t: number): number {
    if (ch.duckStart < 0) return 1;
    const { sidechainAttack: atk, sidechainRelease: rel, sidechainCurve: curve } = this.master;
    const e = t - ch.duckStart;
    const a = ch.duckAmt;
    if (e <= 0) return ch.duckFrom;
    if (e < atk) return ch.duckFrom + (1 - a - ch.duckFrom) * (e / atk);
    const x = (e - atk) / Math.max(0.001, rel);
    if (x >= 1) return 1;
    return 1 - a * Math.pow(1 - x, curve);
  }

  // -------------------------------------------------------------------------
  // Triggering
  // -------------------------------------------------------------------------

  hitDrum(
    trackId: string, engine: DrumEngine, params: DrumParams,
    time: number, velocity: number, semis = 0,
  ): void {
    const ch = this.channel(trackId);
    triggerDrum(engine, { ctx: this.ctx, dest: ch.input, time, params, velocity, semis });
  }

  noteOn(
    trackId: string, engine: SynthEngine, params: SynthParams,
    midi: number, time: number, velocity: number,
  ): SynthVoice {
    const ch = this.channel(trackId);
    // Voice stealing: oldest first, so a held pad never chokes a new melody.
    if (ch.voices.length >= MAX_VOICES_PER_TRACK) {
      const victim = ch.voices.shift();
      victim?.kill(time);
    }
    const voice = new SynthVoice({
      ctx: this.ctx, dest: ch.input, engine, params,
      midi, velocity, time,
      glideFrom: params.glide > 0.001 ? ch.lastMidi : null,
    });
    ch.lastMidi = midi;
    ch.voices.push(voice);
    return voice;
  }

  noteOff(trackId: string, voice: SynthVoice, time: number): void {
    const ch = this.channels.get(trackId);
    voice.release(time);
    if (!ch) return;
    const i = ch.voices.indexOf(voice);
    if (i >= 0) ch.voices.splice(i, 1);
  }

  /** Release every sounding voice on a track. */
  allNotesOff(trackId?: string, time = this.ctx.currentTime): void {
    const targets = trackId
      ? [this.channels.get(trackId)].filter(Boolean) as Channel[]
      : [...this.channels.values()];
    for (const ch of targets) {
      for (const v of ch.voices) v.release(time);
      ch.voices = [];
    }
  }

  /** A one-shot pitched note that releases itself — used by the sequencer. */
  playNote(
    trackId: string, engine: SynthEngine, params: SynthParams,
    midi: number, time: number, duration: number, velocity: number,
  ): void {
    const voice = this.noteOn(trackId, engine, params, midi, time, velocity);
    const end = time + Math.max(0.02, duration);
    voice.release(end);
    const ch = this.channels.get(trackId);
    if (ch) {
      const i = ch.voices.indexOf(voice);
      if (i >= 0) ch.voices.splice(i, 1);
    }
  }

  // -------------------------------------------------------------------------
  // Macros
  // -------------------------------------------------------------------------

  macroFilter(kind: 'low' | 'high', amount: number, on: boolean, glide = 0.06): void {
    const t = this.ctx.currentTime;
    if (kind === 'low') {
      // Sweep down to as low as 120 Hz at full amount.
      const target = on ? clamp(20000 * Math.pow(0.006, amount), 80, 20000) : this.master.cutoff;
      this.macroLP.frequency.setTargetAtTime(target, t, glide);
      this.macroLP.Q.setTargetAtTime(on ? 1 + amount * 6 : 0.9, t, glide);
    } else {
      const target = on ? clamp(20 * Math.pow(200, amount), 20, 4000) : 10;
      this.macroHP.frequency.setTargetAtTime(target, t, glide);
      this.macroHP.Q.setTargetAtTime(on ? 1 + amount * 6 : 0.9, t, glide);
    }
  }

  macroCrush(amount: number, on: boolean): void {
    const t = this.ctx.currentTime;
    if (on) this.crushShaper.curve = crushCurve(amount);
    this.crushWet.gain.setTargetAtTime(on ? 1 : 0, t, 0.008);
    this.crushDry.gain.setTargetAtTime(on ? 0 : 1, t, 0.008);
  }

  /**
   * Beat repeat. `sliceBeats` is how much audio gets captured in the loop —
   * smaller slices give the machine-gun stutter, larger ones a bar repeat.
   * `swell` inverts the amplitude inside each repeat so it reads as reversed.
   */
  macroStutter(sliceBeats: number, on: boolean, swell = false): void {
    const t = this.ctx.currentTime;
    const beat = 60 / Math.max(20, this.bpm);
    const slice = clamp(beat * sliceBeats, 0.02, 3.9);
    if (on) {
      this.stutterDelay.delayTime.setValueAtTime(slice, t);
      this.stutterFb.gain.setTargetAtTime(1.0, t, 0.005);
      this.stutterWet.gain.setTargetAtTime(1, t, 0.004);
      this.stutterDry.gain.setTargetAtTime(0, t, 0.004);
      if (swell) {
        // Ramp the loop gain up across each repeat for a reverse-like swell.
        const g = this.stutterWet.gain;
        g.cancelScheduledValues(t);
        for (let i = 0; i < 8; i++) {
          const base = t + i * slice;
          g.setValueAtTime(0.15, base);
          g.linearRampToValueAtTime(1.1, base + slice * 0.95);
        }
      }
    } else {
      this.stutterFb.gain.setTargetAtTime(0, t, 0.02);
      this.stutterWet.gain.setTargetAtTime(0, t, 0.02);
      this.stutterDry.gain.setTargetAtTime(1, t, 0.02);
    }
  }

  /**
   * Tape stop. Engages the stutter loop, then stretches its delay time — a
   * growing delay line resamples its contents downward, which is a genuine
   * pitch drop rather than a filter fake.
   */
  macroTapeStop(amount: number, on: boolean): void {
    const t = this.ctx.currentTime;
    const beat = 60 / Math.max(20, this.bpm);
    if (on) {
      const dur = clamp(beat * (0.5 + amount * 3.5), 0.2, 4);
      this.stutterDelay.delayTime.cancelScheduledValues(t);
      this.stutterDelay.delayTime.setValueAtTime(0.06, t);
      this.stutterDelay.delayTime.linearRampToValueAtTime(0.06 * (1 + amount * 9), t + dur);
      this.stutterFb.gain.setTargetAtTime(0.98, t, 0.005);
      this.stutterWet.gain.setTargetAtTime(1, t, 0.004);
      this.stutterDry.gain.setTargetAtTime(0, t, 0.004);
      this.macroLP.frequency.cancelScheduledValues(t);
      this.macroLP.frequency.setValueAtTime(20000, t);
      this.macroLP.frequency.exponentialRampToValueAtTime(400, t + dur);
      this.gateGain.gain.cancelScheduledValues(t);
      this.gateGain.gain.setValueAtTime(1, t);
      this.gateGain.gain.linearRampToValueAtTime(0.05, t + dur);
    } else {
      this.stutterDelay.delayTime.cancelScheduledValues(t);
      this.stutterDelay.delayTime.setTargetAtTime(0.25, t, 0.05);
      this.stutterFb.gain.setTargetAtTime(0, t, 0.03);
      this.stutterWet.gain.setTargetAtTime(0, t, 0.03);
      this.stutterDry.gain.setTargetAtTime(1, t, 0.03);
      this.macroLP.frequency.cancelScheduledValues(t);
      this.macroLP.frequency.setTargetAtTime(this.master.cutoff, t, 0.06);
      this.gateGain.gain.cancelScheduledValues(t);
      this.gateGain.gain.setTargetAtTime(1, t, 0.04);
    }
  }

  /** Rhythmic amplitude gating locked to the tempo. */
  macroGate(rateBeats: number, depth: number, on: boolean, startAt?: number): void {
    const g = this.gateGain.gain;
    const t = startAt ?? this.ctx.currentTime;
    g.cancelScheduledValues(t);
    if (!on) {
      g.setTargetAtTime(1, t, 0.02);
      return;
    }
    const beat = 60 / Math.max(20, this.bpm);
    const period = clamp(beat * rateBeats, 0.02, 2);
    const low = clamp(1 - depth, 0, 1);
    // Schedule two bars of gating; the macro re-arms while it is held.
    const cycles = Math.ceil((beat * 8) / period);
    for (let i = 0; i < cycles; i++) {
      const base = t + i * period;
      g.setValueAtTime(1, base);
      g.linearRampToValueAtTime(low, base + period * 0.42);
      g.setValueAtTime(low, base + period * 0.5);
      g.linearRampToValueAtTime(1, base + period * 0.92);
    }
  }

  /** Kill everything except the sidechain source track. */
  macroDropout(on: boolean, keepTrackId: string | null): void {
    const t = this.ctx.currentTime;
    for (const [id, ch] of this.channels) {
      if (on && id !== keepTrackId) {
        ch.dry.gain.setTargetAtTime(0, t, 0.01);
      } else {
        ch.dry.gain.setTargetAtTime(1, t, 0.03);
      }
    }
  }

  /** Dump every channel into the reverb and pull the dry signal down. */
  macroWash(amount: number, on: boolean): void {
    const t = this.ctx.currentTime;
    for (const ch of this.channels.values()) {
      ch.reverbSend.gain.setTargetAtTime(on ? amount : 0, t, 0.05);
      ch.dry.gain.setTargetAtTime(on ? 1 - amount * 0.6 : 1, t, 0.05);
    }
    this.reverbReturn.gain.setTargetAtTime(on ? 1.4 : this.master.reverb.mix, t, 0.05);
  }

  /** A noise sweep that climbs while held — the build-up. */
  macroRiser(amount: number, on: boolean): void {
    const t = this.ctx.currentTime;
    if (on) {
      if (this.riserSrc) return;
      const src = this.ctx.createBufferSource();
      src.buffer = whiteNoise(this.ctx);
      src.loop = true;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 3 + amount * 8;
      bp.frequency.setValueAtTime(200, t);
      // Rise across roughly two bars at the current tempo.
      const dur = (60 / this.bpm) * 8;
      bp.frequency.exponentialRampToValueAtTime(clamp(300 + amount * 11000, 400, 16000), t + dur);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(clamp(amount * 0.35, 0.001, 0.5), t + dur * 0.9);
      src.connect(bp).connect(g).connect(this.masterBus);
      src.start(t);
      this.riserSrc = src; this.riserFilter = bp; this.riserGain = g;
    } else if (this.riserSrc && this.riserGain) {
      const g = this.riserGain.gain;
      const src = this.riserSrc;
      g.cancelScheduledValues(t);
      g.setValueAtTime(Math.max(0.0001, g.value), t);
      g.exponentialRampToValueAtTime(0.0001, t + 0.12);
      try { src.stop(t + 0.15); } catch { /* already stopped */ }
      this.riserSrc = null; this.riserFilter = null; this.riserGain = null;
    }
  }

  /** Reset every macro-owned node to its neutral position. */
  resetMacros(): void {
    this.macroFilter('low', 0, false);
    this.macroFilter('high', 0, false);
    this.macroCrush(0, false);
    this.macroStutter(0.25, false);
    this.macroGate(0.5, 0, false);
    this.macroDropout(false, null);
    this.macroWash(0, false);
    this.macroRiser(0, false);
    const t = this.ctx.currentTime;
    this.gateGain.gain.cancelScheduledValues(t);
    this.gateGain.gain.setTargetAtTime(1, t, 0.02);
  }

  // -------------------------------------------------------------------------
  // Metering
  // -------------------------------------------------------------------------

  readMeter(): MeterReading {
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < this.meterBuf.length; i++) {
      const v = this.meterBuf[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
    }
    return { peak, rms: Math.sqrt(sum / this.meterBuf.length) };
  }

  getSpectrum(out: Uint8Array<ArrayBuffer>): void {
    this.analyser.getByteFrequencyData(out);
  }

  get spectrumSize(): number { return this.analyser.frequencyBinCount; }

  get masterInput(): AudioNode { return this.masterBus; }

  dispose(): void {
    this.allNotesOff();
    void this.ctx.close();
  }
}

export function midiForDegree(root: number, scaleSteps: readonly number[], degree: number, octave: number): number {
  const n = scaleSteps.length;
  const w = ((degree % n) + n) % n;
  const oct = Math.floor(degree / n);
  return 12 * (5 + octave + oct) + root + scaleSteps[w];
}

export { mtof };
