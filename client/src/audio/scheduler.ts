/**
 * Transport and sequencer.
 *
 * The clock runs at 48 pulses per quarter note. 48 divides by 2, 3, 4, 6, 8,
 * 12, 16 and 24, so sixteenths (12 ticks), triplets (16), thirty-seconds (6)
 * and sixteenth-triplets (8) all land on exact integers — no drift, and tracks
 * running at different resolutions stay locked to the same grid.
 *
 * Each track reads its own pattern at its own length, so a 16-step hat against
 * a 12-step bass simply takes lcm(16,12) = 48 steps to repeat. That is where
 * the long, evolving loops come from.
 */

import type { Project, Track, Pattern, Step, TrigCondition, Quantize } from '@shared/types';
import { SCALES } from '@shared/types';
import {
  euclidPattern, swingOffset, hashRandom, degreeToMidi, clamp, QUANTIZE_TO_BEATS,
} from '@shared/theory';
import type { AudioEngine } from './engine';

export const PPQN = 48;
const TICKS_PER_BAR = PPQN * 4;

/** How far ahead we schedule, and how often we top the queue up. */
const LOOKAHEAD_S = 0.12;
const TICK_MS = 20;

export interface PlayPosition {
  playing: boolean;
  tick: number;
  bar: number;
  beat: number;
  /** Sixteenth-note index within the current bar, 0..15. */
  sixteenth: number;
  /** Per-track step index, keyed by track id. */
  trackSteps: Record<string, number>;
}

export interface RecordedEvent {
  trackId: string;
  /** Quantized step index within the track's active pattern. */
  step: number;
  velocity: number;
  degree: number;
  octave: number;
}

type PendingAction = { atTick: number; run: (time: number) => void };

/**
 * A tiny worker whose only job is to tick. Browsers throttle timers in
 * background tabs to once a second, which would starve the scheduler; workers
 * are throttled far less, so the groove survives an alt-tab.
 */
function makeTicker(intervalMs: number): Worker {
  const src = `
    let id = null;
    self.onmessage = (e) => {
      if (e.data.cmd === 'start') {
        clearInterval(id);
        id = setInterval(() => self.postMessage('tick'), e.data.interval);
      } else if (e.data.cmd === 'stop') {
        clearInterval(id); id = null;
      }
    };
  `;
  const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  return w;
}

export class Transport {
  readonly position: PlayPosition = {
    playing: false, tick: 0, bar: 0, beat: 0, sixteenth: 0, trackSteps: {},
  };

  /** Set true while a "fill" key is held — drives FILL trig conditions. */
  fillActive = false;

  /** Tracks currently armed for live recording. */
  readonly recordArmed = new Set<string>();

  onRecord: ((ev: RecordedEvent) => void) | null = null;
  /** Fired when a queued pattern/scene launch actually lands. */
  onLaunch: (() => void) | null = null;

  private engine: AudioEngine;
  /**
   * The project is read through a getter rather than held as a snapshot.
   * A cached copy has to be refreshed by hand on every mutation, and any store
   * action that forgets leaves the sequencer playing stale data — instrument
   * edits that only take effect once you happen to touch the mixer, for
   * instance. Reading live costs nothing and cannot drift.
   */
  private readonly getProject: () => Project;
  private ticker: Worker | null = null;
  private running = false;
  private nextTick = 0;
  private nextTickTime = 0;
  private pending: PendingAction[] = [];

  constructor(engine: AudioEngine, getProject: () => Project) {
    this.engine = engine;
    this.getProject = getProject;
  }

  private get project(): Project {
    return this.getProject();
  }

  get tickDuration(): number {
    return 60 / clamp(this.project.bpm, 20, 300) / PPQN;
  }

  // -------------------------------------------------------------------------
  // Transport control
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    await this.engine.resume();
    this.running = true;
    this.position.playing = true;
    this.nextTick = 0;
    this.nextTickTime = this.engine.currentTime + 0.06;
    this.pending = [];

