#pragma once

// ---------------------------------------------------------------------------
// Motif — master effects.
//
// Reverb and delay, written directly rather than as a graph of nodes. Both are
// sample-driven, so a parameter change takes effect on the next sample with no
// scheduling and nothing to cancel.
// ---------------------------------------------------------------------------

#include <algorithm>
#include <cmath>
#include <vector>

#include "dsp/Dsp.h"

namespace motif::fx {

/** A delay line with fractional read, for modulation without zipper noise. */
class DelayLine {
public:
    void prepare(double sampleRate, double maxSeconds) {
        buffer_.assign(size_t(sampleRate * maxSeconds) + 4, 0.0f);
        write_ = 0;
    }

    void clear() { std::fill(buffer_.begin(), buffer_.end(), 0.0f); }

    void write(float v) {
        buffer_[size_t(write_)] = v;
        if (++write_ >= int(buffer_.size())) write_ = 0;
    }

    float readAt(double delaySamples) const {
        if (buffer_.empty()) return 0.0f;
        const double n = double(buffer_.size());
        double pos = double(write_) - delaySamples;
        while (pos < 0.0) pos += n;
        const int i0 = int(pos) % int(n);
        const int i1 = (i0 + 1) % int(n);
        const float frac = float(pos - std::floor(pos));
        return buffer_[size_t(i0)] * (1.0f - frac) + buffer_[size_t(i1)] * frac;
    }

private:
    std::vector<float> buffer_;
    int write_ = 0;
};

// ---------------------------------------------------------------------------

/**
 * Ping-pong delay.
 *
 * Input hits the left tap; each tap feeds the other, so repeats alternate
 * across the field. A lowpass in the feedback path is what stops long
 * feedback settings turning into a pile of hiss — each repeat comes back
 * darker, the way a real echo does.
 */
class PingPongDelay {
public:
    void prepare(double sampleRate) {
        sampleRate_ = sampleRate;
        left_.prepare(sampleRate, 4.0);
        right_.prepare(sampleRate, 4.0);
        toneL_.setSampleRate(sampleRate);
        toneR_.setSampleRate(sampleRate);
        toneL_.setMode(dsp::SvFilter::Mode::Lowpass);
        toneR_.setMode(dsp::SvFilter::Mode::Lowpass);
        smoothed_.setTimeConstant(0.05f, sampleRate);
        smoothed_.reset(0.25f);
    }

    void reset() { left_.clear(); right_.clear(); toneL_.reset(); toneR_.reset(); }

    /** `beats` is the delay time as a fraction of a beat. */
    void setParams(double bpm, double beats, float feedback, float tone, float pingpong) {
        const double seconds = std::clamp(60.0 / std::max(20.0, bpm) * beats, 0.01, 3.9);
        smoothed_.setTarget(float(seconds));
        feedback_ = std::clamp(feedback, 0.0f, 0.95f);
        tone_ = std::clamp(tone, 200.0f, 18000.0f);
        spread_ = std::clamp(pingpong, 0.0f, 1.0f);
    }

    void process(float inL, float inR, float& outL, float& outR) {
        const double d = double(smoothed_.next()) * sampleRate_;
        toneL_.set(tone_, 0.707);
        toneR_.set(tone_, 0.707);

        const float readL = left_.readAt(d);
        const float readR = right_.readAt(d);

        left_.write(inL + toneR_.next(readR) * feedback_);
        right_.write(inR + toneL_.next(readL) * feedback_);

        // Widen by leaning each tap toward its own side.
        const float mid = (readL + readR) * 0.5f;
        outL = mid + (readL - mid) * (0.5f + spread_ * 0.5f) * 2.0f;
        outR = mid + (readR - mid) * (0.5f + spread_ * 0.5f) * 2.0f;
    }

private:
    DelayLine left_, right_;
    dsp::SvFilter toneL_, toneR_;
    dsp::Smoothed smoothed_;
    double sampleRate_ = 44100.0;
    float feedback_ = 0.4f, tone_ = 3200.0f, spread_ = 0.8f;
};

// ---------------------------------------------------------------------------

/**
 * Reverb: a Freeverb-style bank of comb filters into series allpasses.
 *
 * Eight combs at mutually prime lengths build the density; four allpasses then
 * smear the result so individual echoes stop being audible as echoes. The comb
 * lengths are prime so their repeats never coincide and stack into a ringing
 * tone — the same reason the browser build spaced its early reflections at
 * prime milliseconds.
 */
class Reverb {
public:
    void prepare(double sampleRate) {
        sampleRate_ = sampleRate;
        const double scale = sampleRate / 44100.0;
        for (int i = 0; i < kCombs; ++i) {
            combL_[i].assign(size_t(double(kCombTuning[i]) * scale) + 1, 0.0f);
            combR_[i].assign(size_t(double(kCombTuning[i] + kStereoSpread) * scale) + 1, 0.0f);
            combIdxL_[i] = combIdxR_[i] = 0;
            filtL_[i] = filtR_[i] = 0.0f;
        }
        for (int i = 0; i < kAllpasses; ++i) {
            apL_[i].assign(size_t(double(kAllpassTuning[i]) * scale) + 1, 0.0f);
            apR_[i].assign(size_t(double(kAllpassTuning[i] + kStereoSpread) * scale) + 1, 0.0f);
            apIdxL_[i] = apIdxR_[i] = 0;
        }
    }

