/**
 * The performance layer.
 *
 * A key press arrives here as (layer, cellIndex) and this decides what that
 * means: a drum hit, a held note, a chord, a queued pattern launch, a roll at
 * a rhythmic subdivision, or a master-bus effect. Everything routes through
 * the transport so that quantization and live recording apply uniformly.
 */

import type { Project, Cell, Track, MacroKind } from '@shared/types';
import { buildChord, degreeToMidi, clamp, RATE_TO_BEATS } from '@shared/theory';
import type { AudioEngine } from './engine';
import type { Transport } from './scheduler';
import type { SynthVoice } from './synth';

/** How far ahead the roll engine schedules retriggers. */
const REPEAT_LOOKAHEAD = 0.12;
const REPEAT_INTERVAL_MS = 20;

interface HeldNotes {
  trackId: string;
  voices: SynthVoice[];
}

interface ActiveRepeat {
  cell: Cell;
  trackId: string;
  /** Audio-clock time of the next retrigger. */
  nextTime: number;
  intervalSec: number;
  /** How many hits have fired, for the velocity and pitch ramps. */
  count: number;
}

export interface PerformerCallbacks {
  getProject: () => Project;
  /** Ask the app to mutate state — pattern launches, record arming, etc. */
  dispatch: (action: PerformerAction) => void;
}

export type PerformerAction =
  | { type: 'launchPattern'; trackId: string; patternIndex: number }
  | { type: 'launchScene'; sceneId: string }
  | { type: 'toggleRecord'; trackId: string };

export class Performer {
  /** Cell ids ("layer:index") that are currently lit. */
  readonly active = new Set<string>();
  /** Macros currently latched on via toggle behaviour. */
  readonly latched = new Set<string>();

  private engine: AudioEngine;
  private transport: Transport;
  private cb: PerformerCallbacks;

  private held = new Map<string, HeldNotes>();
  private repeats = new Map<string, ActiveRepeat>();
  private repeatTimer: number | null = null;

  constructor(engine: AudioEngine, transport: Transport, cb: PerformerCallbacks) {
    this.engine = engine;
    this.transport = transport;
    this.cb = cb;
  }

  // -------------------------------------------------------------------------

  private cellId(layer: number, index: number): string {
    return `${layer}:${index}`;
  }

  private track(id: string | null): Track | undefined {
    if (!id) return undefined;
    return this.cb.getProject().tracks.find((t) => t.id === id);
  }

  private cell(layer: number, index: number): Cell | undefined {
    return this.cb.getProject().keymap.layers[layer]?.[index];
  }

  // -------------------------------------------------------------------------
  // Press / release
  // -------------------------------------------------------------------------

  press(layer: number, index: number, velocityScale = 1): void {
    const cell = this.cell(layer, index);
    if (!cell || cell.mode === 'empty') return;
    const id = this.cellId(layer, index);

    if (cell.behavior === 'toggle') {
      if (this.latched.has(id)) {
        this.latched.delete(id);
        this.active.delete(id);
        this.end(cell, id);
        return;
      }
      this.latched.add(id);
    }

    if (this.active.has(id) && cell.behavior !== 'trigger') return;
    this.active.add(id);
    void this.engine.resume();
    this.begin(cell, id, velocityScale);
  }

  release(layer: number, index: number): void {
    const cell = this.cell(layer, index);
    if (!cell) return;
    const id = this.cellId(layer, index);
    if (cell.behavior === 'toggle' && this.latched.has(id)) return; // stays on
    this.active.delete(id);
    this.end(cell, id);
  }

  /** Release everything — panic button, and used on layer switches. */
  releaseAll(): void {
    for (const id of [...this.active]) {
      const [layer, index] = id.split(':').map(Number);
      const cell = this.cell(layer, index);
      if (cell && cell.behavior === 'toggle' && this.latched.has(id)) continue;
      this.active.delete(id);
      if (cell) this.end(cell, id);
    }
  }

  /** Hard reset: drop every held note, roll, macro and latch. */
  panic(): void {
    this.active.clear();
    this.latched.clear();
    this.repeats.clear();
    this.stopRepeatLoop();
    for (const h of this.held.values()) {
      for (const v of h.voices) this.engine.noteOff(h.trackId, v, this.engine.currentTime);
    }
    this.held.clear();
    this.engine.allNotesOff();
    this.engine.resetMacros();
  }