    if (!this.ticker) {
      this.ticker = makeTicker(TICK_MS);
      this.ticker.onmessage = () => this.pump();
    }
    this.ticker.postMessage({ cmd: 'start', interval: TICK_MS });
    this.pump();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.position.playing = false;
    this.ticker?.postMessage({ cmd: 'stop' });
    this.engine.allNotesOff();
    this.pending = [];
    this.position.tick = 0;
    this.position.bar = 0;
    this.position.beat = 0;
    this.position.sixteenth = 0;
    this.position.trackSteps = {};
  }

  toggle(): void {
    if (this.running) this.stop(); else void this.start();
  }

  get isPlaying(): boolean { return this.running; }

  dispose(): void {
    this.stop();
    this.ticker?.terminate();
    this.ticker = null;
  }

  // -------------------------------------------------------------------------
  // Quantized action queue
  // -------------------------------------------------------------------------

  /** The next tick at or after `from` that lands on the given grid. */
  nextBoundary(q: Quantize, from = this.position.tick): number {
    const beats = QUANTIZE_TO_BEATS[q] ?? 0;
    if (beats <= 0) return from;
    const grid = Math.round(beats * PPQN);
    return Math.ceil((from + 1) / grid) * grid;
  }

  /**
   * Run `fn` at the next `q` boundary. With quantize off — or when stopped —
   * it fires immediately, so the instrument stays playable without the
   * transport running.
   */
  schedule(q: Quantize, fn: (time: number) => void): void {
    if (!this.running || q === 'off') {
      fn(Math.max(this.engine.currentTime, this.engine.currentTime + 0.001));
      return;
    }
    this.pending.push({ atTick: this.nextBoundary(q), run: fn });
  }

  /** Audio-clock time of a future tick. */
  timeOfTick(tick: number): number {
    return this.nextTickTime + (tick - this.nextTick) * this.tickDuration;
  }

  /**
   * Quantize a live-played event to the nearest step of a track's pattern.
   * Rounds to nearest rather than down, so playing a hair early still lands on
   * the beat you meant.
   */
  quantizeToPattern(pattern: Pattern): number {
    const ticksPerStep = PPQN / pattern.resolution;
    const stepPos = Math.round(this.position.tick / ticksPerStep);
    return ((stepPos % pattern.length) + pattern.length) % pattern.length;
  }

  // -------------------------------------------------------------------------
  // The scheduling loop
  // -------------------------------------------------------------------------

  private pump(): void {
    if (!this.running) return;
    const horizon = this.engine.currentTime + LOOKAHEAD_S;
    const dt = this.tickDuration;

    let guard = 0;
    while (this.nextTickTime < horizon && guard++ < 4096) {
      this.runPending(this.nextTick, this.nextTickTime);
      this.scheduleTick(this.nextTick, this.nextTickTime);
      this.advancePosition(this.nextTick);
      this.nextTick += 1;
      this.nextTickTime += dt;
    }
  }

  private advancePosition(tick: number): void {
    const p = this.position;
    p.tick = tick;
    p.bar = Math.floor(tick / TICKS_PER_BAR);
    p.beat = Math.floor((tick % TICKS_PER_BAR) / PPQN);
    p.sixteenth = Math.floor((tick % TICKS_PER_BAR) / (PPQN / 4));
  }

  private runPending(tick: number, time: number): void {
    if (this.pending.length === 0) return;
    const due = this.pending.filter((a) => a.atTick <= tick);
    if (due.length === 0) return;
    this.pending = this.pending.filter((a) => a.atTick > tick);
    for (const a of due) a.run(time);
    this.onLaunch?.();
  }

  private scheduleTick(tick: number, time: number): void {
    const project = this.project;
    const sidechainId = project.master.sidechainSource;

    for (let ti = 0; ti < project.tracks.length; ti++) {
      const track = project.tracks[ti];
      if (!track.seqEnabled) continue;
      const pattern = track.patterns[track.activePattern];
      if (!pattern || pattern.length <= 0) continue;

      const ticksPerStep = PPQN / pattern.resolution;
      if (!Number.isInteger(ticksPerStep) || tick % ticksPerStep !== 0) continue;

      const stepPos = Math.floor(tick / ticksPerStep);
      const idx = ((stepPos % pattern.length) + pattern.length) % pattern.length;
      const loopIndex = Math.floor(stepPos / pattern.length);

      const step = pattern.steps[idx];
      if (!step) continue;
      if (!this.stepIsOn(pattern, idx, step)) continue;
      if (!this.conditionPasses(step.cond, loopIndex, tick)) continue;

      const stepDur = ticksPerStep * this.tickDuration;

      // Timing: swing warps the grid, nudge is the step's own offset, and
      // humanize adds a stable per-position jitter so the loop breathes the
      // same way every time round rather than wobbling randomly.
      let t = time;
      t += swingOffset(idx, project.swing, project.swingUnit) * stepDur;
      t += clamp(step.nudge, -0.5, 0.5) * stepDur;
      if (project.humanize > 0) {
        const jitter = (hashRandom(tick * 131 + ti * 977) - 0.5) * 2;
        t += (jitter * project.humanize) / 1000;
      }
      t = Math.max(t, this.engine.currentTime + 0.001);

      const accent = step.accent ? 1.25 : 1;
      const velocity = clamp(step.velocity * accent, 0, 1.3);
      const ratchets = clamp(Math.round(step.ratchet), 1, 8);

      for (let r = 0; r < ratchets; r++) {
        const rt = t + (r * stepDur) / ratchets;
        // Ratchets taper slightly so a roll reads as one gesture, not n hits.
        const rv = velocity * (ratchets === 1 ? 1 : 1 - (r / ratchets) * 0.25);
        this.fireTrack(track, rt, rv, step, stepDur / ratchets, ti);
        if (track.id === sidechainId) this.engine.duckAll(rt);
      }
    }
  }

  /** Whether a step sounds, accounting for euclidean generation. */
  private stepIsOn(pattern: Pattern, idx: number, step: Step): boolean {
    if (pattern.mode !== 'euclid') return step.on;
    const mask = euclidPattern(pattern.euclid, pattern.length);
    return mask[idx] ?? false;
  }

  private conditionPasses(cond: TrigCondition, loopIndex: number, tick: number): boolean {
    switch (cond.type) {
      case 'always': return true;
      case 'prob': return hashRandom(tick * 7919 + loopIndex * 104729) < cond.chance;
      case 'ratio': {
        const of = Math.max(1, cond.of);
        return ((loopIndex % of) + of) % of === (cond.hit - 1) % of;
      }
      case 'fill': return this.fillActive;
      case 'notFill': return !this.fillActive;
      case 'first': return loopIndex === 0;
      case 'notFirst': return loopIndex > 0;
      default: return true;
    }
  }

  private fireTrack(
    track: Track, time: number, velocity: number,
    step: Step, duration: number, trackIndex: number,
  ): void {
    const inst = track.instrument;
    if (inst.kind === 'drum') {
      // Pitched drums: the step's degree becomes a semitone offset, so a kick
      // track can carry a bassline.
      const semis = step.degree === 0 && step.octave === 0
        ? 0
        : degreeToMidi(this.project.key, step.degree, step.octave, 4) - degreeToMidi(this.project.key, 0, 0, 4);
      this.engine.hitDrum(track.id, inst.engine as any, inst.drum, time, velocity, semis);
    } else {
      const midi = degreeToMidi(this.project.key, step.degree, step.octave, 4);
      const len = Math.max(0.03, duration * Math.max(1, step.length) * 0.92);
      this.engine.playNote(track.id, inst.engine as any, inst.synth, midi, time, len, velocity);
    }
  }

  // -------------------------------------------------------------------------
  // Live playing — routed through here so recording can capture it
  // -------------------------------------------------------------------------

  /** Fire a track by hand. Handles sidechain and record capture. */
  playTrackNow(
    track: Track, time: number, velocity: number,
    degree: number, octave: number, durationSec?: number,
  ): void {
    const inst = track.instrument;
    if (inst.kind === 'drum') {
      const semis = degree === 0 && octave === 0
        ? 0
        : degreeToMidi(this.project.key, degree, octave, 4) - degreeToMidi(this.project.key, 0, 0, 4);
      this.engine.hitDrum(track.id, inst.engine as any, inst.drum, time, velocity, semis);
    } else {
      const midi = degreeToMidi(this.project.key, degree, octave, 4);
      this.engine.playNote(
        track.id, inst.engine as any, inst.synth, midi, time,
        durationSec ?? (60 / this.project.bpm) * 0.4, velocity,
      );
    }
    if (track.id === this.project.master.sidechainSource) this.engine.duckAll(time);
    this.capture(track, velocity, degree, octave);
  }

  /** Write a played event into the armed track's pattern. */
  capture(track: Track, velocity: number, degree: number, octave: number): void {
    if (!this.running || !this.recordArmed.has(track.id) || !this.onRecord) return;
    const pattern = track.patterns[track.activePattern];
    if (!pattern) return;
    this.onRecord({
      trackId: track.id,
      step: this.quantizeToPattern(pattern),
      velocity, degree, octave,
    });
  }

  /** Scale degrees in the project key, for the UI. */
  get scaleSteps(): readonly number[] {
    return SCALES[this.project.key.scale] ?? SCALES.minor;
  }
}
