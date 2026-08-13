#include "ui/Theme.h"

namespace motif::ui {

juce::Font monoFont(float height, bool bold) {
    return juce::Font(juce::FontOptions()
                          .withName(juce::Font::getDefaultMonospacedFontName())
                          .withHeight(height)
                          .withStyle(bold ? "Bold" : "Regular"));
}

juce::Font uiFont(float height, bool bold) {
    return juce::Font(juce::FontOptions()
                          .withHeight(height)
                          .withStyle(bold ? "Bold" : "Regular"));
}

void drawPanel(juce::Graphics& g, juce::Rectangle<float> bounds, float corner, bool raised) {
    // A vertical gradient rather than a flat fill: it is a small thing, but it
    // stops large areas reading as dead space.
    juce::ColourGradient grad(raised ? colour::ink2 : colour::ink1,
                              bounds.getCentreX(), bounds.getY(),
                              (raised ? colour::ink2 : colour::ink1).darker(0.18f),
                              bounds.getCentreX(), bounds.getBottom(), false);
    g.setGradientFill(grad);
    g.fillRoundedRectangle(bounds, corner);

    g.setColour(colour::line);
    g.drawRoundedRectangle(bounds.reduced(0.5f), corner, 1.0f);

    // A single lit pixel along the top edge suggests a light source above.
    g.setColour(juce::Colours::white.withAlpha(0.045f));
    g.drawLine(bounds.getX() + corner, bounds.getY() + 1.0f,
               bounds.getRight() - corner, bounds.getY() + 1.0f, 1.0f);
}

void drawGlow(juce::Graphics& g, juce::Rectangle<float> bounds,
              juce::Colour tint, float intensity, float corner) {
    if (intensity <= 0.001f) return;
    // Concentric strokes, fading outward. Cheaper than a real blur and, at
    // these sizes, indistinguishable from one.
    for (int i = 6; i >= 1; --i) {
        const float t = float(i) / 6.0f;
        g.setColour(tint.withAlpha(0.10f * intensity * (1.0f - t) + 0.02f * intensity));
        g.drawRoundedRectangle(bounds.expanded(float(i) * 1.6f), corner + float(i) * 1.4f, 1.6f);
    }
}

void drawKnob(juce::Graphics& g, juce::Rectangle<float> bounds,
              float normalised, juce::Colour tint, bool bipolar) {
    const auto centre = bounds.getCentre();
    const float radius = juce::jmin(bounds.getWidth(), bounds.getHeight()) * 0.5f - 2.0f;
    const float start = juce::degreesToRadians(225.0f);
    const float sweep = juce::degreesToRadians(270.0f);
    const float value = juce::jlimit(0.0f, 1.0f, normalised);

    juce::Path track;
    track.addCentredArc(centre.x, centre.y, radius, radius, 0.0f, start, start + sweep, true);
    g.setColour(colour::ink2.brighter(0.16f));
    g.strokePath(track, juce::PathStrokeType(3.2f, juce::PathStrokeType::curved,
                                             juce::PathStrokeType::rounded));

    const float from = bipolar ? 0.5f : 0.0f;
    if (std::abs(value - from) > 0.004f) {
        juce::Path arc;
        arc.addCentredArc(centre.x, centre.y, radius, radius, 0.0f,
                          start + sweep * from, start + sweep * value, true);
        g.setColour(tint);
        g.strokePath(arc, juce::PathStrokeType(3.2f, juce::PathStrokeType::curved,
                                               juce::PathStrokeType::rounded));
    }

    // Body.
    const float bodyR = radius * 0.66f;
    juce::ColourGradient body(colour::ink2.brighter(0.10f), centre.x, centre.y - bodyR,
                              colour::ink1.darker(0.30f), centre.x, centre.y + bodyR, false);
    g.setGradientFill(body);
    g.fillEllipse(juce::Rectangle<float>(bodyR * 2.0f, bodyR * 2.0f).withCentre(centre));
    g.setColour(colour::line);
    g.drawEllipse(juce::Rectangle<float>(bodyR * 2.0f, bodyR * 2.0f).withCentre(centre), 1.0f);

    // Pointer.
    const float angle = start + sweep * value;
    const juce::Point<float> tip(centre.x + std::cos(angle) * bodyR * 0.82f,
                                 centre.y + std::sin(angle) * bodyR * 0.82f);
    g.setColour(tint.brighter(0.25f));
    g.drawLine({ centre, tip }, 2.2f);
}

void drawCaption(juce::Graphics& g, juce::Rectangle<int> bounds,
                 const juce::String& text, juce::Colour tint, juce::Justification just) {
    g.setColour(tint);
    g.setFont(uiFont(10.0f, true));
    // Letter-spacing by hand; JUCE has no tracking, and small caps without it
    // look cramped.
    juce::String spaced;
    for (int i = 0; i < text.length(); ++i) {
        spaced += text[i];
        if (i < text.length() - 1) spaced += juce::String::charToString(0x2009); // thin space
    }
    g.drawText(spaced.toUpperCase(), bounds, just, false);
}

void drawReadout(juce::Graphics& g, juce::Rectangle<int> bounds,
                 const juce::String& label, const juce::String& value, juce::Colour tint) {
    auto area = bounds;
    drawCaption(g, area.removeFromTop(13), label, colour::dimmer);
    g.setColour(tint);
    g.setFont(monoFont(float(juce::jmin(26, area.getHeight())), true));
    g.drawText(value, area, juce::Justification::centredLeft, false);
}

} // namespace motif::ui