  // -------------------------------------------------------------------------

  private begin(cell: Cell, id: string, velScale: number): void {
    const now = this.engine.currentTime;
    const vel = clamp(cell.velocity * velScale, 0, 1.3);

    switch (cell.mode) {
      case 'hit': {
        const track = this.track(cell.trackId);
        if (!track) return;
        this.transport.schedule(cell.quantize, (t) => {
          this.transport.playTrackNow(track, Math.max(t, now), vel, cell.degree, cell.octave);
        });
        return;
      }

      case 'note': {
        const track = this.track(cell.trackId);
        if (!track || track.instrument.kind !== 'synth') {
          // A "note" pointed at a drum track is just a pitched hit.
          if (track) {
            this.transport.schedule(cell.quantize, (t) => {
              this.transport.playTrackNow(track, Math.max(t, now), vel, cell.degree, cell.octave);
            });
          }
          return;
        }
        this.transport.schedule(cell.quantize, (t) => {
          const project = this.cb.getProject();
          const midi = degreeToMidi(project.key, cell.degree, cell.octave, 4);
          const voice = this.engine.noteOn(
            track.id, track.instrument.engine as any, track.instrument.synth,
            midi, Math.max(t, this.engine.currentTime), vel,
          );
          this.held.set(id, { trackId: track.id, voices: [voice] });
          this.transport.capture(track, vel, cell.degree, cell.octave);
        });
        return;
      }

      case 'chord': {
        const track = this.track(cell.trackId);
        if (!track || track.instrument.kind !== 'synth') return;
        this.transport.schedule(cell.quantize, (t) => {
          const project = this.cb.getProject();
          const notes = buildChord(
            project.key, cell.degree,
            clamp(cell.chordSize, 2, 6), cell.inversion, cell.octave,
          );
          const at = Math.max(t, this.engine.currentTime);
          const voices = notes.map((midi, i) =>
            this.engine.noteOn(
              track.id, track.instrument.engine as any, track.instrument.synth,
              midi,
              // A 4 ms spread across the chord reads as a strum rather than a block.
              at + i * 0.004,
              vel * (i === 0 ? 1 : 0.85),
            ),
          );
          this.held.set(id, { trackId: track.id, voices });
          this.transport.capture(track, vel, cell.degree, cell.octave);
        });
        return;
      }

      case 'pattern': {
        if (!cell.trackId) return;
        this.transport.schedule(cell.quantize, () => {
          this.cb.dispatch({
            type: 'launchPattern', trackId: cell.trackId!, patternIndex: cell.patternIndex,
          });
        });
        return;
      }

      case 'scene': {
        if (!cell.sceneId) return;
        this.transport.schedule(cell.quantize, () => {
          this.cb.dispatch({ type: 'launchScene', sceneId: cell.sceneId! });
        });
        return;
      }

      case 'repeat': {
        const track = this.track(cell.trackId);
        if (!track) return;
        this.startRepeat(id, cell, track);
        return;
      }

      case 'record': {
        if (!cell.trackId) return;
        this.cb.dispatch({ type: 'toggleRecord', trackId: cell.trackId });
        return;
      }

      case 'macro':
        this.setMacro(cell.macro, cell.macroAmount, true);
        return;

      default:
        return;
    }
  }

  private end(cell: Cell, id: string): void {
    const now = this.engine.currentTime;

    if (cell.mode === 'note' || cell.mode === 'chord') {
      const h = this.held.get(id);
      if (h) {
        for (const v of h.voices) this.engine.noteOff(h.trackId, v, now);
        this.held.delete(id);
      }
      return;
    }

    if (cell.mode === 'repeat') {
      this.repeats.delete(id);
      if (this.repeats.size === 0) this.stopRepeatLoop();
      return;
    }

    if (cell.mode === 'macro') {
      // Only lift the macro if no other held key is driving the same one.
      const stillHeld = [...this.active, ...this.latched].some((otherId) => {
        if (otherId === id) return false;
        const [l, i] = otherId.split(':').map(Number);
        const c = this.cell(l, i);
        return c?.mode === 'macro' && c.macro === cell.macro;
      });
      if (!stillHeld) this.setMacro(cell.macro, cell.macroAmount, false);
    }
  }

