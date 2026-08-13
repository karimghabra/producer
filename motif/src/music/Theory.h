#pragma once

// ---------------------------------------------------------------------------
// Motif — musical maths.
//
// Ported from the earlier browser build, where these all earned their place.
// Header-only and free of JUCE so the tests can reach them.
// ---------------------------------------------------------------------------

#include <algorithm>
#include <array>
#include <cmath>
#include <numeric>
#include <string>
#include <vector>

namespace motif::theory {

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

enum class Scale {
    Minor, Major, Dorian, Phrygian, Lydian, Mixolydian, Locrian,
    HarmonicMinor, PhrygianDominant, MinorPentatonic, MajorPentatonic,
    Blues, WholeTone, Chromatic
};

inline const std::vector<int>& scaleSteps(Scale s) {
    static const std::vector<std::vector<int>> kTable = {
        { 0, 2, 3, 5, 7, 8, 10 },        // minor
        { 0, 2, 4, 5, 7, 9, 11 },        // major
        { 0, 2, 3, 5, 7, 9, 10 },        // dorian
        { 0, 1, 3, 5, 7, 8, 10 },        // phrygian
        { 0, 2, 4, 6, 7, 9, 11 },        // lydian
        { 0, 2, 4, 5, 7, 9, 10 },        // mixolydian
        { 0, 1, 3, 5, 6, 8, 10 },        // locrian
        { 0, 2, 3, 5, 7, 8, 11 },        // harmonic minor
        { 0, 1, 4, 5, 7, 8, 10 },        // phrygian dominant
        { 0, 3, 5, 7, 10 },              // minor pentatonic
        { 0, 2, 4, 7, 9 },               // major pentatonic
        { 0, 3, 5, 6, 7, 10 },           // blues
        { 0, 2, 4, 6, 8, 10 },           // whole tone
        { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 },
    };
    return kTable[size_t(s)];
}

inline const char* scaleName(Scale s) {
    static const char* kNames[] = {
        "Minor", "Major", "Dorian", "Phrygian", "Lydian", "Mixolydian", "Locrian",
        "Harmonic Minor", "Phrygian Dominant", "Minor Pentatonic", "Major Pentatonic",
        "Blues", "Whole Tone", "Chromatic"
    };
    return kNames[size_t(s)];
}

struct Key {
    int root = 9;              // 0 = C
    Scale scale = Scale::Minor;
};

/**
 * Scale degree to MIDI note. Degrees outside one octave wrap and carry the
 * octave with them, so degree 7 is the tonic above and -1 the leading tone
 * below — you can write a line that walks off the top of the scale and it
 * keeps making sense.
 */
inline int degreeToMidi(const Key& key, int degree, int octave = 0, int baseOctave = 4) {
    const auto& steps = scaleSteps(key.scale);
    const int n = int(steps.size());
    const int wrapped = ((degree % n) + n) % n;
    const int octShift = int(std::floor(double(degree) / double(n)));
    return 12 * (baseOctave + 1 + octave + octShift) + key.root + steps[size_t(wrapped)];
}

/** Pull an arbitrary note to the nearest one in the key. */
inline int snapToScale(const Key& key, int midi) {
    const auto& steps = scaleSteps(key.scale);
    const int pc = (((midi - key.root) % 12) + 12) % 12;
    const int octave = int(std::floor(double(midi - key.root) / 12.0));
    int best = steps[0];
    int bestDist = 99;
    for (int s : steps) {
        const int d = std::min(std::abs(s - pc), 12 - std::abs(s - pc));
        if (d < bestDist) { bestDist = d; best = s; }
    }
    return key.root + octave * 12 + best;
}

/**
 * Diatonic chord: stack thirds inside the scale, then rotate for inversions.
 * Stacking within the scale is what makes a minor key produce i, ii°, III, iv,
 * v, VI, VII on its own — you never choose a chord quality, the key does.
 */
inline std::vector<int> buildChord(const Key& key, int degree, int size = 3,
                                   int inversion = 0, int octave = 0) {
    std::vector<int> notes;
    for (int i = 0; i < size; ++i) notes.push_back(degreeToMidi(key, degree + i * 2, octave));
    for (int i = 0; i < inversion && !notes.empty(); ++i) {
        const int low = notes.front();
        notes.erase(notes.begin());
        notes.push_back(low + 12);
    }
    return notes;
}

inline std::string noteName(int midi) {
    static const char* kNames[12] = { "C","C#","D","D#","E","F","F#","G","G#","A","A#","B" };
    return std::string(kNames[((midi % 12) + 12) % 12]) + std::to_string(midi / 12 - 1);
}

// ---------------------------------------------------------------------------
// Euclidean rhythm
// ---------------------------------------------------------------------------

/**
 * Bjorklund's algorithm: spread `pulses` onsets across `steps` as evenly as
 * arithmetic allows. It is the same recursion Euclid used for the GCD, and it
 * produces a startling number of the world's traditional rhythms — E(3,8) is
 * the tresillo, E(5,8) the cinquillo, E(7,16) a samba.
 *
 * One integer pair gives a groove that is nearly four-on-the-floor but breathes.
 */
inline std::vector<bool> euclid(int pulses, int steps) {
    const int n = std::max(0, steps);
    const int k = std::clamp(pulses, 0, n);
    if (n == 0) return {};
    if (k == 0) return std::vector<bool>(size_t(n), false);
    if (k == n) return std::vector<bool>(size_t(n), true);

    std::vector<std::vector<bool>> a(size_t(k), std::vector<bool>{ true });
    std::vector<std::vector<bool>> b(size_t(n - k), std::vector<bool>{ false });

    while (b.size() > 1) {
        const size_t pairs = std::min(a.size(), b.size());
        std::vector<std::vector<bool>> merged;
        merged.reserve(pairs);
        for (size_t i = 0; i < pairs; ++i) {
            std::vector<bool> combined = a[i];
            combined.insert(combined.end(), b[i].begin(), b[i].end());
            merged.push_back(std::move(combined));
        }
        std::vector<std::vector<bool>> remainder;
        if (a.size() > b.size()) remainder.assign(a.begin() + long(pairs), a.end());
        else                     remainder.assign(b.begin() + long(pairs), b.end());
        a = std::move(merged);
        b = std::move(remainder);
    }

    std::vector<bool> out;
    for (const auto& group : a) out.insert(out.end(), group.begin(), group.end());
    for (const auto& group : b) out.insert(out.end(), group.begin(), group.end());
    return out;
}

/** Euclidean pattern with rotation and inversion applied. */
inline std::vector<bool> euclidPattern(int pulses, int steps, int rotation, bool invert) {
    auto base = euclid(pulses, steps);
    if (base.empty()) return base;
    const int n = int(base.size());
    const int rot = ((rotation % n) + n) % n;
    // Two arguments on purpose: `vector<bool> out(size_t(n))` parses as a
    // function declaration, not a variable.
    std::vector<bool> out(static_cast<size_t>(n), false);
    for (int i = 0; i < n; ++i) out[size_t(i)] = base[size_t((i + rot) % n)];
    if (invert) for (size_t i = 0; i < out.size(); ++i) out[i] = !out[i];
    return out;
}

inline long long gcd(long long a, long long b) {
    a = std::abs(a); b = std::abs(b);
    while (b) { const long long t = a % b; a = b; b = t; }
    return a ? a : 1;
}

inline long long lcm(long long a, long long b) {
    if (!a || !b) return 0;
    return std::abs(a * b) / gcd(a, b);
}

/**
 * Steps before every pattern length lines up again. A 16-step hat against a
 * 12-step bass takes 48 steps to come round, which is how a four-bar loop stops
 * sounding like a four-bar loop.
 */
inline long long polymeterCycle(const std::vector<int>& lengths, long long cap = 4096) {
    long long cycle = 1;
    for (int n : lengths) if (n > 0) cycle = lcm(cycle, n);
    return std::min(cycle, cap);
}

// ---------------------------------------------------------------------------
// Groove
// ---------------------------------------------------------------------------

/**
 * Swing, as an offset measured in steps.
 *
 * Steps are grouped; the back half of each group is pushed late while the front
 * half stays on the grid. At full amount the offset is a third of the group's
 * half-length, which puts the swung note exactly on the triplet.
 */
inline double swingOffset(int stepIndex, double amount, int unit) {
    if (amount == 0.0) return 0.0;
    const int group = std::max(2, unit);
    const double half = double(group) * 0.5;
    const int pos = ((stepIndex % group) + group) % group;
    if (double(pos) < half) return 0.0;
    return std::clamp(amount, -1.0, 1.0) * (1.0 / 3.0) * half;
}

/**
 * Deterministic pseudo-random from an integer seed.
 *
 * Humanise uses this rather than a real random source, so the same step drifts
 * the same way every time round the loop. That reads as a player's habit; true
 * randomness reads as a wobble.
 */
inline double hashRandom(int64_t seed) {
    uint64_t x = uint64_t(seed) * 0x9E3779B97F4A7C15ull;
    x ^= x >> 30; x *= 0xBF58476D1CE4E5B9ull;
    x ^= x >> 27; x *= 0x94D049BB133111EBull;
    x ^= x >> 31;
    return double(x >> 11) / double(1ull << 53);
}

// ---------------------------------------------------------------------------
// Supersaw detune — the JP-8000 curves
// ---------------------------------------------------------------------------

/**
 * Roland's detune knob is not linear. Adam Szabo measured it as an 11th-order
 * polynomial that is nearly flat near zero and opens sharply at the top, and
 * using the real curve is the difference between a supersaw and seven saws.
 */
inline double jp8000Detune(double x) {
    const double c = std::clamp(x, 0.0, 1.0);
    return 10028.7312891634 * std::pow(c, 11) - 50818.8652045924 * std::pow(c, 10)
         + 111363.4808729368 * std::pow(c, 9) - 138150.6761080548 * std::pow(c, 8)
         + 106649.6679158292 * std::pow(c, 7) - 53046.9642751875 * std::pow(c, 6)
         + 17019.9518580080 * std::pow(c, 5) - 3425.0836591318 * std::pow(c, 4)
         + 404.2703938388 * std::pow(c, 3) - 24.1878824391 * c * c
         + 0.6717417634 * c + 0.0030115596;
}

/** Relative detune offsets of the seven JP-8000 oscillators. */
inline const std::array<double, 7>& supersawOffsets() {
    static const std::array<double, 7> kOffsets = {
        -0.11002313, -0.06288439, -0.01952356, 0.0, 0.01952356, 0.06288439, 0.11002313
    };
    return kOffsets;
}

/** Detune offsets in cents, resampled to an arbitrary voice count. */
inline std::vector<double> unisonCents(int voices, double detune) {
    const int n = std::max(1, voices);
    if (n == 1) return { 0.0 };
    const double depth = jp8000Detune(detune);
    const auto& ref = supersawOffsets();
    std::vector<double> out;
    out.reserve(size_t(n));
    for (int i = 0; i < n; ++i) {
        const double t = double(i) / double(n - 1) * double(ref.size() - 1);
        const size_t lo = size_t(t);
        const size_t hi = std::min(ref.size() - 1, lo + 1);
        const double frac = t - double(lo);
        out.push_back((ref[lo] * (1.0 - frac) + ref[hi] * frac) * depth * 1200.0);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

inline double expScale(double t, double lo, double hi) {
    return lo * std::pow(hi / lo, std::clamp(t, 0.0, 1.0));
}

inline double invExpScale(double v, double lo, double hi) {
    return std::log(std::clamp(v, lo, hi) / lo) / std::log(hi / lo);
}

inline double mtof(double midi) { return 440.0 * std::pow(2.0, (midi - 69.0) / 12.0); }

/**
 * The logistic map. At r near 3.9 it is chaotic but bounded and structured,
 * producing runs of hits and runs of rests — which sounds far more like a
 * played part than uniform randomness does.
 */
inline double logisticStep(double x, double r = 3.9) {
    return std::clamp(r * x * (1.0 - x), 0.0001, 0.9999);
}

} // namespace motif::theory
