#pragma once

// ---------------------------------------------------------------------------
// Motif — preset library.
//
// The knobs are all one-line summaries of a synthesis technique, which is not
// much use if you do not already know the technique. Presets let you find a
// sound by ear first and reverse-engineer it afterwards, which is how most
// people actually learn what a filter envelope does.
// ---------------------------------------------------------------------------

#include <string>
#include <vector>

#include "music/Song.h"

namespace motif {

struct DrumPreset {
    const char* name;
    const char* blurb;
    DrumEngine engine;
    DrumParams params;
};

struct SynthPreset {
    const char* name;
    const char* blurb;
    Patch patch;
};

const std::vector<DrumPreset>& drumPresets();
const std::vector<SynthPreset>& synthPresets();

/** Apply a preset to a track, engine included. */
void applyDrumPreset(Track& track, const DrumPreset& preset);
void applySynthPreset(Track& track, const SynthPreset& preset);

/** The factory sound for an engine — what a reset goes back to. */
const DrumPreset* initDrumPreset(DrumEngine engine);
const SynthPreset* initSynthPreset(SynthEngine engine);

} // namespace motif
