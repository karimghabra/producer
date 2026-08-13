# Pulse

An EDM studio you **play** rather than draw.

Every drum and synth is generated from maths at runtime — there are no samples,
nothing to download, and the whole instrument boots instantly. Your keyboard is
the controller: forty physical keys across four layers, each key assignable to a
hit, a held note, a chord, a rhythmic roll, a clip launch, a scene change, a
master effect, or a record arm.

```bash
npm install
npm run dev
```

Then open **http://localhost:5177** and press *Start the audio engine* (browsers
will not make sound before you interact with the page).

---

## Playing it

| Key | Does |
| --- | --- |
| `Space` | Play / stop |
| `A`–`;` | The kit — one key per drum |
| `Q`–`P` | Rolls, from eighths down to sixty-fourths including triplets |
| `1`–`0` | Softer variants, builds, riser |
| `Z`–`/` | Pitched kicks, bass stabs, stutter, tape stop |
| `F1`–`F4` | Lock a layer: Drums · Melody · Clips · FX |
| hold `Ctrl` | Momentary jump to Clips |
| hold `Alt` | Momentary jump to FX |
| hold `Shift` | Accent |
| hold `Tab` | Fill |
| `Esc` | Panic — kill every note, roll and effect |
| `↑` `↓` | Nudge tempo (with `Shift`, by 5) |

The momentary layers are the point: you can fire a clip or throw a filter sweep
mid-phrase without lifting your playing hand. Shift-click any pad to reassign it.

A MIDI keyboard works too — notes play whichever track is selected, and the mod
wheel sweeps the master filter.

---

## Clips, and when they actually fire

Clip and scene keys are **quantized to the bar**. Pressing one does not switch
the pattern immediately — it queues the change for the next bar line, so section
changes land in time instead of wherever your finger happened to be.

That means the wait varies from nothing to a full bar (about 1.9 s at 128 BPM),
depending on where in the bar you pressed. While a launch is pending it blinks
amber in three places: the pad, the pattern slot, and the track rail (which
shows `→` and the incoming pattern name). Nothing is being ignored — it is
waiting for the downbeat.

If you want a clip to switch the instant you hit it, set that key's **When** to
`off` in the Key Map editor. With the transport stopped, everything fires
immediately regardless.

**Layer 3 (Clips)** is laid out one column per track: the top three rows are
that track's first three patterns, the bottom row stops it. The two rightmost
columns hold the four scenes. **Layer 4 (FX)** has a `Cut` toggle per track on
its bottom row — press to drop a track out, press again to bring it back, both
quantized to the beat.

Scenes only touch tracks listed in their slots. A track added after a scene was
captured is left alone by that scene until you right-click it to re-capture.

---

## Finding sounds

The **SOUND** tab opens with a row of presets for whichever track is selected —
25 drum sounds and 16 synth sounds. Click one and it loads *and plays*, so you
can browse the whole kit by ear. Hovering a preset explains what it is for.

Picking a preset also sets the synthesis engine, so you never have to know that
a bell needs FM and a supersaw does not.

Every knob explains itself on hover, in words rather than synthesis jargon —
"how far the pitch drops at the very start, which is what makes a kick thump
rather than beep" instead of *pitch mod*. Double-click a knob to reset just that
one, hold shift while dragging for fine control, and **↺ Reset sound** restores
the factory sound for the current engine without touching the pattern or mix.

The presets are the fastest way to learn the controls: load two kicks that sound
very different, then look at which knobs moved.

---

## The maths, and why it is there

Nothing here is clever for its own sake. Each piece exists because it makes a
specific musical decision better than a knob would.

**Euclidean rhythms.** Bjorklund's algorithm — the same recursion Euclid used
for the GCD — distributes *k* onsets across *n* steps as evenly as arithmetic
allows. It generates a startling number of the world's traditional rhythms:
E(3,8) is the tresillo, E(5,8) the cinquillo, E(7,16) a samba. One integer pair
gives you a groove that is almost four-on-the-floor but breathes.

**Polymeter.** Tracks keep their own pattern lengths, so a 16-step hat against a
12-step bass takes lcm(16,12) = 48 steps to repeat. The track rail shows the
real cycle length. This is the cheapest way to stop a four-bar loop sounding
like a four-bar loop.

**Trig conditions.** Per-step rules — `1:4` fires only on the first of every
four passes, `FILL` only while Fill is held, `50%` is a coin flip seeded by
position. A handful of these turns one pattern into an arrangement.

**The supersaw detune curve.** The JP-8000's detune knob is not linear; it
follows an 11th-order polynomial that is nearly flat near zero and opens sharply
at the top. Using the real curve, with the original seven-oscillator spacing
resampled to whatever voice count you pick, is the difference between *that*
trance sound and seven detuned saws.

**Scheduled sidechain.** The pump is not a compressor listening for a kick. When
the sequencer places a kick at time *t*, it writes a ducking curve into every
subscribed channel at exactly *t*. Recovery is `1 − a·(1 − x)^curve`; above 1 the
level hangs low and snaps back (deep house), below 1 it lifts immediately. It is
sample-accurate and free.

**Generated reverb.** The impulse response is decaying noise through a one-pole
filter whose coefficient tightens over time — air absorbs treble faster than
bass — with early reflections at prime-millisecond offsets so they never stack
into a periodic flutter.

**Metallic drums.** The hats and cymbals are six square oscillators at the 808's
mutually inharmonic ratios (1, 1.4827, 1.8002, 2.5460, 2.6303, 3.8967). Nothing
lines up, so the spectrum never resolves into a pitch — it just sounds like
metal.

**Swing as an offset in steps.** Steps are grouped; the back half of each group
is pushed late. At full amount the offset is exactly a third of the group's
half-length, which lands the swung note precisely on the triplet.

**Humanize by hash, not by random.** Timing jitter is a hash of the step
position, so the same step drifts the same way every time round the loop. That
reads as a player's habit rather than a wobble.

**Logistic-map fills.** The Dice button uses `x → 3.9·x·(1−x)` rather than
`Math.random`. Chaotic but structured: it produces runs of hits and runs of
rests, which sounds far more like a played part than uniform noise.

**A 48-PPQN clock.** 48 divides by 2, 3, 4, 6, 8, 12, 16 and 24, so sixteenths,
triplets, thirty-seconds and sixteenth-triplets all land on exact integer ticks.
No drift, and tracks at different resolutions stay locked.

---

## Layout

```
shared/     types.ts, theory.ts (the maths), defaults.ts (the starter kit)
server/     Express + node:sqlite. Projects are self-contained JSON documents.
client/
  audio/    dsp · drums · synth · engine · scheduler · performer
  state/    zustand store — the project document is the source of truth
  components/
```

The server's whole job is to hold project documents. All the musical work
happens in the browser, where the audio clock lives.

Persistence uses Node 24's built-in `node:sqlite`, so there is no native module
to compile; if it is unavailable it falls back to a directory of JSON files.
The client also mirrors to `localStorage` on every save, so work survives the
API being down.

---

## Known limits

- **Reverse** is a swell-shaped beat repeat rather than true reversed playback.
  Real reverse needs a ring buffer in an AudioWorklet; the current version reads
  convincingly in a mix but is not sample-reversed.
- **No audio export yet.** Rendering the arrangement to WAV via
  `OfflineAudioContext` is the obvious next step — the engine is already
  structured for it.
- **Single user.** There are no accounts; the server holds one shared set of
  projects. Fine locally, would need auth before deploying anywhere public.
