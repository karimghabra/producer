#include "audio/Engine.h"

#include <algorithm>
#include <cmath>

namespace motif {
namespace {

inline double midiToHz(double note) {
    return 440.0 * std::pow(2.0, (note - 69.0) / 12.0);
}

/**
 * Unison detune spacing, in cents.
 *
 * Not an even spread. The JP-8000's supersaw is the reference here and its
 * oscillators sit at uneven offsets, which is most of why it sounds like one
 * thick voice rather than several thin ones fighting.
 */
const float kUnisonOffsets[Voice::kMaxUnison] = {
    -1.0f, -0.5716f, -0.1775f, 0.0f, 0.1775f, 0.5716f, 1.0f
};

} // namespace

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

void Voice::prepare(double sampleRate) {
    sampleRate_ = sampleRate;
    for (auto& o : oscs_) o.setSampleRate(sampleRate);
    subOsc_.setSampleRate(sampleRate);
    subOsc_.setWave(dsp::Wave::Sine);
    amp_.setSampleRate(sampleRate);
    filtEnv_.setSampleRate(sampleRate);
    filterL_.setSampleRate(sampleRate);
    filterR_.setSampleRate(sampleRate);
    amp_.reset();
    filtEnv_.reset();
}

void Voice::start(int midiNote, float velocity, const Patch& patch) {
    note_ = midiNote;
    velocity_ = dsp::clampf(velocity, 0.0f, 1.0f);
    voices_ = std::clamp(patch.unison, 1, kMaxUnison);

    const double base = double(midiNote + patch.octave * 12);
    const double hz = midiToHz(base);

    // Detune depth rises steeply at the top of the knob, which is how the
    // control on the original behaves and why small settings stay usable.
    const double depthCents = std::pow(double(patch.detune), 2.4) * 55.0;

    for (int i = 0; i < voices_; ++i) {
        // Resample the seven-oscillator spacing onto however many we are using.
        const float t = voices_ == 1 ? 0.0f
                                     : float(i) / float(voices_ - 1) * float(kMaxUnison - 1);
        const int lo = int(t);
        const int hi = std::min(kMaxUnison - 1, lo + 1);
        const float frac = t - float(lo);
        const float rel = kUnisonOffsets[lo] * (1.0f - frac) + kUnisonOffsets[hi] * frac;

        oscs_[size_t(i)].setWave(patch.wave);
        oscs_[size_t(i)].setFrequency(hz * std::pow(2.0, (rel * depthCents) / 1200.0));
        // Random start phase: identical phases would sum into one loud spike on
        // every note and make the unison stack pointless for the first cycle.
        oscs_[size_t(i)].resetPhase(double(i) * 0.137 + 0.0193 * double(midiNote % 7));

        const float pos = voices_ == 1 ? 0.0f
                                       : (float(i) / float(voices_ - 1) * 2.0f - 1.0f) * patch.spread;
        // Equal power, so widening the stack does not change its loudness.
        const float angle = (dsp::clampf(pos, -1.0f, 1.0f) + 1.0f) * 0.25f * float(dsp::kPi);
        panL_[size_t(i)] = std::cos(angle);
        panR_[size_t(i)] = std::sin(angle);
    }

    subOsc_.setFrequency(hz * 0.5);
    subOsc_.resetPhase(0.0);

    baseCutoff_ = dsp::clampf(patch.cutoff * std::pow(2.0f, patch.keyTrack * float(base - 60.0) / 12.0f),
                              30.0f, 18000.0f);

    amp_.attack = patch.ampAttack; amp_.decay = patch.ampDecay;
    amp_.sustain = patch.ampSustain; amp_.release = patch.ampRelease;
    filtEnv_.attack = patch.fltAttack; filtEnv_.decay = patch.fltDecay;
    filtEnv_.sustain = patch.fltSustain; filtEnv_.release = patch.fltRelease;

    filterL_.reset();
    filterR_.reset();
    amp_.noteOn();
    filtEnv_.noteOn();
}

void Voice::release() {
    amp_.noteOff();
    filtEnv_.noteOff();
}

void Voice::kill() {
    amp_.reset();
    filtEnv_.reset();
}

void Voice::render(float& outL, float& outR, const Patch& patch) {
    if (!amp_.active()) return;

    const float ampVal = amp_.next();
    const float envVal = filtEnv_.next();

    // Filter cutoff, per sample. Sweeping this hard is exactly why the filter
    // is a TPT state variable rather than a biquad.
    const float cutoff = dsp::clampf(baseCutoff_ * std::pow(2.0f, patch.filterEnv * envVal),
                                     30.0f, float(sampleRate_ * 0.45));
    filterL_.set(cutoff, patch.resonance);
    filterR_.set(cutoff, patch.resonance);

    float l = 0.0f, r = 0.0f;
    for (int i = 0; i < voices_; ++i) {
        const float s = oscs_[size_t(i)].next();
        l += s * panL_[size_t(i)];
        r += s * panR_[size_t(i)];
    }
    // Incoherent sources sum as the square root of their count.
    const float norm = 1.0f / std::sqrt(float(voices_));
    l *= norm;
    r *= norm;

    if (patch.sub > 0.001f) {
        const float s = subOsc_.next() * patch.sub * 0.7f;
        l += s;
        r += s;
    }

    l = filterL_.next(l);
    r = filterR_.next(r);

    const float g = ampVal * velocity_ * 0.5f;
    l = dsp::saturate(l * g, patch.drive);
    r = dsp::saturate(r * g, patch.drive);

    outL += l;
    outR += r;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

void Engine::prepare(double sampleRate, int /*blockSize*/) {
    sampleRate_ = sampleRate > 0.0 ? sampleRate : 44100.0;
    for (auto& v : voices_) v.prepare(sampleRate_);
    sampleClock_ = 0;
    playheadBeats_ = 0.0;
}

Voice* Engine::allocateVoice() {
    Voice* free = nullptr;
    Voice* oldest = &voices_[0];
    for (auto& v : voices_) {
        if (!v.active()) { free = &v; break; }
        if (v.age() < oldest->age()) oldest = &v;
    }
    Voice* chosen = free ? free : oldest;
    if (!free) chosen->kill();          // steal, with the envelope reset cleanly
    chosen->setStamp(++stampCounter_);
    return chosen;
}

void Engine::noteOn(int midiNote, float velocity) {
    Voice* v = allocateVoice();
    v->start(midiNote, velocity, patch_);

    if (recording_.load(std::memory_order_relaxed)) {
        std::lock_guard<std::mutex> lock(captureLock_);
        const double t = double(sampleClock_ - recordStartSample_) / sampleRate_;
        held_.push_back({ t, midiNote, velocity });
    }
}

void Engine::noteOff(int midiNote) {
    for (auto& v : voices_) {
        if (v.active() && v.note() == midiNote) v.release();
    }

    if (recording_.load(std::memory_order_relaxed)) {
        std::lock_guard<std::mutex> lock(captureLock_);
        const double t = double(sampleClock_ - recordStartSample_) / sampleRate_;
        for (auto it = held_.rbegin(); it != held_.rend(); ++it) {
            if (it->pitch == midiNote) {
                captured_.push_back({ it->startSec, t, it->pitch, it->velocity });
                held_.erase(std::next(it).base());
                break;
            }
        }
    }
}

void Engine::allNotesOff() {
    for (auto& v : voices_) if (v.active()) v.release();
}

int Engine::activeVoices() const {
    int n = 0;
    for (const auto& v : voices_) if (v.active()) ++n;
    return n;
}

// --- recording -------------------------------------------------------------

void Engine::armRecording() {
    std::lock_guard<std::mutex> lock(captureLock_);
    captured_.clear();
    held_.clear();
    recordStartSample_ = sampleClock_;
    recording_.store(true, std::memory_order_relaxed);
}

Take Engine::finishRecording(const FitOptions& opts) {
    recording_.store(false, std::memory_order_relaxed);

    std::vector<RawNote> notes;
    {
        std::lock_guard<std::mutex> lock(captureLock_);
        // Anything still held when recording stopped ends now rather than
        // being thrown away — a note you were still holding is still a note.
        const double t = double(sampleClock_ - recordStartSample_) / sampleRate_;
        for (const auto& h : held_) captured_.push_back({ h.startSec, t, h.pitch, h.velocity });
        held_.clear();
        notes = captured_;
    }

    std::sort(notes.begin(), notes.end(),
              [](const RawNote& a, const RawNote& b) { return a.startSec < b.startSec; });

    Take fitted = fitTake(notes, opts);
    setTake(fitted);
    return fitted;
}

void Engine::clearTake() {
    std::lock_guard<std::mutex> lock(takeLock_);
    take_ = Take{};
    playheadBeats_ = 0.0;
}

void Engine::setTake(const Take& t) {
    std::lock_guard<std::mutex> lock(takeLock_);
    take_ = t;
    firedThisPass_.assign(t.fitted.size(), char(0));
    playheadBeats_ = 0.0;
}

void Engine::setPlaying(bool shouldPlay) {
    playing_.store(shouldPlay, std::memory_order_relaxed);
    if (!shouldPlay) {
        allNotesOff();
    } else {
        std::lock_guard<std::mutex> lock(takeLock_);
        playheadBeats_ = 0.0;
        std::fill(firedThisPass_.begin(), firedThisPass_.end(), char(0));
    }
}

// --- render ----------------------------------------------------------------

void Engine::render(float* left, float* right, int numSamples) {
    std::fill(left, left + numSamples, 0.0f);
    std::fill(right, right + numSamples, 0.0f);

    const bool isPlaying = playing_.load(std::memory_order_relaxed);

    // Sequencer. Advance in beats and fire anything the playhead crosses.
    if (isPlaying) {
        std::unique_lock<std::mutex> lock(takeLock_, std::try_to_lock);
        if (lock.owns_lock() && !take_.fitted.empty()) {
            const double beatsPerSample = take_.fit.bpm / 60.0 / sampleRate_;
            const double loopBeats = take_.beatsPerLoop();
            const double blockBeats = beatsPerSample * double(numSamples);
            const double from = playheadBeats_;
            double to = from + blockBeats;

            triggerScheduledNotes(from, to);

            if (to >= loopBeats) {
                to -= loopBeats;
                std::fill(firedThisPass_.begin(), firedThisPass_.end(), char(0));
                triggerScheduledNotes(0.0, to);
            }
            playheadBeats_ = to;
            loopPhase_.store(loopBeats > 0.0 ? playheadBeats_ / loopBeats : 0.0,
                             std::memory_order_relaxed);
        }
    }

    // Voices.
    for (int i = 0; i < numSamples; ++i) {
        float l = 0.0f, r = 0.0f;
        for (auto& v : voices_) v.render(l, r, patch_);

        l *= patch_.gain;
        r *= patch_.gain;

        // Last line of defence: the output can never leave [-1, 1] no matter
        // how many voices land on the same sample.
        left[i] = dsp::softClip(l);
        right[i] = dsp::softClip(r);
    }

    sampleClock_ += uint64_t(numSamples);

    float peak = 0.0f;
    for (int i = 0; i < numSamples; ++i) peak = std::max(peak, std::abs(left[i]));
    peak_.store(peak, std::memory_order_relaxed);
}

void Engine::triggerScheduledNotes(double fromBeats, double toBeats) {
    for (size_t i = 0; i < take_.fitted.size(); ++i) {
        if (firedThisPass_[i]) continue;
        const double s = take_.fitted[i].startBeats;
        if (s >= fromBeats && s < toBeats) {
            const auto& n = take_.fitted[i];
            Voice* v = allocateVoice();
            v->start(n.pitch, n.velocity, patch_);
            firedThisPass_[i] = 1;
        }
    }
    // Release notes whose length has run out.
    for (size_t i = 0; i < take_.fitted.size(); ++i) {
        const auto& n = take_.fitted[i];
        const double end = n.startBeats + n.lengthBeats;
        if (end >= fromBeats && end < toBeats) {
            for (auto& v : voices_) {
                if (v.active() && v.note() == n.pitch) { v.release(); break; }
            }
        }
    }
}

} // namespace motif
