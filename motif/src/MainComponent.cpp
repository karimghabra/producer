#include "MainComponent.h"

#include "music/Presets.h"
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

/**
 * Trig conditions, as the short labels a sequencer shows on a step.
 *
 * `a:b` fires only on pass a of every b, which is how a two-bar pattern grows
 * into a thirty-two-bar arrangement without a timeline to draw on.
 */
struct CondPreset { const char* label; TrigCondition cond; const char* blurb; };

const std::vector<CondPreset>& condPresets() {
    using T = TrigCondition::Type;
    static const std::vector<CondPreset> kList = {
        { "-", { T::Always, 1.0f, 1, 4 },      "always plays" },
        { "90%",  { T::Probability, 0.90f, 1, 4 },        "plays nine times in ten" },
        { "75%",  { T::Probability, 0.75f, 1, 4 },        "plays three times in four" },
        { "50%",  { T::Probability, 0.50f, 1, 4 },        "a coin flip" },
        { "25%",  { T::Probability, 0.25f, 1, 4 },        "rare" },
        { "1:2",  { T::Ratio, 1.0f, 1, 2 },               "every other pass" },
        { "2:2",  { T::Ratio, 1.0f, 2, 2 },               "the other pass" },
        { "1:3",  { T::Ratio, 1.0f, 1, 3 },               "first of every three" },
        { "1:4",  { T::Ratio, 1.0f, 1, 4 },               "first of every four" },
        { "4:4",  { T::Ratio, 1.0f, 4, 4 },               "last of every four" },
        { "1:8",  { T::Ratio, 1.0f, 1, 8 },               "first of every eight" },
        { "8:8",  { T::Ratio, 1.0f, 8, 8 },               "last of every eight" },
        { "1ST",  { T::First, 1.0f, 1, 4 },               "first pass only" },
        { "!1ST", { T::NotFirst, 1.0f, 1, 4 },            "every pass but the first" },
    };
    return kList;
}

bool sameCondition(const TrigCondition& a, const TrigCondition& b) {
    if (a.type != b.type) return false;
    if (a.type == TrigCondition::Type::Probability) return std::abs(a.chance - b.chance) < 0.01f;
    if (a.type == TrigCondition::Type::Ratio) return a.hit == b.hit && a.of == b.of;
    return true;
}

juce::String condLabel(const TrigCondition& c) {
    for (const auto& p : condPresets()) if (sameCondition(p.cond, c)) return p.label;
    return "?";
}

} // namespace

// ---------------------------------------------------------------------------

MainComponent::MainComponent() {
    // Sized to sit inside a 1707x960 desktop with room for the taskbar, rather
    // than to a display I do not have.
    setSize(1280, 800);
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

    // Serve the interface. Found on disk rather than embedded so the UI can be
    // edited and reloaded without rebuilding the engine, which is most of the
    // reason for putting it in a browser in the first place.
    auto webRoot = juce::File::getSpecialLocation(juce::File::currentExecutableFile);
    juce::File found;
    for (int up = 0; up < 8 && webRoot.exists(); ++up) {
        const auto candidate = webRoot.getChildFile("web");
        if (candidate.isDirectory() && candidate.getChildFile("index.html").existsAsFile()) {
            found = candidate;
            break;
        }
        webRoot = webRoot.getParentDirectory();
    }
    if (found.exists()) {
        bridgePort_ = bridge_.start(found.getFullPathName().toStdString(), 7777);
        if (bridgePort_ > 0)
            juce::Logger::writeToLog("Motif UI on http://127.0.0.1:" + juce::String(bridgePort_));
    }
}

MainComponent::~MainComponent() {
    bridge_.stop();
    shutdownAudio();
}

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
    if (c == '2') { view_ = View::Steps; return true; }
    if (c == '3') { view_ = View::Mix; return true; }
    if (c == '4') { view_ = View::Sound; return true; }
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

