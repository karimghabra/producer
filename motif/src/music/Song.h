#pragma once

// ---------------------------------------------------------------------------
// Motif — the document.
//
// The point where the two halves of this app meet: a take you played and a
// pattern you can edit are the same object. Fitting a performance produces a
// pattern, so nothing is trapped in a "recorded" state you cannot touch.
// ---------------------------------------------------------------------------

#include <cstdint>
#include <string>
#include <vector>

#include "audio/Drums.h"
#include "music/Quantizer.h"
#include "music/Theory.h"

namespace motif {

/** A synth sound. */
struct Patch {
    dsp::Wave wave = dsp::Wave::Saw;
    int unison = 5;
    float detune = 0.30f;
    float spread = 0.70f;
    int octave = 0;
    float sub = 0.25f;

    float cutoff = 2200.0f;
    float resonance = 3.0f;
    float filterEnv = 2.0f;
    float keyTrack = 0.35f;

    float ampAttack = 0.006f, ampDecay = 0.180f, ampSustain = 0.75f, ampRelease = 0.160f;
    float fltAttack = 0.004f, fltDecay = 0.220f, fltSustain = 0.40f, fltRelease = 0.150f;

    float drive = 0.25f;
    float gain = 0.75f;
};

/**
 * Elektron-style trig conditions. `hit:of` fires only on that pass of every
 * `of` passes, which is how one pattern grows into an arrangement without a
 * timeline.
 */
struct TrigCondition {
    enum class Type { Always, Probability, Ratio, Fill, NotFill, First, NotFirst };
    Type type = Type::Always;
    float chance = 1.0f;    // Probability
    int hit = 1, of = 4;    // Ratio
};

struct Step {
    bool on = false;
    float velocity = 0.8f;
    int degree = 0;         // scale degree for pitched tracks
    int octave = 0;
    int length = 1;         // in steps
    int ratchet = 1;        // retriggers inside the step
    float nudge = 0.0f;     // -0.5..0.5 of a step
    bool accent = false;
    TrigCondition cond;
};

struct Pattern {
    std::string name = "A";
    int length = 16;        // steps; differing lengths across tracks give polymeter
    int resolution = 4;     // steps per beat
    bool euclidMode = false;
    int euclidPulses = 4;
    int euclidRotation = 0;
    bool euclidInvert = false;
    std::vector<Step> steps = std::vector<Step>(16);

    /** Whether a step sounds, accounting for euclidean generation. */
    bool stepOn(int index) const {
        if (index < 0 || index >= int(steps.size())) return false;
        if (!euclidMode) return steps[size_t(index)].on;
        const auto mask = theory::euclidPattern(euclidPulses, length, euclidRotation, euclidInvert);
        return index < int(mask.size()) && mask[size_t(index)];
    }

    void resize(int newLength) {
        length = std::max(1, newLength);
        steps.resize(size_t(length));
    }
};

struct Mixer {
    float gain = 0.85f;
    float pan = 0.0f;
    bool mute = false;
    bool solo = false;
    float reverbSend = 0.0f;
    float delaySend = 0.0f;
    /** How far this track ducks when the sidechain source fires. */
    float duck = 0.0f;
};

struct Instrument {
    bool isDrum = true;
    DrumEngine drumEngine = DrumEngine::Kick;
    DrumParams drum;
    Patch synth;
};

struct Track {
    std::string name = "Track";
    uint32_t colour = 0xff5ee6c5;
    Instrument instrument;
    Mixer mixer;
    std::vector<Pattern> patterns{ Pattern{} };
    int activePattern = 0;
    bool seqEnabled = true;
    /** Set when this track is the one live playing and recording go to. */
    bool armed = false;

    const Pattern* current() const {
        if (patterns.empty()) return nullptr;
        const int i = std::clamp(activePattern, 0, int(patterns.size()) - 1);
        return &patterns[size_t(i)];
    }
    Pattern* current() {
        if (patterns.empty()) return nullptr;
        const int i = std::clamp(activePattern, 0, int(patterns.size()) - 1);
        return &patterns[size_t(i)];
    }
};

/** The master bus. */
struct MasterFx {
    float gain = 0.85f;
    float drive = 0.10f;
    bool limiter = true;

    struct Reverb {
        float size = 0.62f;     // decay length
        float damp = 0.45f;     // how fast the treble dies
        float width = 0.90f;
        float mix = 0.85f;      // return level
    } reverb;

    struct Delay {
        float beats = 0.75f;    // dotted eighth by default: three against four
        float feedback = 0.40f;
        float tone = 3200.0f;   // feedback-path lowpass
        float pingpong = 0.80f;
        float mix = 0.85f;
    } delay;

    /** Sidechain recovery. Above 1 the level hangs low then snaps back. */
    float sidechainRelease = 0.24f;
    float sidechainCurve = 1.8f;
};

struct Song {
    std::string name = "Untitled";
    double bpm = 124.0;
    double swing = 0.0;      // 0 straight, 1 full triplet shuffle
    int swingUnit = 2;       // group size in steps
    double humanize = 0.0;   // milliseconds of stable jitter
    theory::Key key;
    std::vector<Track> tracks;
    MasterFx master;
    int beatsPerBar = 4;
    int barsPerLoop = 2;
    /** Index of the track whose hits drive the sidechain. -1 for none. */
    int sidechainSource = 0;

    bool anySolo() const {
        for (const auto& t : tracks) if (t.mixer.solo) return true;
        return false;
    }

    /** Steps before every playing pattern lines up again. */
    long long polymeterCycle() const {
        std::vector<int> lengths;
        for (const auto& t : tracks)
            if (t.seqEnabled && t.current()) lengths.push_back(t.current()->length);
        return theory::polymeterCycle(lengths);
    }
};

// ---------------------------------------------------------------------------

/**
 * Turn a fitted performance into an editable pattern.
 *
 * This is the join between playing something and being able to change it. The
 * grid the fitter inferred becomes the pattern's resolution and length, so the
 * steps line up with what was actually played rather than with some default.
 *
 * `key` decides how pitches are stored: pitched tracks keep scale degrees so
 * the part follows the key when it changes, drum tracks keep a semitone offset.
 */
Pattern patternFromTake(const Take& take, const theory::Key& key, bool pitched);

/** A starter kit, so the app opens with something that already grooves. */
Song makeDefaultSong();

} // namespace motif
