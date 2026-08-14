#pragma once

// ---------------------------------------------------------------------------
// Motif — what can be automated.
//
// The same idea as the instrument parameter table: describe each target once,
// and let the interface, the engine and the save format all read from that
// description rather than each carrying their own copy of the ranges.
//
// Automation never writes to the song. It produces an overlay that the render
// loop reads instead - so playing an arrangement that sweeps a filter does not
// leave the filter somewhere else when it stops.
// ---------------------------------------------------------------------------

#include <string>
#include <vector>

#include "music/Song.h"

namespace motif {

/** Values in effect for one block, after automation has been applied. */
struct AutomationState {
    std::vector<Mixer> mixers;    // one per track, copied from the song then overridden
    MasterFx master;
};

struct AutoTarget {
    const char* id;
    const char* label;
    /** True for master-bus targets, false for per-track ones. */
    bool master = false;
    float min = 0.0f;
    float max = 1.0f;
    bool log = false;
    const char* unit = "";
    const char* help = "";

    /** Write a real value into the overlay. `track` is ignored for master targets. */
    void (*apply)(AutomationState&, int track, float value) = nullptr;
    /** Read the song's own value, so a new lane starts where the mix is. */
    float (*read)(const Song&, int track) = nullptr;

    double toNorm(double value) const;
    double fromNorm(double norm) const;
};

const std::vector<AutoTarget>& autoTargets();
const AutoTarget* findAutoTarget(const std::string& id);

/**
 * Build the values in effect at a position in the arrangement.
 *
 * `sectionBar` is how far into the section we are, in bars. Lanes are applied
 * in order, so the last one to write a target wins - which only matters if a
 * section carries two lanes for the same thing.
 */
AutomationState evaluate(const Song& song, const Section& section, double sectionBar);

/** The overlay with nothing automated: just what the song says. */
AutomationState passthrough(const Song& song);

} // namespace motif
