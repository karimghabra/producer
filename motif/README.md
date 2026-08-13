# Motif

A desktop instrument that works out what you meant.

Every other tool makes you declare the grid first — set a tempo, choose a
subdivision, start a click — and then judges your playing against it. Motif does
the opposite. You play; it takes the performance as the truth and infers the
grid that best explains it: the tempo you were feeling, the subdivision you were
in, whether you were shuffling, and how many bars the idea actually is.

No clicking notes into a piano roll and dragging them around afterwards.

```bash
cmake -S . -B build -G "Visual Studio 17 2022" -A x64 && cmake --build build --config Release
```

Then run `build/Motif_artefacts/Release/Motif.exe`.

| Key | Does |
| --- | --- |
| `R` | Record — press once to start, again to stop and fit |
| `Space` | Play / stop the loop |
| `A`–`K`, `W`,`E`,`T`,`Y`,`U`,`O`,`P` | Play notes, laid out like a piano |
| `←` `→` | Octave down / up |

---

## How the fitting works

The interesting part is `src/music/Quantizer.cpp`. It is deliberately free of
JUCE so it can be tested on its own, and it is where the app earns its keep.

**Finding the grid.** A candidate grid spacing is tested by treating each
onset's position inside its cell as an angle and taking the mean unit vector
over all of them. If the playing meant that grid the angles pile up in one
direction and the resultant is long; if it did not, they cancel out. The
resultant's length is the fit confidence shown in the UI, and its direction is
the grid's phase — solved for, not searched.

**Two priors keep it honest.** A finer grid always explains the data at least as
well as a coarser one, so without a penalty every performance would be read as
thirty-second notes. And halving or doubling the tempo fits identically, so a
log-normal prior over tempo breaks that tie the way a listener would. The width
of that prior matters: too narrow and it stops breaking ties and starts
overruling the evidence.

**Shuffle versus triplets.** A heavy shuffle lands on the triplet grid — that is
not an approximation, it is what a shuffle *is*, and the onsets alone cannot
separate the two readings. What separates them is which positions get used: a
real triplet part plays all three slots in each group, a shuffled part only ever
plays the first and the last. When the middle is empty, Motif describes it as an
even grid with swing, the way a player would.

**Measuring swing needs two passes.** The phase comes from a circular mean over
every onset, so a swung performance drags the grid late along with it and the
shuffle measures as almost nothing — the grid has absorbed the very thing being
measured. So the phase is re-derived from the on-beat onsets alone, which swing
does not move, and the off-beats are measured against that. Medians throughout,
because one fumbled note pulls a mean far enough to invent a shuffle nobody
played.

**What it will not do** is claim to know something it cannot. Fewer than three
notes and it says so rather than inventing a tempo. Triplets at B and sixteenths
at 3B/4 are *identical* onset times; Motif recovers the spacing correctly and
picks a label, and giving it a tempo resolves which. That ambiguity is in the
music, not in the code.

---

## Why C++ and not the browser

This started as a web app, and most of the bugs in it came from the same place:
Web Audio makes you schedule automation against a graph you do not control.
Ramps get deleted because a cancel time lands after their end. `AudioParam.value`
reports the level now, not at the future instant you are scheduling for. A
release anchors to the wrong level and clicks.

Here, an envelope's value at any instant is computed for the sample being
written. A release starts from the level the envelope is actually at, because
you can read it. That entire class of bug does not exist.

The DSP still carries the lessons: raised-cosine attacks, because a straight
ramp stops dead at the top and that corner is heard as a click; PolyBLEP
oscillators, because a naive saw folds its discontinuities back as hash; a
state-variable filter rather than a biquad, because the cutoff gets swept hard
and a biquad zippers when you do that; and a soft clip on the output that is a
straight wire below its knee.

---

## Tests

```bash
cmake --build build --config Release --target MotifTests && ./build/Release/MotifTests.exe
```

Synthesises performances with known ground truth, plays them badly on purpose —
jitter, dropped notes, an offset start — and checks the inferred grid matches.
Twenty checks covering tempo recovery from 90 to 174 BPM, subdivision, swing
detection, loop length, and that fitting never loses or duplicates a note.

---

## State

Working: the record → fit → loop cycle, a polyphonic synth, the take view, fit
strength, swing preservation.

Not yet: drums, the generative co-player, song mode, per-track effects and
automation, audio export, saving anything to disk.
