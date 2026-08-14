#include "ShellComponent.h"

#include "music/Project.h"
#include "music/Song.h"

#if JUCE_WINDOWS
 #include <windows.h>
#endif

namespace motif {

ShellComponent::ShellComponent() {
    setSize(1280, 820);

    // Pick up where the last session left off.
    //
    // Closing the window is how people stop working, not a decision to discard
    // what they were doing. The autosave is written on the way out and read
    // back here; if there is not one yet, the starter kit.
    Song restored;
    std::string ignored;
    if (loadProject(kAutosaveName, restored, ignored)) engine_.setSong(restored);
    else                                               engine_.setSong(makeDefaultSong());

    // Interface first, audio second.
    //
    // Opening the audio device enumerates every driver on the machine, which
    // took 22 seconds here. Doing that before building the window means the app
    // looks like it has failed to start for the whole of it. The engine renders
    // silence until the device arrives, so there is nothing to wait for.
    const auto root = findWebRoot();
    if (!root.exists()) {
        failure_ = "Could not find the web/ directory next to the executable.";
        return;
    }

    bridgePort_ = bridge_.start(root.getFullPathName().toStdString(), 7777);
    if (bridgePort_ <= 0) {
        failure_ = "Could not bind a local port for the interface.";
        return;
    }

    url_ = "http://127.0.0.1:" + juce::String(bridgePort_) + "/";

    // Audio is opened once the interface has loaded - see startAudio(). A
    // fallback timer covers the case where the page never reports back, so a
    // webview problem cannot also mean no sound.
    juce::Timer::callAfterDelay(4000, [safe = juce::Component::SafePointer<ShellComponent>(this)] {
        if (safe != nullptr) safe->startAudio();
    });
}

ShellComponent::~ShellComponent() {
    stopTimer();

    // Before anything is torn down, while the song is still whole.
    std::string ignored;
    saveProject(kAutosaveName, engine_.song(), ignored);

    web_.reset();
    bridge_.stop();
    shutdownAudio();
}

void ShellComponent::parentHierarchyChanged() {
    // Fires when this component is attached to the window. By now there is a
    // native peer, which is what WebView2 needs and what the constructor could
    // not offer it.
    if (webViewAttempted_ || bridgePort_ <= 0 || getPeer() == nullptr) return;
    webViewAttempted_ = true;
    createWebView();
}

void ShellComponent::startAudio() {
    if (audioStarted_) return;
    audioStarted_ = true;
    setAudioChannels(0, 2);
    startTimer(60000);
}

void ShellComponent::timerCallback() {
    std::string ignored;
    saveProject(kAutosaveName, engine_.song(), ignored);
}

/**
 * The only reason to subclass: JUCE reports page load by virtual method, and
 * the shell needs to know when the interface is up so it can open the audio
 * device without stalling the navigation that gets it there.
 */
struct ShellComponent::WebView : juce::WebBrowserComponent {
    WebView(const Options& options, ShellComponent& owner)
        : juce::WebBrowserComponent(options), owner_(owner) {}

    void pageFinishedLoading(const juce::String&) override { owner_.startAudio(); }

    ShellComponent& owner_;
};

void ShellComponent::createWebView() {
    // The backend must be named explicitly. Left to itself JUCE falls back to
    // the legacy ActiveX browser, which is Internet Explorer and cannot parse
    // an arrow function, let alone async/await - the interface loads and then
    // dies on a syntax error.
    // Keep the profile out of the roaming user directory so the app stays
    // self-contained. Created up front: WebView2 will not start if the folder
    // it is handed does not already exist.
    const auto dataDir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                             .getChildFile("MotifWebView");
    dataDir.createDirectory();

    // Open a debug port on the embedded view.
    //
    // WebView2 reads this variable when it creates its environment, which makes
    // the interface inside the shipped app reachable over CDP. That is what
    // lets a test drive the real thing - the exe, its engine, its window -
    // rather than a browser pointed at the same page and hoping they match.
    // Loopback only, and only ever bound on this machine.
#if JUCE_WINDOWS
    ::SetEnvironmentVariableW(L"WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                              L"--remote-debugging-port=9222 --remote-allow-origins=*");
#endif

    const auto options =
        juce::WebBrowserComponent::Options{}
            .withBackend(juce::WebBrowserComponent::Options::Backend::webview2)
            .withWinWebView2Options(
                juce::WebBrowserComponent::Options::WinWebView2{}
                    .withUserDataFolder(dataDir)
                    .withBackgroundColour(juce::Colour(0xff070910)));

    web_ = std::make_unique<WebView>(options, *this);
    addAndMakeVisible(*web_);
    resized();
    web_->goToURL(url_);
    repaint();
}

juce::File ShellComponent::findWebRoot() {
    auto here = juce::File::getSpecialLocation(juce::File::currentExecutableFile);
    for (int up = 0; up < 8 && here.exists(); ++up) {
        const auto candidate = here.getChildFile("web");
        if (candidate.getChildFile("index.html").existsAsFile()) return candidate;
        here = here.getParentDirectory();
    }
    return {};
}

// --- audio -----------------------------------------------------------------

void ShellComponent::prepareToPlay(int blockSize, double sampleRate) {
    engine_.prepare(sampleRate, blockSize);
}

void ShellComponent::getNextAudioBlock(const juce::AudioSourceChannelInfo& info) {
    auto* buffer = info.buffer;
    if (buffer->getNumChannels() < 2) { info.clearActiveBufferRegion(); return; }
    engine_.render(buffer->getWritePointer(0, info.startSample),
                   buffer->getWritePointer(1, info.startSample),
                   info.numSamples);
}

void ShellComponent::releaseResources() {}

// --- ui --------------------------------------------------------------------

void ShellComponent::paint(juce::Graphics& g) {
    g.fillAll(juce::Colour(0xff070910));
    if (web_) return;

    // Only shown when the interface could not be loaded at all, so it says what
    // went wrong rather than presenting an empty window.
    auto area = getLocalBounds().reduced(40);
    g.setColour(juce::Colour(0xffe9eefb));
    g.setFont(juce::Font(juce::FontOptions().withHeight(28.0f).withStyle("Bold")));
    g.drawText("MOTIF", area.removeFromTop(46), juce::Justification::centred, false);

    g.setColour(juce::Colour(0xff5ee6c5));
    g.setFont(juce::Font(juce::FontOptions().withHeight(15.0f)));
    g.drawText(failure_.isNotEmpty() ? failure_
                                     : "Engine running. Interface at " + url_,
               area.removeFromTop(60), juce::Justification::centred, true);

    g.setColour(juce::Colour(0xff55607a));
    g.setFont(juce::Font(juce::FontOptions().withHeight(12.0f)));
    g.drawText("Audio runs here. Closing this window stops the engine.",
               area.removeFromTop(30), juce::Justification::centred, false);
}

void ShellComponent::resized() {
    if (web_) web_->setBounds(getLocalBounds());
}

} // namespace motif
