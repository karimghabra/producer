#pragma once

// ---------------------------------------------------------------------------
// Motif — audio engine.
//
// A plain per-sample render loop. Nothing schedules automation against a graph;
// every value is computed for the sample being written, so a release starts
// from the level the envelope is actually at because we can simply read it.
//
// The sequencer advances in beats inside that same loop, which makes step
// timing sample-accurate without a separate scheduler or a lookahead window.
// ---------------------------------------------------------------------------

#include <array>
#include <atomic>
#include <functional>
#include <mutex>
#include <vector>

#include "audio/Drums.h"
#include "audio/Fx.h"
#include "dsp/Dsp.h"
#include "music/Quantizer.h"
#include "music/Song.h"

namespace motif {

/** One sounding synth note. */
class Voice {
public:
    static constexpr int kMaxUnison = 9;

    void prepare(double sampleRate);
    void start(int midiNote, float velocity, const Patch& patch);
    void release();
    void kill();

    bool active() const { return amp_.active(); }
    int note() const { return note_; }
    uint64_t age() const { return stamp_; }
    void setStamp(uint64_t s) { stamp_ = s; }

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
    uint64_t stamp_ = 0;
};

/** A note captured while recording, before it has been fitted. */
struct PendingNote {
    double startSec = 0.0;
    int pitch = 0;
    float velocity = 0.0f;
};

class Engine {
public:
    static constexpr int kSynthVoices = 24;
    static constexpr int kDrumVoices = 24;
    static constexpr int kMaxTracks = 32;

    void prepare(double sampleRate, int blockSize);
    void render(float* left, float* right, int numSamples);

    // --- the document -----------------------------------------------------
    /** Swap the song. Safe to call from the message thread. */
    void setSong(const Song& song);
    /** A copy, for the UI to read without racing the audio thread. */
    Song song() const;
    /** Edit under the lock: fn receives the live song. */
    void editSong(const std::function<void(Song&)>& fn);

    // --- playing ----------------------------------------------------------
    /** Play a note on the armed track. */
    void noteOn(int midiNote, float velocity);
    void noteOff(int midiNote);
    void allNotesOff();
    /** Fire a track's instrument once, ignoring the sequencer. */
    void auditionTrack(int trackIndex, int midiNote, float velocity);

    // --- recording --------------------------------------------------------
    void armRecording();
    bool recording() const { return recording_.load(std::memory_order_relaxed); }
    /** Stop capturing and fit. Does not install anything by itself. */
    Take finishRecording(const FitOptions& opts);

    // --- transport --------------------------------------------------------
    void setPlaying(bool shouldPlay);
    bool playing() const { return playing_.load(std::memory_order_relaxed); }
    void rewind();
    /** Position in beats since the transport started. */
    double positionBeats() const { return positionBeats_.load(std::memory_order_relaxed); }
    /** Which step of its own pattern each track is on, for the UI. */
    int trackStep(int trackIndex) const;

    float outputPeak() const { return peak_.load(std::memory_order_relaxed); }
    /** How hard the limiter is working, 0..1, for the meter. */
    float limiterReduction() const { return reduction_.load(std::memory_order_relaxed); }
    int activeVoiceCount() const;

private:
    void fireStep(int trackIndex, const Track& track, const Pattern& pattern,
                  int stepIndex, long long passIndex);
    bool conditionPasses(const TrigCondition& cond, long long pass, long long stepCounter) const;
    Voice* allocateSynthVoice(int trackIndex);
    DrumVoice* allocateDrumVoice(int trackIndex);

    struct SynthSlot { Voice voice; int track = -1; };
    struct DrumSlot { DrumVoice voice; int track = -1; };

    std::array<SynthSlot, kSynthVoices> synths_;
    std::array<DrumSlot, kDrumVoices> drums_;

    /** Per-track sequencer and ducking state. */
    struct TrackRuntime {
        double nextStepBeats = 0.0;
        long long stepCounter = 0;
        /** 0 at the moment of a duck, rising to 1 as it recovers. */
        float duckPhase = 1.0f;
        int lastStep = -1;
        /** Retriggers still owed on the current step, and when the next is due. */
        int ratchetsLeft = 0;
        int ratchetStep = -1;
        double ratchetInterval = 0.0;
        double nextRatchetBeats = 0.0;
        float ratchetVelocity = 0.0f;
    };
    std::array<TrackRuntime, kMaxTracks> runtime_;

    Song song_;
    mutable std::mutex songLock_;

    double sampleRate_ = 44100.0;
    double beatsPerSample_ = 0.0;
    double positionBeatsLocal_ = 0.0;
    uint64_t sampleClock_ = 0;
    uint64_t stampCounter_ = 0;

    std::atomic<bool> playing_{ false };
    std::atomic<bool> recording_{ false };
    std::atomic<double> positionBeats_{ 0.0 };
    std::atomic<float> peak_{ 0.0f };
    std::atomic<float> reduction_{ 0.0f };
    std::array<std::atomic<int>, kMaxTracks> stepDisplay_{};

    fx::Reverb reverb_;
    fx::PingPongDelay delay_;
    fx::Limiter limiter_;

    // Recording.
    uint64_t recordStartSample_ = 0;
    std::vector<PendingNote> held_;
    std::vector<RawNote> captured_;
    std::mutex captureLock_;

    // Sidechain recovery shape.
    float duckRelease_ = 0.24f;
    float duckCurve_ = 1.8f;
};

} // namespace motif
