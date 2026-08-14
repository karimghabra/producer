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

/**
 * Synthesis method. Each is a different arrangement of the same primitives
 * rather than a different codebase — what changes is how many oscillators run,
 * whether one modulates another, and what the envelopes are shaped for.
 */
enum class SynthEngine { Supersaw, Reese, FM, Sub, Pluck, Pad };

inline const char* synthEngineName(SynthEngine e) {
    switch (e) {
        case SynthEngine::Supersaw: return "Supersaw";
        case SynthEngine::Reese:    return "Reese";
        case SynthEngine::FM:       return "FM";
        case SynthEngine::Sub:      return "Sub";
        case SynthEngine::Pluck:    return "Pluck";
        case SynthEngine::Pad:      return "Pad";
    }
    return "Synth";
}

/** A synth sound. */
struct Patch {
    SynthEngine engine = SynthEngine::Supersaw;
    dsp::Wave wave = dsp::Wave::Saw;
    int unison = 5;
    float detune = 0.30f;
    float spread = 0.70f;
    int octave = 0;
    float sub = 0.25f;

    /** FM: modulator pitch as a multiple of the carrier. Whole numbers sound
     *  musical; fractions sound like bells and metal. */
    float fmRatio = 2.0f;
    /** Peak deviation in multiples of the carrier frequency. */
    float fmIndex = 3.0f;

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

    /**
     * A filter on the channel itself, after the instrument and before the fader.
     *
     * Separate from the filter inside the instrument on purpose. That one is
     * part of the sound - it moves with the note and its envelope. This one is
     * part of the arrangement: it takes the whole track, drums included, and
     * it is what a filter sweep across a build actually is.
     */
    enum class Filter { Off, Lowpass, Highpass, Bandpass };
    Filter filterType = Filter::Off;
    float filterCutoff = 1200.0f;
    float filterResonance = 0.9f;
};

inline const char* filterName(Mixer::Filter f) {
    switch (f) {
        case Mixer::Filter::Off:       return "Off";
        case Mixer::Filter::Lowpass:   return "Low";
        case Mixer::Filter::Highpass:  return "High";
        case Mixer::Filter::Bandpass:  return "Band";
    }
    return "Off";
}

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

// ---------------------------------------------------------------------------
// Arranging
//
// A loop is a scene; a song is scenes placed one after another. The patterns
// stay the unit you edit - a section does not copy them, it points at a scene
// which points at them - so fixing a hi-hat fixes it everywhere it plays.
//
// Automation belongs to the section rather than to the track, because "the
// filter opens over these two bars" is a statement about a place in the song,
// not a property of the instrument.
// ---------------------------------------------------------------------------

/** Which pattern each track plays. -1 leaves a track silent for the scene. */
struct Scene {
    std::string name = "Scene";
    std::vector<int> patterns;

    int patternFor(size_t track) const {
        return track < patterns.size() ? patterns[track] : 0;
    }
};

/** A point on an automation curve: where, and how far up. */
struct AutoPoint {
    /** Position within the section, in bars. */
    double bar = 0.0;
    /** Normalised 0..1. The target's own table turns this into a real value. */
    float value = 0.0f;
};

/**
 * One parameter automated across one section.
 *
 * Values are normalised because a cutoff sweep is drawn as a shape, and the
 * shape should mean the same thing whether it is sweeping 20 Hz to 20 kHz
 * logarithmically or a send from nothing to full.
 *
 * A lane drives a set of tracks rather than one. "Open the filter on the drums"
 * is a single gesture over three tracks, and drawing the same curve three times
 * would be three curves to keep in agreement afterwards.
 */
struct AutoLane {
    /** Tracks this lane drives. Ignored for master targets. */
    std::vector<int> tracks;
    /** Id from the automation target table. */
    std::string param;
    std::vector<AutoPoint> points;

    /**
     * Where the curve starts and ends, in bars.
     *
     * A ramp does not have to fill its section: drawn over bars 2 to 4 of an
     * eight bar section, it holds its first value before bar 2 and its last
     * after bar 4. The shape occupies exactly what was drawn.
     */
    double startBar() const { return points.empty() ? 0.0 : points.front().bar; }
    double endBar() const { return points.empty() ? 0.0 : points.back().bar; }

    /** Value at `bar`, interpolated. Flat before the first point and after the last. */
    float valueAt(double bar) const {
        if (points.empty()) return 0.0f;
        if (bar <= points.front().bar) return points.front().value;
        if (bar >= points.back().bar) return points.back().value;
        for (size_t i = 1; i < points.size(); ++i) {
            const auto& a = points[i - 1];
            const auto& b = points[i];
            if (bar <= b.bar) {
                const double span = b.bar - a.bar;
                if (span <= 1e-9) return b.value;
                const double t = (bar - a.bar) / span;
                return float(a.value + (b.value - a.value) * t);
            }
        }
        return points.back().value;
    }
};

/** A stretch of the song: one scene, held for a number of bars. */
struct Section {
    int scene = 0;
    int bars = 4;
    std::vector<AutoLane> lanes;
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

    std::vector<Scene> scenes;
    std::vector<Section> arrangement;
    /** Play the arrangement rather than looping whatever is armed. */
    bool songMode = false;

    /** Total length of the arrangement, in bars. */
    int songBars() const {
        int total = 0;
        for (const auto& s : arrangement) total += std::max(1, s.bars);
        return total;
    }

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

// ---------------------------------------------------------------------------
// Track edits
//
// Scenes index their pattern list by track, and automation lanes hold track
// indices. Adding, removing or reordering a track therefore changes what every
// scene and every lane refers to - and doing that to song.tracks alone leaves
// scenes playing the wrong patterns on the wrong tracks, silently.
//
// These are the only correct way to change the track list. They exist so that
// invariant is maintained by the song rather than remembered by each caller.
// ---------------------------------------------------------------------------

/** Insert a track, keeping scenes and automation aligned. `at` < 0 appends. */
void addTrack(Song& song, Track track, int at = -1);

/** Remove a track. Refuses to remove the last one. */
void removeTrack(Song& song, int index);

/** Reorder a track, remapping everything that referred to it by index. */
void moveTrack(Song& song, int from, int to);

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
