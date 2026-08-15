cmake_minimum_required(VERSION 3.22)

project(Motif VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if (MSVC)
    add_compile_options(/W4 /permissive- /utf-8)
    # Denormals cost real time in feedback paths; flush them to zero.
    add_compile_options($<$<CONFIG:Release>:/fp:fast>)

    # Link the C++ runtime into the executable.
    #
    # Otherwise it needs MSVCP140.dll and VCRUNTIME140.dll, which only exist on
    # a machine that has had Visual Studio or its redistributable installed.
    # Copying the app to a laptop would fail at launch with a missing-DLL box
    # and no explanation. A megabyte is worth not having that conversation.
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
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

# ---------------------------------------------------------------------------
# Packaging
#
# What ships is the executable, the WebView2 loader beside it, and the web/
# directory the interface is served from. findWebRoot() walks up from the
# executable looking for web/index.html, so the layout here is the one it
# expects: everything in one folder, nothing to configure.
#
#   cmake --build build --config Release
#   cpack --config build/CPackConfig.cmake -C Release
#
# Produces a ZIP that runs from anywhere, and an installer as well if Inno
# Setup or NSIS is on the machine.
# ---------------------------------------------------------------------------

# Everything ships as one component, and only that component is packaged.
#
# JUCE and cpp-httplib are brought in with FetchContent and carry their own
# install rules, so a package that takes everything ends up with three
# thousand files of headers and a copy of juceaide - 19MB of build tooling
# wrapped around a 7MB app.
# COMPONENT belongs to each artefact kind. Written once at the end it attaches
# only to the last of them, and the executable quietly lands in a component
# nothing packages - producing a 130KB archive with no application in it.
install(TARGETS Motif
        RUNTIME DESTINATION . COMPONENT app
        BUNDLE  DESTINATION . COMPONENT app)
install(DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/web/" DESTINATION web COMPONENT app)

if (WIN32)
    install(FILES
        "${CMAKE_BINARY_DIR}/webview2/Microsoft.Web.WebView2/build/native/x64/WebView2Loader.dll"
        DESTINATION . COMPONENT app)
endif()

set(CPACK_PACKAGE_NAME "Motif")
set(CPACK_PACKAGE_VENDOR "Motif")
set(CPACK_PACKAGE_VERSION ${PROJECT_VERSION})
set(CPACK_PACKAGE_DESCRIPTION_SUMMARY
    "Play a rhythm and Motif works out the tempo, the grid and the shuffle")
set(CPACK_PACKAGE_INSTALL_DIRECTORY "Motif")
set(CPACK_PACKAGE_FILE_NAME "Motif-${PROJECT_VERSION}-windows-x64")
# One folder, so unzipping does not scatter the app across wherever it landed.
set(CPACK_PACKAGE_DIRECTORY "${CMAKE_BINARY_DIR}/dist")
set(CPACK_VERBATIM_VARIABLES TRUE)

# Just the app: not the dependencies' headers and build tools.
#
# Component install has to be ON for the component list to be honoured at all -
# with it off the archive is monolithic and takes everything regardless - and
# the grouping then puts the one component we do want into a single archive.
set(CPACK_COMPONENTS_ALL app)
set(CPACK_ARCHIVE_COMPONENT_INSTALL ON)
set(CPACK_COMPONENTS_GROUPING ALL_COMPONENTS_IN_ONE)

# ZIP always: it needs no tooling and no administrator, and unzip-and-run is a
# lower bar than an installer for something you are still changing daily.
set(CPACK_GENERATOR "ZIP")

find_program(INNO_SETUP NAMES iscc ISCC)
find_program(NSIS_MAKE NAMES makensis)
if (INNO_SETUP)
    list(APPEND CPACK_GENERATOR "INNOSETUP")
    set(CPACK_INNOSETUP_INSTALL_ROOT "{autopf}")
    set(CPACK_INNOSETUP_PROGRAM_MENU_FOLDER "Motif")
    set(CPACK_PACKAGE_EXECUTABLES "Motif" "Motif")
    set(CPACK_CREATE_DESKTOP_LINKS "Motif")
elseif (NSIS_MAKE)
    list(APPEND CPACK_GENERATOR "NSIS")
    set(CPACK_NSIS_PACKAGE_NAME "Motif")
    set(CPACK_NSIS_DISPLAY_NAME "Motif")
    set(CPACK_NSIS_INSTALLED_ICON_NAME "Motif.exe")
    set(CPACK_NSIS_MODIFY_PATH OFF)
    set(CPACK_PACKAGE_EXECUTABLES "Motif" "Motif")
    set(CPACK_CREATE_DESKTOP_LINKS "Motif")
endif()

include(CPack)
