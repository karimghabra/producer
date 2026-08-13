/**
 * Low-level buffer and curve generators.
 *
 * Everything Pulse makes noise with is computed here or in the voice modules —
 * there are no samples to download, which means the whole instrument boots
 * instantly and every drum is a parameter rather than a file.
 */

import { clamp } from '@shared/theory';

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

/** A long, reusable white-noise buffer. One per context, shared by all voices. */
export function whiteNoise(ctx: BaseAudioContext, seconds = 2): AudioBuffer {
  const cached = noiseCache.get(ctx);
  if (cached) return cached;
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  noiseCache.set(ctx, buf);
  return buf;
}

/**
 * Pink-ish noise via the Voss-McCartney style filter bank. Warmer than white,
 * which suits snare bodies and riser sweeps far better.
 */
export function pinkNoise(ctx: BaseAudioContext, seconds = 2): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Reverb impulse response
// ---------------------------------------------------------------------------

export interface ReverbSpec {
  size: number;      // decay length, seconds
  damp: number;      // 0..1 high-frequency absorption
  predelay: number;  // seconds
  width: number;     // 0..1, 0 collapses to mono
}

/**
 * A synthetic impulse response: exponentially decaying noise, low-passed by a
 * one-pole whose coefficient tightens over time (air absorbs treble faster
 * than bass), with discrete early reflections at prime-millisecond offsets so
 * they never stack into a periodic flutter.
 */
export function makeReverbIR(ctx: BaseAudioContext, spec: ReverbSpec): AudioBuffer {
  const sr = ctx.sampleRate;
  const size = clamp(spec.size, 0.15, 12);
  const damp = clamp(spec.damp, 0, 1);
  const pre = Math.floor(sr * clamp(spec.predelay, 0, 0.25));
  const len = Math.max(64, Math.floor(sr * size) + pre);
  const buf = ctx.createBuffer(2, len, sr);

  // Primes (ms) keep early reflections mutually incommensurate.
  const primes = [7, 11, 17, 23, 31, 41, 53, 67, 83, 97, 113, 131, 149, 167];

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    const tail = len - pre;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / tail;                       // 0..1 through the tail
      const env = Math.pow(1 - t, 2.0) * Math.exp(-3.0 * t);
      const n = Math.random() * 2 - 1;
      // Coefficient shrinks with time -> progressively darker tail.
      const coef = clamp(1 - damp * (0.35 + 0.6 * t), 0.02, 1);
      lp += coef * (n - lp);
      d[i] = lp * env;
    }
    // Early reflections, alternating polarity per channel for decorrelation.
    const flip = ch === 0 ? 1 : -1;
    for (let k = 0; k < primes.length; k++) {
      const idx = pre + Math.floor((sr * primes[k]) / 1000) + (ch === 1 ? 13 : 0);
      if (idx < len) d[idx] += (flip * 0.6) / (k * 0.7 + 1);
    }
  }

  // Stereo width: crossfeed the channels toward mono as width falls.
  const m = (1 - clamp(spec.width, 0, 1)) * 0.5;
  if (m > 0.001) {
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    for (let i = 0; i < len; i++) {
      const l = L[i], r = R[i];
      L[i] = l * (1 - m) + r * m;
      R[i] = r * (1 - m) + l * m;
    }
  }

  // Normalise so the reverb send level means the same thing at any size.
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
  }
  if (peak > 0) {
    const g = 0.55 / peak;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] *= g;
    }
  }

  return buf;
}

// ---------------------------------------------------------------------------
// Waveshaper curves
// ---------------------------------------------------------------------------

// WaveShaperNode.curve requires a Float32Array backed by a plain ArrayBuffer,
// which the default `Float32Array` alias no longer guarantees.
type Curve = Float32Array<ArrayBuffer>;

const shaperCache = new Map<string, Curve>();

/**
 * Soft saturation. `amount` 0 is a straight wire; as it rises the curve bends
 * toward tanh, adding odd harmonics without the harsh edge of hard clipping.
 */
export function saturationCurve(amount: number, samples = 2048): Curve {
  const a = clamp(amount, 0, 1);
  const key = `sat:${a.toFixed(3)}:${samples}`;
  const hit = shaperCache.get(key);
  if (hit) return hit;

  const curve = new Float32Array(samples);
  // `k` is the tanh pre-gain. It has to stay modest: tanh saturates hard once
  // k·x exceeds ~2, so a large k flattens everything above a small threshold
  // into a plateau and the output becomes a square wave with instantaneous
  // edges. That is not saturation, it is clipping, and on a bass it turns the
  // decay into an audible click per cycle. `1 + a²·8` tops out at 9, which is
  // genuinely dirty at full travel while leaving mid settings as warmth.
  const k = 1 + a * a * 8;
  const norm = Math.tanh(k);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = a < 0.001 ? x : Math.tanh(k * x) / norm;
  }
  shaperCache.set(key, curve);
  return curve;
}

