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

class ShellComponent : public juce::AudioAppComponent,
                       private juce::Timer {
public:
    /**
     * The project the session is kept in when it has not been given a name.
     *
     * Written periodically and on the way out, read back on the way in.
     * Closing the window is how people stop working, not a decision to throw
     * away what they were doing.
     */
    static constexpr const char* kAutosaveName = "Autosave";

    ShellComponent();
    ~ShellComponent() override;

    void prepareToPlay(int samplesPerBlockExpected, double sampleRate) override;
    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override;
    void releaseResources() override;

    void paint(juce::Graphics&) override;
    void resized() override;
    void parentHierarchyChanged() override;

    int bridgePort() const { return bridgePort_; }

private:
    /** Locate the interface on disk by walking up from the executable. */
    static juce::File findWebRoot();

    /**
     * Build the embedded view.
     *
     * Deferred until this component actually has a native peer. WebView2 needs
     * a real HWND to attach to, and in the constructor there is not one yet -
     * the component is not added to the window until after it returns.
     */
    void createWebView();
    bool webViewAttempted_ = false;

    /**
     * Open the audio device.
     *
     * Deferred until the interface has finished loading. Enumerating the
     * machine's audio drivers took 22 seconds here and it blocks the message
     * thread throughout - which also stalls WebView2's navigation, so the
     * window sits empty for the whole of it. Once the page is up the block
     * costs nothing visible: the interface runs in the webview's own process
     * and the bridge answers on its own thread, so neither is waiting on this.
     */
    void startAudio();
    bool audioStarted_ = false;

    /** Periodic autosave, so a crash costs a minute rather than the session. */
    void timerCallback() override;

    /** Notifies the shell when the interface has finished loading. */
    struct WebView;

    Engine engine_;
    Bridge bridge_{ engine_ };
    int bridgePort_ = 0;
    juce::String failure_;
    juce::String url_;

    std::unique_ptr<juce::WebBrowserComponent> web_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(ShellComponent)
};

} // namespace motif
