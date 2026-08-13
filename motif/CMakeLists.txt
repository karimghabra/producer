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

juce_add_gui_app(Motif
    PRODUCT_NAME "Motif"
    COMPANY_NAME "Motif"
    VERSION ${PROJECT_VERSION}
)

juce_generate_juce_header(Motif)

target_sources(Motif PRIVATE
    src/Main.cpp
    src/MainComponent.cpp
    src/audio/Engine.cpp
    src/audio/Drums.cpp
    src/music/Quantizer.cpp
    src/music/Song.cpp
    src/ui/Theme.cpp
)

target_include_directories(Motif PRIVATE src)

target_compile_definitions(Motif PRIVATE
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:Motif,JUCE_PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:Motif,JUCE_VERSION>"
    # We drive our own DSP; JUCE is here for I/O and drawing.
    JUCE_DISPLAY_SPLASH_SCREEN=0
)

target_link_libraries(Motif PRIVATE
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
    src/audio/Drums.cpp
)
target_include_directories(MotifTests PRIVATE src)

enable_testing()
add_test(NAME quantizer COMMAND MotifTests)
