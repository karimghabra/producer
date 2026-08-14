#include "net/Bridge.h"

#include <httplib.h>

#include <cmath>
#include <sstream>

#include <algorithm>
#include <mutex>

#include "audio/Engine.h"
#include "music/Params.h"
#include "music/Presets.h"
#include "music/Song.h"

namespace motif {
namespace {

/** Minimal JSON escaping. Track names are the only free text that reaches it. */
std::string esc(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) { /* drop control chars */ }
                else out += c;
        }
    }
    return out;
}

std::string num(double v, int decimals = 4) {
    if (!std::isfinite(v)) return "0";
    std::ostringstream o;
    o.precision(decimals);
    o << std::fixed << v;
    std::string s = o.str();
    // Trim trailing zeros so the payload stays small at 30 reads a second.
    if (s.find('.') != std::string::npos) {
        while (!s.empty() && s.back() == '0') s.pop_back();
        if (!s.empty() && s.back() == '.') s.pop_back();
    }
    return s.empty() ? "0" : s;
}

/**
 * Colours handed to new tracks, in order.
 *
 * Chosen to stay distinguishable against the dark background and from each
 * other, since a track's colour is how it is identified everywhere else in the
 * interface - the rail, the step grid, the mixer strip, the keyboard.
 */
constexpr uint32_t kTrackColours[] = {
    0xffff5c7a,   // rose
    0xffffb86b,   // amber
    0xff5ee6c5,   // mint
    0xffffd479,   // gold
    0xffc77dff,   // violet
    0xff6ba8ff,   // blue
    0xff8fe36b,   // green
    0xffff8fd4,   // pink
};
constexpr size_t kTrackColourCount = sizeof(kTrackColours) / sizeof(kTrackColours[0]);

/** Pull a value out of a flat JSON object without dragging in a parser. */
bool field(const std::string& body, const std::string& key, std::string& out) {
    const std::string needle = "\"" + key + "\"";
    auto pos = body.find(needle);
    if (pos == std::string::npos) return false;
    pos = body.find(':', pos + needle.size());
    if (pos == std::string::npos) return false;
    ++pos;
    while (pos < body.size() && std::isspace(static_cast<unsigned char>(body[pos]))) ++pos;
    if (pos >= body.size()) return false;

    if (body[pos] == '"') {
        const auto end = body.find('"', pos + 1);
        if (end == std::string::npos) return false;
        out = body.substr(pos + 1, end - pos - 1);
        return true;
    }
    const auto end = body.find_first_of(",}", pos);
    out = body.substr(pos, (end == std::string::npos ? body.size() : end) - pos);
    while (!out.empty() && std::isspace(static_cast<unsigned char>(out.back()))) out.pop_back();
    return !out.empty();
}

double numField(const std::string& body, const std::string& key, double fallback = 0.0) {
    std::string s;
    if (!field(body, key, s)) return fallback;
    try { return std::stod(s); } catch (...) { return fallback; }
}

int intField(const std::string& body, const std::string& key, int fallback = 0) {
    return int(std::lround(numField(body, key, double(fallback))));
}

} // namespace

// ---------------------------------------------------------------------------

Bridge::Bridge(Engine& engine) : engine_(engine) {}

Bridge::~Bridge() { stop(); }

