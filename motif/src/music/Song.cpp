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
    song.keymap = makeDefaultKeyMap(song);
    return song;
}

// ---------------------------------------------------------------------------
// The default mapping
// ---------------------------------------------------------------------------

KeyMap makeDefaultKeyMap(const Song& song) {
    KeyMap map;
    const int cols = KeyMap::kCols;

    auto findTrack = [&](std::initializer_list<const char*> names) {
        for (const char* want : names)
            for (size_t i = 0; i < song.tracks.size(); ++i)
                if (song.tracks[i].name == want) return int(i);
        return -1;
    };
    auto firstDrum = [&](int skip) {
        for (size_t i = 0; i < song.tracks.size(); ++i)
            if (song.tracks[i].instrument.isDrum && skip-- <= 0) return int(i);
        return -1;
    };
    auto firstPitched = [&](int skip) {
        for (size_t i = 0; i < song.tracks.size(); ++i)
            if (!song.tracks[i].instrument.isDrum && skip-- <= 0) return int(i);
        return -1;
    };

    const int kick  = findTrack({ "Kick" });
    const int clap  = findTrack({ "Clap" });
    const int hats  = findTrack({ "Hats", "Hat" });
    const int snare = findTrack({ "Snare" });
    const int bass  = findTrack({ "Bass" });
    const int lead  = findTrack({ "Lead" });

    auto put = [&](int layer, int index, Cell c) {
        if (Cell* slot = map.at(layer, index)) *slot = std::move(c);
    };
    auto nameOf = [&](int t) {
        return t >= 0 && t < int(song.tracks.size()) ? song.tracks[size_t(t)].name : std::string();
    };

    // --- layer 0: the kit ---------------------------------------------------
    //
    // Home row is the kit at full velocity, the row above it the same kit
    // softly. Two rows you can play a beat between without thinking about it.
    {
        const int kit[] = { kick, clap, hats, snare, kick, clap, hats, snare,
                            firstDrum(4), firstDrum(5) };
        for (int i = 0; i < cols; ++i) {
            const int t = kit[i] >= 0 ? kit[i] : firstDrum(i % 4);
            if (t < 0) continue;
            Cell c;
            c.mode = CellMode::Hit;
            c.track = t;
            c.velocity = i < 4 ? 0.95f : 0.85f;
            c.label = nameOf(t);
            put(0, 20 + i, c);

            Cell soft = c;
            soft.velocity = 0.5f;
            soft.label = nameOf(t) + " soft";
            put(0, 10 + i, soft);
        }
        // The bottom row plays the kick up the scale - a drum used as an
        // instrument, which is most of what a modern low end is.
        for (int i = 0; i < 6 && kick >= 0; ++i) {
            Cell c;
            c.mode = CellMode::Hit;
            c.track = kick;
            c.degree = i;
            c.velocity = 0.9f;
            c.label = "Kick " + std::to_string(i + 1);
            put(0, 30 + i, c);
        }
        // And the number row arms recording, so a take is one key away.
        for (int i = 0; i < 4; ++i) {
            const int t = firstPitched(i) >= 0 ? firstPitched(i) : firstDrum(i);
            if (t < 0) continue;
            Cell c;
            c.mode = CellMode::Record;
            c.track = t;
            c.behavior = CellBehavior::Toggle;
            c.label = "Rec " + nameOf(t);
            put(0, 6 + i, c);
        }
    }

    // --- layer 1: the scale -------------------------------------------------
    {
        const int melody = lead >= 0 ? lead : firstPitched(0);
        const int low = bass >= 0 ? bass : firstPitched(1);
        for (int i = 0; i < cols && melody >= 0; ++i) {
            Cell c;
            c.mode = CellMode::Note;
            c.track = melody;
            c.degree = i;
            c.behavior = CellBehavior::Gate;
            c.label = std::to_string(i + 1);
            put(1, 20 + i, c);

            Cell up = c;
            up.degree = i + 7;
            up.label = std::to_string(i + 8);
            put(1, 10 + i, up);
        }
        for (int i = 0; i < cols && low >= 0; ++i) {
            Cell c;
            c.mode = CellMode::Note;
            c.track = low;
            c.degree = i;
            c.octave = -1;
            c.behavior = CellBehavior::Gate;
            c.label = "B" + std::to_string(i + 1);
            put(1, 30 + i, c);
        }
        // Chords on the number row, built from the key rather than chosen -
        // you never pick a quality, the key decides it.
        const int chordTrack = melody >= 0 ? melody : low;
        for (int i = 0; i < 7 && chordTrack >= 0; ++i) {
            Cell c;
            c.mode = CellMode::Chord;
            c.track = chordTrack;
            c.degree = i;
            c.chordSize = 3;
            c.behavior = CellBehavior::Gate;
            c.label = "Chord " + std::to_string(i + 1);
            put(1, i, c);
        }
        if (chordTrack >= 0) {
            Cell seventh;
            seventh.mode = CellMode::Chord;
            seventh.track = chordTrack;
            seventh.chordSize = 4;
            seventh.behavior = CellBehavior::Gate;
            seventh.degree = 0; seventh.label = "I7";   put(1, 7, seventh);
            seventh.degree = 3; seventh.label = "IV7";  put(1, 8, seventh);
            seventh.degree = 4; seventh.chordSize = 5; seventh.label = "V9"; put(1, 9, seventh);
        }
    }

    // --- layer 2: clips -----------------------------------------------------
    //
    // A column per track: three pattern slots and a stop, quantized to the bar
    // so a launch lands on the downbeat rather than wherever your finger did.
    {
        const int columns = std::min(int(song.tracks.size()), cols - 2);
        for (int col = 0; col < columns; ++col) {
            for (int row = 0; row < 3; ++row) {
                Cell c;
                c.mode = CellMode::Pattern;
                c.track = col;
                c.patternIndex = row;
                c.quantize = Quantize::Bar;
                c.label = nameOf(col) + " " + std::to_string(row + 1);
                put(2, row * cols + col, c);
            }
            Cell stop;
            stop.mode = CellMode::Pattern;
            stop.track = col;
            stop.patternIndex = -1;
            stop.quantize = Quantize::Bar;
            stop.behavior = CellBehavior::Toggle;
            stop.label = "Stop " + nameOf(col);
            put(2, 3 * cols + col, stop);
        }
        // Scenes in the two spare columns, so they never take a track's stop.
        for (int i = 0; i < 8 && i < int(song.scenes.size()); ++i) {
            Cell c;
            c.mode = CellMode::Scene;
            c.scene = i;
            c.quantize = Quantize::Bar;
            c.label = song.scenes[size_t(i)].name;
            put(2, (i / 2) * cols + (cols - 2) + (i % 2), c);
        }
    }

    // --- layer 3: whatever is armed ----------------------------------------
    //
    // Two octaves of the current key on the armed track, so any new sound is
    // immediately playable without mapping anything.
    {
        int armed = 0;
        for (size_t i = 0; i < song.tracks.size(); ++i) if (song.tracks[i].armed) armed = int(i);
        for (int i = 0; i < cols; ++i) {
            Cell c;
            c.mode = CellMode::Note;
            c.track = armed;
            c.behavior = CellBehavior::Gate;
            c.degree = i;      c.label = std::to_string(i + 1);      put(3, 20 + i, c);
            c.degree = i + 7;  c.label = std::to_string(i + 8);      put(3, 10 + i, c);
            c.degree = i - 7;  c.label = std::to_string(i - 6);      put(3, 30 + i, c);
            c.degree = i + 14; c.label = std::to_string(i + 15);     put(3, i, c);
        }
        map.layerNames[3] = "ARMED";
    }

    return map;
}

