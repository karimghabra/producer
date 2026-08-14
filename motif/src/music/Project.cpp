#include "music/Project.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>

#include "music/Params.h"

namespace motif {
namespace {

using json = nlohmann::json;
namespace fs = std::filesystem;

/** Bumped only when a change cannot be expressed as a defaulted field. */
constexpr int kFormatVersion = 1;

/**
 * Read a field, or keep what is already there.
 *
 * Every read goes through this. A project saved by an earlier build is missing
 * whatever was added since, and the right answer for those is the default the
 * struct already holds - not zero, and not a refusal to open the file.
 */
template <typename T>
void get(const json& j, const char* key, T& out) {
    if (auto it = j.find(key); it != j.end() && !it->is_null()) {
        try { out = it->get<T>(); } catch (const json::exception&) { /* keep default */ }
    }
}

json stepToJson(const Step& s) {
    json j{ { "on", s.on }, { "vel", s.velocity } };
    // Only what differs from a default step. A 16-step pattern is 16 of these,
    // and a file full of "ratchet": 1 is harder to read, not easier.
    if (s.degree)          j["deg"] = s.degree;
    if (s.octave)          j["oct"] = s.octave;
    if (s.length != 1)     j["len"] = s.length;
    if (s.ratchet != 1)    j["ratchet"] = s.ratchet;
    if (s.nudge != 0.0f)   j["nudge"] = s.nudge;
    if (s.accent)          j["accent"] = true;
    if (s.cond.type != TrigCondition::Type::Always) {
        j["cond"] = json{ { "type", int(s.cond.type) },
                          { "chance", s.cond.chance },
                          { "hit", s.cond.hit },
                          { "of", s.cond.of } };
    }
    return j;
}

Step stepFromJson(const json& j) {
    Step s;
    get(j, "on", s.on);
    get(j, "vel", s.velocity);
    get(j, "deg", s.degree);
    get(j, "oct", s.octave);
    get(j, "len", s.length);
    get(j, "ratchet", s.ratchet);
    get(j, "nudge", s.nudge);
    get(j, "accent", s.accent);
    if (auto c = j.find("cond"); c != j.end() && c->is_object()) {
        int type = 0;
        get(*c, "type", type);
        s.cond.type = TrigCondition::Type(std::clamp(type, 0, 6));
        get(*c, "chance", s.cond.chance);
        get(*c, "hit", s.cond.hit);
        get(*c, "of", s.cond.of);
    }
    return s;
}

json patternToJson(const Pattern& p) {
    json steps = json::array();
    for (int i = 0; i < p.length && i < int(p.steps.size()); ++i)
        steps.push_back(stepToJson(p.steps[size_t(i)]));
    return json{
        { "name", p.name },
        { "length", p.length },
        { "resolution", p.resolution },
        { "euclid", json{ { "on", p.euclidMode }, { "pulses", p.euclidPulses },
                          { "rotation", p.euclidRotation }, { "invert", p.euclidInvert } } },
        { "steps", std::move(steps) },
    };
}

Pattern patternFromJson(const json& j) {
    Pattern p;
    get(j, "name", p.name);
    int length = p.length;
    get(j, "length", length);
    p.resize(std::clamp(length, 1, 512));
    get(j, "resolution", p.resolution);
    p.resolution = std::clamp(p.resolution, 1, 16);
    if (auto e = j.find("euclid"); e != j.end() && e->is_object()) {
        get(*e, "on", p.euclidMode);
        get(*e, "pulses", p.euclidPulses);
        get(*e, "rotation", p.euclidRotation);
        get(*e, "invert", p.euclidInvert);
    }
    if (auto s = j.find("steps"); s != j.end() && s->is_array()) {
        for (size_t i = 0; i < s->size() && i < p.steps.size(); ++i)
            p.steps[i] = stepFromJson((*s)[i]);
    }
    return p;
}

json trackToJson(const Track& t) {
    json patterns = json::array();
    for (const auto& p : t.patterns) patterns.push_back(patternToJson(p));

    // Instrument parameters come from the shared table, by id. Adding a
    // parameter to the engine puts it in saved files with no change here.
    json sound = json::object();
    for (const auto& spec : paramsFor(t)) sound[spec.id] = spec.get(t);

    return json{
        { "name", t.name },
        { "colour", t.colour },
        { "seqEnabled", t.seqEnabled },
        { "armed", t.armed },
        { "activePattern", t.activePattern },
        { "isDrum", t.instrument.isDrum },
        { "sound", std::move(sound) },
        { "mixer", json{ { "gain", t.mixer.gain }, { "pan", t.mixer.pan },
                         { "mute", t.mixer.mute }, { "solo", t.mixer.solo },
                         { "reverb", t.mixer.reverbSend }, { "delay", t.mixer.delaySend },
                         { "duck", t.mixer.duck },
                         { "filterType", int(t.mixer.filterType) },
                         { "filterCutoff", t.mixer.filterCutoff },
                         { "filterReso", t.mixer.filterResonance } } },
        { "patterns", std::move(patterns) },
    };
}

Track trackFromJson(const json& j) {
    Track t;
    get(j, "name", t.name);
    get(j, "colour", t.colour);
    get(j, "seqEnabled", t.seqEnabled);
    get(j, "armed", t.armed);

    // Before the sound, because which table applies depends on it.
    get(j, "isDrum", t.instrument.isDrum);

    if (auto s = j.find("sound"); s != j.end() && s->is_object()) {
        for (const auto& spec : paramsFor(t)) {
            if (auto v = s->find(spec.id); v != s->end() && v->is_number())
                spec.set(t, v->get<float>());
        }
    }

    if (auto m = j.find("mixer"); m != j.end() && m->is_object()) {
        get(*m, "gain", t.mixer.gain);
        get(*m, "pan", t.mixer.pan);
        get(*m, "mute", t.mixer.mute);
        get(*m, "solo", t.mixer.solo);
        get(*m, "reverb", t.mixer.reverbSend);
        get(*m, "delay", t.mixer.delaySend);
        get(*m, "duck", t.mixer.duck);
        int ft = int(t.mixer.filterType);
        get(*m, "filterType", ft);
        t.mixer.filterType = Mixer::Filter(std::clamp(ft, 0, 3));
        get(*m, "filterCutoff", t.mixer.filterCutoff);
        get(*m, "filterReso", t.mixer.filterResonance);
    }

    if (auto p = j.find("patterns"); p != j.end() && p->is_array() && !p->empty()) {
        t.patterns.clear();
        for (const auto& pj : *p) t.patterns.push_back(patternFromJson(pj));
    }
    get(j, "activePattern", t.activePattern);
    t.activePattern = std::clamp(t.activePattern, 0, int(t.patterns.size()) - 1);
    return t;
}

} // namespace

std::string songToJson(const Song& song) {
    json tracks = json::array();
    for (const auto& t : song.tracks) tracks.push_back(trackToJson(t));

    const json j{
        { "format", "motif-project" },
        { "version", kFormatVersion },
        { "name", song.name },
        { "bpm", song.bpm },
        { "swing", song.swing },
        { "swingUnit", song.swingUnit },
        { "humanize", song.humanize },
        { "beatsPerBar", song.beatsPerBar },
        { "barsPerLoop", song.barsPerLoop },
        { "sidechainSource", song.sidechainSource },
        { "key", json{ { "root", song.key.root }, { "scale", int(song.key.scale) } } },
        { "master", json{
            { "gain", song.master.gain },
            { "drive", song.master.drive },
            { "limiter", song.master.limiter },
            { "sidechainRelease", song.master.sidechainRelease },
            { "sidechainCurve", song.master.sidechainCurve },
            { "reverb", json{ { "size", song.master.reverb.size },
                              { "damp", song.master.reverb.damp },
                              { "width", song.master.reverb.width },
                              { "mix", song.master.reverb.mix } } },
            { "delay", json{ { "beats", song.master.delay.beats },
                             { "feedback", song.master.delay.feedback },
                             { "tone", song.master.delay.tone },
                             { "pingpong", song.master.delay.pingpong },
                             { "mix", song.master.delay.mix } } } } },
        { "tracks", std::move(tracks) },
    };
    return j.dump(2);
}

bool songFromJson(const std::string& text, Song& out, std::string& error) {
    json j = json::parse(text, nullptr, false);
    if (j.is_discarded() || !j.is_object()) { error = "not a valid project file"; return false; }

    auto tracks = j.find("tracks");
    if (tracks == j.end() || !tracks->is_array() || tracks->empty()) {
        error = "the file carries no tracks";
        return false;
    }

    // Built to the side and only handed over once it is whole. A song that
    // half-loaded would be harder to recover from than one that did not load.
    Song song;
    get(j, "name", song.name);
    get(j, "bpm", song.bpm);
    song.bpm = std::clamp(song.bpm, 20.0, 400.0);
    get(j, "swing", song.swing);
    get(j, "swingUnit", song.swingUnit);
    get(j, "humanize", song.humanize);
    get(j, "beatsPerBar", song.beatsPerBar);
    song.beatsPerBar = std::clamp(song.beatsPerBar, 1, 16);
    get(j, "barsPerLoop", song.barsPerLoop);
    song.barsPerLoop = std::clamp(song.barsPerLoop, 1, 64);
    get(j, "sidechainSource", song.sidechainSource);

    if (auto k = j.find("key"); k != j.end() && k->is_object()) {
        get(*k, "root", song.key.root);
        int scale = int(song.key.scale);
        get(*k, "scale", scale);
        song.key.scale = theory::Scale(std::clamp(scale, 0, 7));
    }

    if (auto m = j.find("master"); m != j.end() && m->is_object()) {
        get(*m, "gain", song.master.gain);
        get(*m, "drive", song.master.drive);
        get(*m, "limiter", song.master.limiter);
        get(*m, "sidechainRelease", song.master.sidechainRelease);
        get(*m, "sidechainCurve", song.master.sidechainCurve);
        if (auto r = m->find("reverb"); r != m->end() && r->is_object()) {
            get(*r, "size", song.master.reverb.size);
            get(*r, "damp", song.master.reverb.damp);
            get(*r, "width", song.master.reverb.width);
            get(*r, "mix", song.master.reverb.mix);
        }
        if (auto d = m->find("delay"); d != m->end() && d->is_object()) {
            get(*d, "beats", song.master.delay.beats);
            get(*d, "feedback", song.master.delay.feedback);
            get(*d, "tone", song.master.delay.tone);
            get(*d, "pingpong", song.master.delay.pingpong);
            get(*d, "mix", song.master.delay.mix);
        }
    }

    song.tracks.clear();
    for (const auto& tj : *tracks) song.tracks.push_back(trackFromJson(tj));
    if (song.tracks.empty()) { error = "the file carries no tracks"; return false; }

    // Exactly one armed track, whatever the file says.
    int armed = -1;
    for (size_t i = 0; i < song.tracks.size(); ++i)
        if (song.tracks[i].armed && armed < 0) armed = int(i);
    for (size_t i = 0; i < song.tracks.size(); ++i)
        song.tracks[i].armed = (int(i) == (armed < 0 ? 0 : armed));

    if (song.sidechainSource >= int(song.tracks.size())) song.sidechainSource = -1;

    out = std::move(song);
    return true;
}

// ---------------------------------------------------------------------------

std::string projectsDirectory() {
    std::error_code ec;
    fs::path base;
#ifdef _WIN32
    if (const char* profile = std::getenv("USERPROFILE")) base = fs::path(profile) / "Documents";
#else
    if (const char* home = std::getenv("HOME")) base = fs::path(home) / "Documents";
#endif
    if (base.empty()) base = fs::current_path(ec);

    const fs::path dir = base / "Motif" / "Projects";
    fs::create_directories(dir, ec);
    return dir.string();
}

std::string sanitiseProjectName(const std::string& name) {
    std::string out;
    out.reserve(name.size());
    for (unsigned char c : name) {
        // Path separators, drive colons and traversal dots all go. What is
        // left cannot address anything outside the projects directory.
        if (std::isalnum(c) || c == ' ' || c == '-' || c == '_') out += char(c);
    }
    // Trim, so a name of only spaces does not become a file called " ".
    const auto first = out.find_first_not_of(' ');
    const auto last = out.find_last_not_of(' ');
    out = (first == std::string::npos) ? std::string{} : out.substr(first, last - first + 1);
    if (out.size() > 64) out.resize(64);
    return out;
}

std::vector<std::string> listProjects() {
    std::vector<std::string> names;
    std::error_code ec;
    for (const auto& entry : fs::directory_iterator(projectsDirectory(), ec)) {
        if (ec) break;
        if (entry.is_regular_file(ec) && entry.path().extension() == ".motif")
            names.push_back(entry.path().stem().string());
    }
    std::sort(names.begin(), names.end());
    return names;
}

bool saveProject(const std::string& name, const Song& song, std::string& error) {
    const std::string safe = sanitiseProjectName(name);
    if (safe.empty()) { error = "that name has no usable characters in it"; return false; }

    const fs::path path = fs::path(projectsDirectory()) / (safe + ".motif");

    // Write beside it and rename over the top. A crash midway through leaves
    // the previous save intact rather than a truncated file where the work was.
    const fs::path temp = path.string() + ".tmp";
    {
        std::ofstream out(temp, std::ios::binary | std::ios::trunc);
        if (!out) { error = "could not write to " + path.string(); return false; }
        out << songToJson(song);
        if (!out) { error = "the write failed part way through"; return false; }
    }
    std::error_code ec;
    fs::rename(temp, path, ec);
    if (ec) {
        fs::remove(temp, ec);
        error = "could not replace the existing file";
        return false;
    }
    return true;
}

bool loadProject(const std::string& name, Song& out, std::string& error) {
    const std::string safe = sanitiseProjectName(name);
    if (safe.empty()) { error = "no such project"; return false; }

    const fs::path path = fs::path(projectsDirectory()) / (safe + ".motif");
    std::ifstream in(path, std::ios::binary);
    if (!in) { error = "no project called \"" + safe + "\""; return false; }

    const std::string text{ std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>() };
    return songFromJson(text, out, error);
}

bool deleteProject(const std::string& name) {
    const std::string safe = sanitiseProjectName(name);
    if (safe.empty()) return false;
    std::error_code ec;
    return fs::remove(fs::path(projectsDirectory()) / (safe + ".motif"), ec);
}

} // namespace motif