std::string Bridge::stateJson() const {
    const Song song = engine_.song();
    std::ostringstream j;

    j << "{\"bpm\":" << num(song.bpm)
      << ",\"swing\":" << num(song.swing)
      << ",\"beatsPerBar\":" << song.beatsPerBar
      << ",\"barsPerLoop\":" << song.barsPerLoop
      << ",\"playing\":" << (engine_.playing() ? "true" : "false")
      << ",\"recording\":" << (engine_.recording() ? "true" : "false")
      << ",\"positionBeats\":" << num(engine_.positionBeats())
      << ",\"peak\":" << num(engine_.outputPeak())
      << ",\"reduction\":" << num(engine_.limiterReduction())
      << ",\"cycle\":" << song.polymeterCycle()
      << ",\"sidechainSource\":" << song.sidechainSource
      << ",\"key\":{\"root\":" << song.key.root
      << ",\"scale\":\"" << esc(theory::scaleName(song.key.scale)) << "\"}"
      << ",\"master\":{"
      << "\"gain\":" << num(song.master.gain)
      << ",\"drive\":" << num(song.master.drive)
      << ",\"limiter\":" << (song.master.limiter ? "true" : "false")
      << ",\"reverb\":{\"size\":" << num(song.master.reverb.size)
      << ",\"damp\":" << num(song.master.reverb.damp)
      << ",\"width\":" << num(song.master.reverb.width)
      << ",\"mix\":" << num(song.master.reverb.mix) << "}"
      << ",\"delay\":{\"beats\":" << num(song.master.delay.beats)
      << ",\"feedback\":" << num(song.master.delay.feedback)
      << ",\"tone\":" << num(song.master.delay.tone, 1)
      << ",\"pingpong\":" << num(song.master.delay.pingpong)
      << ",\"mix\":" << num(song.master.delay.mix) << "}}"
      << ",\"tracks\":[";

    for (size_t i = 0; i < song.tracks.size(); ++i) {
        const Track& t = song.tracks[i];
        if (i) j << ',';
        j << "{\"name\":\"" << esc(t.name) << "\""
          << ",\"colour\":" << t.colour
          << ",\"armed\":" << (t.armed ? "true" : "false")
          << ",\"seqEnabled\":" << (t.seqEnabled ? "true" : "false")
          << ",\"isDrum\":" << (t.instrument.isDrum ? "true" : "false")
          << ",\"engine\":\""
          << esc(t.instrument.isDrum ? drumEngineName(t.instrument.drumEngine)
                                     : synthEngineName(t.instrument.synth.engine))
          << "\""
          << ",\"step\":" << engine_.trackStep(int(i))
          << ",\"mixer\":{\"gain\":" << num(t.mixer.gain)
          << ",\"pan\":" << num(t.mixer.pan)
          << ",\"mute\":" << (t.mixer.mute ? "true" : "false")
          << ",\"solo\":" << (t.mixer.solo ? "true" : "false")
          << ",\"reverb\":" << num(t.mixer.reverbSend)
          << ",\"delay\":" << num(t.mixer.delaySend)
          << ",\"duck\":" << num(t.mixer.duck) << "}"
          << ",\"activePattern\":" << t.activePattern
          << ",\"patterns\":[";

        for (size_t p = 0; p < t.patterns.size(); ++p) {
            const Pattern& pat = t.patterns[p];
            if (p) j << ',';
            j << "{\"name\":\"" << esc(pat.name) << "\""
              << ",\"length\":" << pat.length
              << ",\"resolution\":" << pat.resolution
              << ",\"euclid\":" << (pat.euclidMode ? "true" : "false")
              << ",\"pulses\":" << pat.euclidPulses
              << ",\"rotation\":" << pat.euclidRotation
              << ",\"steps\":[";
            for (int s = 0; s < pat.length; ++s) {
                if (s) j << ',';
                const Step& st = pat.steps[size_t(s)];
                j << "{\"on\":" << (pat.stepOn(s) ? "true" : "false")
                  << ",\"vel\":" << num(st.velocity, 3)
                  << ",\"deg\":" << st.degree
                  << ",\"oct\":" << st.octave
                  << ",\"len\":" << st.length
                  << ",\"ratchet\":" << st.ratchet
                  << ",\"nudge\":" << num(st.nudge, 3)
                  << ",\"accent\":" << (st.accent ? "true" : "false")
                  << ",\"cond\":" << int(st.cond.type)
                  << "}";
            }
            j << "]}";
        }
        j << "]}";
    }
    j << "]";

    // What the fitter concluded from the last take.
    //
    // Sent so the interface can show its reasoning rather than silently moving
    // the notes: the tempo it heard, the subdivision it decided you were
    // playing in, how much shuffle was in your hands, and how tightly the
    // playing actually clustered on that grid. Low confidence is worth seeing -
    // it means the grid is a guess.
    {
        std::lock_guard<std::mutex> lock(takeMutex_);
        j << ",\"take\":{\"notes\":" << take_.fitted.size()
          << ",\"rev\":" << takeRev_
          << ",\"strength\":" << num(fitOptions_.strength, 2)
          << ",\"keepSwing\":" << (fitOptions_.keepSwing ? "true" : "false");
        if (!take_.fitted.empty()) {
            // Mean absolute correction, in milliseconds: how far the fit had to
            // move the performance to make it line up.
            double moved = 0.0;
            for (const auto& n : take_.fitted) moved += std::abs(n.movedBeats);
            moved = moved / double(take_.fitted.size()) * 60000.0 / std::max(1.0, take_.fit.bpm);

            j << ",\"bpm\":" << num(take_.fit.bpm, 1)
              << ",\"subdivision\":" << take_.fit.subdivision
              << ",\"bars\":" << take_.fit.bars
              << ",\"confidence\":" << num(take_.fit.confidence, 3)
              << ",\"swing\":" << num(take_.fit.swing, 3)
              << ",\"fellBack\":" << (take_.fit.fellBack ? "true" : "false")
              << ",\"movedMs\":" << num(moved, 1);
        }
        j << "}";
    }

    j << "}";
    return j.str();
}

