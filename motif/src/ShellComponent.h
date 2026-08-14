#pragma once

// ---------------------------------------------------------------------------
// Motif — the application window.
//
// It owns the audio engine and the local bridge, and shows the interface in an
// embedded WebView2. One executable, one window, no browser: the web part is
// an implementation detail of how the interface is drawn, not something the
// user has to go and open.
//
// The audio never touches this class. The engine renders on the audio thread,
// the bridge serves a snapshot over loopback, and this is just the frame that
// holds the picture.
// ---------------------------------------------------------------------------

#include <JuceHeader.h>

#include <memory>

#include "audio/Engine.h"
#include "net/Bridge.h"

namespace motif {

class ShellComponent : public juce::AudioAppComponent {
public:
    ShellComponent();
    ~ShellComponent() override;

    void prepareToPlay(int samplesPerBlockExpected, double sampleRate) override;
    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override;
    void releaseResources() override;

    void paint(juce::Graphics&) override;
    void resized() override;

    int bridgePort() const { return bridgePort_; }

private:
    /** Locate the interface on disk by walking up from the executable. */
    static juce::File findWebRoot();

    Engine engine_;
    Bridge bridge_{ engine_ };
    int bridgePort_ = 0;
    juce::String failure_;
    juce::String url_;

    std::unique_ptr<juce::WebBrowserComponent> web_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(ShellComponent)
};

} // namespace motif
