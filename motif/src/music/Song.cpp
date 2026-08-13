#include "music/Song.h"

#include <algorithm>
#include <cmath>

namespace motif {
namespace {

/**
 * Nearest scale degree for a MIDI note.
 *
 * Storing degrees rather than absolute pitches is what lets a part follow the
 * key when it changes. There is no closed form once a scale has uneven steps,
 * so search the plausible range and take the closest.
 */
int midiToDegree(const theory::Key& key, int midi, int& octaveOut) {
    int bestDegree = 0, bestOctave = 0, bestErr = 1000;
    for (int oct = -3; oct <= 3; ++oct) {
        for (int deg = -14; deg <= 21; ++deg) {
            const int candidate = theory::degreeToMidi(key, deg, oct);
            const int err = std::abs(candidate - midi);
            if (err < bestErr) { bestErr = err; bestDegree = deg; bestOctave = oct; }
            if (err == 0) { octaveOut = oct; return deg; }
        }
    }
    octaveOut = bestOctave;
    return bestDegree;
}

Pattern namedPattern(const char* name, int length, int resolution) {
    Pattern p;
    p.name = name;
    p.resolution = resolution;
    p.resize(length);
    return p;
}

/** Build a pattern from an "x..x..x." string. `X` accents, `o` is quiet. */
Pattern fromString(const char* name, const std::string& s, int resolution = 4) {
    Pattern p = namedPattern(name, int(s.size()), resolution);
    for (size_t i = 0; i < s.size(); ++i) {
        const char c = s[i];
        if (c == 'x' || c == 'X' || c == 'o') {
            p.steps[i].on = true;
            p.steps[i].accent = (c == 'X');
            p.steps[i].velocity = c == 'X' ? 1.0f : (c == 'o' ? 0.5f : 0.8f);
        }
    }
    return p;
}

Pattern fromDegrees(const char* name, const std::vector<int>& degrees, int octave = 0) {
    Pattern p = namedPattern(name, int(degrees.size()), 4);
    for (size_t i = 0; i < degrees.size(); ++i) {
        if (degrees[i] == -99) continue;      // rest
        p.steps[i].on = true;
        p.steps[i].degree = degrees[i];
        p.steps[i].octave = octave;
        p.steps[i].velocity = 0.85f;
    }
    return p;
}

constexpr int R = -99;   // rest, for the tables below

} // namespace

// ---------------------------------------------------------------------------

Pattern patternFromTake(const Take& take, const theory::Key& key, bool pitched) {
    Pattern p;
    p.name = "Take";
    p.resolution = std::max(1, take.fit.subdivision);
    p.euclidMode = false;

    const int totalSteps = std::max(1, take.fit.bars * take.fit.beatsPerBar * p.resolution);
    p.resize(totalSteps);

    for (const auto& note : take.fitted) {
        const int step = int(std::llround(note.startBeats * double(p.resolution)));
        if (step < 0 || step >= totalSteps) continue;

        Step& s = p.steps[size_t(step)];
        // A later note on the same step wins only if it was played harder,
        // which keeps a fumbled double-trigger from replacing the real note.
        if (s.on && s.velocity > note.velocity) continue;

        s.on = true;
        s.velocity = std::clamp(note.velocity, 0.05f, 1.0f);
        s.length = std::max(1, int(std::llround(note.lengthBeats * double(p.resolution))));

        if (pitched) {
            int octave = 0;
            s.degree = midiToDegree(key, note.pitch, octave);
            s.octave = octave;
        } else {
            // Drum tracks keep the offset from the kit's own root note.
            s.degree = 0;
            s.octave = 0;
        }
    }
    return p;
}

// ---------------------------------------------------------------------------

Song makeDefaultSong() {
    Song song;
    song.name = "Untitled";
    song.bpm = 124.0;
    song.swing = 0.10;
    song.key = { 9, theory::Scale::Minor };     // A minor
    song.beatsPerBar = 4;
    song.barsPerLoop = 2;

    auto drumTrack = [](const char* name, uint32_t colour, DrumEngine engine,
                        const DrumParams& params, std::vector<Pattern> patterns,
                        float gain, float duck) {
        Track t;
        t.name = name;
        t.colour = colour;
        t.instrument.isDrum = true;
        t.instrument.drumEngine = engine;
        t.instrument.drum = params;
        t.patterns = std::move(patterns);
        t.mixer.gain = gain;
        t.mixer.duck = duck;
        return t;
    };

    {
        DrumParams p; p.tune = 50; p.decay = 0.45f; p.pitchMod = 28; p.pitchTime = 0.035f;
        p.drive = 0.35f; p.cutoff = 8000; p.resonance = 0.7f; p.snap = 0.5f;
        song.tracks.push_back(drumTrack("Kick", 0xffff5c7a, DrumEngine::Kick, p, {
            fromString("Four",    "x...x...x...x..."),
            fromString("Broken",  "x...x..x..x.x..."),
            fromString("Half",    "x.......x......."),
        }, 1.0f, 0.0f));
    }
    {
        DrumParams p; p.tune = 1100; p.decay = 0.32f; p.noise = 1.0f;
        p.cutoff = 6500; p.resonance = 2.0f; p.drive = 0.15f;
        song.tracks.push_back(drumTrack("Clap", 0xffffd479, DrumEngine::Clap, p, {
            fromString("Backbeat", "....x.......x..."),
            fromString("Offbeat",  "....x......x.x.."),
        }, 0.8f, 0.25f));
    }
    {
        DrumParams p; p.tune = 320; p.decay = 0.055f; p.cutoff = 9000;
        p.resonance = 1.2f; p.drive = 0.15f;
        song.tracks.push_back(drumTrack("Hats", 0xff5ee6c5, DrumEngine::Hat, p, {
            fromString("Offbeat", "..x...x...x...x."),
            fromString("16ths",   "oxoxoxoxoxoxoxox"),
        }, 0.55f, 0.35f));
    }
    {
        DrumParams p; p.tune = 190; p.decay = 0.20f; p.noise = 0.7f;
        p.cutoff = 11000; p.snap = 0.7f; p.drive = 0.25f;
        song.tracks.push_back(drumTrack("Snare", 0xffffb86b, DrumEngine::Snare, p, {
            fromString("Ghost", "..........o....."),
            fromString("Rolls", "..............xx"),
        }, 0.5f, 0.3f));
    }

    {
        Track t;
        t.name = "Bass";
        t.colour = 0xffc77dff;
        t.instrument.isDrum = false;
        t.instrument.synth.wave = dsp::Wave::Saw;
        t.instrument.synth.unison = 3;
        t.instrument.synth.detune = 0.14f;
        t.instrument.synth.spread = 0.25f;
        t.instrument.synth.octave = -2;
        t.instrument.synth.sub = 0.5f;
        t.instrument.synth.cutoff = 620.0f;
        t.instrument.synth.resonance = 6.0f;
        t.instrument.synth.filterEnv = 1.8f;
        t.instrument.synth.ampDecay = 0.14f;
        t.instrument.synth.ampSustain = 0.85f;
        t.instrument.synth.ampRelease = 0.09f;
        t.instrument.synth.drive = 0.40f;
        t.patterns = {
            fromDegrees("Root", { 0, R, 0, 0, R, 0, R, 0, 0, R, 0, 0, R, 0, R, 0 }),
            fromDegrees("Walk", { 0, R, 0, 2, R, 0, R, 4, 0, R, 0, 3, R, 2, R, 0 }),
        };
        t.mixer.gain = 0.8f;
        t.mixer.duck = 0.6f;
        song.tracks.push_back(std::move(t));
    }

    {
        Track t;
        t.name = "Lead";
        t.colour = 0xff4cc9f0;
        t.instrument.isDrum = false;
        t.instrument.synth.unison = 7;
        t.instrument.synth.detune = 0.42f;
        t.instrument.synth.spread = 0.85f;
        t.instrument.synth.sub = 0.15f;
        t.instrument.synth.cutoff = 5200.0f;
        t.instrument.synth.resonance = 3.0f;
        t.instrument.synth.filterEnv = 2.2f;
        t.instrument.synth.ampDecay = 0.30f;
        t.instrument.synth.ampSustain = 0.60f;
        t.instrument.synth.ampRelease = 0.35f;
        t.patterns = {
            fromDegrees("Hook",  { 0, R, 2, R, 4, R, 2, R, 3, R, 2, R, 0, R, R, R }),
            fromDegrees("Stabs", { R, R, 4, R, R, R, 4, R, R, R, 5, R, R, R, 4, R }),
        };
        t.mixer.gain = 0.6f;
        t.mixer.reverbSend = 0.32f;
        t.mixer.delaySend = 0.26f;
        t.mixer.duck = 0.5f;
        t.armed = true;                 // what your keyboard plays by default
        song.tracks.push_back(std::move(t));
    }

    // A little space on the percussion, so the kit is not bone dry.
    song.tracks[1].mixer.reverbSend = 0.26f;   // clap
    song.tracks[3].mixer.reverbSend = 0.20f;   // snare

    song.sidechainSource = 0;           // the kick
    return song;
}

} // namespace motif
