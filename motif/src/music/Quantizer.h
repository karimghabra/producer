#pragma once

// ---------------------------------------------------------------------------
// Motif — take fitting.
//
// You play. The machine works out what you meant.
//
// Every other tool makes you declare the grid first — set a tempo, pick a
// subdivision, enable a click — and then judges your playing against it. This
// does the opposite: it takes the performance as the ground truth and infers
// the grid that best explains it, including the tempo you were feeling, the
// subdivision you were playing in, whether you were swinging, and how many
// bars the idea actually is.
//
// Deliberately free of JUCE so it stays testable on its own.
// ---------------------------------------------------------------------------

#include <cstdint>
#include <vector>

namespace motif {

/** A note exactly as it was played, in seconds from the start of the take. */
struct RawNote {
    double startSec = 0.0;
    double endSec = 0.0;
    int pitch = 60;
    float velocity = 0.8f;
};

/** A note after fitting, positioned in beats from the top of the loop. */
struct FittedNote {
    double startBeats = 0.0;
    double lengthBeats = 0.25;
    int pitch = 60;
    float velocity = 0.8f;
    /** How far this note moved, in beats. Lets the UI show what it changed. */
    double movedBeats = 0.0;
};

/** The musical frame inferred from a performance. */
struct GridFit {
    double bpm = 120.0;
    /** Grid steps per beat: 4 = sixteenths, 3 = eighth triplets, 6 = sixteenth triplets. */
    int subdivision = 4;
    /** Where the grid begins, in seconds into the take. */
    double phaseSec = 0.0;
    /** Loop length. */
    int bars = 1;
    int beatsPerBar = 4;
    /**
     * How tightly the playing clustered on this grid, 0..1. It is the resultant
     * length of the onset phases — 1 means every note landed exactly on a line,
     * 0 means they were scattered uniformly and the grid means nothing.
     */
    double confidence = 0.0;
    /** Detected shuffle, 0 = straight, 1 = full triplet feel. */
    double swing = 0.0;
    /** True when there was too little to infer from and defaults were used. */
    bool fellBack = false;
};

struct FitOptions {
    /** 0 leaves the performance untouched, 1 snaps it hard to the grid. */
    double strength = 1.0;
    /** Set above zero to fit against a known tempo instead of inferring one. */
    double lockedBpm = 0.0;
    int beatsPerBar = 4;
    /** Snap note lengths to musical values as well as their starts. */
    bool fitLengths = true;
    /** Preserve detected swing rather than straightening it out. */
    bool keepSwing = true;
    double minBpm = 65.0;
    double maxBpm = 200.0;
    /** Tempo the search is biased toward when the octave is ambiguous. */
    double bpmPrior = 125.0;
};

struct Take {
    std::vector<RawNote> raw;
    std::vector<FittedNote> fitted;
    GridFit fit;
    /** Loop length in seconds, derived from the fit. */
    double loopSeconds() const;
    double beatsPerLoop() const { return double(fit.bars) * fit.beatsPerBar; }
};

/**
 * Infer the grid a performance was played against.
 *
 * Works by fitting a comb to the onsets. For a candidate spacing, each onset's
 * position within a grid cell is treated as an angle, and the length of the
 * mean unit vector over all of them measures how tightly they cluster — the
 * resultant of circular statistics. Scattered playing gives a short resultant
 * whichever spacing you try; playing that meant a grid gives a long one at the
 * right spacing, and its direction is the grid's phase, solved for rather than
 * searched.
 *
 * Two priors keep it honest. A finer grid always fits at least as well as a
 * coarser one, so subdivisions are weighted toward the simple explanation.
 * Halving or doubling the tempo fits identically, so a log-normal prior around
 * `bpmPrior` breaks that tie the way a listener would.
 */
GridFit inferGrid(const std::vector<RawNote>& notes, const FitOptions& opts = {});

/** Move a performance onto a grid. Never reorders or drops notes. */
std::vector<FittedNote> applyFit(const std::vector<RawNote>& notes,
                                 const GridFit& fit,
                                 const FitOptions& opts = {});

/** Infer and apply in one step. */
Take fitTake(const std::vector<RawNote>& notes, const FitOptions& opts = {});

// --- pieces exposed for testing and for the UI to visualise -----------------

/** Resultant length of the onset phases at a given grid spacing, 0..1. */
double gridResultant(const std::vector<double>& onsets, double spacingSec,
                     double* phaseOut = nullptr);

/** Musical note lengths, in grid steps, that a duration may snap to. */
const std::vector<int>& lengthCandidates();

} // namespace motif