// ---------------------------------------------------------------------------
// Track edits
// ---------------------------------------------------------------------------

namespace {

/** Remap every index that refers to a track, given where each one moved to. */
void remapTrackReferences(Song& song, const std::vector<int>& newIndexOf) {
    const int trackCount = int(song.tracks.size());

    for (auto& scene : song.scenes) {
        std::vector<int> rebuilt(size_t(trackCount), -1);
        for (size_t old = 0; old < newIndexOf.size() && old < scene.patterns.size(); ++old) {
            const int to = newIndexOf[old];
            if (to >= 0 && to < trackCount) rebuilt[size_t(to)] = scene.patterns[old];
        }
        // A track that arrived after this scene was kept plays nothing in it,
        // which is the honest answer: the scene never said anything about it.
        scene.patterns = std::move(rebuilt);
        for (size_t t = 0; t < scene.patterns.size(); ++t) {
            const int limit = int(song.tracks[t].patterns.size());
            if (scene.patterns[t] >= limit) scene.patterns[t] = limit ? limit - 1 : -1;
        }
    }

    for (auto& section : song.arrangement) {
        for (auto& lane : section.lanes) {
            std::vector<int> rebuilt;
            for (int old : lane.tracks) {
                if (old < 0 || old >= int(newIndexOf.size())) continue;
                const int to = newIndexOf[size_t(old)];
                if (to >= 0 && to < trackCount) rebuilt.push_back(to);
            }
            std::sort(rebuilt.begin(), rebuilt.end());
            rebuilt.erase(std::unique(rebuilt.begin(), rebuilt.end()), rebuilt.end());
            lane.tracks = std::move(rebuilt);
        }
    }

    if (song.sidechainSource >= 0 && song.sidechainSource < int(newIndexOf.size()))
        song.sidechainSource = newIndexOf[size_t(song.sidechainSource)];
    else if (song.sidechainSource >= int(newIndexOf.size()))
        song.sidechainSource = -1;
}

} // namespace

