#include "music/Presets.h"

#include <cstring>

namespace motif {
namespace {

DrumParams drum(float tune, float decay, float pitchMod, float pitchTime,
                float noise, float drive, float cutoff, float resonance, float snap) {
    DrumParams p;
    p.tune = tune; p.decay = decay; p.pitchMod = pitchMod; p.pitchTime = pitchTime;
    p.noise = noise; p.drive = drive; p.cutoff = cutoff; p.resonance = resonance; p.snap = snap;
    return p;
}

struct Env { float a, d, s, r; };

Patch synth(SynthEngine engine, int unison, float detune, float spread, int octave, float sub,
            float cutoff, float resonance, float filterEnv, float keyTrack, float drive,
            Env amp, Env flt, float fmRatio = 2.0f, float fmIndex = 3.0f) {
    Patch p;
    p.engine = engine;
    p.unison = unison; p.detune = detune; p.spread = spread; p.octave = octave; p.sub = sub;
    p.cutoff = cutoff; p.resonance = resonance; p.filterEnv = filterEnv; p.keyTrack = keyTrack;
    p.drive = drive;
    p.ampAttack = amp.a; p.ampDecay = amp.d; p.ampSustain = amp.s; p.ampRelease = amp.r;
    p.fltAttack = flt.a; p.fltDecay = flt.d; p.fltSustain = flt.s; p.fltRelease = flt.r;
    p.fmRatio = fmRatio; p.fmIndex = fmIndex;
    p.wave = engine == SynthEngine::Sub || engine == SynthEngine::FM ? dsp::Wave::Sine : dsp::Wave::Saw;
    return p;
}

} // namespace

// ---------------------------------------------------------------------------

const std::vector<DrumPreset>& drumPresets() {
    static const std::vector<DrumPreset> kList = {
        // kicks
        { "909 Kick",   "The house and techno standard. Punchy, gets out of the way.",
          DrumEngine::Kick,  drum(50, 0.45f, 28, 0.035f, 0, 0.35f, 8000, 0.7f, 0.50f) },
        { "808 Boom",   "Long sub tail. Trap and hip-hop \xe2\x80\x94 sits under everything.",
          DrumEngine::Kick,  drum(40, 1.40f, 20, 0.065f, 0, 0.18f, 5500, 0.5f, 0.22f) },
        { "Tech Thump", "Short and tight. Leaves room for a busy groove.",
          DrumEngine::Kick,  drum(55, 0.28f, 26, 0.022f, 0, 0.45f, 9000, 0.8f, 0.60f) },
        { "Trance Kick","Clicky top, fast decay. Built to cut through supersaws.",
          DrumEngine::Kick,  drum(52, 0.36f, 33, 0.028f, 0, 0.50f, 11000, 0.9f, 0.70f) },
        { "Hardstyle",  "Distorted and pitched. The kick is the bassline.",
          DrumEngine::Kick,  drum(62, 0.75f, 40, 0.030f, 0.05f, 0.92f, 12000, 1.6f, 0.75f) },
        // snares
        { "909 Snare",  "Bright, noisy, classic. Backbeat duty.",
          DrumEngine::Snare, drum(190, 0.20f, 0, 0.01f, 0.70f, 0.25f, 11000, 0.8f, 0.70f) },
        { "Trap Snare", "High and snappy, very short. For rolls and rushes.",
          DrumEngine::Snare, drum(260, 0.15f, 0, 0.01f, 0.82f, 0.30f, 13000, 1.0f, 0.80f) },
        { "Deep Snare", "More body than hiss. Warmer, sits lower.",
          DrumEngine::Snare, drum(145, 0.32f, 0, 0.01f, 0.50f, 0.30f, 7500, 0.9f, 0.50f) },
        { "Ghost",      "Barely there. Use quietly between the backbeats.",
          DrumEngine::Snare, drum(200, 0.075f, 0, 0.01f, 0.88f, 0.10f, 9000, 1.2f, 0.40f) },
        // claps
        { "909 Clap",   "Three bursts then a tail. The sound of house music.",
          DrumEngine::Clap,  drum(1100, 0.32f, 0, 0.01f, 1.0f, 0.15f, 6500, 2.0f, 0.0f) },
        { "Tight Clap", "Cropped short. Layers under a snare without mud.",
          DrumEngine::Clap,  drum(1450, 0.15f, 0, 0.01f, 1.0f, 0.20f, 7500, 3.2f, 0.0f) },
        { "Big Room",   "Long and wide. Wants reverb behind it.",
          DrumEngine::Clap,  drum(900, 0.62f, 0, 0.01f, 1.0f, 0.28f, 5500, 1.4f, 0.0f) },
        // hats
        { "909 Closed", "Standard closed hat. Offbeats and sixteenths.",
          DrumEngine::Hat,   drum(320, 0.055f, 0, 0.01f, 0, 0.15f, 9000, 1.2f, 0.0f) },
        { "808 Tick",   "Tiny and dry. Almost a click.",
          DrumEngine::Hat,   drum(410, 0.028f, 0, 0.01f, 0, 0.10f, 11000, 1.0f, 0.0f) },
        { "Open Hat",   "Rings on. Put it on the offbeat and stop worrying.",
          DrumEngine::Hat,   drum(300, 0.36f, 0, 0.01f, 0, 0.20f, 8000, 1.0f, 0.0f) },
        { "Trap Hat",   "Ultra short, bright. Survives 1/32 rolls.",
          DrumEngine::Hat,   drum(460, 0.020f, 0, 0.01f, 0, 0.12f, 12500, 0.9f, 0.0f) },
        { "Sizzle",     "Noisy and loose. More like a small cymbal.",
          DrumEngine::Hat,   drum(275, 0.50f, 0, 0.01f, 0.32f, 0.25f, 7000, 0.8f, 0.0f) },
        // cymbals
        { "Crash",      "Long wash. One per eight bars is usually plenty.",
          DrumEngine::Cymbal, drum(220, 1.70f, 0, 0.01f, 0.25f, 0.15f, 6000, 0.6f, 0.0f) },
        { "Ride",       "Shorter and more defined. Can carry a groove.",
          DrumEngine::Cymbal, drum(350, 0.85f, 0, 0.01f, 0.10f, 0.12f, 9000, 0.7f, 0.0f) },
        // toms and percussion
        { "Low Tom",    "Deep and round. Fills and tribal patterns.",
          DrumEngine::Tom,   drum(90, 0.52f, 14, 0.080f, 0.10f, 0.20f, 6000, 0.7f, 0.0f) },
        { "High Tom",   "Tighter and higher. Pairs with the low tom.",
          DrumEngine::Tom,   drum(185, 0.34f, 12, 0.050f, 0.10f, 0.20f, 8000, 0.7f, 0.0f) },
        { "Rim Click",  "Short wooden tick. Great as a quiet offbeat.",
          DrumEngine::Rim,   drum(820, 0.030f, 0, 0.01f, 0, 0.10f, 12000, 4.0f, 0.0f) },
        { "Noise Sweep","Filtered noise. Build-ups and transitions.",
          DrumEngine::Noise, drum(200, 0.90f, 0, 0.01f, 1.0f, 0.15f, 2200, 8.0f, 0.0f) },
        { "Snare Rush", "Fast noise burst. Stack it into 1/32 rolls.",
          DrumEngine::Noise, drum(200, 0.11f, 0, 0.01f, 1.0f, 0.20f, 4200, 3.0f, 0.0f) },
    };
    return kList;
}

const std::vector<SynthPreset>& synthPresets() {
    static const std::vector<SynthPreset> kList = {
        { "Trance Lead", "Seven detuned saws, wide and bright. The big one.",
          synth(SynthEngine::Supersaw, 7, 0.42f, 0.90f, 0, 0.15f, 6000, 3.0f, 2.2f, 0.40f, 0.25f,
                { 0.010f, 0.40f, 0.70f, 0.40f }, { 0.005f, 0.40f, 0.45f, 0.35f }) },
        { "Big Room Stab", "Short, hard, no sustain. Play it on the offbeats.",
          synth(SynthEngine::Supersaw, 7, 0.50f, 1.00f, 0, 0.10f, 7000, 2.0f, 3.0f, 0.35f, 0.35f,
                { 0.004f, 0.18f, 0.00f, 0.15f }, { 0.002f, 0.15f, 0.10f, 0.12f }) },
        { "Anthem Lead", "Narrower and rounder. Sits better under vocals.",
          synth(SynthEngine::Supersaw, 5, 0.28f, 0.60f, 0, 0.20f, 4800, 2.5f, 1.8f, 0.45f, 0.20f,
                { 0.020f, 0.50f, 0.85f, 0.50f }, { 0.010f, 0.50f, 0.50f, 0.40f }) },

        { "Classic Reese", "Two saws beating against each other. Moving low end.",
          synth(SynthEngine::Reese, 3, 0.40f, 0.25f, -2, 0.50f, 620, 6.0f, 1.8f, 0.35f, 0.45f,
                { 0.004f, 0.15f, 0.85f, 0.10f }, { 0.002f, 0.16f, 0.25f, 0.10f }) },
        { "DnB Growl", "Wider detune, screaming filter. Nasty on purpose.",
          synth(SynthEngine::Reese, 4, 0.68f, 0.40f, -2, 0.35f, 430, 13.0f, 2.6f, 0.30f, 0.72f,
                { 0.004f, 0.20f, 0.90f, 0.12f }, { 0.004f, 0.30f, 0.30f, 0.15f }) },
        { "Sub Reese", "Mostly sub with a hint of movement. Very clean low end.",
          synth(SynthEngine::Reese, 2, 0.20f, 0.15f, -2, 0.80f, 340, 4.0f, 1.2f, 0.40f, 0.28f,
                { 0.005f, 0.20f, 0.90f, 0.10f }, { 0.003f, 0.20f, 0.40f, 0.10f }) },

        { "FM Bass", "Hard, focused, cuts through anything. Whole-number ratio.",
          synth(SynthEngine::FM, 1, 0.0f, 0.0f, -2, 0.25f, 1200, 2.0f, 1.5f, 0.30f, 0.32f,
                { 0.003f, 0.22f, 0.70f, 0.10f }, { 0.002f, 0.16f, 0.20f, 0.10f }, 2.0f, 4.0f) },
        { "Bell", "Non-integer ratio, long tail. Bright and glassy.",
          synth(SynthEngine::FM, 1, 0.0f, 0.0f, 0, 0.0f, 12000, 1.0f, 0.8f, 0.50f, 0.10f,
                { 0.002f, 1.30f, 0.08f, 1.10f }, { 0.001f, 0.90f, 0.20f, 0.70f }, 3.5f, 6.0f) },
        { "Metal Stab", "High ratio, heavy modulation. Clangy and percussive.",
          synth(SynthEngine::FM, 1, 0.0f, 0.0f, 0, 0.0f, 6500, 2.0f, 1.5f, 0.40f, 0.25f,
                { 0.002f, 0.26f, 0.00f, 0.20f }, { 0.001f, 0.20f, 0.10f, 0.15f }, 5.5f, 8.0f) },

        { "Pure Sub", "One sine, nothing else. Felt more than heard.",
          synth(SynthEngine::Sub, 1, 0.0f, 0.0f, -2, 0.0f, 420, 0.7f, 0.4f, 0.50f, 0.15f,
                { 0.006f, 0.20f, 0.92f, 0.12f }, { 0.005f, 0.20f, 0.60f, 0.10f }) },
        { "808 Slide", "Sub with a long tail. Overlap notes for the slide.",
          synth(SynthEngine::Sub, 1, 0.0f, 0.0f, -2, 0.0f, 520, 1.2f, 0.8f, 0.40f, 0.36f,
                { 0.004f, 0.90f, 0.55f, 0.60f }, { 0.003f, 0.50f, 0.40f, 0.40f }) },

        { "House Pluck", "Resonant blip, no sustain. Chords on the offbeat.",
          synth(SynthEngine::Pluck, 3, 0.16f, 0.50f, 0, 0.10f, 3500, 9.0f, 2.8f, 0.40f, 0.20f,
                { 0.002f, 0.22f, 0.00f, 0.20f }, { 0.001f, 0.12f, 0.00f, 0.10f }) },
        { "Wood Pluck", "Softer and duller. More marimba than synth.",
          synth(SynthEngine::Pluck, 1, 0.0f, 0.0f, 0, 0.20f, 2400, 3.0f, 2.0f, 0.50f, 0.12f,
                { 0.002f, 0.36f, 0.00f, 0.30f }, { 0.001f, 0.22f, 0.00f, 0.20f }) },

        { "Warm Pad", "Slow, wide, dark. Fills the space behind everything.",
          synth(SynthEngine::Pad, 5, 0.28f, 1.00f, -1, 0.10f, 2200, 1.5f, 1.0f, 0.20f, 0.10f,
                { 0.600f, 1.20f, 0.80f, 1.60f }, { 0.900f, 1.50f, 0.60f, 1.40f }) },
        { "Choir Pad", "Brighter and slower still. Very long release.",
          synth(SynthEngine::Pad, 7, 0.36f, 1.00f, 0, 0.05f, 3100, 2.2f, 1.2f, 0.30f, 0.08f,
                { 1.000f, 1.50f, 0.85f, 2.20f }, { 1.200f, 1.80f, 0.65f, 1.80f }) },
        { "Dark Drone", "Low, slow and slightly dirty. Tension under a breakdown.",
          synth(SynthEngine::Pad, 4, 0.18f, 0.85f, -2, 0.30f, 900, 4.0f, 1.4f, 0.15f, 0.26f,
                { 1.400f, 2.00f, 0.90f, 2.50f }, { 1.600f, 2.20f, 0.70f, 2.00f }) },
    };
    return kList;
}

// ---------------------------------------------------------------------------

void applyDrumPreset(Track& track, const DrumPreset& preset) {
    track.instrument.isDrum = true;
    track.instrument.drumEngine = preset.engine;
    track.instrument.drum = preset.params;
}

void applySynthPreset(Track& track, const SynthPreset& preset) {
    track.instrument.isDrum = false;
    track.instrument.synth = preset.patch;
}

const DrumPreset* initDrumPreset(DrumEngine engine) {
    for (const auto& p : drumPresets()) if (p.engine == engine) return &p;
    return drumPresets().empty() ? nullptr : &drumPresets().front();
}

const SynthPreset* initSynthPreset(SynthEngine engine) {
    for (const auto& p : synthPresets()) if (p.patch.engine == engine) return &p;
    return synthPresets().empty() ? nullptr : &synthPresets().front();
}

} // namespace motif
