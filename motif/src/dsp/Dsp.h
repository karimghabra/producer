#pragma once

// ---------------------------------------------------------------------------
// Motif — DSP primitives.
//
// Everything here is evaluated one sample at a time. That is the whole point of
// moving off a scheduled audio graph: an envelope's value at any instant is
// computed, not scheduled against a timeline that something else might cancel.
// A release starts from the level the envelope is actually at, because we can
// simply read it.
// ---------------------------------------------------------------------------

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace motif::dsp {

constexpr double kPi = 3.14159265358979323846;

inline float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

/** Cheap deterministic noise. xorshift, so it is repeatable per seed. */
class Noise {
public:
    explicit Noise(uint32_t seed = 0x9E3779B9u) : state_(seed ? seed : 1u) {}
    float next() {
        state_ ^= state_ << 13;
        state_ ^= state_ >> 17;
        state_ ^= state_ << 5;
        return float(int32_t(state_)) * (1.0f / 2147483648.0f);
    }
private:
    uint32_t state_;
};

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * ADSR with a raised-cosine attack.
 *
 * The attack shape matters more than it sounds like it should. A straight ramp
 * is continuous in level but not in slope: it stops dead at the top, and that
 * corner is a step in the first derivative, which is heard as a click on the
 * front of every note. `(1 - cos(pi x)) / 2` leaves and arrives at zero slope,
 * so the attack is exactly as fast without the edge.
 *
 * Decay and release stay exponential, which is what decay sounds like.
 */
class Envelope {
public:
    float attack = 0.004f;
    float decay = 0.150f;
    float sustain = 0.80f;
    float release = 0.120f;

    void setSampleRate(double sr) { sampleRate_ = sr > 0.0 ? sr : 44100.0; }

    void noteOn() {
        stage_ = Stage::Attack;
        // Start the attack from wherever we are, so retriggering a sounding
        // voice ramps from its current level instead of jumping to zero.
        attackFrom_ = value_;
        phase_ = 0.0;
    }

    void noteOff() {
        if (stage_ == Stage::Idle) return;
        stage_ = Stage::Release;
        releaseFrom_ = value_;      // no guessing; this is the real level
        phase_ = 0.0;
    }

    void reset() { stage_ = Stage::Idle; value_ = 0.0f; phase_ = 0.0; }

    bool active() const { return stage_ != Stage::Idle; }
    bool releasing() const { return stage_ == Stage::Release; }
    float value() const { return value_; }

    float next() {
        switch (stage_) {
            case Stage::Idle:
                value_ = 0.0f;
                break;

            case Stage::Attack: {
                const double len = std::max(1.0, double(attack) * sampleRate_);
                phase_ += 1.0 / len;
                if (phase_ >= 1.0) {
                    value_ = 1.0f;
                    stage_ = Stage::Decay;
                    phase_ = 0.0;
                } else {
                    const float shaped = float((1.0 - std::cos(kPi * phase_)) * 0.5);
                    value_ = attackFrom_ + (1.0f - attackFrom_) * shaped;
                }
                break;
            }

            case Stage::Decay: {
                const double len = std::max(1.0, double(decay) * sampleRate_);
                phase_ += 1.0 / len;
                if (phase_ >= 1.0) {
                    value_ = sustain;
                    stage_ = Stage::Sustain;
                } else {
                    // Geometric fall from 1 to the sustain level.
                    const float s = std::max(1.0e-4f, sustain);
                    value_ = std::pow(s, float(phase_));
                }
                break;
            }

            case Stage::Sustain:
                value_ = sustain;
                if (sustain <= 1.0e-4f) { stage_ = Stage::Idle; value_ = 0.0f; }
                break;

            case Stage::Release: {
                const double len = std::max(1.0, double(release) * sampleRate_);
                phase_ += 1.0 / len;
                if (phase_ >= 1.0) {
                    value_ = 0.0f;
                    stage_ = Stage::Idle;
                } else {
                    // Exponential toward silence, from the level we actually held.
                    value_ = releaseFrom_ * float(std::exp(-6.9 * phase_));
                }
                break;
            }
        }
        return value_;
    }

private:
    enum class Stage { Idle, Attack, Decay, Sustain, Release };
    Stage stage_ = Stage::Idle;
    double sampleRate_ = 44100.0;
    double phase_ = 0.0;
    float value_ = 0.0f;
    float releaseFrom_ = 0.0f;
    float attackFrom_ = 0.0f;
};

/** One-shot percussive envelope: shaped attack, exponential fall, no sustain. */
class PercEnvelope {
public:
    void setSampleRate(double sr) { sampleRate_ = sr > 0.0 ? sr : 44100.0; }

    void trigger(float peak, float attackSec, float decaySec) {
        peak_ = peak;
        attackSamples_ = std::max(1.0, double(attackSec) * sampleRate_);
        decaySamples_ = std::max(1.0, double(decaySec) * sampleRate_);
        pos_ = 0.0;
        active_ = true;
    }

    bool active() const { return active_; }

    float next() {
        if (!active_) return 0.0f;
        float v;
        if (pos_ < attackSamples_) {
            const double x = pos_ / attackSamples_;
            v = peak_ * float((1.0 - std::cos(kPi * x)) * 0.5);
        } else {
            const double x = (pos_ - attackSamples_) / decaySamples_;
            if (x >= 1.0) { active_ = false; return 0.0f; }
            v = peak_ * float(std::exp(-6.9 * x));
        }
        pos_ += 1.0;
        return v;
    }

private:
    double sampleRate_ = 44100.0;
    double attackSamples_ = 1.0, decaySamples_ = 1.0, pos_ = 0.0;
    float peak_ = 1.0f;
    bool active_ = false;
};

// ---------------------------------------------------------------------------
// Oscillator
// ---------------------------------------------------------------------------

enum class Wave { Sine, Saw, Square, Triangle };

/**
 * Band-limited oscillator using PolyBLEP.
 *
 * A naive saw or square is a stack of discontinuities, and every one of them
 * folds energy back below Nyquist as inharmonic hash. PolyBLEP subtracts a
 * polynomial approximation of the band-limited step around each discontinuity,
 * which costs a couple of multiplies and removes most of it.
 */
class Oscillator {
public:
    void setSampleRate(double sr) { sampleRate_ = sr > 0.0 ? sr : 44100.0; }
    void setFrequency(double hz) { freq_ = std::clamp(hz, 0.0, sampleRate_ * 0.48); }
    void setWave(Wave w) { wave_ = w; }
    void resetPhase(double p = 0.0) { phase_ = p; }
    double frequency() const { return freq_; }

    float next() {
        const double dt = freq_ / sampleRate_;
        float out = 0.0f;

        switch (wave_) {
            case Wave::Sine:
                out = float(std::sin(2.0 * kPi * phase_));
                break;

            case Wave::Saw:
                out = float(2.0 * phase_ - 1.0);
                out -= polyBlep(phase_, dt);
                break;

            case Wave::Square:
                out = phase_ < 0.5 ? 1.0f : -1.0f;
                out += polyBlep(phase_, dt);
                out -= polyBlep(std::fmod(phase_ + 0.5, 1.0), dt);
                break;

            case Wave::Triangle: {
                // Integrating a band-limited square gives a band-limited
                // triangle, and the leaky integrator keeps DC from creeping in.
                float sq = phase_ < 0.5 ? 1.0f : -1.0f;
                sq += polyBlep(phase_, dt);
                sq -= polyBlep(std::fmod(phase_ + 0.5, 1.0), dt);
                triState_ += float(4.0 * dt) * sq;
                triState_ *= 0.9995f;
                out = triState_;
                break;
            }
        }

        phase_ += dt;
        if (phase_ >= 1.0) phase_ -= 1.0;
        return out;
    }

private:
    static float polyBlep(double t, double dt) {
        if (dt <= 0.0) return 0.0f;
        if (t < dt) {
            const double x = t / dt;
            return float(x + x - x * x - 1.0);
        }
        if (t > 1.0 - dt) {
            const double x = (t - 1.0) / dt;
            return float(x * x + x + x + 1.0);
        }
        return 0.0f;
    }

    double sampleRate_ = 44100.0;
    double freq_ = 440.0;
    double phase_ = 0.0;
    float triState_ = 0.0f;
    Wave wave_ = Wave::Saw;
};

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

/**
 * Topology-preserving state variable filter.
 *
 * Chosen over a biquad specifically because the cutoff gets swept hard and
 * fast here. A biquad recomputes coefficients from a difference equation that
 * assumes they are constant, so sweeping it produces zipper noise and, at high
 * resonance, can go briefly unstable. The TPT form stays well behaved while
 * the cutoff moves, which is exactly what a filter envelope does to it.
 */
class SvFilter {
public:
    enum class Mode { Lowpass, Highpass, Bandpass, Notch };

    void setSampleRate(double sr) { sampleRate_ = sr > 0.0 ? sr : 44100.0; update(); }
    void setMode(Mode m) { mode_ = m; }

    void set(double cutoffHz, double resonance) {
        cutoff_ = std::clamp(cutoffHz, 20.0, sampleRate_ * 0.45);
        // Resonance arrives as a Q-like number; convert to the damping term.
        q_ = std::clamp(resonance, 0.5, 40.0);
        update();
    }

    void reset() { ic1_ = ic2_ = 0.0; }

    float next(float in) {
        const double v3 = in - ic2_;
        const double v1 = a1_ * ic1_ + a2_ * v3;
        const double v2 = ic2_ + a2_ * ic1_ + a3_ * v3;
        ic1_ = 2.0 * v1 - ic1_;
        ic2_ = 2.0 * v2 - ic2_;

        switch (mode_) {
            case Mode::Lowpass:  return float(v2);
            case Mode::Bandpass: return float(v1);
            case Mode::Highpass: return float(in - k_ * v1 - v2);
            case Mode::Notch:    return float(in - k_ * v1);
        }
        return float(v2);
    }

private:
    void update() {
        const double g = std::tan(kPi * cutoff_ / sampleRate_);
        k_ = 1.0 / q_;
        a1_ = 1.0 / (1.0 + g * (g + k_));
        a2_ = g * a1_;
        a3_ = g * a2_;
    }

    double sampleRate_ = 44100.0;
    double cutoff_ = 1000.0, q_ = 0.707, k_ = 1.414;
    double a1_ = 0.0, a2_ = 0.0, a3_ = 0.0;
    double ic1_ = 0.0, ic2_ = 0.0;
    Mode mode_ = Mode::Lowpass;
};

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

/**
 * Soft saturation. The pre-gain is kept modest on purpose: tanh flattens
 * everything above roughly 2/k onto a plateau, so a large pre-gain stops being
 * saturation and becomes a hard clipper, turning the signal into a square wave
 * with instantaneous edges.
 */
inline float saturate(float x, float amount) {
    if (amount <= 0.001f) return x;
    const float k = 1.0f + amount * amount * 8.0f;
    return std::tanh(k * x) / std::tanh(k);
}

/**
 * Output safety. Transparent below the knee, asymptotic above it, so the value
 * can never leave [-1, 1] however many voices sum into it.
 */
inline float softClip(float x, float knee = 0.7f) {
    const float a = std::abs(x);
    if (a <= knee) return x;
    const float span = 1.0f - knee;
    return (x < 0.0f ? -1.0f : 1.0f) * (knee + span * std::tanh((a - knee) / span));
}

/** One-pole smoother, for parameters that must not step. */
class Smoothed {
public:
    void reset(float v) { current_ = target_ = v; }
    void setTarget(float v) { target_ = v; }
    void setTimeConstant(float seconds, double sampleRate) {
        coeff_ = float(1.0 - std::exp(-1.0 / std::max(1.0, seconds * sampleRate)));
    }
    float next() { current_ += coeff_ * (target_ - current_); return current_; }
    float current() const { return current_; }

private:
    float current_ = 0.0f, target_ = 0.0f, coeff_ = 0.01f;
};

} // namespace motif::dsp