void Bridge::commitTake() {
    FitOptions opts;
    { std::lock_guard<std::mutex> lock(takeMutex_); opts = fitOptions_; }

    // Fit against the tempo already set, unless the session has not really
    // started. Playing over a running loop means the loop is the reference; the
    // performance should join it rather than redefine it.
    const Song current = engine_.song();
    const bool overExisting = engine_.playing();
    if (overExisting) opts.lockedBpm = current.bpm;
    opts.bpmPrior = current.bpm;
    opts.beatsPerBar = current.beatsPerBar;

    Take take = engine_.finishRecording(opts);

    {
        std::lock_guard<std::mutex> lock(takeMutex_);
        take_ = take;
        fitOptions_ = opts;
        takeTrack_ = takePattern_ = -1;
        ++takeRev_;
    }
    if (take.fitted.empty()) return;

    // Only take the tempo from the performance when it was confidently the
    // thing setting it. A scattered take would otherwise drag the whole song
    // to whatever the search happened to land on.
    installTake(take, !overExisting && take.fit.confidence > 0.5);
    engine_.setPlaying(true);
}

void Bridge::installTake(const Take& take, bool adoptTempo) {
    int armed = -1;
    const Song snapshot = engine_.song();
    for (size_t i = 0; i < snapshot.tracks.size(); ++i)
        if (snapshot.tracks[i].armed) { armed = int(i); break; }
    if (armed < 0) armed = 0;

    int patternIndex = -1;
    engine_.editSong([&](Song& s) {
        if (armed >= int(s.tracks.size())) return;
        Track& t = s.tracks[size_t(armed)];
        Pattern p = patternFromTake(take, s.key, !t.instrument.isDrum);
        p.name = "Take";
        t.patterns.push_back(std::move(p));
        patternIndex = int(t.patterns.size()) - 1;
        t.activePattern = patternIndex;
        t.seqEnabled = true;
        if (adoptTempo) { s.bpm = take.fit.bpm; s.barsPerLoop = take.fit.bars; }
    });

    std::lock_guard<std::mutex> lock(takeMutex_);
    takeTrack_ = armed;
    takePattern_ = patternIndex;
}

void Bridge::refitTake() {
    std::vector<RawNote> raw;
    FitOptions opts;
    int track, pattern;
    {
        std::lock_guard<std::mutex> lock(takeMutex_);
        raw = take_.raw;
        opts = fitOptions_;
        track = takeTrack_;
        pattern = takePattern_;
    }
    if (raw.empty()) return;

    Take refitted = fitTake(raw, opts);
    { std::lock_guard<std::mutex> lock(takeMutex_); take_ = refitted; ++takeRev_; }
    if (track < 0 || pattern < 0) return;

    // Replace in place rather than appending, so dragging the strength slider
    // does not leave a trail of patterns behind it.
    engine_.editSong([&](Song& s) {
        if (track >= int(s.tracks.size())) return;
        Track& t = s.tracks[size_t(track)];
        if (pattern >= int(t.patterns.size())) return;
        Pattern p = patternFromTake(refitted, s.key, !t.instrument.isDrum);
        p.name = "Take";
        t.patterns[size_t(pattern)] = std::move(p);
    });
}

