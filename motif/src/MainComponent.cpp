#include "MainComponent.h"

#include "ui/Theme.h"

using namespace motif::ui;

namespace motif {
namespace {

constexpr int kBaseNote = 48;

bool isBlackKey(int midi) {
    switch (((midi % 12) + 12) % 12) {
        case 1: case 3: case 6: case 8: case 10: return true;
        default: return false;
    }
}

juce::String subdivisionName(int subdiv) {
    switch (subdiv) {
        case 1: return "1/4";  case 2: return "1/8";  case 3: return "1/8T";
        case 4: return "1/16"; case 6: return "1/16T"; case 8: return "1/32";
        default: return juce::String(subdiv);
    }
}

// --- parameter mapping -----------------------------------------------------
// Frequencies and times are heard in ratios, so their knobs travel
// logarithmically; anything else is linear.

float lin(float v, float lo, float hi) { return juce::jlimit(0.0f, 1.0f, (v - lo) / (hi - lo)); }
float unlin(float n, float lo, float hi) { return lo + n * (hi - lo); }
float logn(float v, float lo, float hi) {
    return juce::jlimit(0.0f, 1.0f, std::log(juce::jmax(lo, v) / lo) / std::log(hi / lo));
}
float unlog(float n, float lo, float hi) { return lo * std::pow(hi / lo, n); }

juce::String hz(float v) {
    return v >= 1000.0f ? juce::String(v / 1000.0f, 1) + "k" : juce::String(int(v));
}
juce::String ms(float v) {
    return v >= 1.0f ? juce::String(v, 2) + "s" : juce::String(int(v * 1000.0f)) + "ms";
}
juce::String pct(float v) { return juce::String(int(v * 100.0f)); }

} // namespace

// ---------------------------------------------------------------------------

MainComponent::MainComponent() {
    setSize(1320, 820);
    setWantsKeyboardFocus(true);

    keyMap_ = {
        { 'A', 0,  false }, { 'W', 1,  true  }, { 'S', 2,  false }, { 'E', 3,  true  },
        { 'D', 4,  false }, { 'F', 5,  false }, { 'T', 6,  true  }, { 'G', 7,  false },
        { 'Y', 8,  true  }, { 'H', 9,  false }, { 'U', 10, true  }, { 'J', 11, false },
        { 'K', 12, false }, { 'O', 13, true  }, { 'L', 14, false }, { 'P', 15, true  },
    };

    engine_.setSong(makeDefaultSong());
    song_ = engine_.song();
    for (size_t i = 0; i < song_.tracks.size(); ++i)
        if (song_.tracks[i].armed) { selectedTrack_ = int(i); break; }

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

Track* MainComponent::selected() {
    if (song_.tracks.empty()) return nullptr;
    selectedTrack_ = juce::jlimit(0, int(song_.tracks.size()) - 1, selectedTrack_);
    return &song_.tracks[size_t(selectedTrack_)];
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

void MainComponent::addKnob(juce::Rectangle<int> b, const juce::String& label, float norm,
                            const juce::String& display, juce::Colour tint,
                            std::function<void(float)> onChange, bool bipolar, float defaultNorm) {
    knobs_.push_back({ b, label, display, juce::jlimit(0.0f, 1.0f, norm),
                       defaultNorm, tint, bipolar, std::move(onChange) });
}

void MainComponent::addHit(juce::Rectangle<int> b, std::function<void()> onClick) {
    hits_.push_back({ b, std::move(onClick) });
}

void MainComponent::drawChip(juce::Graphics& g, juce::Rectangle<int> b, const juce::String& text,
                             juce::Colour tint, bool on, std::function<void()> onClick) {
    const auto f = b.toFloat();
    g.setColour(on ? tint.withAlpha(0.18f) : colour::ink0);
    g.fillRoundedRectangle(f, 6.0f);
    g.setColour(on ? tint : colour::line);
    g.drawRoundedRectangle(f.reduced(0.5f), 6.0f, 1.0f);
    g.setColour(on ? tint : colour::dim);
    g.setFont(uiFont(10.5f, true));
    g.drawText(text, b, juce::Justification::centred, false);
    if (onClick) addHit(b, std::move(onClick));
}

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
        for (int n = 0; n < 128; ++n)
            if (noteSounding_[size_t(n)]) { engine_.noteOff(n); noteSounding_[size_t(n)] = false; }
        return;
    }
    for (const auto& km : keyMap_) {
        const int note = kBaseNote + km.semitone + octaveOffset_ * 12;
        if (note < 0 || note > 127) continue;
        const bool down = juce::KeyPress::isKeyCurrentlyDown(km.keyCode);
        if (down && !noteSounding_[size_t(note)]) {
            engine_.noteOn(note, 0.85f); noteSounding_[size_t(note)] = true;
        } else if (!down && noteSounding_[size_t(note)]) {
            engine_.noteOff(note); noteSounding_[size_t(note)] = false;
        }
    }
}

bool MainComponent::keyPressed(const juce::KeyPress& key) {
    if (key == juce::KeyPress::spaceKey) { togglePlay(); return true; }
    const auto c = key.getTextCharacter();
    if (c == 'r' || c == 'R') { toggleRecord(); return true; }
    if (c == '1') { view_ = View::Arrange; return true; }
    if (c == '2') { view_ = View::Mix; return true; }
    if (c == '3') { view_ = View::Sound; return true; }
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
            commitTakeToTrack();
            engine_.setPlaying(true);
            view_ = View::Arrange;
        }
    } else {
        engine_.armRecording();
    }
}

