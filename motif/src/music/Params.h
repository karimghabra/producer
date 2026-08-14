#pragma once

// ---------------------------------------------------------------------------
// Motif — the parameter table.
//
// Every editable property of an instrument is described once, here, with the
// range it lives in, how it should be swept, and what it actually does. Three
// things then read from that one description: the sound view builds its
// controls from it, the command handler sets values by id, and save/load walks
// it to write and read a file.
//
// Writing the field list three times is how a parameter ends up editable but
// not saved, or saved but not shown. Describing it once makes that impossible.
// ---------------------------------------------------------------------------

#include <string>
#include <vector>

#include "music/Song.h"

namespace motif {

struct ParamSpec {
    const char* id;
    const char* label;
    float min = 0.0f;
    float max = 1.0f;
    /**
     * Sweep logarithmically.
     *
     * Set for anything spanning decades. A linear 1 ms - 3 s attack control
     * puts everything under 200 ms in the first 6% of its travel, which is the
     * part you actually want to adjust.
     */
    bool log = false;
    const char* unit = "";
    /** What it does, in the terms someone would ask the question. */
    const char* help = "";
    /** Non-null for discrete parameters: the name of each position. */
    const char* const* choices = nullptr;
    int choiceCount = 0;

    float (*get)(const Track&) = nullptr;
    void (*set)(Track&, float) = nullptr;

    /** Position of `value` along this parameter's travel, 0..1. */
    double toNorm(double value) const;
    /** The value at `norm` along the travel. */
    double fromNorm(double norm) const;
};

/** Parameters for whichever instrument this track holds. */
const std::vector<ParamSpec>& paramsFor(const Track& track);

const std::vector<ParamSpec>& drumParamSpecs();
const std::vector<ParamSpec>& synthParamSpecs();

/** Look one up by id, or null. */
const ParamSpec* findParam(const Track& track, const std::string& id);

} // namespace motif