std::string Bridge::takeJson() const {
    std::lock_guard<std::mutex> lock(takeMutex_);
    std::ostringstream j;
    j << "{\"rev\":" << takeRev_
      << ",\"loopBeats\":" << num(take_.beatsPerLoop(), 3)
      << ",\"notes\":[";

    // Both positions for every note, in beats: where it was played and where
    // the fit put it. Same order, same length - applyFit never reorders or
    // drops, which is what makes drawing one against the other meaningful.
    const double secToBeats = std::max(1.0, take_.fit.bpm) / 60.0;
    for (size_t i = 0; i < take_.fitted.size(); ++i) {
        const auto& f = take_.fitted[i];
        if (i) j << ',';
        const double playedBeats = i < take_.raw.size()
            ? (take_.raw[i].startSec - take_.fit.phaseSec) * secToBeats
            : f.startBeats;
        j << "{\"played\":" << num(playedBeats, 4)
          << ",\"fitted\":" << num(f.startBeats, 4)
          << ",\"len\":" << num(f.lengthBeats, 3)
          << ",\"pitch\":" << f.pitch
          << ",\"vel\":" << num(f.velocity, 3) << "}";
    }
    j << "]}";
    return j.str();
}

bool Bridge::applyCommand(const std::string& body, std::string& error) {
    std::string type;
    if (!field(body, "type", type)) { error = "missing type"; return false; }

    const int track = intField(body, "track", -1);
    const double value = numField(body, "value", 0.0);

    auto onTrack = [&](auto fn) {
        engine_.editSong([&](Song& s) {
            if (track >= 0 && track < int(s.tracks.size())) fn(s.tracks[size_t(track)], s);
        });
    };

    if (type == "play")      { engine_.setPlaying(true);  return true; }
    if (type == "stop")      { engine_.setPlaying(false); return true; }

    // One button, two meanings: arm, then commit. Pressing record a second time
    // is what ends the take, and ending the take is what fits it.
    if (type == "record") {
        if (engine_.recording()) commitTake();
        else                     engine_.armRecording();
        return true;
    }

    // Re-fit without replaying. The take is kept raw, so strength can be pulled
    // back to hear the performance between where it was played and where the
    // grid says it belongs.
    if (type == "fitStrength") {
        { std::lock_guard<std::mutex> lock(takeMutex_);
          fitOptions_.strength = std::clamp(value, 0.0, 1.0); }
        refitTake();
        return true;
    }
    if (type == "fitSwing") {
        { std::lock_guard<std::mutex> lock(takeMutex_);
          fitOptions_.keepSwing = value > 0.5; }
        refitTake();
        return true;
    }
    if (type == "clearTake") {
        std::lock_guard<std::mutex> lock(takeMutex_);
        take_ = {};
        takeTrack_ = takePattern_ = -1;
        return true;
    }

    if (type == "noteOn")    { engine_.noteOn(intField(body, "note", 60), float(numField(body, "velocity", 0.85))); return true; }
    if (type == "noteOff")   { engine_.noteOff(intField(body, "note", 60)); return true; }
    if (type == "audition")  { engine_.auditionTrack(track, intField(body, "note", 60), 0.95f); return true; }

    if (type == "bpm")   { engine_.editSong([&](Song& s) { s.bpm = std::clamp(value, 40.0, 240.0); }); return true; }
    if (type == "swing") { engine_.editSong([&](Song& s) { s.swing = std::clamp(value, 0.0, 1.0); }); return true; }

    if (type == "selectTrack") {
        engine_.editSong([&](Song& s) {
            for (size_t i = 0; i < s.tracks.size(); ++i) s.tracks[i].armed = (int(i) == track);
        });
        return true;
    }
    if (type == "mute")  { onTrack([&](Track& t, Song&) { t.mixer.mute = value > 0.5; }); return true; }
    if (type == "solo")  { onTrack([&](Track& t, Song&) { t.mixer.solo = value > 0.5; }); return true; }
    if (type == "gain")  { onTrack([&](Track& t, Song&) { t.mixer.gain = float(std::clamp(value, 0.0, 1.5)); }); return true; }
    if (type == "pan")   { onTrack([&](Track& t, Song&) { t.mixer.pan = float(std::clamp(value, -1.0, 1.0)); }); return true; }
    if (type == "send")  {
        std::string which;
        field(body, "which", which);
        onTrack([&](Track& t, Song&) {
            const float v = float(std::clamp(value, 0.0, 1.0));
            if (which == "delay") t.mixer.delaySend = v;
            else if (which == "duck") t.mixer.duck = v;
            else t.mixer.reverbSend = v;
        });
        return true;
    }

    if (type == "toggleStep") {
        const int step = intField(body, "step", -1);
        onTrack([&](Track& t, Song&) {
            if (auto* p = t.current())
                if (step >= 0 && step < int(p->steps.size()))
                    p->steps[size_t(step)].on = !p->steps[size_t(step)].on;
        });
        return true;
    }
    if (type == "selectPattern") {
        const int index = intField(body, "index", 0);
        onTrack([&](Track& t, Song&) { t.activePattern = std::clamp(index, 0, int(t.patterns.size()) - 1); });
        return true;
    }
    // --- track manager ----------------------------------------------------

    if (type == "newSong") {
        engine_.setSong(makeDefaultSong());
        { std::lock_guard<std::mutex> lock(takeMutex_);
          take_ = {}; takeTrack_ = takePattern_ = -1; ++takeRev_; }
        return true;
    }

    if (type == "addTrack") {
        std::string kind;
        field(body, "kind", kind);
        const bool drum = kind != "synth";
        engine_.editSong([&](Song& s) {
            if (int(s.tracks.size()) >= Engine::kMaxTracks) return;
            Track t;
            t.name = drum ? "Drum" : "Synth";
            t.instrument.isDrum = drum;
            t.colour = kTrackColours[s.tracks.size() % kTrackColourCount];
            // A new track starts silent rather than repeating whatever the
            // default pattern happens to be - it is yours to fill in.
            t.patterns.assign(1, Pattern{});
            for (auto& st : t.patterns[0].steps) st.on = false;
            // Arm it: adding a track is how you say what you want to play next.
            for (auto& other : s.tracks) other.armed = false;
            t.armed = true;
            s.tracks.push_back(std::move(t));
        });
        return true;
    }

    if (type == "removeTrack") {
        engine_.editSong([&](Song& s) {
            if (track < 0 || track >= int(s.tracks.size())) return;
            // Never leave the song with nothing in it; there would be no way
            // back to a playable state from the interface.
            if (s.tracks.size() <= 1) return;
            const bool wasArmed = s.tracks[size_t(track)].armed;
            s.tracks.erase(s.tracks.begin() + track);
            if (s.sidechainSource == track) s.sidechainSource = -1;
            else if (s.sidechainSource > track) --s.sidechainSource;
            if (wasArmed) s.tracks[size_t(std::min<size_t>(size_t(track), s.tracks.size() - 1))].armed = true;
        });
        return true;
    }

    if (type == "duplicateTrack") {
        engine_.editSong([&](Song& s) {
            if (track < 0 || track >= int(s.tracks.size())) return;
            if (int(s.tracks.size()) >= Engine::kMaxTracks) return;
            Track copy = s.tracks[size_t(track)];
            copy.name += " 2";
            copy.mixer.solo = false;
            for (auto& t : s.tracks) t.armed = false;
            copy.armed = true;
            s.tracks.insert(s.tracks.begin() + track + 1, std::move(copy));
        });
        return true;
    }

    if (type == "renameTrack") {
        std::string name;
        if (!field(body, "name", name)) { error = "missing name"; return false; }
        if (name.size() > 24) name.resize(24);
        onTrack([&](Track& t, Song&) { if (!name.empty()) t.name = name; });
        return true;
    }

    if (type == "moveTrack") {
        const int to = intField(body, "to", -1);
        engine_.editSong([&](Song& s) {
            const int n = int(s.tracks.size());
            if (track < 0 || track >= n || to < 0 || to >= n || to == track) return;
            Track moved = std::move(s.tracks[size_t(track)]);
            s.tracks.erase(s.tracks.begin() + track);
            s.tracks.insert(s.tracks.begin() + to, std::move(moved));
        });
        return true;
    }

    if (type == "trackColour") {
        onTrack([&](Track& t, Song&) {
            t.colour = 0xff000000u | (uint32_t(intField(body, "colour", 0x5ee6c5)) & 0xffffffu);
        });
        return true;
    }

    if (type == "seqEnabled") { onTrack([&](Track& t, Song&) { t.seqEnabled = value > 0.5; }); return true; }

    if (type == "sidechainSource") {
        engine_.editSong([&](Song& s) {
            s.sidechainSource = (track >= -1 && track < int(s.tracks.size())) ? track : -1;
        });
        return true;
    }

    // --- patterns ---------------------------------------------------------

    if (type == "addPattern") {
        onTrack([&](Track& t, Song&) {
            if (t.patterns.size() >= 16) return;
            Pattern p;
            for (auto& st : p.steps) st.on = false;
            p.name = "Pat " + std::to_string(t.patterns.size() + 1);
            t.patterns.push_back(std::move(p));
            t.activePattern = int(t.patterns.size()) - 1;
        });
        return true;
    }
    if (type == "duplicatePattern") {
        onTrack([&](Track& t, Song&) {
            if (t.patterns.empty() || t.patterns.size() >= 16) return;
            const int i = std::clamp(t.activePattern, 0, int(t.patterns.size()) - 1);
            Pattern copy = t.patterns[size_t(i)];
            copy.name = "Pat " + std::to_string(t.patterns.size() + 1);
            t.patterns.insert(t.patterns.begin() + i + 1, std::move(copy));
            t.activePattern = i + 1;
        });
        return true;
    }
    if (type == "removePattern") {
        const int index = intField(body, "index", -1);
        onTrack([&](Track& t, Song&) {
            if (t.patterns.size() <= 1) return;    // a track must have one
            if (index < 0 || index >= int(t.patterns.size())) return;
            t.patterns.erase(t.patterns.begin() + index);
            t.activePattern = std::clamp(t.activePattern, 0, int(t.patterns.size()) - 1);
        });
        return true;
    }
    if (type == "clearPattern") {
        onTrack([&](Track& t, Song&) {
            if (auto* p = t.current()) { for (auto& st : p->steps) st.on = false; p->euclidMode = false; }
        });
        return true;
    }

    // --- sound design -----------------------------------------------------

    // Set by id and normalised position. The interface never needs to know a
    // parameter's real range or curve - the table owns both, so a control
     // cannot disagree with the engine about what it is editing.
    if (type == "param") {
        std::string id;
        if (!field(body, "id", id)) { error = "missing id"; return false; }
        bool found = false;
        onTrack([&](Track& t, Song&) {
            if (const ParamSpec* spec = findParam(t, id)) {
                spec->set(t, float(spec->fromNorm(value)));
                found = true;
            }
        });
        if (!found) { error = "unknown parameter: " + id; return false; }
        return true;
    }

    if (type == "resetSound") {
        onTrack([&](Track& t, Song&) {
            // Default-construct just the instrument, keeping the track's name,
            // colour, patterns and mixer settings intact.
            const bool drum = t.instrument.isDrum;
            const DrumEngine de = t.instrument.drumEngine;
            const SynthEngine se = t.instrument.synth.engine;
            t.instrument = Instrument{};
            t.instrument.isDrum = drum;
            t.instrument.drumEngine = de;
            t.instrument.synth.engine = se;
        });
        return true;
    }

    if (type == "preset") {
        std::string name;
        if (!field(body, "name", name)) { error = "missing name"; return false; }
        onTrack([&](Track& t, Song&) {
            for (const auto& p : drumPresets()) if (p.name == name) { applyDrumPreset(t, p); return; }
            for (const auto& p : synthPresets()) if (p.name == name) { applySynthPreset(t, p); return; }
        });
        return true;
    }

    error = "unknown command: " + type;
    return false;
}