void MainComponent::commitTakeToTrack() {
    if (take_.fitted.empty() || song_.tracks.empty()) return;
    const int index = juce::jlimit(0, int(song_.tracks.size()) - 1, selectedTrack_);
    const Take take = take_;
    const bool useTempo = take.fit.confidence > 0.5;
    engine_.editSong([index, take, useTempo](Song& s) {
        if (index >= int(s.tracks.size())) return;
        Track& t = s.tracks[size_t(index)];
        Pattern p = patternFromTake(take, s.key, !t.instrument.isDrum);
        p.name = "Take";
        t.patterns.push_back(std::move(p));
        t.activePattern = int(t.patterns.size()) - 1;
        t.seqEnabled = true;
        if (useTempo) { s.bpm = take.fit.bpm; s.barsPerLoop = take.fit.bars; }
    });
    takeIsCommitted_ = true;
    song_ = engine_.song();
}

void MainComponent::togglePlay() { engine_.setPlaying(!engine_.playing()); }

void MainComponent::refit() {
    if (take_.raw.empty()) return;
    take_ = fitTake(take_.raw, fitOptions_);
    fitReveal_ = 0.0f;
    if (!takeIsCommitted_) return;
    const int index = juce::jlimit(0, int(song_.tracks.size()) - 1, selectedTrack_);
    const Take take = take_;
    engine_.editSong([index, take](Song& s) {
        if (index >= int(s.tracks.size())) return;
        Track& t = s.tracks[size_t(index)];
        if (t.patterns.empty()) return;
        t.patterns.back() = patternFromTake(take, s.key, !t.instrument.isDrum);
        t.patterns.back().name = "Take";
    });
    song_ = engine_.song();
}

void MainComponent::addTrack(bool drum) {
    engine_.editSong([drum](Song& s) {
        Track t;
        t.name = drum ? "Drum" : "Synth";
        t.instrument.isDrum = drum;
        static const uint32_t kColours[] = {
            0xff5ee6c5, 0xffffb86b, 0xffc77dff, 0xff4cc9f0, 0xffff5c7a, 0xffffd479, 0xff8ef6a0 };
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
        if (index >= 0 && index < int(s.tracks.size())) s.tracks.erase(s.tracks.begin() + index);
    });
    song_ = engine_.song();
    selectTrack(juce::jmin(selectedTrack_, int(song_.tracks.size()) - 1));
}

// --- mouse -----------------------------------------------------------------

void MainComponent::mouseDown(const juce::MouseEvent& e) {
    grabKeyboardFocus();
    const auto p = e.getPosition();

    for (size_t i = 0; i < knobs_.size(); ++i) {
        if (!knobs_[i].bounds.contains(p)) continue;
        draggingKnob_ = int(i);
        dragStartNorm_ = knobs_[i].normalised;
        dragStartY_ = p.y;
        return;
    }
    if (strengthSlider_.contains(p)) { draggingStrength_ = true; mouseDrag(e); return; }
    for (const auto& h : hits_) if (h.bounds.contains(p)) { h.onClick(); return; }
}

void MainComponent::mouseDrag(const juce::MouseEvent& e) {
    if (draggingKnob_ >= 0 && draggingKnob_ < int(knobs_.size())) {
        // Shift for fine: a knob needs both a coarse sweep and precision.
        const float scale = e.mods.isShiftDown() ? 600.0f : 170.0f;
        const float next = juce::jlimit(0.0f, 1.0f,
            dragStartNorm_ + float(dragStartY_ - e.y) / scale);
        knobs_[size_t(draggingKnob_)].onChange(next);
        song_ = engine_.song();
        return;
    }
    if (draggingStrength_) {
        const float t = juce::jlimit(0.0f, 1.0f,
            float(e.x - strengthSlider_.getX()) / float(juce::jmax(1, strengthSlider_.getWidth())));
        fitOptions_.strength = double(t);
        refit();
    }
}

void MainComponent::mouseUp(const juce::MouseEvent&) {
    draggingKnob_ = -1;
    draggingStrength_ = false;
}

