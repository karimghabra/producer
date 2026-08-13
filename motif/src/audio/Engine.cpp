#include "audio/Engine.h"

#include <algorithm>
#include <cmath>
#include <functional>

namespace motif {
namespace {

inline double midiToHz(double note) { return 440.0 * std::pow(2.0, (note - 69.0) / 12.0); }

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
    velocity_ = dsp::clampf(velocity, 0.0f, 1.4f);
    voices_ = std::clamp(patch.unison, 1, kMaxUnison);

    const double base = double(midiNote + patch.octave * 12);
    const double hz = midiToHz(base);

    // The JP-8000 spacing, resampled to whatever voice count is in use. Even
    // spacing sounds like several thin voices; this sounds like one thick one.
    const auto cents = theory::unisonCents(voices_, double(patch.detune));

    for (int i = 0; i < voices_; ++i) {
        oscs_[size_t(i)].setWave(patch.wave);
        oscs_[size_t(i)].setFrequency(hz * std::pow(2.0, cents[size_t(i)] / 1200.0));
        // Spread the start phases. Identical phases would sum into one loud
        // spike on every note and waste the stack for its first cycle.
        oscs_[size_t(i)].resetPhase(std::fmod(double(i) * 0.137 + double(midiNote % 7) * 0.019, 1.0));

        const float pos = voices_ == 1
            ? 0.0f
            : (float(i) / float(voices_ - 1) * 2.0f - 1.0f) * patch.spread;
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

void Voice::release() { amp_.noteOff(); filtEnv_.noteOff(); }
void Voice::kill() { amp_.reset(); filtEnv_.reset(); }

void Voice::render(float& outL, float& outR, const Patch& patch) {
    if (!amp_.active()) return;

    const float ampVal = amp_.next();
    const float envVal = filtEnv_.next();

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
    outL += dsp::saturate(l * g, patch.drive);
    outR += dsp::saturate(r * g, patch.drive);
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

void Engine::prepare(double sampleRate, int /*blockSize*/) {
    sampleRate_ = sampleRate > 0.0 ? sampleRate : 44100.0;
    for (auto& s : synths_) s.voice.prepare(sampleRate_);
    for (auto& d : drums_) d.voice.prepare(sampleRate_);
    reverb_.prepare(sampleRate_);
    delay_.prepare(sampleRate_);
    limiter_.prepare(sampleRate_);
    sampleClock_ = 0;
    positionBeatsLocal_ = 0.0;
    if (song_.tracks.empty()) song_ = makeDefaultSong();
}

void Engine::setSong(const Song& song) {
    std::lock_guard<std::mutex> lock(songLock_);
    song_ = song;
    for (auto& r : runtime_) r = TrackRuntime{};
    positionBeatsLocal_ = 0.0;
}

Song Engine::song() const {
    std::lock_guard<std::mutex> lock(songLock_);
    return song_;
}

void Engine::editSong(const std::function<void(Song&)>& fn) {
    std::lock_guard<std::mutex> lock(songLock_);
    fn(song_);
}

// --- allocation ------------------------------------------------------------

Voice* Engine::allocateSynthVoice(int trackIndex) {
    SynthSlot* freeSlot = nullptr;
    SynthSlot* oldest = &synths_[0];
    for (auto& s : synths_) {
        if (!s.voice.active()) { freeSlot = &s; break; }
        if (s.voice.age() < oldest->voice.age()) oldest = &s;
    }
    SynthSlot* chosen = freeSlot ? freeSlot : oldest;
    if (!freeSlot) chosen->voice.kill();
    chosen->track = trackIndex;
    chosen->voice.setStamp(++stampCounter_);
    return &chosen->voice;
}

DrumVoice* Engine::allocateDrumVoice(int trackIndex) {
    for (auto& d : drums_) {
        if (!d.voice.active()) { d.track = trackIndex; return &d.voice; }
    }
    // All busy: take the first. Percussion is short, so this is rare and the
    // stolen voice is almost always nearly finished anyway.
    drums_[0].track = trackIndex;
    return &drums_[0].voice;
}

// --- playing ---------------------------------------------------------------

void Engine::noteOn(int midiNote, float velocity) {
    int armed = -1;
    Patch patch;
    bool isDrum = false;
    DrumEngine engine = DrumEngine::Kick;
    DrumParams drumParams;
    {
        std::lock_guard<std::mutex> lock(songLock_);
        for (size_t i = 0; i < song_.tracks.size(); ++i) {
            if (song_.tracks[i].armed) { armed = int(i); break; }
        }
        if (armed < 0 && !song_.tracks.empty()) armed = 0;
        if (armed >= 0) {
            const auto& t = song_.tracks[size_t(armed)];
            isDrum = t.instrument.isDrum;
            patch = t.instrument.synth;
            engine = t.instrument.drumEngine;
            drumParams = t.instrument.drum;
        }
    }
    if (armed < 0) return;

    if (isDrum) {
        allocateDrumVoice(armed)->trigger(engine, drumParams, velocity, float(midiNote - 60));
    } else {
        allocateSynthVoice(armed)->start(midiNote, velocity, patch);
    }

    if (recording_.load(std::memory_order_relaxed)) {
        std::lock_guard<std::mutex> lock(captureLock_);
        const double t = double(sampleClock_ - recordStartSample_) / sampleRate_;
        held_.push_back({ t, midiNote, velocity });
    }
}

void Engine::noteOff(int midiNote) {
    for (auto& s : synths_) {
        if (s.voice.active() && s.voice.note() == midiNote) s.voice.release();
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
    for (auto& s : synths_) if (s.voice.active()) s.voice.release();
}

void Engine::auditionTrack(int trackIndex, int midiNote, float velocity) {
    Patch patch;
    bool isDrum = false;
    DrumEngine engine = DrumEngine::Kick;
    DrumParams drumParams;
    {
        std::lock_guard<std::mutex> lock(songLock_);
        if (trackIndex < 0 || trackIndex >= int(song_.tracks.size())) return;
        const auto& t = song_.tracks[size_t(trackIndex)];
        isDrum = t.instrument.isDrum;
        patch = t.instrument.synth;
        engine = t.instrument.drumEngine;
        drumParams = t.instrument.drum;
    }
    if (isDrum) allocateDrumVoice(trackIndex)->trigger(engine, drumParams, velocity, float(midiNote - 60));
    else        allocateSynthVoice(trackIndex)->start(midiNote, velocity, patch);
}

int Engine::activeVoiceCount() const {
    int n = 0;
    for (const auto& s : synths_) if (s.voice.active()) ++n;
    for (const auto& d : drums_) if (d.voice.active()) ++n;
    return n;
}

int Engine::trackStep(int trackIndex) const {
    if (trackIndex < 0 || trackIndex >= kMaxTracks) return -1;
    return stepDisplay_[size_t(trackIndex)].load(std::memory_order_relaxed);
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
        // A note still held when recording stopped is still a note.
        const double t = double(sampleClock_ - recordStartSample_) / sampleRate_;
        for (const auto& h : held_) captured_.push_back({ h.startSec, t, h.pitch, h.velocity });
        held_.clear();
        notes = captured_;
    }

    std::sort(notes.begin(), notes.end(),
              [](const RawNote& a, const RawNote& b) { return a.startSec < b.startSec; });
    return fitTake(notes, opts);
}

void Engine::setPlaying(bool shouldPlay) {
    playing_.store(shouldPlay, std::memory_order_relaxed);
    if (!shouldPlay) allNotesOff();
    else rewind();
}

void Engine::rewind() {
    std::lock_guard<std::mutex> lock(songLock_);
    positionBeatsLocal_ = 0.0;
    for (auto& r : runtime_) r = TrackRuntime{};
}

// --- sequencing ------------------------------------------------------------

bool Engine::conditionPasses(const TrigCondition& cond, long long pass, long long stepCounter) const {
    switch (cond.type) {
        case TrigCondition::Type::Always: return true;
        case TrigCondition::Type::Probability:
            // Seeded by position, so a given step behaves the same way each
            // time round rather than flickering.
            return theory::hashRandom(stepCounter * 7919 + pass * 104729) < double(cond.chance);
        case TrigCondition::Type::Ratio: {
            const int of = std::max(1, cond.of);
            return ((pass % of) + of) % of == (cond.hit - 1) % of;
        }
        case TrigCondition::Type::First:    return pass == 0;
        case TrigCondition::Type::NotFirst: return pass > 0;
        case TrigCondition::Type::Fill:     return false;    // driven by the UI later
        case TrigCondition::Type::NotFill:  return true;
    }
    return true;
}

void Engine::fireStep(int trackIndex, const Track& track, const Pattern& pattern,
                      int stepIndex, long long passIndex) {
    if (stepIndex < 0 || stepIndex >= int(pattern.steps.size())) return;
    if (!pattern.stepOn(stepIndex)) return;

    const Step& step = pattern.steps[size_t(stepIndex)];
    auto& rt = runtime_[size_t(trackIndex)];
    if (!conditionPasses(step.cond, passIndex, rt.stepCounter)) return;

    const float velocity = std::clamp(step.velocity * (step.accent ? 1.25f : 1.0f), 0.0f, 1.3f);

    if (track.instrument.isDrum) {
        const int semis = theory::degreeToMidi(song_.key, step.degree, step.octave)
                        - theory::degreeToMidi(song_.key, 0, 0);
        allocateDrumVoice(trackIndex)->trigger(track.instrument.drumEngine, track.instrument.drum,
                                               velocity, float(semis));
    } else {
        const int midi = theory::degreeToMidi(song_.key, step.degree, step.octave);
        allocateSynthVoice(trackIndex)->start(midi, velocity, track.instrument.synth);
    }

    // Sidechain: the duck is triggered by the hit itself, at the same instant,
    // so it locks to the grid exactly rather than chasing a detector.
    if (trackIndex == song_.sidechainSource) {
        for (size_t i = 0; i < song_.tracks.size() && i < kMaxTracks; ++i) {
            if (song_.tracks[i].mixer.duck > 0.01f) runtime_[i].duckPhase = 0.0f;
        }
    }
}

// --- render ----------------------------------------------------------------

void Engine::render(float* left, float* right, int numSamples) {
    std::fill(left, left + numSamples, 0.0f);
    std::fill(right, right + numSamples, 0.0f);

    std::unique_lock<std::mutex> lock(songLock_, std::try_to_lock);
    if (!lock.owns_lock()) return;      // a block of silence beats a glitch

    const size_t trackCount = std::min(song_.tracks.size(), size_t(kMaxTracks));
    const bool isPlaying = playing_.load(std::memory_order_relaxed);
    const bool anySolo = song_.anySolo();
    beatsPerSample_ = song_.bpm / 60.0 / sampleRate_;
    const MasterFx& fxParams = song_.master;
    const float duckRelease = std::max(0.02f, fxParams.sidechainRelease);
    const float duckStep = float(1.0 / (double(duckRelease) * sampleRate_));
    duckCurve_ = fxParams.sidechainCurve;

    reverb_.setParams(fxParams.reverb.size, fxParams.reverb.damp, fxParams.reverb.width);
    delay_.setParams(song_.bpm, double(fxParams.delay.beats), fxParams.delay.feedback,
                     fxParams.delay.tone, fxParams.delay.pingpong);
    limiter_.setThreshold(fxParams.limiter ? 0.89f : 1.0f);

    std::array<float, kMaxTracks> trackL{}, trackR{};

    for (int n = 0; n < numSamples; ++n) {
        // --- sequencer, advanced in beats ---------------------------------
        if (isPlaying) {
            for (size_t t = 0; t < trackCount; ++t) {
                const Track& track = song_.tracks[t];
                if (!track.seqEnabled) continue;
                const Pattern* pattern = track.current();
                if (!pattern || pattern->steps.empty()) continue;

                auto& rt = runtime_[t];
                const double stepBeats = 1.0 / double(std::max(1, pattern->resolution));

                if (positionBeatsLocal_ >= rt.nextStepBeats) {
                    const long long absolute = rt.stepCounter;
                    const int index = int(((absolute % pattern->length) + pattern->length) % pattern->length);
                    const long long pass = absolute / pattern->length;

                    fireStep(int(t), track, *pattern, index, pass);
                    stepDisplay_[t].store(index, std::memory_order_relaxed);

                    ++rt.stepCounter;
                    // Swing and per-step nudge move the NEXT boundary rather
                    // than the note, which keeps the grid itself uniform.
                    const double swing = theory::swingOffset(int(rt.stepCounter), song_.swing, song_.swingUnit);
                    rt.nextStepBeats = double(rt.stepCounter) * stepBeats + swing * stepBeats;
                }
            }
            positionBeatsLocal_ += beatsPerSample_;
        }

        // --- voices --------------------------------------------------------
        trackL.fill(0.0f);
        trackR.fill(0.0f);

        for (auto& s : synths_) {
            if (!s.voice.active() || s.track < 0 || s.track >= int(trackCount)) continue;
            s.voice.render(trackL[size_t(s.track)], trackR[size_t(s.track)],
                           song_.tracks[size_t(s.track)].instrument.synth);
        }
        for (auto& d : drums_) {
            if (!d.voice.active() || d.track < 0 || d.track >= int(trackCount)) continue;
            d.voice.render(trackL[size_t(d.track)], trackR[size_t(d.track)]);
        }

        // --- mixer and sends -----------------------------------------------
        float dryL = 0.0f, dryR = 0.0f;
        float sendReverbL = 0.0f, sendReverbR = 0.0f;
        float sendDelayL = 0.0f, sendDelayR = 0.0f;

        for (size_t t = 0; t < trackCount; ++t) {
            const Mixer& m = song_.tracks[t].mixer;
            const bool audible = !m.mute && (!anySolo || m.solo);
            if (!audible) continue;

            auto& rt = runtime_[t];
            if (rt.duckPhase < 1.0f) rt.duckPhase = std::min(1.0f, rt.duckPhase + duckStep);
            // 1 - a*(1-x)^curve: above 1 the level hangs low then snaps back,
            // which is the pump; below 1 it lifts immediately.
            const float duck = 1.0f - m.duck * std::pow(1.0f - rt.duckPhase, duckCurve_);

            const float g = m.gain * duck;
            const float angle = (std::clamp(m.pan, -1.0f, 1.0f) + 1.0f) * 0.25f * float(dsp::kPi);
            const float l = trackL[t] * g * std::cos(angle);
            const float r = trackR[t] * g * std::sin(angle);

            dryL += l;
            dryR += r;
            // Sends are post-fader, so pulling a track down takes its effects
            // with it rather than leaving a ghost in the reverb.
            sendReverbL += l * m.reverbSend;
            sendReverbR += r * m.reverbSend;
            sendDelayL += l * m.delaySend;
            sendDelayR += r * m.delaySend;
        }

        float revL = 0.0f, revR = 0.0f, dlyL = 0.0f, dlyR = 0.0f;
        reverb_.process(sendReverbL, sendReverbR, revL, revR);
        delay_.process(sendDelayL, sendDelayR, dlyL, dlyR);

        float mixL = dryL + revL * fxParams.reverb.mix + dlyL * fxParams.delay.mix;
        float mixR = dryR + revR * fxParams.reverb.mix + dlyR * fxParams.delay.mix;

        if (fxParams.drive > 0.001f) {
            mixL = dsp::saturate(mixL, fxParams.drive);
            mixR = dsp::saturate(mixR, fxParams.drive);
        }

        mixL *= fxParams.gain;
        mixR *= fxParams.gain;

        limiter_.process(mixL, mixR, mixL, mixR);

        // Last line of defence: the output can never leave [-1, 1] however many
        // voices land on the same sample.
        left[n] = dsp::softClip(mixL);
        right[n] = dsp::softClip(mixR);
    }

    sampleClock_ += uint64_t(numSamples);
    if (isPlaying) positionBeats_.store(positionBeatsLocal_, std::memory_order_relaxed);

    float peak = 0.0f;
    for (int i = 0; i < numSamples; ++i) peak = std::max(peak, std::abs(left[i]));
    peak_.store(peak, std::memory_order_relaxed);
    reduction_.store(limiter_.reduction(), std::memory_order_relaxed);
}

} // namespace motif
