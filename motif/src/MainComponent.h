#pragma once

#include <JuceHeader.h>

#include <array>

#include "audio/Engine.h"
#include "music/Quantizer.h"

namespace motif {

/**
 * The window.
 *
 * Built around one idea: you should be able to see the machine's reasoning.
 * The take view draws what you played and where it decided that belongs, at the
 * same time, so the fit is something you watch happen rather than something you
 * accept on trust.
 */
class MainComponent : public juce::AudioAppComponent,
                      private juce::Timer {
public:
    MainComponent();
    ~MainComponent() override;

    // --- audio ------------------------------------------------------------
    void prepareToPlay(int samplesPerBlockExpected, double sampleRate) override;
    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override;
    void releaseResources() override;

    // --- ui ---------------------------------------------------------------
    void paint(juce::Graphics&) override;
    void resized() override;
    void mouseDown(const juce::MouseEvent&) override;
    void mouseDrag(const juce::MouseEvent&) override;
    void mouseUp(const juce::MouseEvent&) override;
    bool keyPressed(const juce::KeyPress&) override;

private:
    void timerCallback() override;

    void pollKeyboard();
    void toggleRecord();
    void togglePlay();
    void refit();

    void paintHeader(juce::Graphics&);
    void paintTakeView(juce::Graphics&);
    void paintReadouts(juce::Graphics&);
    void paintKeyboard(juce::Graphics&);
    void paintControls(juce::Graphics&);

    /** Beats -> x within the take view. */
    float beatToX(double beats) const;
    /** Pitch -> y within the take view. */
    float pitchToY(int pitch) const;

    Engine engine_;
    FitOptions fitOptions_;
    Take take_;

    // Computer keyboard as an instrument. Two rows, laid out like a piano.
    struct KeyMap { int keyCode; int semitone; bool black; };
    std::vector<KeyMap> keyMap_;
    std::array<bool, 128> keyDown_{};
    std::array<bool, 128> noteSounding_{};
    int octaveOffset_ = 0;

    // Layout.
    juce::Rectangle<int> headerArea_, takeArea_, readoutArea_, controlArea_, keyboardArea_;
    juce::Rectangle<int> recButton_, playButton_, clearButton_;
    juce::Rectangle<int> strengthSlider_, swingToggle_;

    // Pitch range currently displayed, so the view frames what was played.
    int lowPitch_ = 48, highPitch_ = 72;

    // Animation.
    float recPulse_ = 0.0f;
    double lastFitTime_ = 0.0;
    /** 0..1 animation of notes travelling from played to fitted position. */
    float fitReveal_ = 1.0f;

    bool draggingStrength_ = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainComponent)
};

} // namespace motif