// ---------------------------------------------------------------------------

int Bridge::start(const std::string& webRoot, int preferredPort) {
    stop();

    server_ = std::make_unique<httplib::Server>();

    server_->set_mount_point("/", webRoot);

    // Never let the interface be cached.
    //
    // It is served from disk so it can be edited and reloaded without
    // rebuilding the engine, and a cached stylesheet quietly defeats that: the
    // app keeps showing the previous version and the edit looks like it did
    // nothing. Nothing here travels further than loopback, so there is no cost.
    server_->set_post_routing_handler(
        [](const httplib::Request&, httplib::Response& res) {
            res.set_header("Cache-Control", "no-store, must-revalidate");
        });

    server_->Get("/api/state", [this](const httplib::Request&, httplib::Response& res) {
        res.set_content(stateJson(), "application/json");
    });

    // Note-level detail of the last take, so the interface can draw where each
    // note was played against where it landed. Kept off /api/state because that
    // is polled twenty times a second and this changes only when you record.
    server_->Get("/api/take", [this](const httplib::Request&, httplib::Response& res) {
        res.set_content(takeJson(), "application/json");
    });

    // The editable parameters of the armed track, with their current values.
    //
    // Descriptions travel with them: the controls are meaningless without
    // knowing what they do, and hiding that in documentation nobody opens is
    // how a synth ends up used only through its presets.
    server_->Get("/api/params", [this](const httplib::Request& req, httplib::Response& res) {
        const Song song = engine_.song();
        int index = 0;
        if (req.has_param("track")) index = std::atoi(req.get_param_value("track").c_str());
        if (index < 0 || index >= int(song.tracks.size())) { res.set_content("[]", "application/json"); return; }

        const Track& t = song.tracks[size_t(index)];
        std::ostringstream j;
        j << '[';
        bool first = true;
        for (const auto& p : paramsFor(t)) {
            if (!first) j << ',';
            first = false;
            const double raw = p.get(t);
            j << "{\"id\":\"" << p.id << "\""
              << ",\"label\":\"" << esc(p.label) << "\""
              << ",\"norm\":" << num(p.toNorm(raw), 4)
              << ",\"value\":" << num(raw, 4)
              << ",\"min\":" << num(p.min, 4)
              << ",\"max\":" << num(p.max, 4)
              << ",\"unit\":\"" << esc(p.unit) << "\""
              << ",\"log\":" << (p.log ? "true" : "false")
              << ",\"help\":\"" << esc(p.help) << "\"";
            if (p.choices != nullptr) {
                j << ",\"choices\":[";
                for (int c = 0; c < p.choiceCount; ++c) {
                    if (c) j << ',';
                    j << '"' << esc(p.choices[c]) << '"';
                }
                j << ']';
            }
            j << '}';
        }
        j << ']';
        res.set_content(j.str(), "application/json");
    });

    server_->Get("/api/presets", [](const httplib::Request&, httplib::Response& res) {
        std::ostringstream j;
        j << "{\"drums\":[";
        const auto& drums = drumPresets();
        for (size_t i = 0; i < drums.size(); ++i) {
            if (i) j << ',';
            j << "{\"name\":\"" << esc(drums[i].name) << "\",\"blurb\":\"" << esc(drums[i].blurb)
              << "\",\"engine\":\"" << esc(drumEngineName(drums[i].engine)) << "\"}";
        }
        j << "],\"synths\":[";
        const auto& synths = synthPresets();
        for (size_t i = 0; i < synths.size(); ++i) {
            if (i) j << ',';
            j << "{\"name\":\"" << esc(synths[i].name) << "\",\"blurb\":\"" << esc(synths[i].blurb)
              << "\",\"engine\":\"" << esc(synthEngineName(synths[i].patch.engine)) << "\"}";
        }
        j << "]}";
        res.set_content(j.str(), "application/json");
    });

    server_->Post("/api/command", [this](const httplib::Request& req, httplib::Response& res) {
        std::string error;
        const bool ok = applyCommand(req.body, error);
        res.status = ok ? 200 : 400;
        res.set_content(ok ? "{\"ok\":true}" : "{\"ok\":false,\"error\":\"" + esc(error) + "\"}",
                        "application/json");
    });

    // Bind before listening, so the port is known up front.
    //
    // bind_to_port reports success, not the port it bound - it returns 1. Only
    // bind_to_any_port hands back a port number. Treating the former as a port
    // sends everything to http://127.0.0.1:1.
    if (server_->bind_to_port("127.0.0.1", preferredPort)) {
        port_ = preferredPort;
    } else {
        port_ = server_->bind_to_any_port("127.0.0.1");   // preferred port taken
    }
    if (port_ <= 0) { server_.reset(); return 0; }

    running_.store(true, std::memory_order_relaxed);
    thread_ = std::thread([this] {
        server_->listen_after_bind();
        running_.store(false, std::memory_order_relaxed);
    });
    return port_;
}

void Bridge::stop() {
    if (server_) server_->stop();
    if (thread_.joinable()) thread_.join();
    server_.reset();
    running_.store(false, std::memory_order_relaxed);
    port_ = 0;
}

} // namespace motif
