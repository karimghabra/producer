// Motif — grid inference tests.
//
// Synthesises performances with known ground truth, plays them badly on
// purpose, and checks the inferred grid matches what was intended.

#include "audio/Engine.h"
#include "audio/Fx.h"
#include "music/Automation.h"
#include "music/Presets.h"
#include "music/Project.h"
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
        // Eighths land on the sixteenth grid too, so the onsets score the two
        // readings identically and only occupancy can tell them apart: half the
        // sixteenth slots are never touched. Before this was checked, playing
        // deliberate eighth notes was reported back as "sixteenths".
        const auto eighths = perform(128.0, 2, 2, 4, 6.0, 0.0, 0.0, 0.09, 23);
        const auto f = inferGrid(eighths);
        check(f.subdivision == 2, "eighths are not called sixteenths",
              "subdiv " + std::to_string(f.subdivision));
        check(pctErr(f.bpm, 128.0) < 2.0, "and the tempo still comes back",
              std::to_string(f.bpm).substr(0, 6));
    }
    {
        // The same playing with an off-beat in it must stay on the fine grid -
        // one note on an odd step is proof the player meant sixteenths.
        auto withOffbeat = perform(128.0, 2, 2, 4, 6.0, 0.0, 0.0, 0.09, 23);
        RawNote extra = withOffbeat.front();
        extra.startSec += 60.0 / 128.0 / 4.0;          // a single sixteenth off
        withOffbeat.push_back(extra);
        const auto f = inferGrid(withOffbeat);
        check(f.subdivision == 4, "one off-beat note keeps the finer grid",
              "subdiv " + std::to_string(f.subdivision));
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

    // --- the channel filter --------------------------------------------------
    //
    // A filter that is wired up but does nothing is indistinguishable from one
    // that is not wired up at all, so this measures the output rather than
    // trusting the code path. Zero crossings stand in for brightness: no FFT
    // needed to tell that the top has been taken off something.
    std::printf("\nChannel filter:\n");
    {
        constexpr double SR = 48000.0;
        const int blockSize = 256;
        const int blocks = 90;                       // about half a second

        auto renderWith = [&](Mixer::Filter type, float cutoff) {
            Song song;
            Track t;
            t.name = "Test";
            t.instrument.isDrum = false;
            t.instrument.synth.engine = SynthEngine::Supersaw;
            t.instrument.synth.cutoff = 18000.0f;    // let the filter under test decide
            t.instrument.synth.ampSustain = 1.0f;
            t.instrument.synth.ampDecay = 2.0f;
            t.armed = true;
            t.seqEnabled = false;                    // played, not sequenced
            t.mixer.filterType = type;
            t.mixer.filterCutoff = cutoff;
            t.mixer.filterResonance = 0.9f;
            song.tracks.push_back(t);
            song.master.limiter = false;             // do not let it colour the test
            song.master.drive = 0.0f;

            Engine engine;
            engine.prepare(SR, blockSize);
            engine.setSong(song);
            engine.noteOn(57, 0.9f);

            std::vector<float> out;
            out.reserve(size_t(blocks * blockSize));
            // Fill values, not just sizes: vector<float> l(size_t(n)) is a
            // function declaration, and the error it produces says nothing
            // about that.
            std::vector<float> l(size_t(blockSize), 0.0f), r(size_t(blockSize), 0.0f);
            for (int b = 0; b < blocks; ++b) {
                engine.render(l.data(), r.data(), blockSize);
                out.insert(out.end(), l.begin(), l.end());
            }
            float peak = 0.0f;
            int crossings = 0;
            for (size_t i = 1; i < out.size(); ++i) {
                peak = std::max(peak, std::abs(out[i]));
                if ((out[i - 1] < 0.0f) != (out[i] < 0.0f)) ++crossings;
            }
            return std::pair<float, int>{ peak, crossings };
        };

        const auto [openPeak, openCross] = renderWith(Mixer::Filter::Off, 1000.0f);
        check(openPeak > 0.01f, "the test tone sounds at all",
              "peak " + std::to_string(openPeak).substr(0, 5));

        const auto [lpPeak, lpCross] = renderWith(Mixer::Filter::Lowpass, 220.0f);
        check(lpCross * 2 < openCross, "a lowpass takes the top off",
              std::to_string(openCross) + " crossings -> " + std::to_string(lpCross));
        check(lpPeak > 0.001f, "and leaves something behind",
              "peak " + std::to_string(lpPeak).substr(0, 5));

        const auto [hpPeak, hpCross] = renderWith(Mixer::Filter::Highpass, 5000.0f);
        check(hpCross > openCross, "a highpass takes the bottom out",
              std::to_string(openCross) + " crossings -> " + std::to_string(hpCross));
        check(hpPeak < openPeak, "and leaves less behind than no filter at all",
              std::to_string(openPeak).substr(0, 5) + " -> " + std::to_string(hpPeak).substr(0, 5));

        // Off must be genuinely off, not a filter parked wide open: a track
        // with no filter should be sample-identical to one before the feature
        // existed.
        const auto [offPeak, offCross] = renderWith(Mixer::Filter::Off, 220.0f);
        check(offPeak == openPeak && offCross == openCross,
              "cutoff is ignored while the filter is off", "identical output");
    }

    // --- arrangement and automation ------------------------------------------
    std::printf("\nArrangement:\n");
    {
        // Curve reading, before anything renders it.
        AutoLane lane;
        lane.param = "cutoff";
        lane.points = { { 0.0, 0.0f }, { 2.0, 1.0f } };
        check(std::abs(lane.valueAt(1.0) - 0.5f) < 1e-6, "a ramp reads half way at half way",
              std::to_string(lane.valueAt(1.0)).substr(0, 5));
        check(lane.valueAt(-1.0) == 0.0f && lane.valueAt(9.0) == 1.0f,
              "and holds flat outside its own span", "");

        AutoLane multi;
        multi.points = { { 0.0, 0.2f }, { 1.0, 1.0f }, { 3.0, 0.0f } };
        check(std::abs(multi.valueAt(2.0) - 0.5f) < 1e-6,
              "a drawn curve interpolates between its points",
              std::to_string(multi.valueAt(2.0)).substr(0, 5));

        // A target's own range, so a cutoff sweep spends its travel usefully.
        const AutoTarget* cutoff = findAutoTarget("cutoff");
        check(cutoff != nullptr && cutoff->log, "cutoff automates logarithmically", "");
        check(cutoff && std::abs(cutoff->fromNorm(0.0) - 20.0) < 0.1
                     && std::abs(cutoff->fromNorm(1.0) - 20000.0) < 1.0,
              "across the audible range",
              cutoff ? std::to_string(int(cutoff->fromNorm(0.5))) + " Hz at half" : "");

        // Evaluation must not touch the song.
        Song song = makeDefaultSong();
        song.tracks[0].mixer.filterCutoff = 800.0f;
        Section sec;
        sec.bars = 2;
        AutoLane sweep;
        sweep.tracks = { 0 };
        sweep.param = "cutoff";
        sweep.points = { { 0.0, 0.0f }, { 2.0, 1.0f } };
        sec.lanes.push_back(sweep);

        const auto atStart = evaluate(song, sec, 0.0);
        const auto atEnd = evaluate(song, sec, 2.0);
        check(atStart.mixers[0].filterCutoff < 30.0f && atEnd.mixers[0].filterCutoff > 19000.0f,
              "a sweep moves the value across the section",
              std::to_string(int(atStart.mixers[0].filterCutoff)) + " -> "
                  + std::to_string(int(atEnd.mixers[0].filterCutoff)) + " Hz");
        check(std::abs(song.tracks[0].mixer.filterCutoff - 800.0f) < 0.01f,
              "and leaves the song's own value alone",
              std::to_string(int(song.tracks[0].mixer.filterCutoff)) + " Hz");

        // An untouched target keeps whatever the mix says.
        check(std::abs(atEnd.mixers[1].gain - song.tracks[1].mixer.gain) < 1e-6,
              "parameters with no lane are untouched", "");

        // A ramp need not fill its section. Drawn over bars 2 to 4 of an eight
        // bar section it occupies exactly that, holding either side.
        Section partial;
        partial.bars = 8;
        AutoLane shortRamp;
        shortRamp.tracks = { 0 };
        shortRamp.param = "gain";
        shortRamp.points = { { 2.0, 0.0f }, { 4.0, 1.0f } };
        partial.lanes.push_back(shortRamp);

        const float before = evaluate(song, partial, 0.5).mixers[0].gain;
        const float atStartOfRamp = evaluate(song, partial, 2.0).mixers[0].gain;
        const float halfway = evaluate(song, partial, 3.0).mixers[0].gain;
        const float atEndOfRamp = evaluate(song, partial, 4.0).mixers[0].gain;
        const float after = evaluate(song, partial, 7.5).mixers[0].gain;
        check(before == atStartOfRamp && std::abs(before) < 1e-6f,
              "before a ramp starts it holds its first value",
              std::to_string(before).substr(0, 5));
        check(std::abs(halfway - 0.75f) < 0.01f, "it moves only across its own span",
              "bar 3 of 8 = " + std::to_string(halfway).substr(0, 5) + " of 1.5");
        check(after == atEndOfRamp && after > 1.49f,
              "and holds its last value afterwards", std::to_string(after).substr(0, 5));

        // Sub-bar ramps: a swell over a quarter of a bar is a normal thing to want.
        Section tiny;
        tiny.bars = 4;
        AutoLane flick;
        flick.tracks = { 0 };
        flick.param = "gain";
        flick.points = { { 1.0, 0.0f }, { 1.25, 1.0f } };
        tiny.lanes.push_back(flick);
        check(std::abs(evaluate(song, tiny, 1.125).mixers[0].gain - 0.75f) < 0.01f,
              "a ramp can be a quarter of a bar long",
              std::to_string(evaluate(song, tiny, 1.125).mixers[0].gain).substr(0, 5));

        // One curve, several tracks.
        Section shared;
        shared.bars = 4;
        AutoLane group;
        group.tracks = { 0, 1, 2 };
        group.param = "cutoff";
        group.points = { { 0.0, 0.0f }, { 4.0, 1.0f } };
        shared.lanes.push_back(group);
        const auto driven = evaluate(song, shared, 4.0);
        check(driven.mixers[0].filterCutoff > 19000.0f && driven.mixers[1].filterCutoff > 19000.0f
                  && driven.mixers[2].filterCutoff > 19000.0f,
              "one curve drives every track selected for it",
              "3 tracks at " + std::to_string(int(driven.mixers[0].filterCutoff)) + " Hz");
        check(std::abs(driven.mixers[3].filterCutoff
                       - song.tracks[3].mixer.filterCutoff) < 0.01f,
              "and leaves the ones that are not", "");

        // A lane pointing at a track that no longer exists must not crash.
        Section stale;
        AutoLane ghost;
        ghost.tracks = { 99 };
        ghost.param = "gain";
        ghost.points = { { 0.0, 1.0f } };
        stale.lanes.push_back(ghost);
        const auto survived = evaluate(song, stale, 0.0);
        check(survived.mixers.size() == song.tracks.size(),
              "a lane on a deleted track is ignored rather than fatal", "");
    }
    {
        // The transport, rendered. A section that silences a track must
        // actually silence it, and the next section must bring it back.
        constexpr double SR = 48000.0;
        const int blockSize = 256;

        Song song = makeDefaultSong();
        song.bpm = 120.0;                      // one bar = 2 seconds at 4/4
        song.songMode = true;

        Scene loud;
        loud.name = "Loud";
        loud.patterns.assign(song.tracks.size(), 0);
        Scene quiet;
        quiet.name = "Quiet";
        quiet.patterns.assign(song.tracks.size(), -1);   // nothing plays
        quiet.patterns[0] = 0;                            // except the kick
        song.scenes = { loud, quiet };

        song.arrangement = { Section{ 0, 1, {} }, Section{ 1, 1, {} } };

        Engine engine;
        engine.prepare(SR, blockSize);
        engine.setSong(song);
        engine.rewindSong();
        engine.setPlaying(true);

        auto renderBars = [&](double bars) {
            const int samples = int(bars * 4.0 * (60.0 / song.bpm) * SR);
            std::vector<float> l(size_t(blockSize), 0.0f), r(size_t(blockSize), 0.0f);
            float peak = 0.0f;
            for (int done = 0; done < samples; done += blockSize) {
                engine.render(l.data(), r.data(), blockSize);
                for (int i = 0; i < blockSize; ++i) peak = std::max(peak, std::abs(l[i]));
            }
            return peak;
        };

        const float first = renderBars(0.9);
        check(first > 0.02f, "the arrangement plays", "peak " + std::to_string(first).substr(0, 5));
        check(engine.currentSection() == 0, "starting in the first section",
              "section " + std::to_string(engine.currentSection()));

        renderBars(0.3);                        // over the boundary
        check(engine.currentSection() == 1, "and moving into the next on time",
              "section " + std::to_string(engine.currentSection()) + " at bar "
                  + std::to_string(engine.songBar()).substr(0, 4));

        // Back round to the top rather than running off the end.
        renderBars(1.0);
        check(engine.currentSection() == 0, "then looping back to the top",
              "section " + std::to_string(engine.currentSection()));
    }

    // --- the project format ------------------------------------------------
    //
    // A save format is where work quietly goes missing: a field that is written
    // but not read, or read into the wrong place, looks fine until the day
    // someone reopens something they care about. So this compares a song with
    // itself after a full trip through text.
    std::printf("\nProject round trip:\n");
    {
        Song song = makeDefaultSong();

        // Move things off their defaults first. Round-tripping a song that is
        // entirely default would pass even if nothing were saved at all.
        song.name = "Round Trip";
        song.bpm = 137.5;
        song.swing = 0.42;
        song.key.root = 7;
        song.barsPerLoop = 4;
        song.master.reverb.mix = 0.31f;
        song.master.delay.beats = 0.375f;
        song.tracks[0].name = "Thump";
        song.tracks[0].colour = 0xff123456;
        song.tracks[0].mixer.pan = -0.4f;
        song.tracks[0].instrument.drum.tune = 41.5f;
        song.tracks[0].instrument.drum.snap = 0.13f;
        song.tracks[4].instrument.synth.cutoff = 830.0f;
        song.tracks[4].instrument.synth.ampRelease = 1.25f;
        song.tracks[4].instrument.synth.engine = SynthEngine::FM;
        song.tracks[4].patterns[0].steps[3].on = true;
        song.tracks[4].patterns[0].steps[3].degree = 4;
        song.tracks[4].patterns[0].steps[3].ratchet = 3;
        song.tracks[4].patterns[0].steps[3].nudge = -0.25f;
        song.tracks[4].patterns[0].steps[3].cond.type = TrigCondition::Type::Ratio;
        song.tracks[4].patterns[0].steps[3].cond.hit = 2;
        song.tracks[4].patterns[0].steps[3].cond.of = 3;

        const std::string text = songToJson(song);
        Song back;
        std::string err;
        const bool ok = songFromJson(text, back, err);
        check(ok, "a saved song loads again", err);

        check(back.tracks.size() == song.tracks.size(), "every track survives",
              std::to_string(back.tracks.size()) + " tracks");
        check(std::abs(back.bpm - song.bpm) < 1e-6 && back.barsPerLoop == song.barsPerLoop
                  && back.key.root == song.key.root && std::abs(back.swing - song.swing) < 1e-6,
              "tempo, key and loop length survive",
              std::to_string(back.bpm).substr(0, 5) + " bpm");
        check(back.name == "Round Trip" && back.tracks[0].name == "Thump"
                  && back.tracks[0].colour == 0xff123456,
              "names and colours survive", back.tracks[0].name);
        check(std::abs(back.master.reverb.mix - 0.31f) < 1e-4
                  && std::abs(back.master.delay.beats - 0.375f) < 1e-4,
              "master effects survive", "");

        // Instrument parameters go through the shared table; if that link
        // breaks, every sound in every saved project reverts to default.
        check(std::abs(back.tracks[0].instrument.drum.tune - 41.5f) < 0.05f
                  && std::abs(back.tracks[0].instrument.drum.snap - 0.13f) < 1e-3,
              "drum parameters survive",
              std::to_string(back.tracks[0].instrument.drum.tune).substr(0, 5) + " Hz");
        check(back.tracks[4].instrument.synth.engine == SynthEngine::FM
                  && std::abs(back.tracks[4].instrument.synth.cutoff - 830.0f) < 1.0f
                  && std::abs(back.tracks[4].instrument.synth.ampRelease - 1.25f) < 1e-3,
              "synth parameters survive",
              std::to_string(back.tracks[4].instrument.synth.cutoff).substr(0, 6) + " Hz");

        const Step& s = back.tracks[4].patterns[0].steps[3];
        check(s.on && s.degree == 4 && s.ratchet == 3 && std::abs(s.nudge + 0.25f) < 1e-4
                  && s.cond.type == TrigCondition::Type::Ratio && s.cond.hit == 2 && s.cond.of == 3,
              "step detail survives, conditions included",
              "deg " + std::to_string(s.degree) + ", ratchet " + std::to_string(s.ratchet));

        // Twice through must be identical to once through. If it is not, some
        // field is being transformed on the way in or out.
        check(songToJson(back) == text, "a second round trip changes nothing", "");
    }
    {
        // What happens to files that are not ours matters as much as ours.
        Song out = makeDefaultSong();
        std::string err;
        check(!songFromJson("not json at all", out, err), "rubbish is refused", err);
        check(!songFromJson("{\"tracks\":[]}", out, err), "an empty song is refused", err);
        check(out.tracks.size() == 6, "a refused load leaves the song alone",
              std::to_string(out.tracks.size()) + " tracks still there");

        // A file from an older version is missing whatever came later. Those
        // fields must come back as their defaults, not as zero.
        Song old;
        err.clear();
        const bool loaded = songFromJson(
            R"({"tracks":[{"name":"Old","patterns":[{"length":16}]}]})", old, err);
        check(loaded && old.tracks.size() == 1, "a sparse file still loads",
              loaded ? old.tracks[0].name : err);
        check(loaded && std::abs(old.bpm - Song{}.bpm) < 1e-9
                  && std::abs(old.tracks[0].mixer.gain - Mixer{}.gain) < 1e-9,
              "missing fields keep their defaults",
              "bpm " + std::to_string(old.bpm).substr(0, 5));
    }
    {
        // Project names reach the filesystem, so they are not allowed to point
        // anywhere but the projects directory.
        check(sanitiseProjectName("../../etc/passwd") == "etcpasswd",
              "traversal is stripped from project names",
              sanitiseProjectName("../../etc/passwd"));
        check(sanitiseProjectName("C:\\Windows\\evil") == "CWindowsevil",
              "so are drive letters and separators",
              sanitiseProjectName("C:\\Windows\\evil"));
        check(sanitiseProjectName("   ").empty(), "a name of only spaces is rejected", "");
        check(sanitiseProjectName("My Track_2 - final") == "My Track_2 - final",
              "ordinary names are left alone", sanitiseProjectName("My Track_2 - final"));
    }

    std::printf("\n%d checks, %d failures\n\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
