// Motif — grid inference tests.
//
// Synthesises performances with known ground truth, plays them badly on
// purpose, and checks the inferred grid matches what was intended.

#include "audio/Engine.h"
#include "audio/Fx.h"
#include "music/Presets.h"
#include "music/Quantizer.h"
#include "music/Theory.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <random>
#include <string>
#include <utility>
#include <vector>

template <typename T> void juce_ignore(const T&) {}

using namespace motif;

namespace {

int failures = 0;
int checks = 0;

void check(bool ok, const std::string& what, const std::string& detail = {}) {
    ++checks;
    if (!ok) ++failures;
    std::printf("  %s  %-46s %s\n", ok ? "PASS" : "FAIL", what.c_str(), detail.c_str());
}

/**
 * Build a performance with a known tempo and grid, then smear it.
 *
 * `jitterMs` is how sloppily it was played. `swing` pushes off-steps late.
 * `dropChance` leaves gaps, because nobody plays every single subdivision.
 */
std::vector<RawNote> perform(double bpm, int subdiv, int bars, int beatsPerBar,
                             double jitterMs, double swing, double dropChance,
                             double startOffsetSec, uint32_t seed) {
    std::mt19937 rng(seed);
    std::normal_distribution<double> jitter(0.0, jitterMs / 1000.0);
    std::uniform_real_distribution<double> uni(0.0, 1.0);

    const double secPerBeat = 60.0 / bpm;
    const double step = secPerBeat / double(subdiv);
    const int totalSteps = bars * beatsPerBar * subdiv;

    std::vector<RawNote> notes;
    for (int i = 0; i < totalSteps; ++i) {
        if (uni(rng) < dropChance) continue;
        double t = startOffsetSec + double(i) * step;
        if (swing > 0.0 && i % 2 == 1) t += swing * (step / 3.0);
        t += jitter(rng);

        RawNote n;
        n.startSec = t;
        n.endSec = t + step * 0.8;
        n.pitch = 48 + (i % 5) * 2;
        n.velocity = 0.8f;
        notes.push_back(n);
    }
    return notes;
}

double pctErr(double got, double want) { return std::abs(got - want) / want * 100.0; }

} // namespace

