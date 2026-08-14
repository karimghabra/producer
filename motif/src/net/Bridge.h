#pragma once

// ---------------------------------------------------------------------------
// Motif — the bridge between the audio engine and the interface.
//
// Audio stays in C++, where the sample-accurate render loop and the DSP live.
// The interface is a web page talking to this over localhost.
//
// The split is deliberate, not a compromise. C++ wins on audio: no garbage
// collector, no runtime, direct control of the audio thread. Canvas wins on
// pixels: the same total control over every drawn element, without hand-rolling
// hit testing and text layout, and without the display-scaling traps that come
// with owning a native window. And a web interface is one a browser can drive,
// which means it can be tested rather than eyeballed.
//
// Transport is plain HTTP on loopback. A socket would buy nothing here: a
// round trip on localhost is measured in microseconds, and the audio thread is
// never in the path — the UI reads a snapshot and posts commands.
// ---------------------------------------------------------------------------

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "music/Quantizer.h"

namespace httplib { class Server; }

namespace motif {

class Engine;

class Bridge {
public:
    Bridge(Engine& engine);
    ~Bridge();

    /**
     * Start serving. `webRoot` is the directory holding the interface; served
     * from disk rather than embedded so the UI can be edited and reloaded
     * without rebuilding the engine.
     *
     * Returns the port actually bound, or 0 on failure.
     */
    int start(const std::string& webRoot, int preferredPort = 7777);
    void stop();

    bool running() const { return running_.load(std::memory_order_relaxed); }
    int port() const { return port_; }

    /** Names of the connected MIDI inputs, for the interface to report. */
    void setMidiDevices(std::vector<std::string> names);

private:
    std::string stateJson() const;
    /** Note-level detail of the last take: played against fitted. */
    std::string takeJson() const;
    bool applyCommand(const std::string& body, std::string& error);

    /**
     * Stop recording, fit what was played, and install it on the armed track.
     *
     * Kept here rather than in the engine because it spans both: the engine
     * owns the captured notes, the song owns where they land, and the decision
     * to adopt the performance's tempo is a musical one rather than an audio
     * one.
     */
    void commitTake();

    /** Re-fit the take already captured, at the current options. */
    void refitTake();

    /** Replace the last installed take pattern with `take`. */
    void installTake(const Take& take, bool adoptTempo);

    Engine& engine_;
    std::unique_ptr<httplib::Server> server_;
    std::thread thread_;
    std::atomic<bool> running_{ false };
    int port_ = 0;

    // The last take, so the interface can show what was inferred and the fit
    // can be redone at a different strength without playing it again.
    mutable std::mutex takeMutex_;
    Take take_;
    FitOptions fitOptions_;
    int takeTrack_ = -1;
    int takePattern_ = -1;
    /** Bumped on every fit, so the interface knows when to fetch the detail. */
    int takeRev_ = 0;

    mutable std::mutex midiMutex_;
    std::vector<std::string> midiDevices_;
};

} // namespace motif
