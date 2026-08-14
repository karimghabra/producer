#include <JuceHeader.h>

#include "ShellComponent.h"

#if JUCE_WINDOWS
 #include <windows.h>
#endif

namespace motif {
namespace {

/**
 * Declare DPI awareness before any window exists.
 *
 * Without this Windows treats the process as legacy: it sizes the window in
 * physical pixels while JUCE, which does know the display scale, renders the
 * component at that scale. On a 150% display the component is drawn 1.5x
 * larger than the frame it is drawn into, so a third of the interface sits
 * outside the window and is simply never seen.
 *
 * Resolved dynamically because SetProcessDpiAwarenessContext only exists from
 * Windows 10 1703, and the SDK here is older than the symbol.
 */
void declareDpiAwareness() {
#if JUCE_WINDOWS
    using SetContextFn = BOOL(WINAPI*)(void*);
    if (HMODULE user32 = ::GetModuleHandleA("user32.dll")) {
        if (auto set = reinterpret_cast<SetContextFn>(
                ::GetProcAddress(user32, "SetProcessDpiAwarenessContext"))) {
            // -4 is DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2.
            if (set(reinterpret_cast<void*>(-4))) return;
        }
    }
    // Older Windows: system-wide awareness is still far better than none.
    if (HMODULE shcore = ::LoadLibraryA("shcore.dll")) {
        using SetAwarenessFn = HRESULT(WINAPI*)(int);
        if (auto set = reinterpret_cast<SetAwarenessFn>(
                ::GetProcAddress(shcore, "SetProcessDpiAwareness"))) {
            set(2);   // PROCESS_PER_MONITOR_DPI_AWARE
        }
    }
#endif
}

/**
 * Run it during static initialisation, before main and therefore before JUCE
 * builds its Desktop. Declaring awareness from inside initialise() is already
 * too late: by then the process has been classified, windows measured, and
 * Windows goes on virtualising every coordinate regardless.
 */
const bool kDpiAwarenessDeclared = [] { declareDpiAwareness(); return true; }();

} // namespace

class MotifApplication : public juce::JUCEApplication {
public:
    const juce::String getApplicationName() override { return "Motif"; }
    const juce::String getApplicationVersion() override { return "0.1.0"; }
    bool moreThanOneInstanceAllowed() override { return false; }

    void initialise(const juce::String&) override {
        juce::ignoreUnused(kDpiAwarenessDeclared);

        mainWindow_ = std::make_unique<MainWindow>(getApplicationName());
    }

    void shutdown() override { mainWindow_ = nullptr; }

    void systemRequestedQuit() override { quit(); }

private:
    class MainWindow : public juce::DocumentWindow {
    public:
        explicit MainWindow(const juce::String& name)
            : DocumentWindow(name,
                             juce::Colour(0xff070910),
                             DocumentWindow::minimiseButton | DocumentWindow::closeButton) {
            setUsingNativeTitleBar(true);
            setContentOwned(new ShellComponent(), true);
            setResizable(true, false);
            setResizeLimits(820, 560, 4000, 2600);
            // Size from the display's own numbers, divided by its scale.
            //
            // On a 150% display the component was being laid out at 1280 wide
            // and rendered 1.5x larger than the frame it was drawn into, so a
            // third of the interface sat outside the window and was never
            // seen. Dividing by the reported scale is correct whether userArea
            // comes back in physical or logical units: if physical, this is the
            // conversion; if logical, the window merely opens smaller than the
            // screen. Either way nothing ends up outside the frame, which is
            // the property that actually matters.
            int w = getWidth(), h = getHeight();
            if (auto* display = juce::Desktop::getInstance().getDisplays().getPrimaryDisplay()) {
                const auto usable = display->userArea;
                if (usable.getWidth() > 200 && usable.getHeight() > 200) {
                    w = juce::jmin(w, int(usable.getWidth() * 0.92));
                    h = juce::jmin(h, int(usable.getHeight() * 0.92));
                }
            }
            centreWithSize(juce::jmax(760, w), juce::jmax(520, h));

            // No full-screen workaround any more: the interface is laid out by
            // the browser engine, which handles display scaling correctly on
            // its own. That was the entire cause of the clipping.
            setVisible(true);
        }

        void closeButtonPressed() override {
            juce::JUCEApplication::getInstance()->systemRequestedQuit();
        }

    private:
        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainWindow)
    };

    std::unique_ptr<MainWindow> mainWindow_;
};

} // namespace motif

START_JUCE_APPLICATION(motif::MotifApplication)