/** Bit-depth reduction as a staircase transfer function. */
export function crushCurve(amount: number, samples = 4096): Curve {
  const a = clamp(amount, 0, 1);
  const key = `crush:${a.toFixed(3)}`;
  const hit = shaperCache.get(key);
  if (hit) return hit;

  // 16 bits down to about 2 as the amount opens.
  const bits = Math.max(1.5, 16 - a * 14);
  const levels = Math.pow(2, bits);
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.round(x * levels) / levels;
  }
  shaperCache.set(key, curve);
  return curve;
}

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

/**
 * Web Audio's exponential ramps cannot touch zero, so a "decay to silence"
 * needs a floor. This is the value we treat as silent.
 */
export const SILENCE = 0.0001;

/**
 * Schedule attack/decay/sustain on an amplitude param.
 *
 * The attack is linear from true zero, not exponential from a tiny floor. An
 * exponential ramp from 0.0001 to 0.45 is a factor of 4500, so virtually all
 * of the rise happens in the final fraction of the attack time — the level
 * sits at nothing and then snaps, which is heard as a click on every note
 * rather than as a fast attack. Decay stays exponential, which is what decay
 * actually sounds like.
 */
export function applyAttackDecay(
  param: AudioParam,
  t0: number,
  peak: number,
  attack: number,
  decay: number,
  sustain: number,
): number {
  const a = Math.max(0.0005, attack);
  const d = Math.max(0.001, decay);
  const p = Math.max(SILENCE, peak);
  param.cancelScheduledValues(t0);
  param.setValueAtTime(0, t0);
  param.linearRampToValueAtTime(p, t0 + a);
  param.exponentialRampToValueAtTime(Math.max(SILENCE, p * sustain), t0 + a + d);
  return t0 + a + d;
}

/**
 * Schedule a filter cutoff envelope: base → peak → sustain, in Hz.
 *
 * Deliberately separate from the amplitude version. Reusing that one here
 * started the cutoff at 0.0001 Hz, which is a closed filter passing nothing,
 * so every note began muted and then snapped open — a transient in its own
 * right, and a degenerate biquad while it lasted.
 */
export function applyFilterEnv(
  param: AudioParam,
  t0: number,
  base: number,
  peak: number,
  attack: number,
  decay: number,
  sustain: number,
): number {
  const a = Math.max(0.0005, attack);
  const d = Math.max(0.001, decay);
  const lo = Math.max(10, base);
  const hi = Math.max(10, peak);
  const sus = Math.max(10, lo + (hi - lo) * sustain);
  param.cancelScheduledValues(t0);
  param.setValueAtTime(lo, t0);
  param.exponentialRampToValueAtTime(hi, t0 + a);
  param.exponentialRampToValueAtTime(sus, t0 + a + d);
  return t0 + a + d;
}

/**
 * Where an attack/decay/sustain envelope actually is at time `t`.
 *
 * Needed because `AudioParam.value` reports the value *now*, not at some future
 * scheduled time — and the sequencer schedules note-offs up to a lookahead
 * ahead of the clock. Anchoring a release to `param.value` therefore stamps the
 * wrong level and produces a step discontinuity: an audible click on every
 * note. `cancelAndHoldAtTime` is not a substitute; it inserts nothing when no
 * events remain after `t`, which makes the release start from the end of the
 * decay and cuts the note short.
 *
 * We scheduled every breakpoint ourselves, so the value is exactly computable.
 */
export function adsrValueAt(
  t: number, t0: number, peak: number,
  attack: number, decay: number, sustain: number,
): number {
  const a = Math.max(0.0005, attack);
  const d = Math.max(0.001, decay);
  const p = Math.max(SILENCE, peak);
  if (t <= t0) return SILENCE;
  // Matches applyAttackDecay: linear attack, exponential decay.
  if (t < t0 + a) return Math.max(SILENCE, p * ((t - t0) / a));
  const sus = Math.max(SILENCE, p * sustain);
  if (t < t0 + a + d) return p * Math.pow(sus / p, (t - t0 - a) / d);
  return sus;
}

/** Schedule a release starting from an explicitly supplied level. */
export function applyRelease(
  param: AudioParam, t: number, release: number, from: number,
): number {
  const r = Math.max(0.005, release);
  param.cancelScheduledValues(t);
  param.setValueAtTime(Math.max(SILENCE, from), t);
  param.exponentialRampToValueAtTime(SILENCE, t + r);
  return t + r;
}

/**
 * A percussive decay: instant attack, exponential fall. Used by every drum
 * voice, where a full ADSR would be overkill.
 */
export function percEnv(
  param: AudioParam,
  t0: number,
  peak: number,
  decay: number,
  attack = 0.001,
): number {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(SILENCE, t0);
  param.linearRampToValueAtTime(Math.max(SILENCE, peak), t0 + attack);
  param.exponentialRampToValueAtTime(SILENCE, t0 + attack + Math.max(0.005, decay));
  return t0 + attack + decay;
}

/**
 * Equal-power pan positions. Using cos/sin rather than a linear crossfade
 * keeps perceived loudness constant as a sound moves across the stereo field.
 */
export function panGains(pan: number): [number, number] {
  const p = (clamp(pan, -1, 1) + 1) * 0.25 * Math.PI; // 0..π/2
  return [Math.cos(p), Math.sin(p)];
}
