#pragma once

#include <JuceHeader.h>

#include <array>
#include <vector>

#include "audio/Engine.h"
#include "music/Quantizer.h"
#include "music/Song.h"

namespace motif {

/**
 * The window.
 *
 * Two ideas share the screen. On the left, a track manager — the multi-track
 * arrangement. In the middle, the take view, which draws what you played and
 * where the fitter decided it belongs at the same time, so a correction is
 * something you watch happen rather than accept on trust.
 */
class MainComponent : public juce::AudioAppComponent,
                      private juce::Timer {
public:
    MainComponent();
    ~MainComponent() override;

    void prepareToPlay(int samplesPerBlockExpected, double sampleRate) override;
    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override;
    void releaseResources() override;

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
    void commitTakeToTrack();
    void selectTrack(int index);
    void addTrack(bool drum);
    void removeSelectedTrack();

    void paintHeader(juce::Graphics&);
    void paintTrackRail(juce::Graphics&);
    void paintTakeView(juce::Graphics&);
    void paintReadouts(juce::Graphics&);
    void paintControls(juce::Graphics&);
    void paintKeyboard(juce::Graphics&);

    float beatToX(double beats) const;
    float pitchToY(int pitch) const;

    Engine engine_;
    Song song_;                 // UI-side copy, refreshed each frame
    FitOptions fitOptions_;
    Take take_;
    bool takeIsCommitted_ = false;

    int selectedTrack_ = 0;

    struct KeyMap { int keyCode; int semitone; bool black; };
    std::vector<KeyMap> keyMap_;
    std::array<bool, 128> noteSounding_{};
    int octaveOffset_ = 0;

    juce::Rectangle<int> headerArea_, railArea_, takeArea_, readoutArea_, controlArea_, keyboardArea_;
    juce::Rectangle<int> recButton_, playButton_, keepButton_;
    juce::Rectangle<int> strengthSlider_, swingToggle_, addSynthButton_, addDrumButton_;
    std::vector<juce::Rectangle<int>> trackRows_;

    int lowPitch_ = 48, highPitch_ = 72;
    float recPulse_ = 0.0f;
    float fitReveal_ = 1.0f;
    bool draggingStrength_ = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainComponent)
};

} // namespace motif
