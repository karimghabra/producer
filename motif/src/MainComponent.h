#pragma once

#include <JuceHeader.h>

#include <array>
#include <functional>
#include <vector>

#include "audio/Engine.h"
#include "music/Quantizer.h"
#include "music/Song.h"

namespace motif {

/**
 * The window.
 *
 * Controls are immediate-mode: each paint rebuilds a list of live widgets with
 * their hit rectangles and setters, and the mouse handlers look up whatever is
 * under the cursor. With a fully custom-drawn interface that avoids keeping a
 * parallel tree of Components in sync with a document that changes underneath
 * it — the widget list cannot drift from what is on screen, because it is
 * built from the same pass that drew it.
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
    void mouseDoubleClick(const juce::MouseEvent&) override;
    bool keyPressed(const juce::KeyPress&) override;

private:
    enum class View { Arrange, Mix, Sound };

    void timerCallback() override;

    // --- widgets ----------------------------------------------------------
    struct Knob {
        juce::Rectangle<int> bounds;
        juce::String label, display;
        float normalised = 0.0f;
        float defaultNorm = 0.0f;
        juce::Colour tint;
        bool bipolar = false;
        std::function<void(float)> onChange;
    };
    struct Hit {
        juce::Rectangle<int> bounds;
        std::function<void()> onClick;
    };

    void addKnob(juce::Rectangle<int> b, const juce::String& label, float norm,
                 const juce::String& display, juce::Colour tint,
                 std::function<void(float)> onChange, bool bipolar = false,
                 float defaultNorm = 0.0f);
    void addHit(juce::Rectangle<int> b, std::function<void()> onClick);
    void drawChip(juce::Graphics&, juce::Rectangle<int>, const juce::String&,
                  juce::Colour, bool on, std::function<void()> onClick);

    // --- actions ----------------------------------------------------------
    void pollKeyboard();
    void toggleRecord();
    void togglePlay();
    void refit();
    void commitTakeToTrack();
    void selectTrack(int index);
    void addTrack(bool drum);
    void removeSelectedTrack();
    Track* selected();

    // --- painting ---------------------------------------------------------
    void paintHeader(juce::Graphics&);
    void paintTrackRail(juce::Graphics&);
    void paintArrangeView(juce::Graphics&);
    void paintMixView(juce::Graphics&);
    void paintSoundView(juce::Graphics&);
    void paintTransportStrip(juce::Graphics&);
    void paintKeyboard(juce::Graphics&);

    float beatToX(double beats) const;
    float pitchToY(int pitch) const;

    Engine engine_;
    Song song_;
    FitOptions fitOptions_;
    Take take_;
    bool takeIsCommitted_ = false;

    View view_ = View::Arrange;
    int selectedTrack_ = 0;

    std::vector<Knob> knobs_;
    std::vector<Hit> hits_;
    int draggingKnob_ = -1;
    float dragStartNorm_ = 0.0f;
    int dragStartY_ = 0;

    struct KeyMap { int keyCode; int semitone; bool black; };
    std::vector<KeyMap> keyMap_;
    std::array<bool, 128> noteSounding_{};
    int octaveOffset_ = 0;

    juce::Rectangle<int> headerArea_, railArea_, mainArea_, stripArea_, keyboardArea_;
    juce::Rectangle<int> recButton_, playButton_, keepButton_;
    std::array<juce::Rectangle<int>, 3> viewTabs_;
    std::vector<juce::Rectangle<int>> trackRows_;
    juce::Rectangle<int> strengthSlider_;
    bool draggingStrength_ = false;

    int lowPitch_ = 48, highPitch_ = 72;
    float recPulse_ = 0.0f;
    float fitReveal_ = 1.0f;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainComponent)
};

} // namespace motif
