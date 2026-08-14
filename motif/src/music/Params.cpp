#include "music/Params.h"

#include <algorithm>
#include <cmath>

namespace motif {
namespace {

const char* const kSynthEngines[] = { "Supersaw", "Reese", "FM", "Sub", "Pluck", "Pad" };
const char* const kWaves[]        = { "Sine", "Saw", "Square", "Triangle" };
const char* const kDrumEngines[]  = { "Kick", "Snare", "Clap", "Hat", "Cymbal", "Tom", "Rim", "Noise" };

// Shorthands. The tables below are long enough without the ceremony.
#define SYN(field) \
    [](const Track& t) { return float(t.instrument.synth.field); }, \
    [](Track& t, float v) { t.instrument.synth.field = v; }
#define SYN_INT(field) \
    [](const Track& t) { return float(t.instrument.synth.field); }, \
    [](Track& t, float v) { t.instrument.synth.field = int(std::lround(v)); }
#define DRM(field) \
    [](const Track& t) { return float(t.instrument.drum.field); }, \
    [](Track& t, float v) { t.instrument.drum.field = v; }

} // namespace

double ParamSpec::toNorm(double value) const {
    const double lo = min, hi = max;
    if (hi <= lo) return 0.0;
    const double v = std::clamp(value, lo, hi);
    if (log && lo > 0.0) return std::log(v / lo) / std::log(hi / lo);
    return (v - lo) / (hi - lo);
}

double ParamSpec::fromNorm(double norm) const {
    const double n = std::clamp(norm, 0.0, 1.0);
    const double lo = min, hi = max;
    if (log && lo > 0.0) return lo * std::pow(hi / lo, n);
    return lo + n * (hi - lo);
}

const std::vector<ParamSpec>& synthParamSpecs() {
    static const std::vector<ParamSpec> specs = {
        { "engine", "ENGINE", 0, 5, false, "",
          "How the sound is made. Supersaw is many detuned saws for width; Reese "
          "is two, beating against each other, for a bass that moves; FM is one "
          "oscillator bending another; Sub is a clean low sine; Pluck is short "
          "and percussive; Pad is slow and soft.",
          kSynthEngines, 6,
          [](const Track& t) { return float(int(t.instrument.synth.engine)); },
          [](Track& t, float v) { t.instrument.synth.engine = SynthEngine(std::clamp(int(std::lround(v)), 0, 5)); } },

        { "wave", "WAVE", 0, 3, false, "",
          "The raw shape before anything is done to it. Sine is pure, saw is "
          "bright and buzzy, square is hollow, triangle sits between sine and saw.",
          kWaves, 4,
          [](const Track& t) { return float(int(t.instrument.synth.wave)); },
          [](Track& t, float v) { t.instrument.synth.wave = dsp::Wave(std::clamp(int(std::lround(v)), 0, 3)); } },

        { "unison", "VOICES", 1, 9, false, "",
          "How many copies of the oscillator run at once. More voices, spread "
          "apart by DETUNE, is what makes a supersaw enormous. One voice is a "
          "single clean tone.", nullptr, 0, SYN_INT(unison) },

        { "detune", "DETUNE", 0, 1, false, "",
          "How far apart the unison voices are tuned. A little is thickness; a "
          "lot is a chord that has not decided what it is yet.", nullptr, 0, SYN(detune) },

        { "spread", "SPREAD", 0, 1, false, "",
          "How far the voices are thrown across the stereo field. At zero they "
          "stack in the middle; at one the outer voices sit hard left and right.",
          nullptr, 0, SYN(spread) },

        { "octave", "OCTAVE", -3, 3, false, "",
          "Shifts the whole instrument in octaves, without changing the pattern.",
          nullptr, 0, SYN_INT(octave) },

        { "sub", "SUB", 0, 1, false, "",
          "A sine one octave below, mixed underneath. This is where the weight "
          "in a bass comes from - the part felt more than heard.", nullptr, 0, SYN(sub) },

        { "fmRatio", "FM RATIO", 0.5f, 12, false, "x",
          "Only used by the FM engine. The modulator's pitch as a multiple of "
          "the note. Whole numbers stay musical; fractions ring like bells and "
          "metal.", nullptr, 0, SYN(fmRatio) },

        { "fmIndex", "FM AMOUNT", 0, 12, false, "",
          "Only used by the FM engine. How hard the modulator bends the carrier. "
          "Low is a gentle edge, high is clangorous and inharmonic.",
          nullptr, 0, SYN(fmIndex) },

        { "cutoff", "CUTOFF", 60, 18000, true, "Hz",
          "The filter closes above this frequency. Lower is darker and further "
          "away; higher is brighter and closer.", nullptr, 0, SYN(cutoff) },

        { "resonance", "RESO", 0.5f, 14, false, "",
          "Emphasis right at the cutoff. Turn it up and the filter starts to "
          "sing at whatever it is set to - the classic acid whistle.",
          nullptr, 0, SYN(resonance) },

        { "filterEnv", "FILT ENV", -4, 6, false, "",
          "How far the filter envelope sweeps the cutoff. Positive opens on each "
          "note and closes again; negative does the reverse.", nullptr, 0, SYN(filterEnv) },

        { "keyTrack", "KEY TRACK", 0, 1, false, "",
          "How much the cutoff follows the note played, so high notes stay as "
          "bright as low ones instead of getting muffled.", nullptr, 0, SYN(keyTrack) },

        { "ampAttack", "AMP A", 0.001f, 3, true, "s",
          "How long the note takes to reach full level. Near zero is an "
          "immediate hit; long is a swell.", nullptr, 0, SYN(ampAttack) },
        { "ampDecay", "AMP D", 0.002f, 4, true, "s",
          "How long it takes to fall from full level to the sustain level.",
          nullptr, 0, SYN(ampDecay) },
        { "ampSustain", "AMP S", 0, 1, false, "",
          "The level it holds at while the key is down. At zero the note is a "
          "blip regardless of how long you hold it.", nullptr, 0, SYN(ampSustain) },
        { "ampRelease", "AMP R", 0.002f, 5, true, "s",
          "How long it takes to fade after the key is let go. Long releases "
          "overlap into the next note and blur the rhythm.", nullptr, 0, SYN(ampRelease) },

        { "fltAttack", "FLT A", 0.001f, 3, true, "s",
          "Attack of the filter envelope - how quickly the sweep starts.",
          nullptr, 0, SYN(fltAttack) },
        { "fltDecay", "FLT D", 0.002f, 4, true, "s",
          "Decay of the filter envelope. Short with a high FILT ENV is the "
          "sharp percussive pluck.", nullptr, 0, SYN(fltDecay) },
        { "fltSustain", "FLT S", 0, 1, false, "",
          "Where the filter sweep settles while the key is held.",
          nullptr, 0, SYN(fltSustain) },
        { "fltRelease", "FLT R", 0.002f, 5, true, "s",
          "How the filter closes after the key is let go.", nullptr, 0, SYN(fltRelease) },

        { "drive", "DRIVE", 0, 1, false, "",
          "Saturation before the output. Adds harmonics and loudness, and "
          "rounds off peaks rather than clipping them.", nullptr, 0, SYN(drive) },
        { "gain", "LEVEL", 0, 1.5f, false, "",
          "Output level of the instrument itself, before the mixer.",
          nullptr, 0, SYN(gain) },
    };
    return specs;
}

const std::vector<ParamSpec>& drumParamSpecs() {
    static const std::vector<ParamSpec> specs = {
        { "engine", "ENGINE", 0, 7, false, "",
          "Which drum this is. Each is a different arrangement of the same "
          "parts rather than a sample: a pitched body, a noise component, and "
          "envelopes shaped for that job.",
          kDrumEngines, 8,
          [](const Track& t) { return float(int(t.instrument.drumEngine)); },
          [](Track& t, float v) { t.instrument.drumEngine = DrumEngine(std::clamp(int(std::lround(v)), 0, 7)); } },

        { "tune", "TUNE", 20, 1200, true, "Hz",
          "The pitch of the body. On a kick this is how low it sits; on metals "
          "it moves the whole spectrum.", nullptr, 0, DRM(tune) },

        { "decay", "DECAY", 0.02f, 3, true, "s",
          "How long the hit rings for. Short is tight and clipped, long is "
          "boomy and fills the space between beats.", nullptr, 0, DRM(decay) },

        { "pitchMod", "PITCH DROP", 0, 48, false, "st",
          "How far the pitch falls at the start of the hit. This drop is most "
          "of what makes a kick sound like a kick rather than a low note.",
          nullptr, 0, DRM(pitchMod) },

        { "pitchTime", "DROP TIME", 0.005f, 0.4f, true, "s",
          "How long that fall takes. Fast is a click and a thump; slow is the "
          "long descending 909 tom.", nullptr, 0, DRM(pitchTime) },

        { "noise", "NOISE", 0, 1, false, "",
          "Balance between the pitched body and noise. Snares and hats are "
          "mostly noise; kicks are mostly body.", nullptr, 0, DRM(noise) },

        { "drive", "DRIVE", 0, 1, false, "",
          "Saturation. Pushes the hit forward and thickens it; past about "
          "three quarters it starts to square off.", nullptr, 0, DRM(drive) },

        { "cutoff", "CUTOFF", 200, 18000, true, "Hz",
          "Low-pass filter on the whole hit. Pull it down to push a drum behind "
          "the others without turning it down.", nullptr, 0, DRM(cutoff) },

        { "resonance", "RESO", 0.3f, 14, false, "",
          "Emphasis at the cutoff. On drums a little adds a tone at the filter "
          "frequency, which can give a hat a pitch.", nullptr, 0, DRM(resonance) },

        { "snap", "SNAP", 0, 1, false, "",
          "The transient at the very start - the sound of the beater hitting "
          "the skin. It is what cuts through a mix.", nullptr, 0, DRM(snap) },
    };
    return specs;
}

const std::vector<ParamSpec>& paramsFor(const Track& track) {
    return track.instrument.isDrum ? drumParamSpecs() : synthParamSpecs();
}

const ParamSpec* findParam(const Track& track, const std::string& id) {
    for (const auto& p : paramsFor(track))
        if (id == p.id) return &p;
    return nullptr;
}

} // namespace motif
