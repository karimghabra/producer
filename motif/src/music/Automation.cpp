#include "music/Automation.h"

#include <algorithm>
#include <cmath>

namespace motif {
namespace {

/** Guard for the track index; a lane can outlive the track it pointed at. */
Mixer* mixerFor(AutomationState& s, int track) {
    if (track < 0 || track >= int(s.mixers.size())) return nullptr;
    return &s.mixers[size_t(track)];
}

#define TRACK_SET(field) \
    [](AutomationState& s, int track, float v) { if (auto* m = mixerFor(s, track)) m->field = v; }
#define TRACK_GET(field) \
    [](const Song& song, int track) { \
        return track >= 0 && track < int(song.tracks.size()) \
            ? song.tracks[size_t(track)].mixer.field : 0.0f; }

} // namespace

double AutoTarget::toNorm(double value) const {
    if (max <= min) return 0.0;
    const double v = std::clamp(value, double(min), double(max));
    if (log && min > 0.0f) return std::log(v / min) / std::log(double(max) / min);
    return (v - min) / (max - min);
}

double AutoTarget::fromNorm(double norm) const {
    const double n = std::clamp(norm, 0.0, 1.0);
    if (log && min > 0.0f) return min * std::pow(double(max) / min, n);
    return min + n * (max - min);
}

const std::vector<AutoTarget>& autoTargets() {
    static const std::vector<AutoTarget> targets = {
        // --- per track ------------------------------------------------------
        { "cutoff", "Filter cutoff", false, 20.0f, 20000.0f, true, "Hz",
          "The channel filter's cutoff. This is the sweep - draw it rising over "
          "a section and the track opens up across those bars. The filter has to "
          "be switched on for the track, or there is nothing to sweep.",
          TRACK_SET(filterCutoff), TRACK_GET(filterCutoff) },

        { "reso", "Filter resonance", false, 0.5f, 20.0f, false, "",
          "Emphasis at the cutoff. Rising alongside a sweep is what makes a "
          "filter build scream rather than just brighten.",
          TRACK_SET(filterResonance), TRACK_GET(filterResonance) },

        { "gain", "Level", false, 0.0f, 1.5f, false, "",
          "Track level. Drawn falling to nothing, this is how a part drops out "
          "under a break without muting it on a hard edge.",
          TRACK_SET(gain), TRACK_GET(gain) },

        { "pan", "Pan", false, -1.0f, 1.0f, false, "",
          "Position across the stereo field.",
          TRACK_SET(pan), TRACK_GET(pan) },

        { "verb", "Reverb send", false, 0.0f, 1.0f, false, "",
          "How much of this track goes to the reverb. Opening it into a break is "
          "how a part dissolves rather than stops.",
          TRACK_SET(reverbSend), TRACK_GET(reverbSend) },

        { "delay", "Delay send", false, 0.0f, 1.0f, false, "",
          "How much of this track goes to the delay. A stab thrown into the "
          "delay on the last beat of a section is the oldest trick there is.",
          TRACK_SET(delaySend), TRACK_GET(delaySend) },

        { "duck", "Sidechain depth", false, 0.0f, 1.0f, false, "",
          "How far this track ducks under the sidechain source. Bringing it up "
          "across a build makes the pump arrive with the drop.",
          TRACK_SET(duck), TRACK_GET(duck) },

        // --- master ---------------------------------------------------------
        { "mDrive", "Master drive", true, 0.0f, 1.0f, false, "",
          "Saturation across the whole mix.",
          [](AutomationState& s, int, float v) { s.master.drive = v; },
          [](const Song& song, int) { return song.master.drive; } },

        { "mGain", "Master level", true, 0.0f, 1.5f, false, "",
          "Level of the whole mix. Drawn falling, it is a fade-out.",
          [](AutomationState& s, int, float v) { s.master.gain = v; },
          [](const Song& song, int) { return song.master.gain; } },

        { "mRevMix", "Reverb return", true, 0.0f, 1.5f, false, "",
          "How much reverb comes back into the mix.",
          [](AutomationState& s, int, float v) { s.master.reverb.mix = v; },
          [](const Song& song, int) { return song.master.reverb.mix; } },

        { "mRevSize", "Reverb size", true, 0.0f, 1.0f, false, "",
          "How long the space rings for. Opening it out over a breakdown is a "
          "room getting bigger around you.",
          [](AutomationState& s, int, float v) { s.master.reverb.size = v; },
          [](const Song& song, int) { return song.master.reverb.size; } },

        { "mDlyMix", "Delay return", true, 0.0f, 1.5f, false, "",
          "How much delay comes back into the mix.",
          [](AutomationState& s, int, float v) { s.master.delay.mix = v; },
          [](const Song& song, int) { return song.master.delay.mix; } },

        { "mDlyFb", "Delay feedback", true, 0.0f, 0.95f, false, "",
          "How much of each repeat feeds back. Pushed up at the end of a "
          "section, the delay runs away into the next one.",
          [](AutomationState& s, int, float v) { s.master.delay.feedback = v; },
          [](const Song& song, int) { return song.master.delay.feedback; } },
    };
    return targets;
}

const AutoTarget* findAutoTarget(const std::string& id) {
    for (const auto& t : autoTargets())
        if (id == t.id) return &t;
    return nullptr;
}

void reserveTracks(AutomationState& state, size_t tracks) {
    state.mixers.reserve(tracks);
}

void passthroughInto(const Song& song, AutomationState& s) {
    // assign() over a reserved vector copies into storage that already exists.
    s.mixers.clear();
    for (const auto& t : song.tracks) s.mixers.push_back(t.mixer);
    s.master = song.master;
}

void evaluateInto(const Song& song, const Section& section, double sectionBar,
                  AutomationState& s) {
    passthroughInto(song, s);
    for (const auto& lane : section.lanes) {
        const AutoTarget* target = findAutoTarget(lane.param);
        if (!target || lane.points.empty() || !target->apply) continue;

        const float value = float(target->fromNorm(lane.valueAt(sectionBar)));
        if (target->master) { target->apply(s, -1, value); continue; }
        // One curve, every track it was pointed at. A track that has since been
        // deleted is skipped inside apply rather than checked for here.
        for (int track : lane.tracks) target->apply(s, track, value);
    }
}

} // namespace motif