  // -------------------------------------------------------------------------
  // Note repeat / rolls
  // -------------------------------------------------------------------------

  private startRepeat(id: string, cell: Cell, track: Track): void {
    const project = this.cb.getProject();
    const beats = RATE_TO_BEATS[cell.repeatRate] ?? 0.25;
    const intervalSec = (60 / clamp(project.bpm, 20, 300)) * beats;
    const now = this.engine.currentTime;

    // When the transport is running, snap the first hit to the roll's own
    // grid so the roll lands with the beat instead of wherever your finger did.
    let nextTime = now + 0.005;
    if (this.transport.isPlaying) {
      const gridTick = Math.round(beats * 48);
      const boundary = Math.ceil((this.transport.position.tick + 1) / gridTick) * gridTick;
      const snapped = this.transport.timeOfTick(boundary);
      if (snapped > now && snapped - now < intervalSec * 1.2) nextTime = snapped;
    }

    this.repeats.set(id, { cell, trackId: track.id, nextTime, intervalSec, count: 0 });
    this.startRepeatLoop();
  }

  private startRepeatLoop(): void {
    if (this.repeatTimer !== null) return;
    this.repeatTimer = window.setInterval(() => this.pumpRepeats(), REPEAT_INTERVAL_MS);
    this.pumpRepeats();
  }

  private stopRepeatLoop(): void {
    if (this.repeatTimer === null) return;
    window.clearInterval(this.repeatTimer);
    this.repeatTimer = null;
  }

  private pumpRepeats(): void {
    const horizon = this.engine.currentTime + REPEAT_LOOKAHEAD;
    for (const r of this.repeats.values()) {
      const track = this.track(r.trackId);
      if (!track) continue;
      let guard = 0;
      while (r.nextTime < horizon && guard++ < 32) {
        // The ramp runs over roughly one bar of the roll, then holds.
        const span = Math.max(1, Math.round(1 / (r.intervalSec || 1)) * 2);
        const phase = clamp(r.count / span, 0, 1);
        const ramp = r.cell.repeatRamp;
        const velMul = ramp >= 0
          ? 1 - ramp * 0.7 + ramp * 0.7 * phase   // build up
          : 1 + ramp * 0.7 * phase;               // fade out
        const semis = r.cell.repeatPitch * phase;

        const vel = clamp(r.cell.velocity * velMul, 0.02, 1.3);
        const degreeShift = Math.round(semis);
        this.transport.playTrackNow(
          track, r.nextTime, vel,
          r.cell.degree + degreeShift, r.cell.octave,
          r.intervalSec * 0.9,
        );
        r.nextTime += r.intervalSec;
        r.count += 1;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Macros
  // -------------------------------------------------------------------------

  private setMacro(kind: MacroKind, amount: number, on: boolean): void {
    const a = clamp(amount, 0, 1);
    switch (kind) {
      case 'filterDown': this.engine.macroFilter('low', a, on); break;
      case 'filterUp': this.engine.macroFilter('high', a, on); break;
      case 'crush': this.engine.macroCrush(a, on); break;
      case 'riser': this.engine.macroRiser(a, on); break;
      case 'wash': this.engine.macroWash(a, on); break;
      case 'tapeStop': this.engine.macroTapeStop(a, on); break;
      case 'dropout':
        this.engine.macroDropout(on, this.cb.getProject().master.sidechainSource);
        break;
      case 'gate': {
        // Quantise the rate to musical divisions: 1, 1/2, 1/4, 1/8 of a beat.
        const rate = Math.pow(2, -Math.round(a * 3));
        this.engine.macroGate(rate, 0.35 + a * 0.6, on);
        break;
      }
      case 'stutter':
      case 'reverse': {
        // 1 beat down to a thirty-second, in powers of two.
        const slice = Math.pow(2, -Math.round(a * 5));
        this.engine.macroStutter(slice, on, kind === 'reverse');
        break;
      }
    }
  }

  /** Re-apply every latched macro — used after a project or tempo change. */
  refreshLatched(): void {
    for (const id of this.latched) {
      const [l, i] = id.split(':').map(Number);
      const c = this.cell(l, i);
      if (c?.mode === 'macro') this.setMacro(c.macro, c.macroAmount, true);
    }
  }
}
