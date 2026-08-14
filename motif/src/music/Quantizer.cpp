#include "music/Quantizer.h"

#include <algorithm>
#include <cmath>
#include <numeric>

namespace motif {
namespace {

constexpr double kTwoPi = 6.283185307179586;

/** Subdivisions we are willing to believe someone played in. */
const int kSubdivisions[] = { 1, 2, 3, 4, 6, 8 };

/**
 * How readily we accept each subdivision. A finer grid can always explain the
 * data at least as well as a coarser one, so without this the search would
 * always land on the finest option and call every performance thirty-second
 * notes. Sixteenths are the common case and get no penalty.
 */
double subdivisionPrior(int subdiv) {
    switch (subdiv) {
        case 1:  return 0.80;   // quarter notes only
        case 2:  return 0.94;   // eighths
        case 3:  return 0.86;   // eighth triplets
        case 4:  return 1.00;   // sixteenths
        case 6:  return 0.84;   // sixteenth triplets
        case 8:  return 0.78;   // thirty-seconds
        default: return 0.70;
    }
}

/**
 * Log-normal prior over tempo. Half and double time fit a performance exactly
 * as well as each other, so something has to break the tie; a listener resolves
 * it by preferring a tempo that feels like a tempo, and this is that preference
 * written down.
 */
double tempoPrior(double bpm, double centre) {
    // Width matters more than it looks. Too narrow and the prior stops breaking
    // octave ties and starts overruling the evidence: 90 BPM sixteenths and 120
    // BPM eighth-triplets produce identical onset times, and a tight prior picks
    // the one nearer its centre regardless of which the player meant. Wide
    // enough to still reject half and double time, loose enough to let 90 and
    // 174 stand when that is what was played.
    const double z = std::log2(bpm / centre) / 0.90;
    return std::exp(-0.5 * z * z);
}

double wrapPositive(double v, double period) {
    const double r = std::fmod(v, period);
    return r < 0.0 ? r + period : r;
}

std::vector<double> onsetsOf(const std::vector<RawNote>& notes) {
    std::vector<double> out;
    out.reserve(notes.size());
    for (const auto& n : notes) out.push_back(n.startSec);
    std::sort(out.begin(), out.end());
    return out;
}

/** Median of a copy, so the caller's vector is left alone. */
double median(std::vector<double> v) {
    if (v.empty()) return 0.0;
    const size_t mid = v.size() / 2;
    std::nth_element(v.begin(), v.begin() + long(mid), v.end());
    if (v.size() % 2 == 1) return v[mid];
    const double hi = v[mid];
    std::nth_element(v.begin(), v.begin() + long(mid - 1), v.end());
    return (v[mid - 1] + hi) * 0.5;
}

/** Nearest value in a sorted candidate list. */
int nearestCandidate(double value, const std::vector<int>& candidates) {
    int best = candidates.front();
    double bestErr = std::abs(value - best);
    for (int c : candidates) {
        const double err = std::abs(value - c);
        if (err < bestErr) { bestErr = err; best = c; }
    }
    return best;
}

} // namespace

// ---------------------------------------------------------------------------

const std::vector<int>& lengthCandidates() {
    // In grid steps. Includes dotted and double-dotted shapes, which is why the
    // list is not simply powers of two.
    static const std::vector<int> kLengths = {
        1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64
    };
    return kLengths;
}

double gridResultant(const std::vector<double>& onsets, double spacingSec, double* phaseOut) {
    if (onsets.size() < 2 || spacingSec <= 0.0) {
        if (phaseOut) *phaseOut = 0.0;
        return 0.0;
    }

    // Each onset's position inside its grid cell becomes an angle. If the
    // playing meant this grid the angles pile up in one direction and the mean
    // vector is long; if it did not, they cancel and it is short.
    double sumX = 0.0, sumY = 0.0;
    for (double t : onsets) {
        const double angle = kTwoPi * wrapPositive(t, spacingSec) / spacingSec;
        sumX += std::cos(angle);
        sumY += std::sin(angle);
    }
    const double n = double(onsets.size());
    sumX /= n;
    sumY /= n;

    if (phaseOut) {
        // The mean direction is the grid's offset, solved rather than searched.
        double angle = std::atan2(sumY, sumX);
        if (angle < 0.0) angle += kTwoPi;
        *phaseOut = angle / kTwoPi * spacingSec;
    }
    return std::sqrt(sumX * sumX + sumY * sumY);
}

// ---------------------------------------------------------------------------

GridFit inferGrid(const std::vector<RawNote>& notes, const FitOptions& opts) {
    GridFit fit;
    fit.beatsPerBar = std::max(1, opts.beatsPerBar);

    const auto onsets = onsetsOf(notes);
    if (onsets.size() < 3) {
        // Not enough to infer anything from. Say so rather than inventing a
        // grid the player never implied.
        fit.bpm = opts.lockedBpm > 0.0 ? opts.lockedBpm : opts.bpmPrior;
        fit.subdivision = 4;
        fit.phaseSec = onsets.empty() ? 0.0 : onsets.front();
        fit.bars = 1;
        fit.confidence = 0.0;
        fit.fellBack = true;
        return fit;
    }

    double bestScore = -1.0;
    double bestBpm = opts.bpmPrior;
    int bestSubdiv = 4;
    double bestPhase = onsets.front();
    double bestResultant = 0.0;

    const bool locked = opts.lockedBpm > 0.0;
    const double bpmLo = locked ? opts.lockedBpm : opts.minBpm;
    const double bpmHi = locked ? opts.lockedBpm : opts.maxBpm;
    const double bpmStep = 0.25;

    for (int subdiv : kSubdivisions) {
        for (double bpm = bpmLo; bpm <= bpmHi + 1e-9; bpm += bpmStep) {
            const double spacing = 60.0 / bpm / subdiv;
            // Ignore grids so fine they are below the resolution of playing.
            if (spacing < 0.030) continue;

            double phase = 0.0;
            const double r = gridResultant(onsets, spacing, &phase);
            const double score = r * subdivisionPrior(subdiv)
                               * (locked ? 1.0 : tempoPrior(bpm, opts.bpmPrior));

            if (score > bestScore) {
                bestScore = score;
                bestBpm = bpm;
                bestSubdiv = subdiv;
                bestPhase = phase;
                bestResultant = r;
            }
            if (locked) break;
        }
    }

    fit.bpm = bestBpm;
    fit.subdivision = bestSubdiv;
    fit.confidence = bestResultant;

    // Anchor the grid at or before the first onset, so the take starts at the
    // top of the loop rather than part way into a bar.
    double spacing = 60.0 / fit.bpm / fit.subdivision;
    const double firstIndex = std::floor((onsets.front() - bestPhase) / spacing + 0.5);
    fit.phaseSec = bestPhase + firstIndex * spacing;

    // --- shuffle, or genuinely triplets? ----------------------------------
    //
    // A heavy shuffle lands on the triplet grid. That is not an approximation,
    // it is what a shuffle is, so the onsets alone cannot separate the two
    // readings. What does separate them is which positions get used: a real
    // triplet part plays all three slots in each group, while a shuffled part
    // only ever plays the first and the last and leaves the middle empty.
    //
    // When the middle is empty, describe it the way a player would — an even
    // grid with swing — rather than as triplets they did not play.
    if (fit.subdivision % 3 == 0) {
        int occupancy[3] = { 0, 0, 0 };
        for (double t : onsets) {
            const long long step = std::llround((t - fit.phaseSec) / spacing);
            occupancy[((step % 3) + 3) % 3]++;
        }
        const int total = occupancy[0] + occupancy[1] + occupancy[2];
        const bool middleEmpty = occupancy[1] * 8 < total;
        const bool lastUsed = occupancy[2] * 5 > total;
        if (total >= 6 && middleEmpty && lastUsed) {
            fit.subdivision = fit.subdivision / 3 * 2;   // 6 -> 4, 3 -> 2
            spacing = 60.0 / fit.bpm / fit.subdivision;
            // Solve the phase again at the new spacing. The old one is an
            // offset within a cell that no longer exists, and carrying it over
            // shifts the whole grid — which would scramble exactly the even/odd
            // assignment the swing measurement below depends on.
            double rephased = 0.0;
            gridResultant(onsets, spacing, &rephased);
            const double idx = std::floor((onsets.front() - rephased) / spacing + 0.5);
            fit.phaseSec = rephased + idx * spacing;
        }
    }

    // --- finer than it needed to be? --------------------------------------
    //
    // Play straight eighths and every onset lands on the sixteenth grid too, so
    // the two readings score identically on the onsets and the subdivision
    // prior alone decides - which called deliberate eighth-note playing
    // "sixteenths". Occupancy separates them the same way it separates shuffle
    // from triplets: if the odd steps are never used, the grid has twice the
    // resolution the performance actually implies.
    //
    // Stops at eighths rather than going all the way down: a part is still
    // worth holding on a grid you can add an off-beat to. Anything that does
    // use an odd step stops this immediately - including a swung part, whose
    // late off-beats round onto odd steps and whose shuffle is measured below.
    //
    // The phase needs no correction. Every onset sits at p + 2k*spacing, which
    // is p + k*(2*spacing): the same origin, counted in bigger steps.
    while (fit.subdivision >= 4 && fit.subdivision % 2 == 0 && onsets.size() >= 4) {
        bool anyOdd = false;
        for (double t : onsets) {
            const long long step = std::llround((t - fit.phaseSec) / spacing);
            if (((step % 2) + 2) % 2 != 0) { anyOdd = true; break; }
        }
        if (anyOdd) break;
        fit.subdivision /= 2;
        spacing = 60.0 / fit.bpm / fit.subdivision;
    }

    // --- swing ------------------------------------------------------------
    //
    // Two passes, because the two quantities contaminate each other. The phase
    // came from a circular mean over every onset, so a swung performance drags
    // the grid late along with it and the shuffle measures as nearly zero — the
    // grid has already absorbed what we are trying to detect.
    //
    // So: re-derive the phase from the on-beat onsets alone, which swing does
    // not move, then measure how late the off-beats sit against that.
    // A triplet grid cannot be swung by definition, so it is left at zero.
    if (fit.subdivision % 2 == 0) {
        std::vector<double> evenDev, oddDev;
        for (double t : onsets) {
            const double rel = (t - fit.phaseSec) / spacing;
            const long long step = std::llround(rel);
            ((((step % 2) + 2) % 2 == 0) ? evenDev : oddDev).push_back(rel - double(step));
        }

        // Medians throughout. A single fumbled note pulls a mean far enough to
        // invent a shuffle that was never played; the median ignores it.
        const double phaseCorrection = median(evenDev);
        for (double& d : oddDev) d -= phaseCorrection;
        const double late = median(oddDev);

        if (evenDev.size() >= 3 && oddDev.size() >= 3) {
            // How ragged the on-beats were, as a yardstick for the off-beats.
            std::vector<double> spread;
            spread.reserve(evenDev.size());
            for (double d : evenDev) spread.push_back(std::abs(d - phaseCorrection));
            const double noise = median(spread);

            // Only call it swing when the off-beats sit clearly later than the
            // player's own timing scatter would explain.
            if (late > std::max(0.045, 2.0 * noise)) {
                fit.swing = std::clamp(late / (1.0 / 3.0), 0.0, 1.0);
            }
        }
        fit.phaseSec += phaseCorrection * spacing;
    }

    // --- loop length ------------------------------------------------------
    double lastEnd = onsets.back();
    for (const auto& n : notes) lastEnd = std::max(lastEnd, n.endSec);

    const double secPerBar = (60.0 / fit.bpm) * fit.beatsPerBar;
    const double spanBars = (lastEnd - fit.phaseSec) / secPerBar;

    // Prefer power-of-two loop lengths; musicians play in 1, 2, 4 and 8 bars
    // far more often than 3, 5 or 7. Only accept an odd length when the span
    // clearly overshoots the power of two below it.
    int bars = 1;
    for (int candidate : { 1, 2, 4, 8, 16 }) {
        // 0.12 of a bar of slack so a slightly short last note does not drop
        // the whole loop down an octave in length.
        if (spanBars <= double(candidate) + 0.12) { bars = candidate; break; }
        bars = candidate;
    }
    fit.bars = bars;

    return fit;
}

// ---------------------------------------------------------------------------

std::vector<FittedNote> applyFit(const std::vector<RawNote>& notes,
                                 const GridFit& fit,
                                 const FitOptions& opts) {
    std::vector<FittedNote> out;
    out.reserve(notes.size());

    const double spacing = 60.0 / fit.bpm / fit.subdivision;   // seconds per grid step
    const double stepBeats = 1.0 / double(fit.subdivision);
    const double strength = std::clamp(opts.strength, 0.0, 1.0);
    const double swingOffset = (opts.keepSwing ? fit.swing : 0.0) * (1.0 / 3.0);

    for (const auto& n : notes) {
        FittedNote f;
        f.pitch = n.pitch;
        f.velocity = n.velocity;

        // --- start ---------------------------------------------------------
        const double relSteps = (n.startSec - fit.phaseSec) / spacing;
        const long long step = std::llround(relSteps);
        double target = double(step);
        // Put the shuffle back on the off-steps if we are keeping it.
        if (swingOffset > 0.0 && (step % 2 + 2) % 2 == 1) target += swingOffset;
        const double snappedSteps = relSteps + (target - relSteps) * strength;

        f.startBeats = snappedSteps * stepBeats;
        f.movedBeats = (snappedSteps - relSteps) * stepBeats;

        // --- length --------------------------------------------------------
        const double heldSec = std::max(0.0, n.endSec - n.startSec);
        double lengthSteps = heldSec / spacing;

        if (opts.fitLengths) {
            const double musical = double(nearestCandidate(lengthSteps, lengthCandidates()));
            lengthSteps = lengthSteps + (musical - lengthSteps) * strength;
        }
        // Never let a note vanish; a step is the shortest thing the grid holds.
        f.lengthBeats = std::max(lengthSteps, 0.25) * stepBeats;

        out.push_back(f);
    }

    // Two notes of the same pitch landing on the same step is a double trigger,
    // not a chord. Keep the louder and drop the other.
    std::sort(out.begin(), out.end(), [](const FittedNote& a, const FittedNote& b) {
        if (a.startBeats != b.startBeats) return a.startBeats < b.startBeats;
        return a.pitch < b.pitch;
    });

    const double eps = stepBeats * 0.25;
    std::vector<FittedNote> deduped;
    deduped.reserve(out.size());
    for (const auto& note : out) {
        auto clash = std::find_if(deduped.begin(), deduped.end(), [&](const FittedNote& e) {
            return e.pitch == note.pitch && std::abs(e.startBeats - note.startBeats) < eps;
        });
        if (clash == deduped.end()) {
            deduped.push_back(note);
        } else if (note.velocity > clash->velocity) {
            *clash = note;
        }
    }

    return deduped;
}

// ---------------------------------------------------------------------------

double Take::loopSeconds() const {
    return (60.0 / fit.bpm) * double(fit.bars) * fit.beatsPerBar;
}

Take fitTake(const std::vector<RawNote>& notes, const FitOptions& opts) {
    Take take;
    take.raw = notes;
    take.fit = inferGrid(notes, opts);
    take.fitted = applyFit(notes, take.fit, opts);
    return take;
}

} // namespace motif
