cmake_minimum_required(VERSION 3.22)

project(Motif VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if (MSVC)
    add_compile_options(/W4 /permissive- /utf-8)
    # Denormals cost real time in feedback paths; flush them to zero.
    add_compile_options($<$<CONFIG:Release>:/fp:fast>)
else()
    add_compile_options(-Wall -Wextra)
endif()

include(FetchContent)

# JUCE gives us audio device handling, MIDI, and a vector graphics API.
# Fetched rather than vendored so there is nothing to install by hand.
FetchContent_Declare(
    JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG 8.0.4
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(JUCE)

# Single-header HTTP server. The UI is a web page driven over localhost, which
# keeps the audio in C++ where it belongs while making the interface something
# a browser - and Playwright - can actually drive and inspect.
FetchContent_Declare(
    httplib
    GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
    GIT_TAG v0.18.3
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(httplib)

# JSON, for the project format.
#
# The interface payloads are written by hand - they are one-way and shaped by
# what the UI needs. A saved project has to be read back as well as written,
# and hand-rolling a parser is where a file format quietly starts losing
# people's work.
FetchContent_Declare(
    nlohmann_json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG v3.11.3
    GIT_SHALLOW TRUE
)
set(JSON_BuildTests OFF CACHE INTERNAL "")
FetchContent_MakeAvailable(nlohmann_json)

# WebView2 headers and import library.
#
# JUCE looks for a NuGet package on disk. A .nupkg is a zip, so fetching and
# extracting it keeps the build self-contained: no NuGet install, nothing for
# anyone cloning this to do by hand.
if (WIN32)
    FetchContent_Declare(
        webview2pkg
        URL https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.2792.45
        DOWNLOAD_EXTRACT_TIMESTAMP TRUE
        SOURCE_DIR ${CMAKE_BINARY_DIR}/webview2/Microsoft.Web.WebView2
    )
    FetchContent_MakeAvailable(webview2pkg)
    set(JUCE_WEBVIEW2_PACKAGE_LOCATION ${CMAKE_BINARY_DIR}/webview2
        CACHE STRING "Where JUCE should look for the WebView2 package" FORCE)
endif()

juce_add_gui_app(Motif
    PRODUCT_NAME "Motif"
    COMPANY_NAME "Motif"
    VERSION ${PROJECT_VERSION}
    # The interface is a web page rendered inside the app's own window via
    # WebView2, which ships with Windows. One executable, one window, no
    # browser - while the UI itself stays something that can be edited without
    # a rebuild and driven by a test.
    NEEDS_WEB_BROWSER TRUE
    NEEDS_WEBVIEW2 TRUE
)

juce_generate_juce_header(Motif)

target_sources(Motif PRIVATE
    src/Main.cpp
    src/ShellComponent.cpp
    src/audio/Engine.cpp
    src/audio/Drums.cpp
    src/music/Quantizer.cpp
    src/music/Song.cpp
    src/music/Presets.cpp
    src/music/Params.cpp
    src/music/Project.cpp
    src/music/Automation.cpp
    src/net/Bridge.cpp
)

target_include_directories(Motif PRIVATE src)

# WebView2 is loaded at runtime through WebView2Loader.dll. Without it beside
# the executable the backend faults during construction - and as an access
# violation rather than a C++ exception, so nothing can catch it and the
# process simply disappears. The NuGet package ships the DLL; put it where the
# loader will look.
if (WIN32)
    add_custom_command(TARGET Motif POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${CMAKE_BINARY_DIR}/webview2/Microsoft.Web.WebView2/build/native/x64/WebView2Loader.dll"
            "$<TARGET_FILE_DIR:Motif>"
        COMMENT "Copying WebView2Loader.dll beside Motif.exe"
        VERBATIM)
endif()

target_compile_definitions(Motif PRIVATE
    JUCE_WEB_BROWSER=1
    JUCE_USE_WIN_WEBVIEW2=1
    JUCE_USE_CURL=0
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:Motif,JUCE_PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:Motif,JUCE_VERSION>"
    # We drive our own DSP; JUCE is here for I/O and drawing.
    JUCE_DISPLAY_SPLASH_SCREEN=0
)

target_link_libraries(Motif PRIVATE
    httplib::httplib
    nlohmann_json::nlohmann_json
    juce::juce_audio_utils
    juce::juce_audio_devices
    juce::juce_gui_extra
    juce::juce_dsp
    PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags
)

# ---------------------------------------------------------------------------
# Tests
#
# The quantizer is deliberately free of JUCE, so the part of this app that is
# actually novel can be tested on its own without spinning up an audio device.
# ---------------------------------------------------------------------------

add_executable(MotifTests
    tests/QuantizerTest.cpp
    src/music/Quantizer.cpp
    src/music/Song.cpp
    src/music/Presets.cpp
    src/music/Params.cpp
    src/music/Project.cpp
    src/music/Automation.cpp
    src/audio/Drums.cpp
    src/audio/Engine.cpp
)
target_include_directories(MotifTests PRIVATE src)
target_link_libraries(MotifTests PRIVATE nlohmann_json::nlohmann_json)

enable_testing()
add_test(NAME quantizer COMMAND MotifTests)
