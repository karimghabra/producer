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
#include "music/Automation.h"
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
    std::array<double, kMaxUnison> baseHz_{};
    dsp::Oscillator subOsc_;
    dsp::Oscillator modOsc_;            // FM modulator
    dsp::Envelope amp_, filtEnv_;
    dsp::SvFilter filterL_, filterR_;

    double sampleRate_ = 44100.0;
    int note_ = 60;
    float velocity_ = 0.8f;
    int voices_ = 1;
    float baseCutoff_ = 1000.0f;
    double carrierHz_ = 440.0;
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
    /**
     * Play a note on the armed track.
     *
     * `atSec` is when the note was actually played, on whatever clock the
     * caller has, or negative to mean "now".
     *
     * It matters because notes arrive over HTTP, and a request can be queued
     * behind others or overtaken by a later one. Timestamping on arrival meant
     * the recorded rhythm was the rhythm of the network rather than the
     * rhythm of the playing - fine when idle, and wrong exactly when the
     * interface is busy. Only relative times are used, so the caller's clock
     * needs no relationship to ours beyond being steady.
     */
    void noteOn(int midiNote, float velocity, double atSec = -1.0);
    void noteOff(int midiNote, double atSec = -1.0);
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

    // --- arrangement --------------------------------------------------------
    /** Position within the arrangement, in bars. Meaningless outside song mode. */
    double songBar() const { return songBar_.load(std::memory_order_relaxed); }
    /** Which section is playing, or -1. */
    int currentSection() const { return section_.load(std::memory_order_relaxed); }
    /** Start the arrangement again from the top. */
    void rewindSong();

    float outputPeak() const { return peak_.load(std::memory_order_relaxed); }
    /** Post-fader level of one track, 0..1, for its meter. */
    float trackPeak(int trackIndex) const;
    /** How hard the limiter is working, 0..1, for the meter. */
    float limiterReduction() const { return reduction_.load(std::memory_order_relaxed); }
    int activeVoiceCount() const;

private:
    struct SynthSlot {
        Voice voice;
        int track = -1;
        /**
         * When the sequencer should let this note go, in beats.
         *
         * Negative means nobody will: a note played by hand is held until the
         * key comes up. A note fired by the sequencer has a length, and
         * without this nothing ever released it - every sequenced synth note
         * sustained until the voice pool stole it, which is a drone rather
         * than a part.
         */
        double releaseAt = -1.0;
    };
    struct DrumSlot { DrumVoice voice; int track = -1; };

    void fireStep(int trackIndex, const Track& track, const Pattern& pattern,
                  int stepIndex, long long passIndex);
    bool conditionPasses(const TrigCondition& cond, long long pass, long long stepCounter) const;
    /** Returns the slot, not the voice: the caller has to set when it ends. */
    SynthSlot* allocateSynthVoice(int trackIndex);
    DrumVoice* allocateDrumVoice(int trackIndex);

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

        /** The channel filter. Two, because the track is already stereo here. */
        dsp::SvFilter filterL, filterR;
        /** Decaying post-fader peak, held on the audio thread. */
        float peak = 0.0f;
    };
    std::array<TrackRuntime, kMaxTracks> runtime_;

    /**
     * Meter levels, published for the interface to read.
     *
     * Separate from the runtime copy because this is the one crossing threads:
     * the audio thread stores, the message thread loads, and neither waits for
     * the other. A meter that tore would only ever be off by one frame, but
     * the race itself is undefined behaviour.
     */
    std::array<std::atomic<float>, kMaxTracks> trackPeaks_{};

    /**
     * The mixer values in effect for the current block, after automation.
     *
     * A member rather than a local, so the render loop refills storage it
     * already has instead of allocating a vector on the audio thread every few
     * milliseconds. Reserved once in prepare().
     */
    AutomationState live_;

    Song song_;
    mutable std::mutex songLock_;

    double sampleRate_ = 44100.0;
    double beatsPerSample_ = 0.0;
    double positionBeatsLocal_ = 0.0;
    uint64_t sampleClock_ = 0;
    uint64_t stampCounter_ = 0;

    std::atomic<bool> playing_{ false };
    std::atomic<bool> recording_{ false };

    // Arrangement playback. songBar_ is the position; section_ is which stretch
    // that lands in, published so the interface can follow it.
    std::atomic<double> songBar_{ 0.0 };
    std::atomic<int> section_{ -1 };
    /** Pattern chosen by the current scene, per track. -1 means "as the song says". */
    std::array<int, kMaxTracks> scenePattern_{};
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