    void reset() {
        for (int i = 0; i < kCombs; ++i) {
            std::fill(combL_[i].begin(), combL_[i].end(), 0.0f);
            std::fill(combR_[i].begin(), combR_[i].end(), 0.0f);
            filtL_[i] = filtR_[i] = 0.0f;
        }
        for (int i = 0; i < kAllpasses; ++i) {
            std::fill(apL_[i].begin(), apL_[i].end(), 0.0f);
            std::fill(apR_[i].begin(), apR_[i].end(), 0.0f);
        }
    }

    /** `size` 0..1 is decay length; `damp` 0..1 is how fast treble dies. */
    void setParams(float size, float damp, float width) {
        feedback_ = 0.70f + std::clamp(size, 0.0f, 1.0f) * 0.28f;
        damp_ = std::clamp(damp, 0.0f, 1.0f) * 0.4f;
        width_ = std::clamp(width, 0.0f, 1.0f);
    }

    void process(float inL, float inR, float& outL, float& outR) {
        const float input = (inL + inR) * 0.015f;   // gain staging into the tank
        float accL = 0.0f, accR = 0.0f;

        for (int i = 0; i < kCombs; ++i) {
            // Left.
            {
                auto& buf = combL_[i];
                int& idx = combIdxL_[i];
                const float y = buf[size_t(idx)];
                accL += y;
                // One-pole in the feedback path: each pass through the comb
                // loses more treble, which is what makes a tail sound like air
                // rather than a delay.
                filtL_[i] = y * (1.0f - damp_) + filtL_[i] * damp_;
                buf[size_t(idx)] = input + filtL_[i] * feedback_;
                if (++idx >= int(buf.size())) idx = 0;
            }
            // Right.
            {
                auto& buf = combR_[i];
                int& idx = combIdxR_[i];
                const float y = buf[size_t(idx)];
                accR += y;
                filtR_[i] = y * (1.0f - damp_) + filtR_[i] * damp_;
                buf[size_t(idx)] = input + filtR_[i] * feedback_;
                if (++idx >= int(buf.size())) idx = 0;
            }
        }

        for (int i = 0; i < kAllpasses; ++i) {
            {
                auto& buf = apL_[i];
                int& idx = apIdxL_[i];
                const float y = buf[size_t(idx)];
                const float out = -accL + y;
                buf[size_t(idx)] = accL + y * 0.5f;
                if (++idx >= int(buf.size())) idx = 0;
                accL = out;
            }
            {
                auto& buf = apR_[i];
                int& idx = apIdxR_[i];
                const float y = buf[size_t(idx)];
                const float out = -accR + y;
                buf[size_t(idx)] = accR + y * 0.5f;
                if (++idx >= int(buf.size())) idx = 0;
                accR = out;
            }
        }

        // Width: blend toward mono as it closes.
        const float wet1 = width_ * 0.5f + 0.5f;
        const float wet2 = (1.0f - width_) * 0.5f;
        outL = accL * wet1 + accR * wet2;
        outR = accR * wet1 + accL * wet2;
    }

private:
    static constexpr int kCombs = 8;
    static constexpr int kAllpasses = 4;
    static constexpr int kStereoSpread = 23;
    // Mutually prime, so repeats never line up into a ringing tone.
    static constexpr int kCombTuning[kCombs] =
        { 1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617 };
    static constexpr int kAllpassTuning[kAllpasses] = { 556, 441, 341, 225 };

    std::vector<float> combL_[kCombs], combR_[kCombs];
    std::vector<float> apL_[kAllpasses], apR_[kAllpasses];
    int combIdxL_[kCombs]{}, combIdxR_[kCombs]{};
    int apIdxL_[kAllpasses]{}, apIdxR_[kAllpasses]{};
    float filtL_[kCombs]{}, filtR_[kCombs]{};

    double sampleRate_ = 44100.0;
    float feedback_ = 0.84f, damp_ = 0.2f, width_ = 1.0f;
};

// ---------------------------------------------------------------------------

/**
 * Peak limiter with lookahead.
 *
 * The delay line holds the signal back by exactly the attack window, so gain
 * reduction is already in place by the time a transient arrives instead of
 * chasing it. Without that a fast limiter either lets peaks through or
 * distorts catching them.
 */
class Limiter {
public:
    void prepare(double sampleRate) {
        sampleRate_ = sampleRate;
        lookaheadSamples_ = int(0.002 * sampleRate);
        left_.prepare(sampleRate, 0.05);
        right_.prepare(sampleRate, 0.05);
        gain_ = 1.0f;
        releaseCoeff_ = float(std::exp(-1.0 / (0.12 * sampleRate)));
    }

    void setThreshold(float t) { threshold_ = std::clamp(t, 0.05f, 1.0f); }

    void process(float inL, float inR, float& outL, float& outR) {
        left_.write(inL);
        right_.write(inR);

        const float peak = std::max(std::abs(inL), std::abs(inR));
        const float target = peak > threshold_ ? threshold_ / peak : 1.0f;
        // Instant attack, exponential release: catch it now, let go slowly.
        gain_ = target < gain_ ? target : gain_ * releaseCoeff_ + target * (1.0f - releaseCoeff_);

        outL = left_.readAt(lookaheadSamples_) * gain_;
        outR = right_.readAt(lookaheadSamples_) * gain_;
    }

    float reduction() const { return 1.0f - gain_; }

private:
    DelayLine left_, right_;
    double sampleRate_ = 44100.0;
    int lookaheadSamples_ = 88;
    float threshold_ = 0.89f, gain_ = 1.0f, releaseCoeff_ = 0.999f;
};

} // namespace motif::fx