void MainComponent::mouseDoubleClick(const juce::MouseEvent& e) {
    for (const auto& k : knobs_) {
        if (k.bounds.contains(e.getPosition())) { k.onChange(k.defaultNorm); song_ = engine_.song(); return; }
    }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

void MainComponent::resized() {
    auto area = getLocalBounds().reduced(16);

    headerArea_ = area.removeFromTop(54);
    area.removeFromTop(12);
    keyboardArea_ = area.removeFromBottom(84);
    area.removeFromBottom(10);
    stripArea_ = area.removeFromBottom(74);
    area.removeFromBottom(10);
    railArea_ = area.removeFromLeft(236);
    area.removeFromLeft(10);
    mainArea_ = area;

    auto btns = headerArea_.withTrimmedLeft(128).withWidth(370).reduced(0, 8);
    recButton_ = btns.removeFromLeft(116);
    btns.removeFromLeft(7);
    playButton_ = btns.removeFromLeft(104);
    btns.removeFromLeft(7);
    keepButton_ = btns.removeFromLeft(112);

    auto tabs = headerArea_.withTrimmedLeft(520).withWidth(300).reduced(0, 12);
    for (int i = 0; i < 3; ++i) { viewTabs_[size_t(i)] = tabs.removeFromLeft(96); tabs.removeFromLeft(4); }

    strengthSlider_ = stripArea_.reduced(16, 14).removeFromLeft(240).withTrimmedTop(24).withHeight(13);
}

float MainComponent::beatToX(double beats) const {
    const auto inner = mainArea_.reduced(14, 12).toFloat();
    const double total = juce::jmax(1.0, take_.beatsPerLoop());
    return inner.getX() + float(beats / total) * inner.getWidth();
}

float MainComponent::pitchToY(int pitch) const {
    const auto inner = mainArea_.reduced(14, 12).toFloat();
    const float span = float(juce::jmax(1, highPitch_ - lowPitch_));
    return inner.getY() + (1.0f - float(pitch - lowPitch_) / span) * inner.getHeight();
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

void MainComponent::paint(juce::Graphics& g) {
    knobs_.clear();
    hits_.clear();

    g.fillAll(colour::ink0);
    juce::ColourGradient bg(colour::ink1.brighter(0.04f),
                            float(getWidth()) * 0.55f, float(mainArea_.getCentreY()),
                            colour::ink0, 0.0f, float(getHeight()), true);
    g.setGradientFill(bg);
    g.fillAll();

    paintHeader(g);
    paintTrackRail(g);
    switch (view_) {
        case View::Arrange: paintArrangeView(g); break;
        case View::Mix:     paintMixView(g); break;
        case View::Sound:   paintSoundView(g); break;
    }
    paintTransportStrip(g);
    paintKeyboard(g);

    // Knobs are drawn last so their registration order matches hit testing.
    for (const auto& k : knobs_) {
        auto b = k.bounds;
        drawKnob(g, b.removeFromTop(b.getHeight() - 24).toFloat(), k.normalised, k.tint, k.bipolar);
        g.setColour(colour::dimmer);
        g.setFont(uiFont(8.5f, true));
        g.drawText(k.label.toUpperCase(), b.removeFromTop(11), juce::Justification::centred, false);
        g.setColour(colour::dim);
        g.setFont(monoFont(9.5f, true));
        g.drawText(k.display, b, juce::Justification::centred, false);
    }
}

void MainComponent::paintHeader(juce::Graphics& g) {
    auto area = headerArea_;
    g.setColour(colour::text);
    g.setFont(uiFont(24.0f, true));
    g.drawText("MOTIF", area.removeFromLeft(120).reduced(2, 0),
               juce::Justification::centredLeft, false);

    const bool rec = engine_.recording();
    const bool playing = engine_.playing();

    auto button = [&](juce::Rectangle<int> b, const juce::String& text, juce::Colour tint,
                      bool on, float glow, std::function<void()> onClick) {
        const auto f = b.toFloat();
        if (on) drawGlow(g, f, tint, glow, 9.0f);
        g.setColour(on ? tint.withAlpha(0.20f) : colour::ink2);
        g.fillRoundedRectangle(f, 9.0f);
        g.setColour(on ? tint : colour::line);
        g.drawRoundedRectangle(f.reduced(0.5f), 9.0f, 1.2f);
        g.setColour(on ? tint : colour::dim);
        g.setFont(uiFont(12.0f, true));
        g.drawText(text, b, juce::Justification::centred, false);
        addHit(b, std::move(onClick));
    };

    button(recButton_, rec ? "RECORDING" : "RECORD", colour::hot, rec,
           rec ? 0.55f + 0.45f * std::sin(recPulse_) : 0.0f, [this] { toggleRecord(); });
    button(playButton_, playing ? "PLAYING" : "PLAY", colour::fitted, playing, 0.7f,
           [this] { togglePlay(); });
    button(keepButton_, "KEEP TAKE", colour::played,
           !take_.fitted.empty() && !takeIsCommitted_, 0.6f, [this] { commitTakeToTrack(); });

    const char* names[3] = { "ARRANGE", "MIX", "SOUND" };
    const View views[3] = { View::Arrange, View::Mix, View::Sound };
    for (int i = 0; i < 3; ++i) {
        const bool on = view_ == views[i];
        const auto b = viewTabs_[size_t(i)];
        g.setColour(on ? colour::ink2.brighter(0.2f) : juce::Colours::transparentBlack);
        g.fillRoundedRectangle(b.toFloat(), 6.0f);
        g.setColour(on ? colour::fitted : colour::dimmer);
        g.setFont(uiFont(11.0f, true));
        g.drawText(names[i], b, juce::Justification::centred, false);
        const int idx = i;
        addHit(b, [this, idx, views] { view_ = views[idx]; });
    }

    g.setColour(colour::dimmer);
    g.setFont(uiFont(10.5f));
    g.drawText("R rec  \xe2\x80\xa2  SPACE play  \xe2\x80\xa2  1/2/3 views  \xe2\x80\xa2  A\xe2\x80\x93K notes  \xe2\x80\xa2  \xe2\x86\x91\xe2\x86\x93 track",
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
    area.removeFromTop(5);

    auto footer = area.removeFromBottom(28);
    trackRows_.clear();

    const int rowH = 44;
    for (size_t i = 0; i < song_.tracks.size() && area.getHeight() >= rowH; ++i) {
        const auto& track = song_.tracks[i];
        auto row = area.removeFromTop(rowH);
        area.removeFromTop(4);
        trackRows_.push_back(row);

        const bool sel = int(i) == selectedTrack_;
        const juce::Colour tint(track.colour);
        const auto rf = row.toFloat();
        g.setColour(sel ? tint.withAlpha(0.13f) : colour::ink2.withAlpha(0.5f));
        g.fillRoundedRectangle(rf, 7.0f);
        g.setColour(sel ? tint.withAlpha(0.85f) : colour::line);
        g.drawRoundedRectangle(rf.reduced(0.5f), 7.0f, sel ? 1.4f : 1.0f);

        auto inner = row.reduced(9, 5);
        g.setColour(tint);
        g.fillRoundedRectangle(float(inner.getX() - 4), float(inner.getY() + 2), 3.0f,
                               float(inner.getHeight() - 4), 1.5f);

        // Solo and mute on the right of each row.
        auto badges = inner.removeFromRight(46);
        auto soloB = badges.removeFromLeft(22).reduced(1, 6);
        auto muteB = badges.removeFromLeft(22).reduced(1, 6);
        const int idx = int(i);

        g.setColour(track.mixer.solo ? colour::gold : colour::line);
        g.fillRoundedRectangle(soloB.toFloat(), 3.0f);
        g.setColour(track.mixer.solo ? colour::ink0 : colour::dimmer);
        g.setFont(uiFont(9.0f, true));
        g.drawText("S", soloB, juce::Justification::centred, false);
        addHit(soloB, [this, idx] {
            engine_.editSong([idx](Song& s) {
                if (idx < int(s.tracks.size())) s.tracks[size_t(idx)].mixer.solo = !s.tracks[size_t(idx)].mixer.solo;
            });
            song_ = engine_.song();
        });

        g.setColour(track.mixer.mute ? colour::hot : colour::line);
        g.fillRoundedRectangle(muteB.toFloat(), 3.0f);
        g.setColour(track.mixer.mute ? juce::Colours::white : colour::dimmer);
        g.drawText("M", muteB, juce::Justification::centred, false);
        addHit(muteB, [this, idx] {
            engine_.editSong([idx](Song& s) {
                if (idx < int(s.tracks.size())) s.tracks[size_t(idx)].mixer.mute = !s.tracks[size_t(idx)].mixer.mute;
            });
            song_ = engine_.song();
        });

        g.setColour(track.mixer.mute ? colour::dimmer : colour::text);
        g.setFont(uiFont(12.0f, true));
        g.drawText(track.name, inner.removeFromTop(15), juce::Justification::centredLeft, false);

        g.setColour(colour::dimmer);
        g.setFont(uiFont(9.0f));
        const auto* pattern = track.current();
        juce::String sub = track.instrument.isDrum
            ? juce::String(drumEngineName(track.instrument.drumEngine)) : juce::String("Synth");
        if (pattern) sub += "  \xc2\xb7  " + juce::String(pattern->name);
        g.drawText(sub, inner.removeFromTop(12), juce::Justification::centredLeft, false);

        if (pattern) {
            auto lights = inner.removeFromTop(7);
            const int n = juce::jmin(pattern->length, 32);
            const float w = float(lights.getWidth()) / float(juce::jmax(1, n));
            const int here = engine_.trackStep(int(i));
            for (int s = 0; s < n; ++s) {
                juce::Rectangle<float> r(float(lights.getX()) + float(s) * w, float(lights.getY()),
                                         juce::jmax(1.5f, w - 1.5f), 5.0f);
                const bool on = pattern->stepOn(s);
                g.setColour(engine_.playing() && s == here ? colour::gold
                                                          : (on ? tint.withAlpha(0.85f) : colour::line));
                g.fillRoundedRectangle(r, 1.5f);
            }
        }

        addHit(row, [this, idx] { selectTrack(idx); });
    }

    auto addSynth = footer.removeFromLeft(footer.getWidth() / 2 - 3);
    footer.removeFromLeft(6);
    drawChip(g, addSynth, "+ SYNTH", colour::fitted, false, [this] { addTrack(false); });
    drawChip(g, footer, "+ DRUM", colour::fitted, false, [this] { addTrack(true); });
}

// --- arrange ---------------------------------------------------------------

void MainComponent::paintArrangeView(juce::Graphics& g) {
    drawPanel(g, mainArea_.toFloat(), 12.0f);
    const auto inner = mainArea_.reduced(14, 12).toFloat();

    if (take_.fitted.empty()) {
        g.setColour(colour::dimmer);
        g.setFont(uiFont(14.5f));
        g.drawText(engine_.recording()
                       ? "Playing\xe2\x80\xa6 press R again when you have the idea down"
                       : "Press R and play something. Motif works out the rest.",
                   mainArea_, juce::Justification::centred, false);
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
        g.setColour(juce::Colours::white.withAlpha(0.013f));
        g.fillRect(inner.getX(), pitchToY(p), inner.getWidth(), pitchToY(p - 1) - pitchToY(p));
    }

    const float laneH = juce::jmax(4.0f, inner.getHeight() / float(highPitch_ - lowPitch_ + 1));
    const double secPerBeat = 60.0 / fit.bpm;
    for (size_t i = 0; i < take_.fitted.size(); ++i) {
        const auto& f = take_.fitted[i];
        const double rawBeats = i < take_.raw.size()
            ? (take_.raw[i].startSec - fit.phaseSec) / secPerBeat : f.startBeats;
        const float yTop = pitchToY(f.pitch) - laneH * 0.5f;
        const float h = juce::jmax(3.0f, laneH - 2.0f);
        const float xPlayed = beatToX(rawBeats), xFitted = beatToX(f.startBeats);
        const float w = juce::jmax(4.0f, beatToX(f.startBeats + f.lengthBeats) - xFitted - 1.0f);

        if (std::abs(xPlayed - xFitted) > 0.6f) {
            g.setColour(colour::played.withAlpha(0.32f));
            g.drawRoundedRectangle({ xPlayed, yTop, w, h }, 3.0f, 1.0f);
            g.setColour(colour::played.withAlpha(0.18f));
            g.drawLine(xPlayed, yTop + h * 0.5f, xFitted, yTop + h * 0.5f, 1.0f);
        }
        const float x = xPlayed + (xFitted - xPlayed) * fitReveal_;
        juce::Rectangle<float> r(x, yTop, w, h);
        juce::ColourGradient grad(colour::fitted.brighter(0.25f), r.getX(), r.getY(),
                                  colour::fitted.darker(0.3f), r.getX(), r.getBottom(), false);
        g.setGradientFill(grad);
        g.fillRoundedRectangle(r, 3.0f);
        g.setColour(colour::fitted.brighter(0.5f).withAlpha(0.85f));
        g.drawRoundedRectangle(r.reduced(0.5f), 3.0f, 1.0f);
    }

    if (engine_.playing() && totalBeats > 0.0) {
        const double pos = std::fmod(engine_.positionBeats(), totalBeats);
        const float x = inner.getX() + float(pos / totalBeats) * inner.getWidth();
        g.setColour(colour::gold.withAlpha(0.18f));
        g.fillRect(x - 5.0f, inner.getY(), 10.0f, inner.getHeight());
        g.setColour(colour::gold);
        g.drawLine(x, inner.getY(), x, inner.getBottom(), 1.6f);
    }

    g.setColour(colour::played);
    g.setFont(uiFont(10.0f, true));
    g.drawText("AS PLAYED", mainArea_.reduced(16, 9).removeFromTop(13), juce::Justification::topRight, false);
    g.setColour(colour::fitted);
    g.drawText("AS FITTED", mainArea_.reduced(16, 9).removeFromTop(27).removeFromBottom(13),
               juce::Justification::topRight, false);
}

// --- mix -------------------------------------------------------------------

void MainComponent::paintMixView(juce::Graphics& g) {
    auto area = mainArea_;
    auto masterArea = area.removeFromBottom(184);
    area.removeFromBottom(10);

    drawPanel(g, area.toFloat(), 12.0f);
    auto strips = area.reduced(12, 10);
    drawCaption(g, strips.removeFromTop(16), "Channels", colour::dimmer);
    strips.removeFromTop(4);

    const int n = juce::jmax(1, int(song_.tracks.size()));
    const int stripW = juce::jmin(132, strips.getWidth() / n);

    for (size_t i = 0; i < song_.tracks.size(); ++i) {
        auto strip = strips.removeFromLeft(stripW).reduced(3, 0);
        const auto& track = song_.tracks[i];
        const juce::Colour tint(track.colour);
        const int idx = int(i);

        g.setColour(int(i) == selectedTrack_ ? tint.withAlpha(0.10f) : colour::ink2.withAlpha(0.45f));
        g.fillRoundedRectangle(strip.toFloat(), 8.0f);
        g.setColour(int(i) == selectedTrack_ ? tint.withAlpha(0.7f) : colour::line);
        g.drawRoundedRectangle(strip.toFloat().reduced(0.5f), 8.0f, 1.0f);

        auto s = strip.reduced(6, 8);
        g.setColour(tint);
        g.setFont(uiFont(11.0f, true));
        g.drawText(track.name, s.removeFromTop(15), juce::Justification::centred, false);
        s.removeFromTop(2);

        auto edit = [this, idx](std::function<void(Mixer&)> fn) {
            return [this, idx, fn] {
                engine_.editSong([idx, fn](Song& song) {
                    if (idx < int(song.tracks.size())) fn(song.tracks[size_t(idx)].mixer);
                });
                song_ = engine_.song();
            };
        };

        const int kh = 58;
        auto row1 = s.removeFromTop(kh);
        addKnob(row1.removeFromLeft(row1.getWidth() / 2), "Level", lin(track.mixer.gain, 0.0f, 1.5f),
                pct(track.mixer.gain / 1.5f), tint,
                [this, idx](float v) { engine_.editSong([idx, v](Song& s2) {
                    if (idx < int(s2.tracks.size())) s2.tracks[size_t(idx)].mixer.gain = unlin(v, 0.0f, 1.5f); }); },
                false, lin(0.85f, 0.0f, 1.5f));
        addKnob(row1, "Pan", lin(track.mixer.pan, -1.0f, 1.0f),
                std::abs(track.mixer.pan) < 0.02f ? "C"
                    : (track.mixer.pan < 0 ? "L" : "R") + juce::String(int(std::abs(track.mixer.pan) * 100)),
                tint,
                [this, idx](float v) { engine_.editSong([idx, v](Song& s2) {
                    if (idx < int(s2.tracks.size())) s2.tracks[size_t(idx)].mixer.pan = unlin(v, -1.0f, 1.0f); }); },
                true, 0.5f);

        auto row2 = s.removeFromTop(kh);
        addKnob(row2.removeFromLeft(row2.getWidth() / 2), "Verb", track.mixer.reverbSend,
                pct(track.mixer.reverbSend), colour::played,
                [this, idx](float v) { engine_.editSong([idx, v](Song& s2) {
                    if (idx < int(s2.tracks.size())) s2.tracks[size_t(idx)].mixer.reverbSend = v; }); });
        addKnob(row2, "Delay", track.mixer.delaySend, pct(track.mixer.delaySend), colour::played,
                [this, idx](float v) { engine_.editSong([idx, v](Song& s2) {
                    if (idx < int(s2.tracks.size())) s2.tracks[size_t(idx)].mixer.delaySend = v; }); });

        auto row3 = s.removeFromTop(kh);
        addKnob(row3, "Sidechain", track.mixer.duck, pct(track.mixer.duck), colour::gold,
                [this, idx](float v) { engine_.editSong([idx, v](Song& s2) {
                    if (idx < int(s2.tracks.size())) s2.tracks[size_t(idx)].mixer.duck = v; }); });

        juce::ignoreUnused(edit);
    }

    // --- master ------------------------------------------------------------
    drawPanel(g, masterArea.toFloat(), 12.0f);
    auto m = masterArea.reduced(14, 10);
    drawCaption(g, m.removeFromTop(16), "Master", colour::dimmer);
    m.removeFromTop(4);

    auto setMaster = [this](std::function<void(MasterFx&)> fn) {
        engine_.editSong([fn](Song& s) { fn(s.master); });
        song_ = engine_.song();
    };
    const auto& mx = song_.master;
    const int kh = 62;
    auto row = m.removeFromTop(kh);
    const int kw = row.getWidth() / 11;

    addKnob(row.removeFromLeft(kw), "Volume", lin(mx.gain, 0.0f, 1.4f), pct(mx.gain / 1.4f),
            colour::fitted, [setMaster](float v) { setMaster([v](MasterFx& f) { f.gain = unlin(v, 0.0f, 1.4f); }); },
            false, lin(0.85f, 0.0f, 1.4f));
    addKnob(row.removeFromLeft(kw), "Drive", mx.drive, pct(mx.drive), colour::hot,
            [setMaster](float v) { setMaster([v](MasterFx& f) { f.drive = v; }); });

    addKnob(row.removeFromLeft(kw), "Verb size", mx.reverb.size, pct(mx.reverb.size), colour::played,
            [setMaster](float v) { setMaster([v](MasterFx& f) { f.reverb.size = v; }); });
    addKnob(row.removeFromLeft(kw), "Damp", mx.reverb.damp, pct(mx.reverb.damp), colour::played,
            [setMaster](float v) { setMaster([v](MasterFx& f) { f.reverb.damp = v; }); });
    addKnob(row.removeFromLeft(kw), "Width", mx.reverb.width, pct(mx.reverb.width), colour::played,
            [setMaster](float v) { setMaster([v](MasterFx& f) { f.reverb.width = v; }); });
    addKnob(row.removeFromLeft(kw), "Verb mix", mx.reverb.mix, pct(mx.reverb.mix), colour::played,
            [setMaster](float v) { setMaster([v](MasterFx& f) { f.reverb.mix = v; }); });

    addKnob(row.removeFromLeft(kw), "Time", lin(mx.delay.beats, 0.125f, 2.0f),
            juce::String(mx.delay.beats, 2) + "b", colour::accent2(),
            [setMaster](float v) { setMaster([v](MasterFx& f) { f.delay.beats = unlin(v, 0.125f, 2.0f); }); },
            false, lin(0.75f, 0.125f, 2.0f));
    addKnob(row.removeFromLeft(kw), "Feedback", lin(mx.delay.feedback, 0.0f, 0.95f), pct(mx.delay.feedback),
            colour::accent2(),
            [setMaster](float v) { setMaster([v](MasterFx& f) { f.delay.feedback = unlin(v, 0.0f, 0.95f); }); });
    addKnob(row.removeFromLeft(kw), "Tone", logn(mx.delay.tone, 200.0f, 18000.0f), hz(mx.delay.tone),
            colour::accent2(),
            [setMaster](float v) { setMaster([v](MasterFx& f) { f.delay.tone = unlog(v, 200.0f, 18000.0f); }); });
    addKnob(row.removeFromLeft(kw), "Ping-pong", mx.delay.pingpong, pct(mx.delay.pingpong), colour::accent2(),
            [setMaster](float v) { setMaster([v](MasterFx& f) { f.delay.pingpong = v; }); });
    addKnob(row.removeFromLeft(kw), "Delay mix", mx.delay.mix, pct(mx.delay.mix), colour::accent2(),
            [setMaster](float v) { setMaster([v](MasterFx& f) { f.delay.mix = v; }); });

    m.removeFromTop(6);
    auto bottom = m.removeFromTop(24);
    drawChip(g, bottom.removeFromLeft(120), "LIMITER", colour::fitted, mx.limiter,
             [setMaster, on = mx.limiter] { setMaster([on](MasterFx& f) { f.limiter = !on; }); });
    bottom.removeFromLeft(10);

    // Limiter activity, so you can see it working rather than guess.
    const float red = engine_.limiterReduction();
    auto meter = bottom.removeFromLeft(180).reduced(0, 6);
    g.setColour(colour::ink0);
    g.fillRoundedRectangle(meter.toFloat(), 3.0f);
    g.setColour(red > 0.25f ? colour::hot : colour::gold);
    g.fillRoundedRectangle(meter.toFloat().withWidth(meter.getWidth() * juce::jlimit(0.0f, 1.0f, red * 3.0f)), 3.0f);
    g.setColour(colour::dimmer);
    g.setFont(uiFont(9.5f));
    g.drawText("  gain reduction", bottom, juce::Justification::centredLeft, false);
}

// --- sound -----------------------------------------------------------------

void MainComponent::paintSoundView(juce::Graphics& g) {
    drawPanel(g, mainArea_.toFloat(), 12.0f);
    Track* track = selected();
    if (!track) return;

    auto area = mainArea_.reduced(16, 12);
    const juce::Colour tint(track->colour);
    const int idx = selectedTrack_;

    auto head = area.removeFromTop(22);
    g.setColour(tint);
    g.setFont(uiFont(15.0f, true));
    g.drawText(track->name, head.removeFromLeft(180), juce::Justification::centredLeft, false);
    drawChip(g, head.removeFromRight(110), "DELETE TRACK", colour::hot, false,
             [this] { removeSelectedTrack(); });
    area.removeFromTop(8);

    auto setDrum = [this, idx](std::function<void(DrumParams&)> fn) {
        engine_.editSong([idx, fn](Song& s) {
            if (idx < int(s.tracks.size())) fn(s.tracks[size_t(idx)].instrument.drum); });
        song_ = engine_.song();
    };
    auto setSynth = [this, idx](std::function<void(Patch&)> fn) {
        engine_.editSong([idx, fn](Song& s) {
            if (idx < int(s.tracks.size())) fn(s.tracks[size_t(idx)].instrument.synth); });
        song_ = engine_.song();
    };

    // Engine selector.
    auto engines = area.removeFromTop(26);
    drawCaption(g, engines.removeFromLeft(70), "Engine", colour::dimmer);
    if (track->instrument.isDrum) {
        for (int e = 0; e < 8; ++e) {
            const auto de = DrumEngine(e);
            drawChip(g, engines.removeFromLeft(74).reduced(2, 0), drumEngineName(de), tint,
                     track->instrument.drumEngine == de, [this, idx, de] {
                         engine_.editSong([idx, de](Song& s) {
                             if (idx < int(s.tracks.size())) s.tracks[size_t(idx)].instrument.drumEngine = de; });
                         song_ = engine_.song();
                     });
        }
    } else {
        const char* waves[4] = { "Saw", "Square", "Triangle", "Sine" };
        const dsp::Wave ws[4] = { dsp::Wave::Saw, dsp::Wave::Square, dsp::Wave::Triangle, dsp::Wave::Sine };
        for (int e = 0; e < 4; ++e) {
            const auto w = ws[e];
            drawChip(g, engines.removeFromLeft(84).reduced(2, 0), waves[e], tint,
                     track->instrument.synth.wave == w,
                     [setSynth, w] { setSynth([w](Patch& p) { p.wave = w; }); });
        }
    }
    area.removeFromTop(12);

    const int kh = 66;
    auto row1 = area.removeFromTop(kh);
    auto row2 = area.removeFromTop(kh);
    auto row3 = area.removeFromTop(kh);

    auto place = [](juce::Rectangle<int>& row, int count) {
        return row.removeFromLeft(juce::jmin(96, row.getWidth() / juce::jmax(1, count)));
    };

    if (track->instrument.isDrum) {
        const auto& d = track->instrument.drum;
        addKnob(place(row1, 5), "Tune", logn(d.tune, 20.0f, 2000.0f), hz(d.tune), tint,
                [setDrum](float v) { setDrum([v](DrumParams& p) { p.tune = unlog(v, 20.0f, 2000.0f); }); });
        addKnob(place(row1, 4), "Decay", logn(d.decay, 0.01f, 3.0f), ms(d.decay), tint,
                [setDrum](float v) { setDrum([v](DrumParams& p) { p.decay = unlog(v, 0.01f, 3.0f); }); });
        addKnob(place(row1, 3), "Punch", lin(d.pitchMod, 0.0f, 48.0f), juce::String(int(d.pitchMod)) + "st", colour::hot,
                [setDrum](float v) { setDrum([v](DrumParams& p) { p.pitchMod = unlin(v, 0.0f, 48.0f); }); });
        addKnob(place(row1, 2), "Punch time", logn(d.pitchTime, 0.002f, 0.4f), ms(d.pitchTime), colour::hot,
                [setDrum](float v) { setDrum([v](DrumParams& p) { p.pitchTime = unlog(v, 0.002f, 0.4f); }); });
        addKnob(row1, "Snap", d.snap, pct(d.snap), colour::gold,
                [setDrum](float v) { setDrum([v](DrumParams& p) { p.snap = v; }); });

        addKnob(place(row2, 4), "Noise", d.noise, pct(d.noise), colour::gold,
                [setDrum](float v) { setDrum([v](DrumParams& p) { p.noise = v; }); });
        addKnob(place(row2, 3), "Cutoff", logn(d.cutoff, 60.0f, 20000.0f), hz(d.cutoff), colour::fitted,
                [setDrum](float v) { setDrum([v](DrumParams& p) { p.cutoff = unlog(v, 60.0f, 20000.0f); }); });
        addKnob(place(row2, 2), "Reso", lin(d.resonance, 0.5f, 18.0f), juce::String(d.resonance, 1), colour::fitted,
                [setDrum](float v) { setDrum([v](DrumParams& p) { p.resonance = unlin(v, 0.5f, 18.0f); }); });
        addKnob(row2, "Drive", d.drive, pct(d.drive), colour::played,
                [setDrum](float v) { setDrum([v](DrumParams& p) { p.drive = v; }); });

        g.setColour(colour::dimmer);
        g.setFont(uiFont(10.5f));
        g.drawText("Punch is how far the pitch drops at the start \xe2\x80\x94 it is what makes a kick thump rather than beep.",
                   row3.removeFromTop(20), juce::Justification::centredLeft, false);
    } else {
        const auto& p = track->instrument.synth;
        addKnob(place(row1, 6), "Unison", lin(float(p.unison), 1.0f, 9.0f), juce::String(p.unison), tint,
                [setSynth](float v) { setSynth([v](Patch& q) { q.unison = int(std::round(unlin(v, 1.0f, 9.0f))); }); });
        addKnob(place(row1, 5), "Detune", p.detune, pct(p.detune), tint,
                [setSynth](float v) { setSynth([v](Patch& q) { q.detune = v; }); });
        addKnob(place(row1, 4), "Spread", p.spread, pct(p.spread), tint,
                [setSynth](float v) { setSynth([v](Patch& q) { q.spread = v; }); });
        addKnob(place(row1, 3), "Octave", lin(float(p.octave), -3.0f, 3.0f),
                (p.octave > 0 ? "+" : "") + juce::String(p.octave), tint,
                [setSynth](float v) { setSynth([v](Patch& q) { q.octave = int(std::round(unlin(v, -3.0f, 3.0f))); }); },
                true, 0.5f);
        addKnob(place(row1, 2), "Sub", p.sub, pct(p.sub), colour::hot,
                [setSynth](float v) { setSynth([v](Patch& q) { q.sub = v; }); });
        addKnob(row1, "Drive", p.drive, pct(p.drive), colour::played,
                [setSynth](float v) { setSynth([v](Patch& q) { q.drive = v; }); });

        addKnob(place(row2, 4), "Cutoff", logn(p.cutoff, 30.0f, 18000.0f), hz(p.cutoff), colour::fitted,
                [setSynth](float v) { setSynth([v](Patch& q) { q.cutoff = unlog(v, 30.0f, 18000.0f); }); });
        addKnob(place(row2, 3), "Reso", lin(p.resonance, 0.5f, 24.0f), juce::String(p.resonance, 1), colour::fitted,
                [setSynth](float v) { setSynth([v](Patch& q) { q.resonance = unlin(v, 0.5f, 24.0f); }); });
        addKnob(place(row2, 2), "Env amt", lin(p.filterEnv, -4.0f, 5.0f), juce::String(p.filterEnv, 1) + "oct",
                colour::fitted,
                [setSynth](float v) { setSynth([v](Patch& q) { q.filterEnv = unlin(v, -4.0f, 5.0f); }); },
                true, lin(0.0f, -4.0f, 5.0f));
        addKnob(row2, "Key track", p.keyTrack, pct(p.keyTrack), colour::fitted,
                [setSynth](float v) { setSynth([v](Patch& q) { q.keyTrack = v; }); });

        addKnob(place(row3, 4), "Attack", logn(p.ampAttack, 0.0005f, 2.0f), ms(p.ampAttack), tint,
                [setSynth](float v) { setSynth([v](Patch& q) { q.ampAttack = unlog(v, 0.0005f, 2.0f); }); });
        addKnob(place(row3, 3), "Decay", logn(p.ampDecay, 0.002f, 4.0f), ms(p.ampDecay), tint,
                [setSynth](float v) { setSynth([v](Patch& q) { q.ampDecay = unlog(v, 0.002f, 4.0f); }); });
        addKnob(place(row3, 2), "Sustain", p.ampSustain, pct(p.ampSustain), tint,
                [setSynth](float v) { setSynth([v](Patch& q) { q.ampSustain = v; }); });
        addKnob(row3, "Release", logn(p.ampRelease, 0.002f, 4.0f), ms(p.ampRelease), tint,
                [setSynth](float v) { setSynth([v](Patch& q) { q.ampRelease = unlog(v, 0.002f, 4.0f); }); });
    }

    g.setColour(colour::dimmer);
    g.setFont(uiFont(10.0f));
    g.drawText("Drag a knob to change it \xc2\xb7 shift for fine \xc2\xb7 double-click to reset",
               mainArea_.reduced(16, 12), juce::Justification::bottomRight, false);
}

// --- transport strip -------------------------------------------------------

void MainComponent::paintTransportStrip(juce::Graphics& g) {
    drawPanel(g, stripArea_.toFloat(), 12.0f);
    auto area = stripArea_.reduced(16, 10);

    drawCaption(g, strengthSlider_.withY(strengthSlider_.getY() - 20).withHeight(13),
                "Fit strength", colour::dimmer);
    const auto b = strengthSlider_.toFloat();
    g.setColour(colour::ink0);
    g.fillRoundedRectangle(b, b.getHeight() * 0.5f);
    const float t = float(fitOptions_.strength);
    auto filled = b.withWidth(juce::jmax(b.getHeight(), b.getWidth() * t));
    juce::ColourGradient grad(colour::played, filled.getX(), 0.0f, colour::fitted, filled.getRight(), 0.0f, false);
    g.setGradientFill(grad);
    g.fillRoundedRectangle(filled, filled.getHeight() * 0.5f);
    g.setColour(colour::text);
    g.fillEllipse(juce::Rectangle<float>(13.0f, 13.0f).withCentre({ b.getX() + b.getWidth() * t, b.getCentreY() }));
    g.setColour(colour::dim);
    g.setFont(monoFont(10.5f));
    g.drawText(pct(t) + "%", strengthSlider_.withX(strengthSlider_.getRight() + 8).withWidth(42),
               juce::Justification::centredLeft, false);

    area.removeFromLeft(310);
    auto readouts = area;
    const int w = readouts.getWidth() / 6;
    const auto& fit = take_.fit;
    const bool has = !take_.fitted.empty();
    auto cell = [&](const juce::String& label, const juce::String& value, juce::Colour tint) {
        drawReadout(g, readouts.removeFromLeft(w), label, value, tint);
    };
    cell("Tempo", juce::String(song_.bpm, 1), colour::text);
    cell("Grid", has ? subdivisionName(fit.subdivision) : "\xe2\x80\x94", colour::fitted);
    cell("Bars", juce::String(song_.barsPerLoop), colour::text);
    cell("Fit", has ? pct(float(fit.confidence)) + "%" : "\xe2\x80\x94",
         fit.confidence > 0.75 ? colour::fitted : colour::gold);
    cell("Swing", has ? pct(float(fit.swing)) + "%" : "\xe2\x80\x94", colour::played);
    cell("Cycle", juce::String(int(song_.polymeterCycle())) + " st", colour::dim);
}

void MainComponent::paintKeyboard(juce::Graphics& g) {
    drawPanel(g, keyboardArea_.toFloat(), 12.0f);
    auto area = keyboardArea_.reduced(14, 11);

    int whites = 0;
    for (const auto& km : keyMap_) if (!km.black) ++whites;
    const float w = float(area.getWidth()) / float(juce::jmax(1, whites));
    const juce::Colour tint = song_.tracks.empty() ? colour::fitted
        : juce::Colour(song_.tracks[size_t(juce::jlimit(0, int(song_.tracks.size()) - 1, selectedTrack_))].colour);

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
        g.setFont(uiFont(10.5f, true));
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
        juce::Rectangle<float> r(float(area.getX()) + float(whiteIndex) * w - w * 0.28f,
                                 float(area.getY()), w * 0.56f, float(area.getHeight()) * 0.6f);
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
    g.drawText("OCT " + juce::String(octaveOffset_ >= 0 ? "+" : "") + juce::String(octaveOffset_),
               keyboardArea_.reduced(16, 9), juce::Justification::topRight, false);
}

} // namespace motif
