// Motif — grid inference tests.
//
// Synthesises performances with known ground truth, plays them badly on
// purpose, and checks the inferred grid matches what was intended.

#include "music/Quantizer.h"

#include <cmath>
#include <cstdio>
#include <random>
#include <string>
#include <vector>

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

    std::printf("\n%d checks, %d failures\n\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
