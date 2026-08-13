#include "audio/Drums.h"

#include <algorithm>
#include <cmath>

namespace motif {
namespace {

/**
 * Headroom, applied at the voice output rather than to the velocity.
 *
 * It cannot be folded into the input level: saturation normalises as
 * tanh(k*x)/tanh(k), which at high drive maps almost any input back up to full
 * scale, so a quieter input comes out just as loud. Body and transient are also
 * separate paths that can align. Fuzzing the earlier build's parameter space
 * put 11% of random settings above full scale before this moved.
 */
constexpr float kHeadroom = 0.82f;

inline float semitoneScale(float semis) { return std::pow(2.0f, semis / 12.0f); }

} // namespace

constexpr float DrumVoice::kMetalRatios[DrumVoice::kMetals];

void DrumVoice::prepare(double sampleRate) {
    sampleRate_ = sampleRate;
    body_.setSampleRate(sampleRate);
    body2_.setSampleRate(sampleRate);
    click_.setSampleRate(sampleRate);
    for (auto& m : metals_) m.setSampleRate(sampleRate);
    toneFilter_.setSampleRate(sampleRate);
    noiseFilter_.setSampleRate(sampleRate);
    metalHp_.setSampleRate(sampleRate);
    ampEnv_.setSampleRate(sampleRate);
    noiseEnv_.setSampleRate(sampleRate);
    clickEnv_.setSampleRate(sampleRate);
    active_ = false;
}

void DrumVoice::trigger(DrumEngine engine, const DrumParams& p, float velocity, float semitones) {
    engine_ = engine;
    params_ = p;
    velocity_ = std::clamp(velocity, 0.0f, 1.4f);
    active_ = true;

    baseHz_ = std::clamp(double(p.tune * semitoneScale(semitones)), 20.0, 4000.0);

    toneFilter_.reset();
    noiseFilter_.reset();
    metalHp_.reset();
    clapBurst_ = 0;
    clapPos_ = 0.0;

    switch (engine) {
        case DrumEngine::Kick:
        case DrumEngine::Tom: {
            const bool tom = engine == DrumEngine::Tom;
            body_.setWave(dsp::Wave::Sine);
            body_.resetPhase(0.0);
            pitchFrom_ = baseHz_ * std::pow(2.0, double(p.pitchMod) * (tom ? 0.4 : 1.0) / 12.0);
            pitchTo_ = baseHz_;
            pitchLen_ = std::max(1.0, double(p.pitchTime) * (tom ? 2.0 : 1.0) * sampleRate_);
            pitchPos_ = 0.0;
            ampEnv_.trigger(velocity_ * kHeadroom, 0.002f, p.decay);
            toneFilter_.setMode(dsp::SvFilter::Mode::Lowpass);
            toneFilter_.set(std::clamp(double(p.cutoff), 40.0, 18000.0), p.resonance);

            // Beater transient: a pitched partial, never a noise burst. Noise is
            // uncorrelated sample to sample, so a burst of it on the front of a
            // kick is a tick however it is filtered — the roughness is the
            // signal, not the shaping.
            if (p.snap > 0.01f) {
                click_.setWave(dsp::Wave::Triangle);
                click_.resetPhase(0.0);
                clickEnv_.trigger(velocity_ * p.snap * 0.4f * kHeadroom, 0.0012f, 0.009f);
            }
            if (p.noise > 0.01f && tom) noiseEnv_.trigger(velocity_ * p.noise * 0.4f * kHeadroom, 0.001f, p.decay * 0.4f);
            break;
        }

        case DrumEngine::Snare: {
            // Two-tone body. The 1.588 ratio is roughly the 909's oscillator
            // pair — close to a tritone, deliberately unresolved.
            body_.setWave(dsp::Wave::Triangle);
            body2_.setWave(dsp::Wave::Triangle);
            body_.resetPhase(0.0);
            body2_.resetPhase(0.25);
            pitchFrom_ = baseHz_ * 1.35;
            pitchTo_ = baseHz_;
            pitchLen_ = std::max(1.0, 0.03 * sampleRate_);
            pitchPos_ = 0.0;
            ampEnv_.trigger(velocity_ * (1.0f - p.noise) * kHeadroom, 0.001f, p.decay * 0.75f);
            noiseEnv_.trigger(velocity_ * p.noise * 0.9f * kHeadroom, 0.001f, p.decay);
            noiseFilter_.setMode(dsp::SvFilter::Mode::Bandpass);
            noiseFilter_.set(std::clamp(baseHz_ * 6.0, 300.0, 9000.0), 0.9);
            break;
        }

        case DrumEngine::Clap: {
            noiseFilter_.setMode(dsp::SvFilter::Mode::Bandpass);
            noiseFilter_.set(std::clamp(baseHz_, 200.0, 6000.0), std::clamp(1.0 + p.resonance, 0.6, 12.0));
            clapSpacing_ = 0.0095 * sampleRate_;
            noiseEnv_.trigger(velocity_ * 0.85f * kHeadroom, 0.0008f, 0.010f);
            break;
        }

        case DrumEngine::Hat:
        case DrumEngine::Cymbal: {
            for (int i = 0; i < kMetals; ++i) {
                metals_[i].setWave(dsp::Wave::Square);
                metals_[i].setFrequency(baseHz_ * double(kMetalRatios[i]));
                metals_[i].resetPhase(double(i) * 0.11);
            }
            metalHp_.setMode(dsp::SvFilter::Mode::Highpass);
            const double hp = double(p.cutoff) * (engine == DrumEngine::Cymbal ? 0.55 : 1.0);
            metalHp_.set(std::clamp(hp, 200.0, 18000.0), std::clamp(double(p.resonance), 0.5, 8.0));
            ampEnv_.trigger(velocity_ * 0.8f * kHeadroom, 0.0008f, p.decay);
            if (p.noise > 0.01f) noiseEnv_.trigger(velocity_ * p.noise * 0.35f * kHeadroom, 0.0008f, p.decay);
            break;
        }

        case DrumEngine::Rim: {
            body_.setWave(dsp::Wave::Square);
            body2_.setWave(dsp::Wave::Square);
            body_.setFrequency(baseHz_);
            body2_.setFrequency(baseHz_ * 1.4);
            body_.resetPhase(0.0);
            body2_.resetPhase(0.3);
            pitchLen_ = 1.0; pitchPos_ = 1.0;    // no sweep
            pitchFrom_ = pitchTo_ = baseHz_;
            toneFilter_.setMode(dsp::SvFilter::Mode::Bandpass);
            toneFilter_.set(std::clamp(baseHz_ * 1.6, 200.0, 9000.0), 6.0);
            ampEnv_.trigger(velocity_ * 0.7f * kHeadroom, 0.0005f, 0.028f);
            break;
        }

        case DrumEngine::Noise: {
            noiseFilter_.setMode(dsp::SvFilter::Mode::Bandpass);
            noiseFilter_.set(std::clamp(double(p.cutoff) * semitoneScale(semitones), 60.0, 18000.0),
                             std::clamp(double(p.resonance), 0.5, 30.0));
            noiseEnv_.trigger(velocity_ * 0.8f * kHeadroom, 0.002f, p.decay);
            break;
        }
    }
}

void DrumVoice::render(float& outL, float& outR) {
    if (!active_) return;

    float sample = 0.0f;

    // Pitch envelope, per sample. Geometric, because pitch is heard in ratios.
    double sweptHz = pitchTo_;
    if (pitchPos_ < pitchLen_) {
        const double t = pitchPos_ / pitchLen_;
        sweptHz = pitchFrom_ * std::pow(pitchTo_ / pitchFrom_, t);
        pitchPos_ += 1.0;
    }

    switch (engine_) {
        case DrumEngine::Kick:
        case DrumEngine::Tom: {
            body_.setFrequency(sweptHz);
            float v = body_.next() * ampEnv_.next();
            v = dsp::saturate(v, params_.drive);
            v = toneFilter_.next(v);
            if (noiseEnv_.active()) v += noise_.next() * noiseEnv_.next() * 0.5f;
            if (clickEnv_.active()) {
                // The transient sweeps down toward the body so it fuses with it
                // rather than sitting in its own register as a separate tick.
                click_.setFrequency(std::clamp(sweptHz * 8.0, 150.0, 9000.0));
                v += click_.next() * clickEnv_.next();
            }
            sample = v;
            if (!ampEnv_.active() && !clickEnv_.active() && !noiseEnv_.active()) active_ = false;
            break;
        }

        case DrumEngine::Snare: {
            body_.setFrequency(sweptHz);
            body2_.setFrequency(sweptHz * 1.588);
            const float env = ampEnv_.next();
            float v = (body_.next() * 0.7f + body2_.next() * 0.45f) * env;
            if (noiseEnv_.active()) {
                float n = noiseFilter_.next(noise_.next());
                v += n * noiseEnv_.next();
            }
            sample = dsp::saturate(v, params_.drive);
            if (!ampEnv_.active() && !noiseEnv_.active()) active_ = false;
            break;
        }

        case DrumEngine::Clap: {
            float n = noiseFilter_.next(noise_.next());
            sample = n * noiseEnv_.next();
            clapPos_ += 1.0;
            if (!noiseEnv_.active()) {
                if (clapBurst_ < 2) {
                    // Next burst, each a little quieter than the last.
                    ++clapBurst_;
                    noiseEnv_.trigger(velocity_ * (0.75f - float(clapBurst_) * 0.12f) * kHeadroom,
                                      0.0008f, 0.010f);
                } else if (clapBurst_ == 2) {
                    ++clapBurst_;
                    noiseEnv_.trigger(velocity_ * 0.8f * kHeadroom, 0.001f, params_.decay);
                } else {
                    active_ = false;
                }
            }
            sample = dsp::saturate(sample, params_.drive);
            break;
        }

        case DrumEngine::Hat:
        case DrumEngine::Cymbal: {
            float mix = 0.0f;
            for (auto& m : metals_) mix += m.next();
            mix *= 1.0f / float(kMetals);
            if (noiseEnv_.active()) mix += noise_.next() * noiseEnv_.next() * 0.35f;
            mix = metalHp_.next(mix);
            sample = dsp::saturate(mix * ampEnv_.next(), params_.drive);
            if (!ampEnv_.active()) active_ = false;
            break;
        }

        case DrumEngine::Rim: {
            float v = (body_.next() + body2_.next()) * 0.5f;
            v = toneFilter_.next(v);
            sample = v * ampEnv_.next();
            if (!ampEnv_.active()) active_ = false;
            break;
        }

        case DrumEngine::Noise: {
            float n = noiseFilter_.next(noise_.next());
            sample = dsp::saturate(n * noiseEnv_.next(), params_.drive);
            if (!noiseEnv_.active()) active_ = false;
            break;
        }
    }

    outL += sample;
    outR += sample;
}

} // namespace motif