int main() {
    std::printf("\nMotif grid inference\n====================\n\n");

    // --- tempo recovery ----------------------------------------------------
    std::printf("Tempo, from sloppy playing:\n");
    for (double bpm : { 90.0, 110.0, 128.0, 140.0, 174.0 }) {
        const auto notes = perform(bpm, 4, 2, 4, 12.0, 0.0, 0.35, 0.137, 42);
        const auto fit = inferGrid(notes);
        const bool ok = pctErr(fit.bpm, bpm) < 2.0;
        check(ok, "bpm " + std::to_string(int(bpm)),
              "got " + std::to_string(fit.bpm).substr(0, 6) +
              "  conf " + std::to_string(int(fit.confidence * 100)) + "%");
    }

    // --- subdivision -------------------------------------------------------
    std::printf("\nSubdivision:\n");
    {
        const auto straight = perform(120.0, 4, 1, 4, 8.0, 0.0, 0.2, 0.05, 7);
        const auto f = inferGrid(straight);
        check(f.subdivision == 4 || f.subdivision == 2,
              "sixteenths read as straight", "subdiv " + std::to_string(f.subdivision));
    }
    {
        // Triplets at B and sixteenths at 3B/4 produce identical onset times.
        // Nothing in the performance distinguishes them, so what is actually
        // required is that the grid SPACING is right — the notes land where
        // they were played — not that we guess the same label the player would
        // have used.
        const auto triplets = perform(120.0, 3, 1, 4, 8.0, 0.0, 0.15, 0.05, 11);
        const auto f = inferGrid(triplets);
        const double wantSpacing = 60.0 / 120.0 / 3.0;
        const double gotSpacing = 60.0 / f.bpm / f.subdivision;
        check(pctErr(gotSpacing, wantSpacing) < 2.0,
              "triplet spacing recovered",
              std::to_string(f.bpm).substr(0, 5) + " / " + std::to_string(f.subdivision) +
              " = " + std::to_string(gotSpacing).substr(0, 6) + "s");
    }
    {
        // Given the tempo, the ambiguity disappears entirely.
        const auto triplets = perform(120.0, 3, 1, 4, 8.0, 0.0, 0.15, 0.05, 11);
        FitOptions locked;
        locked.lockedBpm = 120.0;
        const auto f = inferGrid(triplets, locked);
        check(f.subdivision == 3 || f.subdivision == 6,
              "a known tempo resolves it to triplets",
              "subdiv " + std::to_string(f.subdivision));
    }

    // --- swing -------------------------------------------------------------
    std::printf("\nSwing:\n");
    {
        const auto straight = perform(120.0, 4, 1, 4, 6.0, 0.0, 0.1, 0.0, 3);
        const auto f = inferGrid(straight);
        check(f.swing < 0.25, "straight playing reads as straight",
              "swing " + std::to_string(int(f.swing * 100)) + "%");
    }
    {
        FitOptions locked;
        locked.lockedBpm = 120.0;
        const auto swung = perform(120.0, 4, 2, 4, 6.0, 0.85, 0.1, 0.0, 4);
        const auto f = inferGrid(swung, locked);
        check(f.swing > 0.45, "shuffled playing reads as shuffled",
              "swing " + std::to_string(int(f.swing * 100)) + "%  subdiv " +
              std::to_string(f.subdivision));
    }

    // --- loop length -------------------------------------------------------
    std::printf("\nLoop length:\n");
    for (int bars : { 1, 2, 4 }) {
        const auto notes = perform(128.0, 4, bars, 4, 10.0, 0.0, 0.3, 0.08, uint32_t(bars * 13));
        const auto f = inferGrid(notes);
        check(f.bars == bars, std::to_string(bars) + " bar idea",
              "got " + std::to_string(f.bars));
    }

    // --- confidence is meaningful -----------------------------------------
    std::printf("\nConfidence separates playing from noise:\n");
    {
        const auto tight = perform(128.0, 4, 2, 4, 3.0, 0.0, 0.3, 0.0, 21);
        const auto loose = perform(128.0, 4, 2, 4, 55.0, 0.0, 0.3, 0.0, 21);
        const auto ft = inferGrid(tight);
        const auto fl = inferGrid(loose);
        check(ft.confidence > 0.9, "tight playing scores high",
              std::to_string(int(ft.confidence * 100)) + "%");
        check(fl.confidence < ft.confidence - 0.2, "sloppy playing scores lower",
              std::to_string(int(fl.confidence * 100)) + "%");
    }

    // --- fitting actually moves notes onto the grid ------------------------
    std::printf("\nFitting:\n");
    {
        const auto notes = perform(128.0, 4, 1, 4, 18.0, 0.0, 0.25, 0.03, 99);
        FitOptions opts;
        opts.strength = 1.0;
        // Swing deliberately places notes off the grid, so it has to be off for
        // this particular check to mean anything.
        opts.keepSwing = false;
        const auto take = fitTake(notes, opts);
        const double stepBeats = 1.0 / double(take.fit.subdivision);

        double worst = 0.0;
        for (const auto& n : take.fitted) {
            const double steps = n.startBeats / stepBeats;
            worst = std::max(worst, std::abs(steps - std::round(steps)));
        }
        check(worst < 1e-6, "every note lands exactly on a grid line",
              "worst offset " + std::to_string(worst));
        check(take.fitted.size() == notes.size(), "no notes lost or duplicated",
              std::to_string(notes.size()) + " in, " + std::to_string(take.fitted.size()) + " out");
    }
    {
        // Strength 0 must be a no-op on position.
        const auto notes = perform(128.0, 4, 1, 4, 20.0, 0.0, 0.2, 0.05, 5);
        FitOptions opts;
        opts.strength = 0.0;
        opts.fitLengths = false;
        const auto take = fitTake(notes, opts);
        double worst = 0.0;
        const double secPerBeat = 60.0 / take.fit.bpm;
        for (size_t i = 0; i < take.fitted.size(); ++i) {
            const double wantBeats = (notes[i].startSec - take.fit.phaseSec) / secPerBeat;
            worst = std::max(worst, std::abs(take.fitted[i].startBeats - wantBeats));
        }
        check(worst < 1e-9, "strength 0 leaves the performance untouched",
              "worst drift " + std::to_string(worst));
    }

    // --- degenerate input --------------------------------------------------
    std::printf("\nToo little to go on:\n");
    {
        const auto f = inferGrid({});
        check(f.fellBack && f.confidence == 0.0, "empty take admits it cannot tell", "");
        std::vector<RawNote> one{ { 0.0, 0.2, 60, 0.8f } };
        const auto f1 = inferGrid(one);
        check(f1.fellBack, "single note admits it cannot tell", "");
    }

    // --- master effects ----------------------------------------------------
    std::printf("\nMaster effects:\n");
    {
        constexpr double SR = 48000.0;
        constexpr int N = int(SR * 3.0);

        // Reverb: an impulse in should still be ringing well after it stops.
        motif::fx::Reverb verb;
        verb.prepare(SR);
        verb.setParams(0.62f, 0.45f, 0.9f);
        std::vector<float> tail(size_t(N), 0.0f);
        for (int i = 0; i < N; ++i) {
            const float in = i == 0 ? 1.0f : 0.0f;
            float l = 0.0f, r = 0.0f;
            verb.process(in, in, l, r);
            tail[size_t(i)] = std::abs(l);
        }
        auto energyAt = [&](double sec) {
            const int start = int(sec * SR);
            float e = 0.0f;
            for (int i = start; i < std::min(N, start + int(SR * 0.05)); ++i) e = std::max(e, tail[size_t(i)]);
            return e;
        };
        const float e100 = energyAt(0.1), e800 = energyAt(0.8), e2500 = energyAt(2.5);
        check(e100 > 1e-5f, "reverb produces a tail", "peak at 100ms " + std::to_string(e100));
        check(e800 < e100 && e800 > 0.0f, "the tail decays rather than sustaining",
              "800ms/100ms = " + std::to_string(e800 / std::max(1e-9f, e100)));
        check(e2500 < e800, "and keeps decaying", "2.5s " + std::to_string(e2500));

        // Delay: an impulse should come back at the delay time, not before.
        motif::fx::PingPongDelay dly;
        dly.prepare(SR);
        dly.setParams(120.0, 0.5, 0.5f, 8000.0f, 0.8f);   // 0.25s at 120bpm
        std::vector<float> out(size_t(SR), 0.0f);
        for (int i = 0; i < int(SR); ++i) {
            const float in = i == 0 ? 1.0f : 0.0f;
            float l = 0.0f, r = 0.0f;
            dly.process(in, in, l, r);
            out[size_t(i)] = std::abs(l) + std::abs(r);
        }
        int firstEcho = -1;
        for (int i = 20; i < int(SR); ++i) if (out[size_t(i)] > 0.05f) { firstEcho = i; break; }
        const double echoMs = firstEcho > 0 ? double(firstEcho) / SR * 1000.0 : -1.0;
        check(firstEcho > 0 && std::abs(echoMs - 250.0) < 30.0,
              "delay repeats at the right time", "first echo " + std::to_string(int(echoMs)) + "ms, want 250ms");

        // Limiter: nothing gets past the ceiling.
        motif::fx::Limiter lim;
        lim.prepare(SR);
        lim.setThreshold(0.89f);
        float worst = 0.0f;
        for (int i = 0; i < int(SR); ++i) {
            const float in = float(2.5 * std::sin(double(i) * 0.05));   // way over full scale
            float l = 0.0f, r = 0.0f;
            lim.process(in, in, l, r);
            worst = std::max(worst, std::abs(l));
        }
        check(worst <= 0.92f, "limiter holds the ceiling", "worst " + std::to_string(worst));
    }

    // --- ported theory -----------------------------------------------------
    std::printf("\nPorted from the browser build:\n");
    {
        auto show = [](const std::vector<bool>& v) {
            std::string s;
            for (bool b : v) s += b ? 'x' : '.';
            return s;
        };
        check(show(motif::theory::euclid(3, 8)) == "x..x..x.", "E(3,8) is the tresillo",
              show(motif::theory::euclid(3, 8)));
        check(show(motif::theory::euclid(5, 8)) == "x.xx.xx.", "E(5,8) is the cinquillo",
              show(motif::theory::euclid(5, 8)));
        check(motif::theory::polymeterCycle({ 16, 12 }) == 48, "16 against 12 cycles in 48",
              std::to_string(motif::theory::polymeterCycle({ 16, 12 })));
        const motif::theory::Key aMinor{ 9, motif::theory::Scale::Minor };
        check(motif::theory::degreeToMidi(aMinor, 0) == 69, "degree 0 of A minor is A4",
              std::to_string(motif::theory::degreeToMidi(aMinor, 0)));
        const auto chord = motif::theory::buildChord(aMinor, 0, 3);
        check(chord.size() == 3 && chord[1] - chord[0] == 3,
              "the key picks the chord quality (A minor triad)",
              std::to_string(chord[1] - chord[0]) + " semitones to the third");
        check(std::abs(motif::theory::swingOffset(1, 1.0, 2) - (1.0 / 3.0)) < 1e-9,
              "full swing lands exactly on the triplet", "");
    }

    // --- instruments -------------------------------------------------------
    std::printf("\nInstruments (rendered, not assumed):\n");
    {
        constexpr double SR = 48000.0;

        // Zero-crossing rate is a cheap brightness proxy: enough to tell a sub
        // from a supersaw without an FFT.
        auto analyse = [](const std::vector<float>& buf) {
            float peak = 0.0f;
            int crossings = 0;
            for (size_t i = 1; i < buf.size(); ++i) {
                peak = std::max(peak, std::abs(buf[i]));
                if ((buf[i - 1] < 0.0f) != (buf[i] < 0.0f)) ++crossings;
            }
            return std::pair<float, int>{ peak, crossings };
        };

        int clipping = 0, silent = 0;
        std::vector<int> brightness;

        for (const auto& preset : motif::synthPresets()) {
            motif::Voice v;
            v.prepare(SR);
            v.start(60, 0.9f, preset.patch);
            std::vector<float> buf(size_t(SR * 0.5), 0.0f);
            for (size_t i = 0; i < buf.size(); ++i) {
                float l = 0.0f, r = 0.0f;
                v.render(l, r, preset.patch);
                buf[i] = l;
            }
            const auto [peak, cross] = analyse(buf);
            if (peak >= 1.0f) ++clipping;
            if (peak < 0.005f) { ++silent; std::printf("       (silent: %s)\n", preset.name); }
            brightness.push_back(cross);
        }

        check(silent == 0, "every synth preset makes a sound",
              std::to_string(motif::synthPresets().size()) + " presets");
        check(clipping == 0, "no synth preset clips on its own", "");

        // The engines must be genuinely different, not differently labelled.
        auto mm = std::minmax_element(brightness.begin(), brightness.end());
        check(*mm.second > *mm.first * 4, "the engines differ in character",
              "brightness spread " + std::to_string(*mm.first) + " to " + std::to_string(*mm.second));

        int drumClipping = 0, drumSilent = 0;
        for (const auto& preset : motif::drumPresets()) {
            motif::DrumVoice d;
            d.prepare(SR);
            d.trigger(preset.engine, preset.params, 1.0f, 0.0f);
            std::vector<float> buf(size_t(SR * 2.0), 0.0f);
            for (size_t i = 0; i < buf.size(); ++i) {
                float l = 0.0f, r = 0.0f;
                d.render(l, r);
                buf[i] = l;
            }
            const auto [peak, cross] = analyse(buf);
            juce_ignore(cross);
            if (peak >= 1.0f) {
                ++drumClipping;
                std::printf("       (clips: %-14s peak %.3f)\n", preset.name, peak);
            }
            if (peak < 0.005f) { ++drumSilent; std::printf("       (silent: %s)\n", preset.name); }
        }
        check(drumSilent == 0, "every drum preset makes a sound",
              std::to_string(motif::drumPresets().size()) + " presets");
        check(drumClipping == 0, "no drum preset clips on its own", "");
    }

    std::printf("\n%d checks, %d failures\n\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
