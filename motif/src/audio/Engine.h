#pragma once

// ---------------------------------------------------------------------------
// Motif — audio engine.
//
// A plain render loop. Nothing schedules automation against a timeline; every
// value is computed for the sample being written. Note timing is taken from
// the audio clock rather than the message thread, so a captured take is
// accurate to the sample rather than to whenever the UI happened to run.
// ---------------------------------------------------------------------------

#include <array>
#include <atomic>
#include <mutex>
#include <vector>

#include "dsp/Dsp.h"
#include "music/Quantizer.h"

namespace motif {

/** A synth sound. Small on purpose — this is meant to be played, not dialled. */
struct Patch {
    dsp::Wave wave = dsp::Wave::Saw;
    int unison = 5;
    float detune = 0.30f;       // 0..1
    float spread = 0.70f;       // stereo width of the unison stack
    int octave = 0;
    float sub = 0.25f;

    float cutoff = 2200.0f;     // Hz
    float resonance = 3.0f;
    float filterEnv = 2.0f;     // octaves
    float keyTrack = 0.35f;

    float ampAttack = 0.006f, ampDecay = 0.180f, ampSustain = 0.75f, ampRelease = 0.160f;
    float fltAttack = 0.004f, fltDecay = 0.220f, fltSustain = 0.40f, fltRelease = 0.150f;

    float drive = 0.25f;
    float gain = 0.75f;
};

/** One sounding note. */
class Voice {
public:
    static constexpr int kMaxUnison = 7;

    void prepare(double sampleRate);
    void start(int midiNote, float velocity, const Patch& patch);
    void release();
    void kill();

    bool active() const { return amp_.active(); }
    int note() const { return note_; }
    /** Rising with age, so the oldest voice is the one stolen. */
    uint64_t age() const { return startStamp_; }
    void setStamp(uint64_t s) { startStamp_ = s; }

    /** Render one frame, adding into the stereo pair. */
    void render(float& outL, float& outR, const Patch& patch);

private:
    std::array<dsp::Oscillator, kMaxUnison> oscs_;
    std::array<float, kMaxUnison> panL_{}, panR_{};
    dsp::Oscillator subOsc_;
    dsp::Envelope amp_, filtEnv_;
    dsp::SvFilter filterL_, filterR_;

    double sampleRate_ = 44100.0;
    int note_ = 60;
    float velocity_ = 0.8f;
    int voices_ = 1;
    float baseCutoff_ = 1000.0f;
    uint64_t startStamp_ = 0;
};

/** A note captured while recording, before it has been fitted. */
struct PendingNote {
    double startSec = 0.0;
    int pitch = 0;
    float velocity = 0.0f;
};

class Engine {
public:
    static constexpr int kVoices = 16;

    void prepare(double sampleRate, int blockSize);
    void render(float* left, float* right, int numSamples);

    // --- playing ----------------------------------------------------------
    void noteOn(int midiNote, float velocity);
    void noteOff(int midiNote);
    void allNotesOff();

    // --- recording --------------------------------------------------------
    /** Begin capturing. Timestamps run from this call, on the audio clock. */
    void armRecording();
    bool recording() const { return recording_.load(std::memory_order_relaxed); }
    /** Stop capturing, infer the grid, and install the result as the loop. */
    Take finishRecording(const FitOptions& opts);
    void clearTake();

    // --- transport --------------------------------------------------------
    void setPlaying(bool shouldPlay);
    bool playing() const { return playing_.load(std::memory_order_relaxed); }
    /** Position through the loop, 0..1, for the UI. */
    double loopPhase() const { return loopPhase_.load(std::memory_order_relaxed); }
    double bpm() const { return take_.fit.bpm; }

    const Take& take() const { return take_; }
    void setTake(const Take& t);

    Patch& patch() { return patch_; }
    const Patch& patch() const { return patch_; }

    /** Peak of the last block, for metering. */
    float outputPeak() const { return peak_.load(std::memory_order_relaxed); }

    /** How many notes are currently sounding. */
    int activeVoices() const;

private:
    void triggerScheduledNotes(double loopStartBeats, double loopEndBeats);
    Voice* allocateVoice();

    std::array<Voice, kVoices> voices_;
    Patch patch_;

    double sampleRate_ = 44100.0;
    uint64_t sampleClock_ = 0;
    uint64_t stampCounter_ = 0;

    std::atomic<bool> playing_{ false };
    std::atomic<bool> recording_{ false };
    std::atomic<double> loopPhase_{ 0.0 };
    std::atomic<float> peak_{ 0.0f };

    // Recording state, written on the audio thread.
    uint64_t recordStartSample_ = 0;
    std::vector<PendingNote> held_;
    std::vector<RawNote> captured_;
    std::mutex captureLock_;

    // Playback state.
    Take take_;
    double playheadBeats_ = 0.0;
    std::vector<char> firedThisPass_;
    std::mutex takeLock_;
};

} // namespace motif
