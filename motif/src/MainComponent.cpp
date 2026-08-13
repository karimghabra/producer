#include "MainComponent.h"

#include "ui/Theme.h"

using namespace motif::ui;

namespace motif {
namespace {

constexpr int kBaseNote = 48;   // C3 on the home row

bool isBlackKey(int midi) {
    switch (((midi % 12) + 12) % 12) {
        case 1: case 3: case 6: case 8: case 10: return true;
        default: return false;
    }
}

juce::String subdivisionName(int subdiv) {
    switch (subdiv) {
        case 1: return "1/4";
        case 2: return "1/8";
        case 3: return "1/8T";
        case 4: return "1/16";
        case 6: return "1/16T";
        case 8: return "1/32";
        default: return juce::String(subdiv);
    }
}

} // namespace

// ---------------------------------------------------------------------------

MainComponent::MainComponent() {
    setSize(1240, 780);
    setWantsKeyboardFocus(true);

    keyMap_ = {
        { 'A', 0,  false }, { 'W', 1,  true  }, { 'S', 2,  false }, { 'E', 3,  true  },
        { 'D', 4,  false }, { 'F', 5,  false }, { 'T', 6,  true  }, { 'G', 7,  false },
        { 'Y', 8,  true  }, { 'H', 9,  false }, { 'U', 10, true  }, { 'J', 11, false },
        { 'K', 12, false }, { 'O', 13, true  }, { 'L', 14, false }, { 'P', 15, true  },
    };

    engine_.setSong(makeDefaultSong());
    song_ = engine_.song();
    for (size_t i = 0; i < song_.tracks.size(); ++i) {
        if (song_.tracks[i].armed) { selectedTrack_ = int(i); break; }
    }

    setAudioChannels(0, 2);
    startTimerHz(60);
}

MainComponent::~MainComponent() { shutdownAudio(); }

void MainComponent::prepareToPlay(int blockSize, double sampleRate) {
    engine_.prepare(sampleRate, blockSize);
}

void MainComponent::getNextAudioBlock(const juce::AudioSourceChannelInfo& info) {
    auto* buffer = info.buffer;
    if (buffer->getNumChannels() < 2) { info.clearActiveBufferRegion(); return; }
    engine_.render(buffer->getWritePointer(0, info.startSample),
                   buffer->getWritePointer(1, info.startSample),
                   info.numSamples);
}

void MainComponent::releaseResources() {}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

void MainComponent::timerCallback() {
    song_ = engine_.song();
    pollKeyboard();

    if (engine_.recording()) {
        recPulse_ += 0.055f;
        if (recPulse_ > juce::MathConstants<float>::twoPi)
            recPulse_ -= juce::MathConstants<float>::twoPi;
    }
    if (fitReveal_ < 1.0f) fitReveal_ = juce::jmin(1.0f, fitReveal_ + 0.035f);
    repaint();
}

void MainComponent::pollKeyboard() {
    if (!hasKeyboardFocus(true)) {
        for (int n = 0; n < 128; ++n) {
            if (noteSounding_[size_t(n)]) { engine_.noteOff(n); noteSounding_[size_t(n)] = false; }
        }
        return;
    }
    for (const auto& km : keyMap_) {
        const int note = kBaseNote + km.semitone + octaveOffset_ * 12;
        if (note < 0 || note > 127) continue;
        const bool down = juce::KeyPress::isKeyCurrentlyDown(km.keyCode);
        if (down && !noteSounding_[size_t(note)]) {
            engine_.noteOn(note, 0.85f);
            noteSounding_[size_t(note)] = true;
        } else if (!down && noteSounding_[size_t(note)]) {
            engine_.noteOff(note);
            noteSounding_[size_t(note)] = false;
        }
    }
}

bool MainComponent::keyPressed(const juce::KeyPress& key) {
    if (key == juce::KeyPress::spaceKey) { togglePlay(); return true; }
    const auto c = key.getTextCharacter();
    if (c == 'r' || c == 'R') { toggleRecord(); return true; }
    if (key == juce::KeyPress::leftKey)  { octaveOffset_ = juce::jlimit(-3, 3, octaveOffset_ - 1); return true; }
    if (key == juce::KeyPress::rightKey) { octaveOffset_ = juce::jlimit(-3, 3, octaveOffset_ + 1); return true; }
    if (key == juce::KeyPress::upKey)   { selectTrack(selectedTrack_ - 1); return true; }
    if (key == juce::KeyPress::downKey) { selectTrack(selectedTrack_ + 1); return true; }
    return false;
}

void MainComponent::selectTrack(int index) {
    if (song_.tracks.empty()) return;
    selectedTrack_ = juce::jlimit(0, int(song_.tracks.size()) - 1, index);
    const int sel = selectedTrack_;
    engine_.editSong([sel](Song& s) {
        for (size_t i = 0; i < s.tracks.size(); ++i) s.tracks[i].armed = (int(i) == sel);
    });
}

void MainComponent::toggleRecord() {
    if (engine_.recording()) {
        take_ = engine_.finishRecording(fitOptions_);
        takeIsCommitted_ = false;
        fitReveal_ = 0.0f;
        if (!take_.fitted.empty()) {
            int lo = 127, hi = 0;
            for (const auto& n : take_.fitted) { lo = juce::jmin(lo, n.pitch); hi = juce::jmax(hi, n.pitch); }
            lowPitch_ = juce::jmax(0, lo - 3);
            highPitch_ = juce::jmin(127, hi + 3);
            if (highPitch_ - lowPitch_ < 12) highPitch_ = lowPitch_ + 12;
            // The tempo the performance implied becomes the song's tempo when
            // there is nothing else established yet.
            commitTakeToTrack();
            engine_.setPlaying(true);
        }
    } else {
        engine_.armRecording();
    }
}

/** Turn the fitted take into a pattern on the selected track. */
void MainComponent::commitTakeToTrack() {
    if (take_.fitted.empty() || song_.tracks.empty()) return;
    const int index = juce::jlimit(0, int(song_.tracks.size()) - 1, selectedTrack_);
    const Take take = take_;
    const bool useTakeTempo = take.fit.confidence > 0.5;

    engine_.editSong([index, take, useTakeTempo](Song& s) {
        if (index >= int(s.tracks.size())) return;
        Track& t = s.tracks[size_t(index)];
        Pattern p = patternFromTake(take, s.key, !t.instrument.isDrum);
        p.name = "Take";
        t.patterns.push_back(std::move(p));
        t.activePattern = int(t.patterns.size()) - 1;
        t.seqEnabled = true;
        if (useTakeTempo) {
            s.bpm = take.fit.bpm;
            s.barsPerLoop = take.fit.bars;
        }
    });
    takeIsCommitted_ = true;
    song_ = engine_.song();
}

void MainComponent::togglePlay() { engine_.setPlaying(!engine_.playing()); }

void MainComponent::refit() {
    if (take_.raw.empty()) return;
    take_ = fitTake(take_.raw, fitOptions_);
    fitReveal_ = 0.0f;
    if (takeIsCommitted_) {
        // Replace the pattern this take produced rather than stacking another.
        const int index = juce::jlimit(0, int(song_.tracks.size()) - 1, selectedTrack_);
        const Take take = take_;
        engine_.editSong([index, take](Song& s) {
            if (index >= int(s.tracks.size())) return;
            Track& t = s.tracks[size_t(index)];
            if (t.patterns.empty()) return;
            t.patterns.back() = patternFromTake(take, s.key, !t.instrument.isDrum);
            t.patterns.back().name = "Take";
            t.activePattern = int(t.patterns.size()) - 1;
        });
        song_ = engine_.song();
    }
}

void MainComponent::addTrack(bool drum) {
    engine_.editSong([drum](Song& s) {
        Track t;
        t.name = drum ? "Drum" : "Synth";
        t.instrument.isDrum = drum;
        static const uint32_t kColours[] = {
            0xff5ee6c5, 0xffffb86b, 0xffc77dff, 0xff4cc9f0, 0xffff5c7a, 0xffffd479, 0xff8ef6a0
        };
        t.colour = kColours[s.tracks.size() % 7];
        t.patterns = { Pattern{} };
        s.tracks.push_back(std::move(t));
    });
    song_ = engine_.song();
    selectTrack(int(song_.tracks.size()) - 1);
}

void MainComponent::removeSelectedTrack() {
    if (song_.tracks.size() <= 1) return;
    const int index = selectedTrack_;
    engine_.editSong([index](Song& s) {
        if (index >= 0 && index < int(s.tracks.size()))
            s.tracks.erase(s.tracks.begin() + index);
    });
    song_ = engine_.song();
    selectTrack(juce::jmin(selectedTrack_, int(song_.tracks.size()) - 1));
}

void MainComponent::mouseDown(const juce::MouseEvent& e) {
    grabKeyboardFocus();
    const auto p = e.getPosition();

    if (recButton_.contains(p))  { toggleRecord(); return; }
    if (playButton_.contains(p)) { togglePlay(); return; }
    if (keepButton_.contains(p)) { commitTakeToTrack(); return; }
    if (addSynthButton_.contains(p)) { addTrack(false); return; }
    if (addDrumButton_.contains(p))  { addTrack(true); return; }
    if (strengthSlider_.contains(p)) { draggingStrength_ = true; mouseDrag(e); return; }
    if (swingToggle_.contains(p)) { fitOptions_.keepSwing = !fitOptions_.keepSwing; refit(); return; }

    for (size_t i = 0; i < trackRows_.size(); ++i) {
        if (!trackRows_[i].contains(p)) continue;
        // The right-hand strip toggles mute; the rest selects.
        const auto muteZone = trackRows_[i].removeFromRight(30);
        if (muteZone.contains(p)) {
            const int idx = int(i);
            engine_.editSong([idx](Song& s) {
                if (idx < int(s.tracks.size())) s.tracks[size_t(idx)].mixer.mute = !s.tracks[size_t(idx)].mixer.mute;
            });
            song_ = engine_.song();
        } else {
            selectTrack(int(i));
        }
        return;
    }
}

void MainComponent::mouseDrag(const juce::MouseEvent& e) {
    if (!draggingStrength_) return;
    const float t = juce::jlimit(0.0f, 1.0f,
        float(e.x - strengthSlider_.getX()) / float(juce::jmax(1, strengthSlider_.getWidth())));
    fitOptions_.strength = double(t);
    refit();
}

void MainComponent::mouseUp(const juce::MouseEvent&) { draggingStrength_ = false; }

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

void MainComponent::resized() {
    auto area = getLocalBounds().reduced(16);

    headerArea_ = area.removeFromTop(56);
    area.removeFromTop(12);

    keyboardArea_ = area.removeFromBottom(88);
    area.removeFromBottom(12);
    controlArea_ = area.removeFromBottom(80);
    area.removeFromBottom(12);
    readoutArea_ = area.removeFromBottom(70);
    area.removeFromBottom(12);

    railArea_ = area.removeFromLeft(240);
    area.removeFromLeft(12);
    takeArea_ = area;

    auto btns = headerArea_.withTrimmedLeft(140).withWidth(400).reduced(0, 8);
    recButton_ = btns.removeFromLeft(120);
    btns.removeFromLeft(8);
    playButton_ = btns.removeFromLeft(110);
    btns.removeFromLeft(8);
    keepButton_ = btns.removeFromLeft(110);

    auto ctl = controlArea_.reduced(16, 14);
    strengthSlider_ = ctl.removeFromLeft(300).withTrimmedTop(26).withHeight(14);
    ctl.removeFromLeft(70);
    swingToggle_ = ctl.removeFromLeft(120).withTrimmedTop(22).withHeight(26);
    ctl.removeFromLeft(20);
    addSynthButton_ = ctl.removeFromLeft(110).withTrimmedTop(22).withHeight(26);
    ctl.removeFromLeft(8);
    addDrumButton_ = ctl.removeFromLeft(110).withTrimmedTop(22).withHeight(26);
}

float MainComponent::beatToX(double beats) const {
    const auto inner = takeArea_.reduced(14, 12).toFloat();
    const double total = juce::jmax(1.0, take_.beatsPerLoop());
    return inner.getX() + float(beats / total) * inner.getWidth();
}

float MainComponent::pitchToY(int pitch) const {
    const auto inner = takeArea_.reduced(14, 12).toFloat();
    const float span = float(juce::jmax(1, highPitch_ - lowPitch_));
    return inner.getY() + (1.0f - float(pitch - lowPitch_) / span) * inner.getHeight();
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

void MainComponent::paint(juce::Graphics& g) {
    g.fillAll(colour::ink0);
    juce::ColourGradient bg(colour::ink1.brighter(0.04f),
                            float(getWidth()) * 0.55f, float(takeArea_.getCentreY()),
                            colour::ink0, 0.0f, float(getHeight()), true);
    g.setGradientFill(bg);
    g.fillAll();

    paintHeader(g);
    paintTrackRail(g);
    paintTakeView(g);
    paintReadouts(g);
    paintControls(g);
    paintKeyboard(g);
}

void MainComponent::paintHeader(juce::Graphics& g) {
    auto area = headerArea_;
    g.setColour(colour::text);
    g.setFont(uiFont(25.0f, true));
    g.drawText("MOTIF", area.removeFromLeft(126).reduced(2, 0),
               juce::Justification::centredLeft, false);

    const bool rec = engine_.recording();
    const bool playing = engine_.playing();

    auto button = [&](juce::Rectangle<int> b, const juce::String& text,
                      juce::Colour tint, bool on, float glow) {
        const auto f = b.toFloat();
        if (on) drawGlow(g, f, tint, glow, 9.0f);
        g.setColour(on ? tint.withAlpha(0.20f) : colour::ink2);
        g.fillRoundedRectangle(f, 9.0f);
        g.setColour(on ? tint : colour::line);
        g.drawRoundedRectangle(f.reduced(0.5f), 9.0f, 1.2f);
        g.setColour(on ? tint : colour::dim);
        g.setFont(uiFont(12.5f, true));
        g.drawText(text, b, juce::Justification::centred, false);
    };

    button(recButton_, rec ? "RECORDING" : "RECORD", colour::hot, rec,
           rec ? 0.55f + 0.45f * std::sin(recPulse_) : 0.0f);
    button(playButton_, playing ? "PLAYING" : "PLAY", colour::fitted, playing, 0.7f);
    button(keepButton_, "KEEP TAKE", colour::played,
           !take_.fitted.empty() && !takeIsCommitted_, 0.6f);

    g.setColour(colour::dimmer);
    g.setFont(uiFont(11.0f));
    g.drawText("R record  \xe2\x80\xa2  SPACE play  \xe2\x80\xa2  A\xe2\x80\x93K notes  \xe2\x80\xa2  \xe2\x86\x91\xe2\x86\x93 track  \xe2\x80\xa2  \xe2\x86\x90\xe2\x86\x92 octave",
               headerArea_, juce::Justification::centredRight, false);
}

void MainComponent::paintTrackRail(juce::Graphics& g) {
    drawPanel(g, railArea_.toFloat(), 12.0f);
    auto area = railArea_.reduced(10, 10);

    auto header = area.removeFromTop(18);
    drawCaption(g, header, "Tracks", colour::dimmer);
    g.setColour(colour::dimmer);
    g.setFont(monoFont(10.0f));
    g.drawText(juce::String(song_.tracks.size()), header, juce::Justification::centredRight, false);
    area.removeFromTop(6);

    trackRows_.clear();
    const int rowH = 46;
    for (size_t i = 0; i < song_.tracks.size() && area.getHeight() >= rowH; ++i) {
        const auto& track = song_.tracks[i];
        auto row = area.removeFromTop(rowH);
        area.removeFromTop(4);
        trackRows_.push_back(row);

        const bool selected = int(i) == selectedTrack_;
        const juce::Colour tint(track.colour);

        const auto rf = row.toFloat();
        g.setColour(selected ? tint.withAlpha(0.13f) : colour::ink2.withAlpha(0.55f));
        g.fillRoundedRectangle(rf, 7.0f);
        g.setColour(selected ? tint.withAlpha(0.8f) : colour::line);
        g.drawRoundedRectangle(rf.reduced(0.5f), 7.0f, selected ? 1.4f : 1.0f);

        auto inner = row.reduced(9, 6);

        // Colour stripe.
        g.setColour(tint);
        g.fillRoundedRectangle(float(inner.getX() - 4), float(inner.getY() + 2), 3.0f,
                               float(inner.getHeight() - 4), 1.5f);

        auto textArea = inner.withTrimmedLeft(6).withTrimmedRight(34);
        g.setColour(track.mixer.mute ? colour::dimmer : colour::text);
        g.setFont(uiFont(12.5f, true));
        g.drawText(track.name, textArea.removeFromTop(16), juce::Justification::centredLeft, false);

        g.setColour(colour::dimmer);
        g.setFont(uiFont(9.5f));
        const auto* pattern = track.current();
        juce::String sub = track.instrument.isDrum
            ? juce::String(drumEngineName(track.instrument.drumEngine))
            : juce::String("Synth");
        if (pattern) sub += "  \xc2\xb7  " + juce::String(pattern->name) + "  \xc2\xb7  " + juce::String(pattern->length);
        g.drawText(sub, textArea.removeFromTop(13), juce::Justification::centredLeft, false);

        // Step lights: the pattern in miniature, lit at the playing step.
        if (pattern) {
            auto lights = textArea.removeFromTop(8);
            const int n = juce::jmin(pattern->length, 32);
            const float w = float(lights.getWidth()) / float(juce::jmax(1, n));
            const int playing = engine_.trackStep(int(i));
            for (int s = 0; s < n; ++s) {
                const bool on = pattern->stepOn(s);
                const bool here = engine_.playing() && s == playing;
                juce::Rectangle<float> r(float(lights.getX()) + float(s) * w, float(lights.getY()),
                                         juce::jmax(1.5f, w - 1.5f), 5.0f);
                g.setColour(here ? colour::gold : (on ? tint.withAlpha(0.85f) : colour::line));
                g.fillRoundedRectangle(r, 1.5f);
            }
        }

        // Mute strip on the right.
        auto muteZone = row.removeFromRight(30);
        g.setColour(track.mixer.mute ? colour::hot : colour::dimmer.withAlpha(0.5f));
        g.setFont(uiFont(11.0f, true));
        g.drawText(track.mixer.mute ? "M" : "\xe2\x97\x8f", muteZone, juce::Justification::centred, false);
    }
}

void MainComponent::paintTakeView(juce::Graphics& g) {
    drawPanel(g, takeArea_.toFloat(), 12.0f);
    const auto inner = takeArea_.reduced(14, 12).toFloat();

    if (take_.fitted.empty()) {
        g.setColour(colour::dimmer);
        g.setFont(uiFont(14.5f));
        g.drawText(engine_.recording()
                       ? "Playing\xe2\x80\xa6 press R again when you have the idea down"
                       : "Press R and play something. Motif works out the rest.",
                   takeArea_, juce::Justification::centred, false);
        return;
    }

    const auto& fit = take_.fit;
    const double totalBeats = take_.beatsPerLoop();
    const double stepBeats = 1.0 / double(fit.subdivision);

    for (double b = 0.0; b <= totalBeats + 1e-9; b += stepBeats) {
        const float x = beatToX(b);
        const bool isBar = std::fmod(b, double(fit.beatsPerBar)) < 1e-6;
        const bool isBeat = std::fmod(b, 1.0) < 1e-6;
        g.setColour(isBar ? colour::line.brighter(0.45f) : isBeat ? colour::line : colour::lineSoft);
        g.drawVerticalLine(int(x), inner.getY(), inner.getBottom());
    }

    for (int p = lowPitch_; p <= highPitch_; ++p) {
        if (!isBlackKey(p)) continue;
        const float y0 = pitchToY(p), y1 = pitchToY(p - 1);
        g.setColour(juce::Colours::white.withAlpha(0.013f));
        g.fillRect(inner.getX(), y0, inner.getWidth(), y1 - y0);
    }

    const float laneH = juce::jmax(4.0f, inner.getHeight() / float(highPitch_ - lowPitch_ + 1));
    const double secPerBeat = 60.0 / fit.bpm;

    for (size_t i = 0; i < take_.fitted.size(); ++i) {
        const auto& f = take_.fitted[i];
        const double rawBeats = (i < take_.raw.size())
            ? (take_.raw[i].startSec - fit.phaseSec) / secPerBeat
            : f.startBeats;

        const float yTop = pitchToY(f.pitch) - laneH * 0.5f;
        const float h = juce::jmax(3.0f, laneH - 2.0f);
        const float xPlayed = beatToX(rawBeats);
        const float xFitted = beatToX(f.startBeats);
        const float w = juce::jmax(4.0f, beatToX(f.startBeats + f.lengthBeats) - xFitted - 1.0f);

        // The correction, drawn. This is the whole point of the view.
        if (std::abs(xPlayed - xFitted) > 0.6f) {
            g.setColour(colour::played.withAlpha(0.32f));
            g.drawRoundedRectangle({ xPlayed, yTop, w, h }, 3.0f, 1.0f);
            g.setColour(colour::played.withAlpha(0.18f));
            g.drawLine(xPlayed, yTop + h * 0.5f, xFitted, yTop + h * 0.5f, 1.0f);
        }

        const float x = xPlayed + (xFitted - xPlayed) * fitReveal_;
        juce::Rectangle<float> r(x, yTop, w, h);
        juce::ColourGradient grad(colour::fitted.brighter(0.25f), r.getX(), r.getY(),
                                  colour::fitted.darker(0.30f), r.getX(), r.getBottom(), false);
        g.setGradientFill(grad);
        g.fillRoundedRectangle(r, 3.0f);
        g.setColour(colour::fitted.brighter(0.5f).withAlpha(0.85f));
        g.drawRoundedRectangle(r.reduced(0.5f), 3.0f, 1.0f);
    }

    if (engine_.playing() && totalBeats > 0.0) {
        const double loopPos = std::fmod(engine_.positionBeats(), totalBeats);
        const float x = inner.getX() + float(loopPos / totalBeats) * inner.getWidth();
        g.setColour(colour::gold.withAlpha(0.18f));
        g.fillRect(x - 5.0f, inner.getY(), 10.0f, inner.getHeight());
        g.setColour(colour::gold);
        g.drawLine(x, inner.getY(), x, inner.getBottom(), 1.6f);
    }

    g.setColour(colour::played);
    g.setFont(uiFont(10.0f, true));
    g.drawText("AS PLAYED", takeArea_.reduced(16, 9).removeFromTop(13),
               juce::Justification::topRight, false);
    g.setColour(colour::fitted);
    g.drawText("AS FITTED", takeArea_.reduced(16, 9).removeFromTop(27).removeFromBottom(13),
               juce::Justification::topRight, false);
}

void MainComponent::paintReadouts(juce::Graphics& g) {
    drawPanel(g, readoutArea_.toFloat(), 12.0f);
    auto area = readoutArea_.reduced(16, 11);

    const auto& fit = take_.fit;
    const bool has = !take_.fitted.empty();
    const int cols = 6;
    const int w = area.getWidth() / cols;

    auto cell = [&](const juce::String& label, const juce::String& value, juce::Colour tint) {
        drawReadout(g, area.removeFromLeft(w), label, value, tint);
    };

    cell("Tempo",  juce::String(song_.bpm, 1), colour::text);
    cell("Grid",   has ? subdivisionName(fit.subdivision) : "\xe2\x80\x94", colour::fitted);
    cell("Length", juce::String(song_.barsPerLoop) + (song_.barsPerLoop == 1 ? " bar" : " bars"), colour::text);
    cell("Fit",    has ? juce::String(int(fit.confidence * 100.0)) + "%" : "\xe2\x80\x94",
                   fit.confidence > 0.75 ? colour::fitted : colour::gold);
    cell("Swing",  has ? juce::String(int(fit.swing * 100.0)) + "%" : "\xe2\x80\x94", colour::played);
    cell("Cycle",  juce::String(int(song_.polymeterCycle())) + " st", colour::dim);
}

void MainComponent::paintControls(juce::Graphics& g) {
    drawPanel(g, controlArea_.toFloat(), 12.0f);

    drawCaption(g, strengthSlider_.withY(strengthSlider_.getY() - 22).withHeight(14),
                "Fit strength", colour::dimmer);

    const auto b = strengthSlider_.toFloat();
    g.setColour(colour::ink0);
    g.fillRoundedRectangle(b, b.getHeight() * 0.5f);
    g.setColour(colour::line);
    g.drawRoundedRectangle(b.reduced(0.5f), b.getHeight() * 0.5f, 1.0f);

    const float t = float(fitOptions_.strength);
    auto filled = b.withWidth(juce::jmax(b.getHeight(), b.getWidth() * t));
    juce::ColourGradient grad(colour::played, filled.getX(), 0.0f,
                              colour::fitted, filled.getRight(), 0.0f, false);
    g.setGradientFill(grad);
    g.fillRoundedRectangle(filled, filled.getHeight() * 0.5f);
    g.setColour(colour::text);
    g.fillEllipse(juce::Rectangle<float>(14.0f, 14.0f)
                      .withCentre({ b.getX() + b.getWidth() * t, b.getCentreY() }));

    g.setColour(colour::dim);
    g.setFont(monoFont(11.0f));
    g.drawText(juce::String(int(fitOptions_.strength * 100.0)) + "%",
               strengthSlider_.withX(strengthSlider_.getRight() + 10).withWidth(46),
               juce::Justification::centredLeft, false);
    g.setColour(colour::dimmer);
    g.setFont(uiFont(10.0f));
    g.drawText("0 = as played      100 = locked to the grid",
               strengthSlider_.withY(strengthSlider_.getBottom() + 5).withHeight(13).withWidth(300),
               juce::Justification::centredLeft, false);

    auto chip = [&](juce::Rectangle<int> r, const juce::String& text, juce::Colour tint, bool on) {
        const auto f = r.toFloat();
        g.setColour(on ? tint.withAlpha(0.18f) : colour::ink0);
        g.fillRoundedRectangle(f, 6.0f);
        g.setColour(on ? tint : colour::line);
        g.drawRoundedRectangle(f.reduced(0.5f), 6.0f, 1.0f);
        g.setColour(on ? tint : colour::dim);
        g.setFont(uiFont(11.0f, true));
        g.drawText(text, r, juce::Justification::centred, false);
    };

    chip(swingToggle_, "KEEP SWING", colour::played, fitOptions_.keepSwing);
    chip(addSynthButton_, "+ SYNTH TRACK", colour::fitted, false);
    chip(addDrumButton_, "+ DRUM TRACK", colour::fitted, false);
}

void MainComponent::paintKeyboard(juce::Graphics& g) {
    drawPanel(g, keyboardArea_.toFloat(), 12.0f);
    auto area = keyboardArea_.reduced(14, 12);

    int whites = 0;
    for (const auto& km : keyMap_) if (!km.black) ++whites;
    const float w = float(area.getWidth()) / float(juce::jmax(1, whites));

    const juce::Colour tint = song_.tracks.empty()
        ? colour::fitted
        : juce::Colour(song_.tracks[size_t(juce::jlimit(0, int(song_.tracks.size()) - 1,
                                                        selectedTrack_))].colour);

    float x = float(area.getX());
    for (const auto& km : keyMap_) {
        if (km.black) continue;
        const int note = kBaseNote + km.semitone + octaveOffset_ * 12;
        const bool down = note >= 0 && note < 128 && noteSounding_[size_t(note)];
        juce::Rectangle<float> r(x + 1.0f, float(area.getY()), w - 2.0f, float(area.getHeight()));
        if (down) drawGlow(g, r, tint, 0.8f, 4.0f);
        g.setColour(down ? tint.withAlpha(0.75f) : colour::ink2.brighter(0.08f));
        g.fillRoundedRectangle(r, 4.0f);
        g.setColour(colour::line);
        g.drawRoundedRectangle(r.reduced(0.5f), 4.0f, 1.0f);
        g.setColour(down ? colour::ink0 : colour::dimmer);
        g.setFont(uiFont(11.0f, true));
        g.drawText(juce::String::charToString(juce::juce_wchar(km.keyCode)),
                   r.reduced(4.0f).toNearestInt(), juce::Justification::centredBottom, false);
        x += w;
    }

    x = float(area.getX());
    int whiteIndex = 0;
    for (const auto& km : keyMap_) {
        if (!km.black) { ++whiteIndex; continue; }
        const int note = kBaseNote + km.semitone + octaveOffset_ * 12;
        const bool down = note >= 0 && note < 128 && noteSounding_[size_t(note)];
        const float cx = float(area.getX()) + float(whiteIndex) * w;
        juce::Rectangle<float> r(cx - w * 0.28f, float(area.getY()), w * 0.56f,
                                 float(area.getHeight()) * 0.6f);
        if (down) drawGlow(g, r, tint, 0.8f, 4.0f);
        g.setColour(down ? tint.withAlpha(0.85f) : colour::ink0);
        g.fillRoundedRectangle(r, 4.0f);
        g.setColour(colour::line);
        g.drawRoundedRectangle(r.reduced(0.5f), 4.0f, 1.0f);
        g.setColour(down ? colour::ink0 : colour::dimmer);
        g.setFont(uiFont(10.0f, true));
        g.drawText(juce::String::charToString(juce::juce_wchar(km.keyCode)),
                   r.reduced(3.0f).toNearestInt(), juce::Justification::centredBottom, false);
    }

    g.setColour(colour::dimmer);
    g.setFont(monoFont(10.0f));
    g.drawText("OCT " + juce::String(octaveOffset_ >= 0 ? "+" : "") + juce::String(octaveOffset_)
                   + "    \xe2\x86\x92 " + (song_.tracks.empty() ? juce::String("\xe2\x80\x94")
                       : juce::String(song_.tracks[size_t(juce::jlimit(0, int(song_.tracks.size()) - 1, selectedTrack_))].name)),
               keyboardArea_.reduced(16, 9), juce::Justification::topRight, false);
}

} // namespace motif
