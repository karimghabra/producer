#include "net/Bridge.h"

#include <httplib.h>

#include <cmath>
#include <sstream>

#include "audio/Engine.h"
#include "music/Presets.h"

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
    if (type == "record")    { engine_.armRecording();    return true; }
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

    server_->Get("/api/state", [this](const httplib::Request&, httplib::Response& res) {
        res.set_content(stateJson(), "application/json");
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
