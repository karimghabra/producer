#include "MainComponent.h"

#include "ui/Theme.h"

using namespace motif::ui;

namespace motif {
namespace {

constexpr int kBaseNote = 48;   // C3 sits on the home row

/** Note names, for the keyboard and the take view's pitch axis. */
const char* kNoteNames[12] = { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" };

juce::String noteName(int midi) {
    return juce::String(kNoteNames[((midi % 12) + 12) % 12]) + juce::String(midi / 12 - 1);
}

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
    setSize(1120, 720);
    setWantsKeyboardFocus(true);

    // Piano layout on the two home rows: white keys along ASDF, black keys on
    // the row above where they physically sit between them.
    keyMap_ = {
        { 'A', 0,  false }, { 'W', 1,  true  }, { 'S', 2,  false }, { 'E', 3,  true  },
        { 'D', 4,  false }, { 'F', 5,  false }, { 'T', 6,  true  }, { 'G', 7,  false },
        { 'Y', 8,  true  }, { 'H', 9,  false }, { 'U', 10, true  }, { 'J', 11, false },
        { 'K', 12, false }, { 'O', 13, true  }, { 'L', 14, false }, { 'P', 15, true  },
    };

    setAudioChannels(0, 2);
    startTimerHz(60);
}

MainComponent::~MainComponent() {
    shutdownAudio();
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

void MainComponent::prepareToPlay(int samplesPerBlockExpected, double sampleRate) {
    engine_.prepare(sampleRate, samplesPerBlockExpected);
}

void MainComponent::getNextAudioBlock(const juce::AudioSourceChannelInfo& info) {
    auto* buffer = info.buffer;
    if (buffer->getNumChannels() < 2) { info.clearActiveBufferRegion(); return; }

    float* l = buffer->getWritePointer(0, info.startSample);
    float* r = buffer->getWritePointer(1, info.startSample);
    engine_.render(l, r, info.numSamples);
}

void MainComponent::releaseResources() {}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

void MainComponent::timerCallback() {
    pollKeyboard();

    if (engine_.recording()) {
        recPulse_ += 0.055f;
        if (recPulse_ > juce::MathConstants<float>::twoPi) recPulse_ -= juce::MathConstants<float>::twoPi;
    }
    if (fitReveal_ < 1.0f) fitReveal_ = juce::jmin(1.0f, fitReveal_ + 0.035f);

    repaint();
}

/**
 * Polled rather than event-driven. JUCE reports key presses but not reliable
 * per-key releases, and a held note has to end when the finger lifts, not when
 * the OS decides to stop repeating.
 */
void MainComponent::pollKeyboard() {
    if (!hasKeyboardFocus(true)) {
        // Losing focus mid-chord would leave notes hanging forever.
        for (int n = 0; n < 128; ++n) {
            if (noteSounding_[size_t(n)]) {
                engine_.noteOff(n);
                noteSounding_[size_t(n)] = false;
            }
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
    if (key.getTextCharacter() == 'r' || key.getTextCharacter() == 'R') { toggleRecord(); return true; }
    if (key == juce::KeyPress::leftKey)  { octaveOffset_ = juce::jlimit(-3, 3, octaveOffset_ - 1); return true; }
    if (key == juce::KeyPress::rightKey) { octaveOffset_ = juce::jlimit(-3, 3, octaveOffset_ + 1); return true; }
    return false;
}

void MainComponent::toggleRecord() {
    if (engine_.recording()) {
        take_ = engine_.finishRecording(fitOptions_);
        fitReveal_ = 0.0f;                 // animate the snap
        lastFitTime_ = juce::Time::getMillisecondCounterHiRes();
        if (!take_.fitted.empty()) {
            // Frame the pitch range that was actually played, with a little air.
            int lo = 127, hi = 0;
            for (const auto& n : take_.fitted) { lo = juce::jmin(lo, n.pitch); hi = juce::jmax(hi, n.pitch); }
            lowPitch_ = juce::jmax(0, lo - 3);
            highPitch_ = juce::jmin(127, hi + 3);
            if (highPitch_ - lowPitch_ < 12) highPitch_ = lowPitch_ + 12;
            engine_.setPlaying(true);
        }
    } else {
        engine_.clearTake();
        take_ = Take{};
        engine_.setPlaying(false);
        engine_.armRecording();
    }
}

void MainComponent::togglePlay() {
    engine_.setPlaying(!engine_.playing());
}

void MainComponent::refit() {
    if (take_.raw.empty()) return;
    take_ = fitTake(take_.raw, fitOptions_);
    engine_.setTake(take_);
    fitReveal_ = 0.0f;
}

void MainComponent::mouseDown(const juce::MouseEvent& e) {
    grabKeyboardFocus();
    if (recButton_.contains(e.getPosition()))   { toggleRecord(); return; }
    if (playButton_.contains(e.getPosition()))  { togglePlay(); return; }
    if (clearButton_.contains(e.getPosition())) {
        engine_.clearTake(); take_ = Take{}; engine_.setPlaying(false); return;
    }
    if (strengthSlider_.contains(e.getPosition())) { draggingStrength_ = true; mouseDrag(e); return; }
    if (swingToggle_.contains(e.getPosition())) { fitOptions_.keepSwing = !fitOptions_.keepSwing; refit(); return; }
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
    auto area = getLocalBounds().reduced(18);

    headerArea_ = area.removeFromTop(58);
    area.removeFromTop(14);

    keyboardArea_ = area.removeFromBottom(96);
    area.removeFromBottom(14);

    controlArea_ = area.removeFromBottom(88);
    area.removeFromBottom(14);

    readoutArea_ = area.removeFromBottom(76);
    area.removeFromBottom(14);

    takeArea_ = area;

    auto btns = headerArea_.withTrimmedLeft(150).withWidth(430).reduced(0, 8);
    recButton_ = btns.removeFromLeft(120);
    btns.removeFromLeft(10);
    playButton_ = btns.removeFromLeft(120);
    btns.removeFromLeft(10);
    clearButton_ = btns.removeFromLeft(100);

    auto ctl = controlArea_.reduced(18, 16);
    strengthSlider_ = ctl.removeFromLeft(320).withTrimmedTop(26).withHeight(16);
    ctl.removeFromLeft(28);
    swingToggle_ = ctl.removeFromLeft(130).withTrimmedTop(22).withHeight(26);
}

float MainComponent::beatToX(double beats) const {
    const auto inner = takeArea_.reduced(16, 14).toFloat();
    const double total = juce::jmax(1.0, take_.beatsPerLoop());
    return inner.getX() + float(beats / total) * inner.getWidth();
}

float MainComponent::pitchToY(int pitch) const {
    const auto inner = takeArea_.reduced(16, 14).toFloat();
    const float span = float(juce::jmax(1, highPitch_ - lowPitch_));
    const float t = 1.0f - (float(pitch - lowPitch_) / span);
    return inner.getY() + t * inner.getHeight();
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

void MainComponent::paint(juce::Graphics& g) {
    // Page: a very slight radial lift behind the take view keeps the eye there.
    g.fillAll(colour::ink0);
    juce::ColourGradient bg(colour::ink1.brighter(0.05f),
                            float(getWidth()) * 0.5f, float(takeArea_.getCentreY()),
                            colour::ink0, 0.0f, float(getHeight()), true);
    g.setGradientFill(bg);
    g.fillAll();

    paintHeader(g);
    paintTakeView(g);
    paintReadouts(g);
    paintControls(g);
    paintKeyboard(g);
}

void MainComponent::paintHeader(juce::Graphics& g) {
    auto area = headerArea_;

    g.setColour(colour::text);
    g.setFont(uiFont(26.0f, true));
    g.drawText("MOTIF", area.removeFromLeft(130).reduced(2, 0),
               juce::Justification::centredLeft, false);

    const bool rec = engine_.recording();
    const bool playing = engine_.playing();

    // Record.
    {
        const auto b = recButton_.toFloat();
        const float pulse = rec ? 0.55f + 0.45f * std::sin(recPulse_) : 0.0f;
        if (rec) drawGlow(g, b, colour::hot, pulse, 9.0f);
        g.setColour(rec ? colour::hot.withAlpha(0.20f + 0.12f * pulse) : colour::ink2);
        g.fillRoundedRectangle(b, 9.0f);
        g.setColour(rec ? colour::hot : colour::line);
        g.drawRoundedRectangle(b.reduced(0.5f), 9.0f, 1.2f);

        g.setColour(rec ? colour::hot : colour::dim);
        g.fillEllipse(juce::Rectangle<float>(9.0f, 9.0f).withCentre(
            { b.getX() + 24.0f, b.getCentreY() }));
        g.setFont(uiFont(12.5f, true));
        g.drawText(rec ? "RECORDING" : "RECORD",
                   recButton_.withTrimmedLeft(36), juce::Justification::centredLeft, false);
    }

    // Play.
    {
        const auto b = playButton_.toFloat();
        if (playing) drawGlow(g, b, colour::fitted, 0.7f, 9.0f);
        g.setColour(playing ? colour::fitted.withAlpha(0.18f) : colour::ink2);
        g.fillRoundedRectangle(b, 9.0f);
        g.setColour(playing ? colour::fitted : colour::line);
        g.drawRoundedRectangle(b.reduced(0.5f), 9.0f, 1.2f);

        juce::Path icon;
        const float cy = b.getCentreY();
        if (playing) {
            icon.addRoundedRectangle(b.getX() + 20.0f, cy - 5.5f, 4.0f, 11.0f, 1.0f);
            icon.addRoundedRectangle(b.getX() + 26.5f, cy - 5.5f, 4.0f, 11.0f, 1.0f);
        } else {
            icon.addTriangle(b.getX() + 21.0f, cy - 6.5f, b.getX() + 21.0f, cy + 6.5f,
                             b.getX() + 31.0f, cy);
        }
        g.setColour(playing ? colour::fitted : colour::dim);
        g.fillPath(icon);
        g.setFont(uiFont(12.5f, true));
        g.drawText(playing ? "PLAYING" : "PLAY",
                   playButton_.withTrimmedLeft(42), juce::Justification::centredLeft, false);
    }

    // Clear.
    {
        const auto b = clearButton_.toFloat();
        g.setColour(colour::ink2);
        g.fillRoundedRectangle(b, 9.0f);
        g.setColour(colour::line);
        g.drawRoundedRectangle(b.reduced(0.5f), 9.0f, 1.2f);
        g.setColour(colour::dim);
        g.setFont(uiFont(12.5f, true));
        g.drawText("CLEAR", clearButton_, juce::Justification::centred, false);
    }

    // Hint on the right.
    g.setColour(colour::dimmer);
    g.setFont(uiFont(11.5f));
    g.drawText("R record   \xe2\x80\xa2   SPACE play   \xe2\x80\xa2   A\xe2\x80\x93K play notes   \xe2\x80\xa2   \xe2\x86\x90 \xe2\x86\x92 octave",
               headerArea_, juce::Justification::centredRight, false);
}

void MainComponent::paintTakeView(juce::Graphics& g) {
    drawPanel(g, takeArea_.toFloat(), 12.0f);
    const auto inner = takeArea_.reduced(16, 14).toFloat();

    const bool empty = take_.fitted.empty();

    if (empty) {
        g.setColour(colour::dimmer);
        g.setFont(uiFont(15.0f));
        g.drawText(engine_.recording() ? "Playing\xe2\x80\xa6 press R when you have the idea down"
                                       : "Press R and play something. Motif works out the rest.",
                   takeArea_, juce::Justification::centred, false);
        return;
    }

    const auto& fit = take_.fit;
    const double totalBeats = take_.beatsPerLoop();

    // --- grid -------------------------------------------------------------
    const double stepBeats = 1.0 / double(fit.subdivision);
    for (double b = 0.0; b <= totalBeats + 1e-9; b += stepBeats) {
        const float x = beatToX(b);
        const bool isBar = std::fmod(b, double(fit.beatsPerBar)) < 1e-6;
        const bool isBeat = std::fmod(b, 1.0) < 1e-6;
        g.setColour(isBar ? colour::line.brighter(0.45f)
                          : isBeat ? colour::line : colour::lineSoft);
        g.drawVerticalLine(int(x), inner.getY(), inner.getBottom());
    }

    // Pitch lanes: shade the black-key rows so the vertical axis reads.
    for (int p = lowPitch_; p <= highPitch_; ++p) {
        if (!isBlackKey(p)) continue;
        const float y0 = pitchToY(p);
        const float y1 = pitchToY(p - 1);
        g.setColour(juce::Colours::white.withAlpha(0.014f));
        g.fillRect(inner.getX(), y0, inner.getWidth(), y1 - y0);
    }

    // --- notes ------------------------------------------------------------
    const float laneH = juce::jmax(4.0f, inner.getHeight() / float(highPitch_ - lowPitch_ + 1));
    const double secPerBeat = 60.0 / fit.bpm;

    for (size_t i = 0; i < take_.fitted.size(); ++i) {
        const auto& f = take_.fitted[i];

        // Where it was actually played, for the "before" ghost.
        const double rawBeats = (i < take_.raw.size())
            ? (take_.raw[i].startSec - fit.phaseSec) / secPerBeat
            : f.startBeats;

        const float yTop = pitchToY(f.pitch) - laneH * 0.5f;
        const float h = juce::jmax(3.0f, laneH - 2.0f);

        const float xPlayed = beatToX(rawBeats);
        const float xFitted = beatToX(f.startBeats);
        const float w = juce::jmax(4.0f, beatToX(f.startBeats + f.lengthBeats) - xFitted - 1.0f);

        // Ghost of the performance, and a line to where it went. This is the
        // whole point of the view: the correction is visible, not implied.
        if (std::abs(xPlayed - xFitted) > 0.6f) {
            g.setColour(colour::played.withAlpha(0.34f));
            g.drawRoundedRectangle({ xPlayed, yTop, w, h }, 3.0f, 1.0f);
            g.setColour(colour::played.withAlpha(0.20f));
            g.drawLine(xPlayed, yTop + h * 0.5f, xFitted, yTop + h * 0.5f, 1.0f);
        }

        // The fitted note slides into place on a new take.
        const float x = xPlayed + (xFitted - xPlayed) * fitReveal_;

        juce::Rectangle<float> r(x, yTop, w, h);
        juce::ColourGradient grad(colour::fitted.brighter(0.25f), r.getX(), r.getY(),
                                  colour::fitted.darker(0.30f), r.getX(), r.getBottom(), false);
        g.setGradientFill(grad);
        g.fillRoundedRectangle(r, 3.0f);
        g.setColour(colour::fitted.brighter(0.5f).withAlpha(0.85f));
        g.drawRoundedRectangle(r.reduced(0.5f), 3.0f, 1.0f);
    }

    // --- playhead ---------------------------------------------------------
    if (engine_.playing()) {
        const float x = inner.getX() + float(engine_.loopPhase()) * inner.getWidth();
        g.setColour(colour::gold.withAlpha(0.20f));
        g.fillRect(x - 6.0f, inner.getY(), 12.0f, inner.getHeight());
        g.setColour(colour::gold);
        g.drawLine(x, inner.getY(), x, inner.getBottom(), 1.6f);
    }

    // Legend.
    auto legend = takeArea_.removeFromTop(0);
    juce::ignoreUnused(legend);
    g.setColour(colour::played);
    g.setFont(uiFont(10.5f, true));
    g.drawText("AS PLAYED", takeArea_.reduced(18, 10).removeFromTop(14),
               juce::Justification::topRight, false);
    g.setColour(colour::fitted);
    g.drawText("AS FITTED", takeArea_.reduced(18, 10).removeFromTop(28).removeFromBottom(14),
               juce::Justification::topRight, false);
}

void MainComponent::paintReadouts(juce::Graphics& g) {
    drawPanel(g, readoutArea_.toFloat(), 12.0f);
    auto area = readoutArea_.reduced(18, 12);

    const auto& fit = take_.fit;
    const bool has = !take_.fitted.empty();
    const int cols = 5;
    const int w = area.getWidth() / cols;

    auto cell = [&](const juce::String& label, const juce::String& value, juce::Colour tint) {
        drawReadout(g, area.removeFromLeft(w), label, has ? value : "\xe2\x80\x94", tint);
    };

    cell("Tempo",  juce::String(fit.bpm, 1),                 colour::text);
    cell("Grid",   subdivisionName(fit.subdivision),          colour::fitted);
    cell("Length", juce::String(fit.bars) + (fit.bars == 1 ? " bar" : " bars"), colour::text);
    cell("Fit",    juce::String(int(fit.confidence * 100.0)) + "%",
                   fit.confidence > 0.75 ? colour::fitted : colour::gold);
    cell("Swing",  juce::String(int(fit.swing * 100.0)) + "%", colour::played);
}

void MainComponent::paintControls(juce::Graphics& g) {
    drawPanel(g, controlArea_.toFloat(), 12.0f);

    // Fit strength.
    {
        auto label = strengthSlider_.withY(strengthSlider_.getY() - 24).withHeight(14);
        drawCaption(g, label, "Fit strength", colour::dimmer);

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

        const float knobX = b.getX() + b.getWidth() * t;
        g.setColour(colour::text);
        g.fillEllipse(juce::Rectangle<float>(15.0f, 15.0f).withCentre({ knobX, b.getCentreY() }));

        g.setColour(colour::dim);
        g.setFont(monoFont(11.5f));
        g.drawText(juce::String(int(fitOptions_.strength * 100.0)) + "%",
                   strengthSlider_.withX(strengthSlider_.getRight() + 12).withWidth(50),
                   juce::Justification::centredLeft, false);

        g.setColour(colour::dimmer);
        g.setFont(uiFont(10.5f));
        g.drawText("0 = exactly as played      100 = locked to the grid",
                   strengthSlider_.withY(strengthSlider_.getBottom() + 6).withHeight(14).withWidth(340),
                   juce::Justification::centredLeft, false);
    }

    // Keep swing.
    {
        const auto b = swingToggle_.toFloat();
        const bool on = fitOptions_.keepSwing;
        g.setColour(on ? colour::played.withAlpha(0.18f) : colour::ink0);
        g.fillRoundedRectangle(b, 6.0f);
        g.setColour(on ? colour::played : colour::line);
        g.drawRoundedRectangle(b.reduced(0.5f), 6.0f, 1.0f);
        g.setColour(on ? colour::played : colour::dim);
        g.setFont(uiFont(11.5f, true));
        g.drawText("KEEP SWING", swingToggle_, juce::Justification::centred, false);
    }
}

void MainComponent::paintKeyboard(juce::Graphics& g) {
    drawPanel(g, keyboardArea_.toFloat(), 12.0f);
    auto area = keyboardArea_.reduced(16, 14);

    // Count the white keys we are drawing so they can share the width evenly.
    int whites = 0;
    for (const auto& km : keyMap_) if (!km.black) ++whites;
    const float w = float(area.getWidth()) / float(juce::jmax(1, whites));

    float x = float(area.getX());
    // Whites first, blacks on top, so the overlap reads correctly.
    for (const auto& km : keyMap_) {
        if (km.black) continue;
        const int note = kBaseNote + km.semitone + octaveOffset_ * 12;
        const bool down = note >= 0 && note < 128 && noteSounding_[size_t(note)];
        juce::Rectangle<float> r(x + 1.0f, float(area.getY()), w - 2.0f, float(area.getHeight()));

        if (down) drawGlow(g, r, colour::fitted, 0.8f, 4.0f);
        g.setColour(down ? colour::fitted.withAlpha(0.75f) : colour::ink2.brighter(0.10f));
        g.fillRoundedRectangle(r, 4.0f);
        g.setColour(colour::line);
        g.drawRoundedRectangle(r.reduced(0.5f), 4.0f, 1.0f);

        g.setColour(down ? colour::ink0 : colour::dimmer);
        g.setFont(uiFont(11.0f, true));
        g.drawText(juce::String::charToString(juce::juce_wchar(km.keyCode)),
                   r.reduced(4.0f).toNearestInt(), juce::Justification::centredBottom, false);
        g.setColour(down ? colour::ink0.withAlpha(0.7f) : colour::dimmer.withAlpha(0.6f));
        g.setFont(uiFont(9.5f));
        g.drawText(noteName(note), r.reduced(4.0f).toNearestInt(),
                   juce::Justification::centredTop, false);
        x += w;
    }

    x = float(area.getX());
    int whiteIndex = 0;
    for (const auto& km : keyMap_) {
        if (!km.black) { ++whiteIndex; continue; }
        const int note = kBaseNote + km.semitone + octaveOffset_ * 12;
        const bool down = note >= 0 && note < 128 && noteSounding_[size_t(note)];
        // Sit between the two whites it falls between.
        const float cx = float(area.getX()) + float(whiteIndex) * w;
        juce::Rectangle<float> r(cx - w * 0.28f, float(area.getY()),
                                 w * 0.56f, float(area.getHeight()) * 0.62f);

        if (down) drawGlow(g, r, colour::fitted, 0.8f, 4.0f);
        g.setColour(down ? colour::fitted.withAlpha(0.85f) : colour::ink0);
        g.fillRoundedRectangle(r, 4.0f);
        g.setColour(colour::line);
        g.drawRoundedRectangle(r.reduced(0.5f), 4.0f, 1.0f);
        g.setColour(down ? colour::ink0 : colour::dimmer);
        g.setFont(uiFont(10.5f, true));
        g.drawText(juce::String::charToString(juce::juce_wchar(km.keyCode)),
                   r.reduced(3.0f).toNearestInt(), juce::Justification::centredBottom, false);
    }

    g.setColour(colour::dimmer);
    g.setFont(monoFont(10.5f));
    g.drawText("OCT " + juce::String(octaveOffset_ >= 0 ? "+" : "") + juce::String(octaveOffset_),
               keyboardArea_.reduced(18, 10), juce::Justification::topRight, false);
}

} // namespace motif
