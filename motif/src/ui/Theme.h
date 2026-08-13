#pragma once

#include <JuceHeader.h>

namespace motif::ui {

/**
 * Palette.
 *
 * Two accents doing one job: amber is what you played, mint is where it landed.
 * Everything in the app that shows the fit uses that pairing, so the difference
 * between a performance and its grid is always the same two colours.
 */
namespace colour {
    const juce::Colour ink0     { 0xff070910 };   // page
    const juce::Colour ink1     { 0xff0e121b };   // panel
    const juce::Colour ink2     { 0xff161c29 };   // raised
    const juce::Colour line     { 0xff222b3d };   // hairline
    const juce::Colour lineSoft { 0xff192031 };

    const juce::Colour text     { 0xffe9eefb };
    const juce::Colour dim      { 0xff8593ad };
    const juce::Colour dimmer   { 0xff55607a };

    const juce::Colour played   { 0xffffb86b };   // amber — as performed
    const juce::Colour fitted   { 0xff5ee6c5 };   // mint  — as fitted
    const juce::Colour hot      { 0xffff5c7a };   // record
    const juce::Colour gold     { 0xffffd479 };
}

/** Rounded panel with a hairline and a faint inner lift. */
void drawPanel(juce::Graphics& g, juce::Rectangle<float> bounds,
               float corner = 10.0f, bool raised = false);

/** Soft outer glow, for anything that should feel alive. */
void drawGlow(juce::Graphics& g, juce::Rectangle<float> bounds,
              juce::Colour tint, float intensity, float corner = 10.0f);

/** A knob that looks like it wants to be turned. */
void drawKnob(juce::Graphics& g, juce::Rectangle<float> bounds,
              float normalised, juce::Colour tint, bool bipolar = false);

/** Section label: small, wide-tracked, quiet. */
void drawCaption(juce::Graphics& g, juce::Rectangle<int> bounds,
                 const juce::String& text, juce::Colour tint,
                 juce::Justification just = juce::Justification::centredLeft);

/** Monospaced numeric readout with a label above it. */
void drawReadout(juce::Graphics& g, juce::Rectangle<int> bounds,
                 const juce::String& label, const juce::String& value,
                 juce::Colour tint);

juce::Font monoFont(float height, bool bold = false);
juce::Font uiFont(float height, bool bold = false);

} // namespace motif::ui
