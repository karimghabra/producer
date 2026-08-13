#pragma once

// ---------------------------------------------------------------------------
// Motif — drum synthesis.
//
// Ported from the browser build, with everything that took a long session to
// find left intact: raised-cosine attacks, a pitched beater transient rather
// than a noise burst, saturation that stays saturation instead of becoming a
// clipper, and headroom applied after the drive rather than before it.
// ---------------------------------------------------------------------------

#include "dsp/Dsp.h"

namespace motif {

enum class DrumEngine { Kick, Snare, Clap, Hat, Cymbal, Tom, Rim, Noise };

inline const char* drumEngineName(DrumEngine e) {
    switch (e) {
        case DrumEngine::Kick:   return "Kick";
        case DrumEngine::Snare:  return "Snare";
        case DrumEngine::Clap:   return "Clap";
        case DrumEngine::Hat:    return "Hat";
        case DrumEngine::Cymbal: return "Cymbal";
        case DrumEngine::Tom:    return "Tom";
        case DrumEngine::Rim:    return "Rim";
        case DrumEngine::Noise:  return "Noise";
    }
    return "Drum";
}

struct DrumParams {
    float tune = 55.0f;        // Hz — body pitch, or spectral centre for metals
    float decay = 0.40f;       // seconds
    float pitchMod = 24.0f;    // semitones the pitch envelope sweeps
    float pitchTime = 0.045f;  // seconds for that sweep
    float noise = 0.0f;        // tone / noise balance
    float drive = 0.30f;
    float cutoff = 12000.0f;
    float resonance = 0.7f;
    float snap = 0.50f;        // beater transient level
};

/**
 * One drum hit.
 *
 * A drum is fire-and-forget: nothing releases it, so the whole voice can be a
 * self-contained state machine that reports when it has finished.
 */
class DrumVoice {
public:
    void prepare(double sampleRate);

    void trigger(DrumEngine engine, const DrumParams& params, float velocity, float semitones = 0.0f);

    bool active() const { return active_; }

    /** Render one frame, adding into the pair. */
    void render(float& outL, float& outR);

private:
    /**
     * Metals are six square oscillators at these mutually inharmonic ratios,
     * as the 808 did it. Nothing lines up, so the spectrum never resolves into
     * a pitch — it just sounds like metal.
     */
    static constexpr int kMetals = 6;
    static constexpr float kMetalRatios[kMetals] = {
        1.0f, 1.4827f, 1.8002f, 2.5460f, 2.6303f, 3.8967f
    };

    DrumEngine engine_ = DrumEngine::Kick;
    DrumParams params_;
    double sampleRate_ = 44100.0;
    bool active_ = false;

    float velocity_ = 1.0f;
    double baseHz_ = 55.0;

    dsp::Oscillator body_, body2_;
    dsp::Oscillator metals_[kMetals];
    dsp::Oscillator click_;
    dsp::Noise noise_;
    dsp::SvFilter toneFilter_, noiseFilter_, metalHp_;

    dsp::PercEnvelope ampEnv_, noiseEnv_, clickEnv_;

    // Pitch envelope, evaluated per sample rather than scheduled.
    double pitchPos_ = 0.0, pitchLen_ = 1.0;
    double pitchFrom_ = 55.0, pitchTo_ = 55.0;

    // The 909 clap is three fast bursts then a tail; that spacing is the
    // entire trick and it is why it reads as many hands rather than one.
    int clapBurst_ = 0;
    double clapPos_ = 0.0, clapSpacing_ = 1.0;
};

} // namespace motif