/**
 * Everything is measured from the space actually available.
 *
 * The first version assumed a comfortable window and hard-coded widths, which
 * pushed the view tabs and the step grid off the right edge on a smaller
 * display. Nothing here is a fixed position any more: the header lays itself
 * out left to right from whatever it has, and the panels take proportions.
 */
void MainComponent::resized() {
    auto area = getLocalBounds().reduced(12);
    const int W = area.getWidth();

    headerArea_ = area.removeFromTop(50);
    area.removeFromTop(10);

    // Give the keyboard and strip a share of the height rather than a fixed
    // number of pixels, so a short window loses a little from each instead of
    // clipping the main panel entirely.
    keyboardArea_ = area.removeFromBottom(juce::jlimit(56, 84, area.getHeight() / 9));
    area.removeFromBottom(8);
    stripArea_ = area.removeFromBottom(juce::jlimit(56, 74, area.getHeight() / 9));
    area.removeFromBottom(8);

    railArea_ = area.removeFromLeft(juce::jlimit(180, 236, W / 6));
    area.removeFromLeft(8);
    mainArea_ = area;

    // Header, packed left to right from what is there.
    auto head = headerArea_;
    head.removeFromLeft(juce::jlimit(74, 118, W / 12));      // wordmark

    const int btnW = juce::jlimit(74, 112, (W - 260) / 12);
    auto btns = head.removeFromLeft(btnW * 3 + 12).reduced(0, 7);
    recButton_ = btns.removeFromLeft(btnW);
    btns.removeFromLeft(6);
    playButton_ = btns.removeFromLeft(btnW);
    btns.removeFromLeft(6);
    keepButton_ = btns.removeFromLeft(btnW);

    head.removeFromLeft(juce::jmax(8, W / 40));
    const int tabW = juce::jlimit(58, 88, (W - btnW * 3 - 200) / kViewCount);
    auto tabs = head.removeFromLeft(tabW * kViewCount + (kViewCount - 1) * 3).reduced(0, 11);
    for (int i = 0; i < kViewCount; ++i) {
        viewTabs_[size_t(i)] = tabs.removeFromLeft(tabW);
        tabs.removeFromLeft(3);
    }
    // Whatever is left is where the shortcut hint goes; it is drawn only if
    // there is genuinely room, so it can never push anything off the edge.
    hintArea_ = head;

    strengthSlider_ = stripArea_.reduced(14, 12)
                          .removeFromLeft(juce::jlimit(140, 240, W / 6))
                          .withTrimmedTop(22).withHeight(12);
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
        case View::Steps:   paintStepsView(g); break;
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

    const char* names[kViewCount] = { "ARRANGE", "STEPS", "MIX", "SOUND" };
    const View views[kViewCount] = { View::Arrange, View::Steps, View::Mix, View::Sound };
    for (int i = 0; i < kViewCount; ++i) {
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

    // Only if it genuinely fits. A hint that overlaps the tabs is worse than
    // no hint at all.
    if (hintArea_.getWidth() > 300) {
        g.setColour(colour::dimmer);
        g.setFont(uiFont(10.0f));
        g.drawText("R rec   SPACE play   1-4 views   A-K notes   up/dn track",
                   hintArea_, juce::Justification::centredRight, false);
    }

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
        if (pattern) sub += "  -  " + juce::String(pattern->name);
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
                       ? "Playing... press R again when you have the idea down"
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

// --- steps -----------------------------------------------------------------

void MainComponent::paintStepsView(juce::Graphics& g) {
    Track* track = selected();
    if (!track || !track->current()) {
        drawPanel(g, mainArea_.toFloat(), 12.0f);
        return;
    }
    const Pattern& pattern = *track->current();
    const juce::Colour tint(track->colour);
    const int trackIdx = selectedTrack_;
    const int patIdx = track->activePattern;

    auto editPattern = [this, trackIdx, patIdx](std::function<void(Pattern&)> fn) {
        engine_.editSong([trackIdx, patIdx, fn](Song& s) {
            if (trackIdx >= int(s.tracks.size())) return;
            auto& ps = s.tracks[size_t(trackIdx)].patterns;
            if (patIdx >= 0 && patIdx < int(ps.size())) fn(ps[size_t(patIdx)]);
        });
        song_ = engine_.song();
    };
    auto editStep = [editPattern](int index, std::function<void(Step&)> fn) {
        editPattern([index, fn](Pattern& p) {
            if (index >= 0 && index < int(p.steps.size())) fn(p.steps[size_t(index)]);
        });
    };

    auto area = mainArea_;
    auto inspector = area.removeFromBottom(176);
    area.removeFromBottom(10);

    // --- grid -------------------------------------------------------------
    drawPanel(g, area.toFloat(), 12.0f);
    auto grid = area.reduced(14, 12);

    auto slotRow = grid.removeFromTop(24);
    g.setColour(tint);
    g.setFont(uiFont(13.0f, true));
    g.drawText(track->name, slotRow.removeFromLeft(110), juce::Justification::centredLeft, false);

    for (size_t i = 0; i < track->patterns.size() && slotRow.getWidth() > 130; ++i) {
        const int idx = int(i);
        drawChip(g, slotRow.removeFromLeft(58).reduced(2, 1),
                 track->patterns[i].name, tint, idx == patIdx,
                 [this, trackIdx, idx] {
                     engine_.editSong([trackIdx, idx](Song& s) {
                         if (trackIdx < int(s.tracks.size())) s.tracks[size_t(trackIdx)].activePattern = idx; });
                     song_ = engine_.song();
                     selectedStep_ = -1;
                 });
    }
    drawChip(g, slotRow.removeFromLeft(34).reduced(2, 1), "+", colour::dim, false,
             [this, trackIdx] {
                 engine_.editSong([trackIdx](Song& s) {
                     if (trackIdx >= int(s.tracks.size())) return;
                     auto& t = s.tracks[size_t(trackIdx)];
                     Pattern p;
                     p.name = juce::String::charToString(juce::juce_wchar('A' + t.patterns.size())).toStdString();
                     t.patterns.push_back(p);
                     t.activePattern = int(t.patterns.size()) - 1;
                 });
                 song_ = engine_.song();
             });

    auto tools = slotRow.removeFromRight(210);
    drawChip(g, tools.removeFromLeft(66).reduced(2, 1), "CLEAR", colour::dim, false,
             [editPattern] { editPattern([](Pattern& p) { for (auto& s : p.steps) s = Step{}; }); });
    drawChip(g, tools.removeFromLeft(66).reduced(2, 1), "EUCLID", colour::fitted, pattern.euclidMode,
             [editPattern, on = pattern.euclidMode] {
                 editPattern([on](Pattern& p) { p.euclidMode = !on; }); });
    drawChip(g, tools.removeFromLeft(66).reduced(2, 1), "DICE", colour::gold, false,
             [editPattern] {
                 // The logistic map, not a uniform random. It clusters - runs of
                 // hits and runs of rests - which sounds far more like a played
                 // part than evenly scattered noise.
                 editPattern([](Pattern& p) {
                     double x = 0.31 + double(juce::Random::getSystemRandom().nextFloat()) * 0.3;
                     for (size_t i = 0; i < p.steps.size(); ++i) {
                         x = theory::logisticStep(x);
                         const bool downbeat = (i % size_t(juce::jmax(1, p.resolution))) == 0;
                         p.steps[i].on = x < 0.45 * (downbeat ? 1.5 : 0.8);
                         if (p.steps[i].on) p.steps[i].velocity = float(juce::jlimit(0.35, 1.0, 0.55 + x * 0.5));
                     }
                     p.euclidMode = false;
                 });
             });

    grid.removeFromTop(8);

    // Step buttons, sized to the space rather than to a guess.
    //
    // Wrapping matters: a 32- or 64-step pattern on one line would either run
    // off the edge or shrink each cell to a sliver. Sixteen to a row keeps the
    // bar structure readable at any length.
    const int n = pattern.length;
    const int perRow = juce::jmin(n, 16);
    const int rows = (n + perRow - 1) / perRow;
    const int cellW = juce::jmax(14, grid.getWidth() / juce::jmax(1, perRow));
    const int cellH = juce::jlimit(26, 62,
                                   (grid.getHeight() - (rows - 1) * 6) / juce::jmax(1, rows));
    const int playingStep = engine_.playing() ? engine_.trackStep(trackIdx) : -1;

    for (int row = 0; row < rows; ++row) {
        auto line = grid.removeFromTop(cellH);
        grid.removeFromTop(6);
        for (int c = 0; c < perRow; ++c) {
            const int index = row * perRow + c;
            if (index >= n) break;
            auto cell = line.removeFromLeft(cellW).reduced(2);
            const Step& step = pattern.steps[size_t(index)];
            const bool on = pattern.stepOn(index);
            const bool isBeat = (index % juce::jmax(1, pattern.resolution)) == 0;
            const bool here = index == playingStep;
            const bool sel = index == selectedStep_;

            const auto f = cell.toFloat();
            if (here && on) drawGlow(g, f, tint, 0.9f, 5.0f);
            g.setColour(on ? tint.withAlpha(0.9f) : (isBeat ? colour::ink2.brighter(0.14f) : colour::ink2));
            g.fillRoundedRectangle(f, 5.0f);
            if (on) {
                // Velocity as a fill height, so dynamics are visible at a glance.
                auto v = f.withTrimmedTop(f.getHeight() * (1.0f - juce::jlimit(0.0f, 1.0f, step.velocity)));
                g.setColour(juce::Colours::white.withAlpha(0.18f));
                g.fillRoundedRectangle(v, 4.0f);
            }
            g.setColour(sel ? colour::text : (here ? colour::gold : colour::line));
            g.drawRoundedRectangle(f.reduced(0.5f), 5.0f, sel || here ? 1.8f : 1.0f);

            g.setColour(on ? colour::ink0.withAlpha(0.65f) : colour::dimmer);
            g.setFont(monoFont(8.0f));
            g.drawText(juce::String(index + 1), cell.reduced(3).removeFromTop(10),
                       juce::Justification::topLeft, false);

            if (on && !track->instrument.isDrum) {
                g.setColour(colour::ink0.withAlpha(0.85f));
                g.setFont(monoFont(9.5f, true));
                g.drawText(theory::noteName(theory::degreeToMidi(song_.key, step.degree, step.octave)),
                           cell.reduced(3), juce::Justification::centred, false);
            }
            // Badges for anything that makes this step behave differently.
            juce::String badge;
            if (step.ratchet > 1) badge += "x" + juce::String(step.ratchet) + " ";
            if (step.cond.type != TrigCondition::Type::Always) badge += condLabel(step.cond);
            if (badge.isNotEmpty()) {
                g.setColour(on ? colour::ink0.withAlpha(0.8f) : colour::gold);
                g.setFont(monoFont(7.5f, true));
                g.drawText(badge, cell.reduced(3), juce::Justification::bottomRight, false);
            }

            addHit(cell, [this, index, editStep, wasOn = pattern.steps[size_t(index)].on] {
                const bool inspecting = juce::ModifierKeys::getCurrentModifiers().isShiftDown();
                if (!inspecting) editStep(index, [wasOn](Step& s) { s.on = !wasOn; });
                selectedStep_ = index;
            });
        }
    }

    // --- inspector --------------------------------------------------------
    drawPanel(g, inspector.toFloat(), 12.0f);
    auto ins = inspector.reduced(14, 10);

    auto insHead = ins.removeFromTop(18);
    drawCaption(g, insHead.removeFromLeft(200),
                selectedStep_ >= 0 ? "Step " + juce::String(selectedStep_ + 1) : "Pattern",
                colour::dimmer);
    g.setColour(colour::dimmer);
    g.setFont(uiFont(10.0f));
    g.drawText("click a step to toggle - shift-click to inspect without toggling",
               insHead, juce::Justification::centredRight, false);
    ins.removeFromTop(6);

    auto left = ins.removeFromLeft(ins.getWidth() / 2 - 8);
    ins.removeFromLeft(16);

    // Pattern-level controls, always present.
    {
        auto row = left.removeFromTop(62);
        addKnob(row.removeFromLeft(84), "Length", lin(float(pattern.length), 1.0f, 64.0f),
                juce::String(pattern.length), tint,
                [editPattern](float v) {
                    editPattern([v](Pattern& p) { p.resize(int(std::round(unlin(v, 1.0f, 64.0f)))); });
                }, false, lin(16.0f, 1.0f, 64.0f));

        const int resTable[5] = { 2, 3, 4, 6, 8 };
        int resIdx = 2;
        for (int i = 0; i < 5; ++i) if (resTable[i] == pattern.resolution) resIdx = i;
        addKnob(row.removeFromLeft(84), "Grid", float(resIdx) / 4.0f,
                subdivisionName(pattern.resolution), tint,
                [editPattern, resTable](float v) {
                    const int i = juce::jlimit(0, 4, int(std::round(v * 4.0f)));
                    const int r = resTable[i];
                    editPattern([r](Pattern& p) { p.resolution = r; });
                }, false, 0.5f);

        if (pattern.euclidMode) {
            addKnob(row.removeFromLeft(84), "Pulses", lin(float(pattern.euclidPulses), 0.0f, float(pattern.length)),
                    juce::String(pattern.euclidPulses), colour::fitted,
                    [editPattern](float v) {
                        editPattern([v](Pattern& p) {
                            p.euclidPulses = int(std::round(v * float(p.length))); }); });
            addKnob(row.removeFromLeft(84), "Rotate",
                    lin(float(pattern.euclidRotation), 0.0f, float(juce::jmax(1, pattern.length - 1))),
                    juce::String(pattern.euclidRotation), colour::fitted,
                    [editPattern](float v) {
                        editPattern([v](Pattern& p) {
                            p.euclidRotation = int(std::round(v * float(juce::jmax(1, p.length - 1)))); }); });
        }

        if (pattern.euclidMode) {
            g.setColour(colour::dimmer);
            g.setFont(uiFont(10.0f));
            g.drawText("E(" + juce::String(pattern.euclidPulses) + "," + juce::String(pattern.length)
                           + ") spreads the hits as evenly as arithmetic allows. E(3,8) is the tresillo.",
                       left.removeFromTop(16), juce::Justification::centredLeft, false);
        }
    }

    // Step-level controls, only once a step is chosen.
    if (selectedStep_ >= 0 && selectedStep_ < int(pattern.steps.size())) {
        const Step& step = pattern.steps[size_t(selectedStep_)];
        const int si = selectedStep_;
        auto row = ins.removeFromTop(62);

        addKnob(row.removeFromLeft(76), "Velocity", step.velocity, pct(step.velocity), tint,
                [editStep, si](float v) { editStep(si, [v](Step& s) { s.velocity = juce::jmax(0.02f, v); }); },
                false, 0.8f);
        if (!track->instrument.isDrum) {
            addKnob(row.removeFromLeft(76), "Degree", lin(float(step.degree), -7.0f, 14.0f),
                    theory::noteName(theory::degreeToMidi(song_.key, step.degree, step.octave)), tint,
                    [editStep, si](float v) {
                        editStep(si, [v](Step& s) { s.degree = int(std::round(unlin(v, -7.0f, 14.0f))); }); },
                    true, lin(0.0f, -7.0f, 14.0f));
            addKnob(row.removeFromLeft(76), "Octave", lin(float(step.octave), -3.0f, 3.0f),
                    (step.octave > 0 ? "+" : "") + juce::String(step.octave), tint,
                    [editStep, si](float v) {
                        editStep(si, [v](Step& s) { s.octave = int(std::round(unlin(v, -3.0f, 3.0f))); }); },
                    true, 0.5f);
            addKnob(row.removeFromLeft(76), "Length", lin(float(step.length), 1.0f, 16.0f),
                    juce::String(step.length), tint,
                    [editStep, si](float v) {
                        editStep(si, [v](Step& s) { s.length = int(std::round(unlin(v, 1.0f, 16.0f))); }); },
                    false, 0.0f);
        }
        addKnob(row.removeFromLeft(76), "Ratchet", lin(float(step.ratchet), 1.0f, 8.0f),
                "x" + juce::String(step.ratchet), colour::gold,
                [editStep, si](float v) {
                    editStep(si, [v](Step& s) { s.ratchet = int(std::round(unlin(v, 1.0f, 8.0f))); }); },
                false, 0.0f);
        addKnob(row.removeFromLeft(76), "Nudge", lin(step.nudge, -0.5f, 0.5f),
                juce::String(int(step.nudge * 100.0f)) + "%", colour::played,
                [editStep, si](float v) { editStep(si, [v](Step& s) { s.nudge = unlin(v, -0.5f, 0.5f); }); },
                true, 0.5f);

        auto condRow = ins.removeFromTop(24);
        drawCaption(g, condRow.removeFromLeft(74), "Condition", colour::dimmer);
        for (const auto& preset : condPresets()) {
            if (condRow.getWidth() < 46) break;
            const auto cond = preset.cond;
            drawChip(g, condRow.removeFromLeft(44).reduced(1, 0), preset.label, colour::fitted,
                     sameCondition(preset.cond, step.cond),
                     [editStep, si, cond] { editStep(si, [cond](Step& s) { s.cond = cond; }); });
        }

        ins.removeFromTop(4);
        auto flagRow = ins.removeFromTop(22);
        drawChip(g, flagRow.removeFromLeft(84), "ACCENT", colour::gold, step.accent,
                 [editStep, si, on = step.accent] { editStep(si, [on](Step& s) { s.accent = !on; }); });
        flagRow.removeFromLeft(8);
        g.setColour(colour::dimmer);
        g.setFont(uiFont(10.0f));
        for (const auto& preset : condPresets())
            if (sameCondition(preset.cond, step.cond))
                g.drawText(juce::String("Condition: ") + preset.blurb, flagRow,
                           juce::Justification::centredLeft, false);
    } else {
        g.setColour(colour::dimmer);
        g.setFont(uiFont(11.5f));
        g.drawText("Select a step to set its velocity, pitch, ratchet, nudge and trig condition.",
                   ins.removeFromTop(30), juce::Justification::centredLeft, false);
    }
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

    // --- presets ----------------------------------------------------------
    // First, because finding a sound by ear beats reasoning about knobs you do
    // not yet have a feel for. Clicking one loads it and plays it.
    auto presetHead = area.removeFromTop(16);
    drawCaption(g, presetHead.removeFromLeft(70), "Presets", colour::dimmer);
    g.setColour(colour::dimmer);
    g.setFont(uiFont(9.5f));
    g.drawText("click to load and hear - then turn knobs to taste", presetHead,
               juce::Justification::centredLeft, false);
    area.removeFromTop(4);

    auto presetRows = area.removeFromTop(track->instrument.isDrum ? 52 : 30);
    {
        auto line = presetRows.removeFromTop(24);
        int placed = 0;
        auto audition = [this, idx] {
            engine_.auditionTrack(idx, 60, 0.95f);
        };
        if (track->instrument.isDrum) {
            for (const auto& preset : drumPresets()) {
                if (line.getWidth() < 90) {
                    if (presetRows.getHeight() < 24) break;
                    line = presetRows.removeFromTop(24);
                }
                const bool on = track->instrument.drumEngine == preset.engine
                             && std::abs(track->instrument.drum.tune - preset.params.tune) < 0.5f;
                const auto* p = &preset;
                drawChip(g, line.removeFromLeft(88).reduced(2, 1), preset.name, tint, on,
                         [this, idx, p, audition] {
                             engine_.editSong([idx, p](Song& s) {
                                 if (idx < int(s.tracks.size())) applyDrumPreset(s.tracks[size_t(idx)], *p); });
                             song_ = engine_.song();
                             audition();
                         });
                ++placed;
            }
        } else {
            for (const auto& preset : synthPresets()) {
                if (line.getWidth() < 100) break;
                const bool on = track->instrument.synth.engine == preset.patch.engine
                             && std::abs(track->instrument.synth.cutoff - preset.patch.cutoff) < 1.0f;
                const auto* p = &preset;
                drawChip(g, line.removeFromLeft(98).reduced(2, 1), preset.name, tint, on,
                         [this, idx, p, audition] {
                             engine_.editSong([idx, p](Song& s) {
                                 if (idx < int(s.tracks.size())) applySynthPreset(s.tracks[size_t(idx)], *p); });
                             song_ = engine_.song();
                             audition();
                         });
                ++placed;
            }
        }
        juce::ignoreUnused(placed);
    }
    area.removeFromTop(8);

    // --- engine -----------------------------------------------------------
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
        for (int e = 0; e < 6; ++e) {
            const auto se = SynthEngine(e);
            drawChip(g, engines.removeFromLeft(88).reduced(2, 0), synthEngineName(se), tint,
                     track->instrument.synth.engine == se,
                     [setSynth, se] { setSynth([se](Patch& p) { p.engine = se; }); });
        }
    }
    area.removeFromTop(10);

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
        g.drawText("Punch is how far the pitch drops at the start - it is what makes a kick thump rather than beep.",
                   row3.removeFromTop(20), juce::Justification::centredLeft, false);
    } else {
        const auto& p = track->instrument.synth;
        const bool isFM = p.engine == SynthEngine::FM;
        if (isFM) {
            // Whole-number ratios sound musical; fractions sound like bells.
            addKnob(place(row1, 6), "Ratio", lin(p.fmRatio, 0.25f, 16.0f),
                    juce::String(p.fmRatio, 2) + ":1", tint,
                    [setSynth](float v) { setSynth([v](Patch& q) { q.fmRatio = unlin(v, 0.25f, 16.0f); }); });
            addKnob(place(row1, 5), "Index", lin(p.fmIndex, 0.0f, 16.0f), juce::String(p.fmIndex, 1), tint,
                    [setSynth](float v) { setSynth([v](Patch& q) { q.fmIndex = unlin(v, 0.0f, 16.0f); }); });
        } else {
            addKnob(place(row1, 6), "Unison", lin(float(p.unison), 1.0f, 9.0f), juce::String(p.unison), tint,
                    [setSynth](float v) { setSynth([v](Patch& q) { q.unison = int(std::round(unlin(v, 1.0f, 9.0f))); }); });
            addKnob(place(row1, 5), "Detune", p.detune, pct(p.detune), tint,
                    [setSynth](float v) { setSynth([v](Patch& q) { q.detune = v; }); });
        }
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
    g.drawText("Drag a knob to change it - shift for fine - double-click to reset",
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
    cell("Grid", has ? subdivisionName(fit.subdivision) : "-", colour::fitted);
    cell("Bars", juce::String(song_.barsPerLoop), colour::text);
    cell("Fit", has ? pct(float(fit.confidence)) + "%" : "-",
         fit.confidence > 0.75 ? colour::fitted : colour::gold);
    cell("Swing", has ? pct(float(fit.swing)) + "%" : "-", colour::played);
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
