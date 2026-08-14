#include "ShellComponent.h"

#include "music/Song.h"

namespace motif {

namespace {
/** Startup log beside the executable, so a failure to appear can be read. */
void logLine(const juce::String& text) {
    auto file = juce::File::getSpecialLocation(juce::File::currentExecutableFile)
                    .getSiblingFile("motif-startup.log");
    file.appendText(juce::Time::getCurrentTime().toString(true, true) + "  " + text + "\n");
}
} // namespace

ShellComponent::ShellComponent() {
    setSize(1280, 820);
    logLine("shell starting");

    engine_.setSong(makeDefaultSong());

    // Interface first, audio second.
    //
    // Opening the audio device enumerates every driver on the machine, which
    // took 22 seconds here. Doing that before building the window means the app
    // looks like it has failed to start for the whole of it. The engine renders
    // silence until the device arrives, so there is nothing to wait for.
    const auto root = findWebRoot();
    logLine("web root: " + (root.exists() ? root.getFullPathName() : juce::String("NOT FOUND")));
    if (!root.exists()) {
        failure_ = "Could not find the web/ directory next to the executable.";
        return;
    }

    bridgePort_ = bridge_.start(root.getFullPathName().toStdString(), 7777);
    logLine("bridge port: " + juce::String(bridgePort_));
    if (bridgePort_ <= 0) {
        failure_ = "Could not bind a local port for the interface.";
        return;
    }

    // Keep the profile out of the roaming user directory so the app stays
    // self-contained. Created up front: WebView2 will not start if the folder
    // it is handed does not already exist.
    const auto dataDir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                             .getChildFile("MotifWebView");
    dataDir.createDirectory();

    const auto options =
        juce::WebBrowserComponent::Options{}
            .withBackend(juce::WebBrowserComponent::Options::Backend::webview2)
            .withWinWebView2Options(
                juce::WebBrowserComponent::Options::WinWebView2{}
                    .withUserDataFolder(dataDir)
                    .withBackgroundColour(juce::Colour(0xff070910))
                    // Without this the component throws instead of falling back
                    // when the runtime is missing, which takes the app with it.
                    .withStatusBarDisabled());

    url_ = "http://127.0.0.1:" + juce::String(bridgePort_) + "/";

    // TODO: embed the interface with WebView2 so this is a single window.
    //
    // Constructing juce::WebBrowserComponent with the webview2 backend takes
    // the process down with an access violation - not a C++ exception, so a
    // try/catch around it catches nothing. The runtime is installed and does
    // start (it spawns its helper processes), so the fault is in the handover,
    // most likely the options struct or the environment being created before
    // the component has a native peer to attach to.
    //
    // Until that is understood the interface opens in the default browser. The
    // engine, the bridge and the interface itself are unaffected; only where
    // the pixels land changes.
    juce::ignoreUnused(options);
    logLine("opening interface at " + url_);
    juce::URL(url_).launchInDefaultBrowser();

    // Now the slow part, once there is a window to look at while it happens.
    juce::MessageManager::callAsync([this] {
        setAudioChannels(0, 2);
        logLine("audio started");
    });
}

ShellComponent::~ShellComponent() {
    web_.reset();
    bridge_.stop();
    shutdownAudio();
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