void addTrack(Song& song, Track track, int at) {
    const int count = int(song.tracks.size());
    const int where = (at < 0 || at > count) ? count : at;

    // Fill value, not just a size: vector<int> v(size_t(n)) declares a
    // function, and the errors it produces name everything but the cause.
    std::vector<int> newIndexOf(size_t(count), -1);
    for (int i = 0; i < count; ++i) newIndexOf[size_t(i)] = i < where ? i : i + 1;

    song.tracks.insert(song.tracks.begin() + where, std::move(track));
    remapTrackReferences(song, newIndexOf);
}

void removeTrack(Song& song, int index) {
    const int count = int(song.tracks.size());
    if (index < 0 || index >= count) return;
    // The song must always have something in it; there is no way back to a
    // playable state from an empty one.
    if (count <= 1) return;

    const bool wasArmed = song.tracks[size_t(index)].armed;
    song.tracks.erase(song.tracks.begin() + index);

    // Fill value, not just a size: vector<int> v(size_t(n)) declares a
    // function, and the errors it produces name everything but the cause.
    std::vector<int> newIndexOf(size_t(count), -1);
    for (int i = 0; i < count; ++i)
        newIndexOf[size_t(i)] = i == index ? -1 : (i < index ? i : i - 1);
    remapTrackReferences(song, newIndexOf);

    if (wasArmed) {
        const size_t next = std::min(size_t(index), song.tracks.size() - 1);
        for (auto& t : song.tracks) t.armed = false;
        song.tracks[next].armed = true;
    }
}

void moveTrack(Song& song, int from, int to) {
    const int count = int(song.tracks.size());
    if (from < 0 || from >= count || to < 0 || to >= count || from == to) return;

    Track moved = std::move(song.tracks[size_t(from)]);
    song.tracks.erase(song.tracks.begin() + from);
    song.tracks.insert(song.tracks.begin() + to, std::move(moved));

    // Fill value, not just a size: vector<int> v(size_t(n)) declares a
    // function, and the errors it produces name everything but the cause.
    std::vector<int> newIndexOf(size_t(count), -1);
    for (int i = 0; i < count; ++i) {
        if (i == from) newIndexOf[size_t(i)] = to;
        else if (from < to) newIndexOf[size_t(i)] = (i > from && i <= to) ? i - 1 : i;
        else               newIndexOf[size_t(i)] = (i >= to && i < from) ? i + 1 : i;
    }
    remapTrackReferences(song, newIndexOf);
}

} // namespace motif
