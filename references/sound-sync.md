# Sound and sync: script, voice, music, SFX

See also: director.md (film header, storyboard frames, world per act), judgment.md (sound with an arc), type.md (word cadence; section 0.3 copy voice and tells), transitions.md (cut cadence, wipes that lead the voice), close.md (name on the voice), slop.md (sound patterns, Part 2 audio gate), tools.md (`look.py` audio audit, `voice.py`, `mix.py`).

Order of work: write the script, generate the voice, read the word timings, derive beat frames from them, build the picture to those frames, add SFX on picture events, then music, then mix. Picture follows voice; it does not chase it afterwards. This file covers how the reference films sync, how to write a VO script that fits beats, text lead, when not to use voice, SFX choices, and fallbacks when no ElevenLabs key exists.

**Honesty note.** The reference clips' audio was mostly not analysed in the study (the breakdowns say so: voice lines "not verified", "not subtitled"; sync of cuts to voice unverified for M913-M920). What is solid is picture: onset times, cut times, cadences, and the few voice windows the breakdowns recorded (M926, M939, M945, M946, M967, M968). Everything about SFX gain, music tempo, and mixing is marked **practice, not from the corpus**.

Rules are written WHEN situation, DO decision with numbers, *because* what it buys. Time in frames at 30 fps with seconds in brackets; evidence in brackets (M###).

Scripts (the skill's own; arguments differ, run `--help`): `scripts/voice.py` (ElevenLabs TTS with word timestamps to `vo.words.json`, SFX, music; exit code 3 when no key; also a local `vo-local` fallback with estimated timings), `scripts/sync.mjs` (words.json to a frame table / `beats.json`), `scripts/mix.py` (VO + music + SFX, ducking, -14 LUFS), `scripts/render.mjs` (writes `<out>.events.json` from `window.__events`), `scripts/look.py` (inspects the final). Tool changes and their numbers are in section 4a.

---

## 1. How the reference films sync

| Pattern | What the picture does | Evidence |
|---|---|---|
| **Word pops land on spoken words** | Each on-screen word or row appears on the frame of its spoken word (rows at 0.07, 0.83, 1.74, 2.74 s on the four spoken words; three consecutive headline words at 3.70 / 4.27 / 4.50 s) | M925, M927, M964, M967 |
| **Text slightly ahead of voice** | Pop at 0.07 s while voice starts 0.13 s (2 f lead); a wordmark finishes revealing 0.16 s (5 f) before it is spoken; a wipe leads its voice line by 0.16 s | M967, M926, M939 |
| **VO sentence runs across cuts** | One spoken sentence passes over several beats; each beat's text carries only the next fragment; the cut falls mid-sentence | M936-M938, M926 (orbit, ring, question, name over one sentence), M939, M945 to M946 |
| **On-screen text is not the transcript** | Spoken line and on-screen claim differ; speech is never captioned | M913, M919, M939 (not captioned), M946 (no subtitles), M964 (spoken sentence differs from the claim) |
| **Cut intervals on a music grid** | Four consecutive cuts exactly 10 f (0.333 s) apart, then one 8 f cut; constant cadence | M962 |
| **Constant cadence of repeated events** | Service swaps every 11 f (0.34-0.37 s, "a steady drum"); checklist ticks 22/22/24 f at 25 fps; strobe plates 4 f at 60 fps; card reel swaps on a 4/2-frame syncopation; menu scroll every 0.77-0.93 s | M955, M913, M948, M967, M963 |
| **Clicks and cuts as hits** | Single-frame events carry the beat: a drop (1 f), a click (1 f flash), a ring pop (1 f at 3x), a name slam, a hard cut at peak velocity | M931, M959, M926, M932, M929, M924 |
| **Music-only kinetic type** | Words hard-cut 3-4 f apart (6-7 f at 60 fps) and hold 0.9 s; no voice | M921-M924 (music only), M962 |
| **Text beats shaped like speech** | Pop cadences that slow toward the end of a phrase (4 then 6 f; 8-9 f at 24 fps; 5, 8, 8 f) | M967, M964, M929 |

Three film modes follow from this:

| Mode | Use when | Picture timing source | Examples |
|---|---|---|---|
| **Voice-led** | explainer, product story, claims that need grammar | the word timings from the VO | M925-M929, M936-M940, M945-M946, M964, M967-M968 |
| **Music-led kinetic** | type and motion are the message; under about 15 s; brand sting | a beat grid (frames) | M921-M924, M962-M963, M973 |
| **Hybrid** | short vocal or one VO line over a music bed | grid for cuts, word times for the one line | M914 (music with a short vocal 1.0-2.4 s) |

**WHEN** choosing a mode **DO** decide it with the film header (director.md section 7) **because** voice-led films cut on words and music-led films cut on a grid, and a film that tries to do both cuts to nothing.

---

## 2. When NOT to use VO

**WHEN** the words on screen are the whole message and the film is short (about 15 s or less), **or** the film is a brand sting or ident, **DO** skip voice: build kinetic type to music and an SFX layer (M921-M924, M962, M973) **because** type that is read at 3-4 f per word already has speech rhythm, and a voice duplicating it adds nothing.

**WHEN** the proof beats are mostly UI typing, clicking, and dragging **DO** keep those beats under music and SFX, with VO only on hook, turn and cta lines **because** typing and clicking are the sound of the proof, and speech over them splits attention (*practice, not from the corpus*; M913-M919 keep speech uncaptioned and short).

**WHEN** the audience will watch muted (social) **DO** put the claim on screen as type and treat VO as optional (*practice, not from the corpus*). The corpus keeps speech uncaptioned, so the on-screen text must work alone.

---

## 3. Writing the VO script

**WHEN** writing the script **DO** write it before any picture, one line per beat or sentence in a plain text file (`voice.py vo --script script.txt`: line breaks become `lines.json` entries) **because** the voice sets the beat lengths.

**WHEN** counting words **DO** budget by speaking rate:

| Content | Words per second | Corpus check |
|---|---|---|
| Content line, explainer | 2.2-3.4 (about 9-14 f per word) | 11 words in 3.28 s = 3.4; 5 words in 2.32 s = 2.2 (M939) |
| Hook or claim line with stage business | 1.5-2.5 | 6 words in 3.7 s = 1.6 (M967; inferred from the voice window, includes a picture gap) |
| Sign-off line | 1.2-1.7 | 6 words in 3.84 s = 1.6 (M946); 2 words in 1.73 s = 1.15 (M968) |

Use 2.5-3 words per second for content lines as the working default and 1.2-1.7 for sign-offs.

**Word budget per beat** (usable time = beat length minus about 0.5 s lead-in minus 0.3 s tail, times 2.5-3 w/s):

| Beat (length) | Words | Notes |
|---|---|---|
| hook, 4-5 s (120-150 f) | 4-10 | One sentence that may finish in the next beat |
| turn, 4-5 s | 6-12 | Ends so the brand name is spoken on or just after the reveal (M926: wordmark complete 0.16 s before it is spoken) |
| proof, 4-7 s | 0-14 | A proof may be silent or carry one line; do not narrate each click |
| cta, 3-6 s | 3-8 | The offer and the name; leave a gap for the lingering mark (M946: line 2.33-6.17 s across the whole resolve and hold) |
| film total | about 28-38 words at 15 s, 60-80 at 30 s | *practice, not from the corpus* |

**WHEN** writing lines **DO** write them the way the brand speaks (brand.md section 0.5, voice row), avoid the copy tells in type.md section 0.3 ("Not just X. It's Y.", one-word triplets, "Meet X", "seamless"), and cut half; the on-screen words and the spoken words should differ, so neither is a caption of the other. Keep them short spoken sentences with one idea, verbs first, no more than 14 words, no parentheses, numbers spelled the way they are said, and the brand name exactly once near the turn **because** short lines survive a cut mid-sentence (M936-M938) and give sync points.

**WHEN** splitting the sentence across beats **DO** cut at a clause boundary or mid-clause so that the voice carries across the seam, and mark the word that sits on the cut in the storyboard (director.md section 5) **because** a sentence running over a cut makes two beats play as one.

**WHEN** a number is said **DO** make the picture show it before the voice finishes saying it (M945 number on screen 0.03-1.53 s while the line runs) **because** the eye lands on the figure while the ear confirms.

Example script format (generic, 15 s):

```
Say it once. Watch it done.
(hook: 6 words, 2.4 s at 2.5 w/s)
No steps in between. Just the result.
(proof 1: 7 words)
(silent: typing and click under music)
Meet <name>. Start now.
(cta: 4 words, slower, 1.4 w/s)
```

---

## 4. Order of work with scripts

1. **Script** to `script.txt` (section 3).
2. **VO**: `python3 scripts/voice.py vo --script script.txt --out audio/vo.mp3` writes `audio/vo.mp3`, `audio/vo.words.json` (`[{"word","start","end","raw_start","raw_end"}]`; start/end are refined to the audible speech, raw_* is the API alignment) and `audio/vo.lines.json`. Exit code 3 means no key: go to section 9.
3. **Word timings to frames**: `node scripts/sync.mjs audio/vo.words.json --fps 30 --lead 2 --out beats.json` prints the frame table (word, start frame, end frame, onset frame = start minus `--lead`) and writes `beats.json` plus `beats.js` (`window.BEATS`, loadable from a `file://` page); it also adds `vo.lines.json` lines when that file sits next to the words file. By hand: `frame = round(start_seconds * fps)`.
4. **Beat frames**: set each beat's start and end from the timings: a beat starts a few frames before its first spoken word and ends at the cut chosen in the storyboard. Update the storyboard Frames column (director.md section 7).
5. **Picture** to those frames. Put every word pop, row, and big hit on a frame from the table (section 5), not on a round number.
6. **SFX on picture events**: list each frame-exact event (cursor press, hard cut, whip, logo hit, counter end), generate or choose the sound, place it by the event frame (section 7).
7. **Music** last: it must fit the cut grid and the voice (section 6).
8. **Mix**: `python3 scripts/mix.py --duration <s> --vo audio/vo.mp3@0 --music audio/music.mp3 --events events.json --duck --out audio/mix.wav` (VO + music + SFX, -14 LUFS). SFX go in either as repeatable `--sfx clip@time:gain_dB` or as `--events` JSON `[{"t":2.1,"sfx":"path","gain":-8}]` (your own SFX placement list, not render.mjs's `<out>.events.json`); `--vo` is `clip@start_seconds` and may be repeated (one per line clip, section 4a). `--duck` now means a fixed 9 dB, see 4a.
9. **Check**: scrub the render at each word-onset frame and each hit frame; fix by moving picture, not by retiming audio, unless the VO itself is wrong. Then `python3 scripts/look.py final.mp4` (cuts, end hold, loudness; 4a).

Frame table the picture is built from:

| Word | Start s | End s | Start f | End f | What lands on this word |
|---|---|---|---|---|---|
| (from `vo.words.json`) | | | `round(start*30)` | `round(end*30)` | pop, row, tint, cut |

---

## 4a. Tool behaviour and numbers (measured on a real 16 s film)

| Tool | What it does now | Why |
|---|---|---|
| `voice.py vo` | After generation, `silencedetect` (-40 dB, 0.08 s; 0.01 s at the file edges) snaps each word/line **start to the speech onset and end to the offset**, never outward. Real run: line 1 ended 1.591 -> 1.462, first word 0.000 -> 0.047, last line end 8.406 -> 8.103 (-303 ms). `raw_start`/`raw_end` keep the API times; `--no-refine` skips; `voice.py refine --vo f.mp3` redoes existing files. | The API alignment runs 50-300 ms past audible speech; a cut on it lands on silence. |
| `voice.py split --vo audio/vo.mp3 --lines audio/vo.lines.json --out audio/vo` | One `lineNN.wav` per line (speech + 30 ms pads, 8 ms fades) and `lines.index.json` `[{i (1-based = NN), text, clip, dur, lead, start, end}]`. `lead` = seconds from clip start to the first speech sample. | Each line can sit on its own beat frame instead of the one-take timing. |
| `sync.mjs words.json` | If `lines.index.json` sits beside it (or in `./vo`, `./lines`, or `--index`), prints a clip table: speech frame, onset frame, **place frame** (speech frame minus the clip lead) and the ready `--vo clip@seconds`. | Placing clips is then copying a column. |
| `mix.py --vo` | Repeatable: `--vo audio/vo/line01.wav@0.017 --vo audio/vo/line02.wav@1.786 ...`. To land line N's first sound on beat frame F use `@(F/30 - lead)`. | |
| `mix.py --duck` | Predictable duck from a gain envelope built from each VO clip's speech regions: music **-9 dB** (`--duck-db N`) while a line is spoken, 80 ms ramp-in that ends at the onset (`--duck-attack`), 300 ms ramp-out from the offset (`--duck-release`). The log prints measured music RMS in speech vs gaps. Real run: attenuation 9.0 dB in speech, 0.0 dB in gaps (independent re-measure 9.0 / 0.1). Gaps shorter than attack + release (about 0.4 s) recover only partly (5-7 dB at 0.2-0.35 s gaps); lower `--duck-release` for faster breathing. | The old sidechain went -12 to -28 dB and held after lines. |
| `voice.py sfx` / `sfx-norm --in files...` | Every SFX is trimmed of leading silence and **peak-normalised to -3 dBFS** (`--peak`), re-measured after the mp3 encode; peak and LUFS printed per file; `--keep-raw` keeps `x.raw.mp3`; `--no-normalize` skips. Before: click -22 dBFS, whoosh +0.3 dBFS; after: all -3.0. | Raw generations differ by 20 dB; mix gains then mean something. |
| `voice.py music` / `music-check --in f.mp3 [--ms N]` | Prints the **audible span** (RMS windows within 12 dB of the loud level) and a **WARNING with a ready-to-run fix** if leading silence > 0.5 s, trailing silence > 1 s or audible < 85 % of the request. The real 16 s file: audible 2.06-11.10 s (9.0 s, 56 %). | The API returns late-starting, early-ending files. |
| `voice.py music-fit --in music.mp3 --out fit.wav --duration S [--loop-bars] [--bpm N] [--xfade 0.2] [--tail 1.0]` | Trims the leading silence, loops the audible section with equal-power crossfades to **exactly S seconds** (48 kHz stereo wav), 1 s tail fade. `--loop-bars` estimates the tempo (real file: 119.8 BPM) and loops on whole bars (4 bars = 8.01 s from 2.06 s) so the beat grid holds; it assumes the audible start is a downbeat. | The music then fills the film and the cuts keep their grid. |
| `render.mjs` | If the page sets `window.__events = [{t, frame, type, label}]` (push to it from the same code that places each cut/show/hide/hit), it is written to `<out>.events.json` beside the mp4 (`<outDir>/events.json` in `--still` mode) and the path printed (the runtime's `Motion.film` already fills it: 56 events on the real film, 4 `cut` + 4 `show`). | One source of truth for cut times. |
| `look.py film.mp4 [--events f] [--hold-warn 1.4]` | Cuts: every event of type `cut`/`show`/`hide` (or containing `cut`) from `<film>.events.json` is authoritative; without events it combines scene score >= 0.3, scene >= 0.12 with a structural change, and an abrupt pixel spike with low luma correlation, merged within 3 frames (real film: scene 0.3 alone found 3 of 5 cuts, this finds all 5 plus one slam-in). Writes `mid.jpg` (2 f before each cut) and `strips.jpg` (cut-1 / cut / cut+1 per row). Reports the longest static-ish stretch, the final shot and the **end hold** (trailing frames with a diff below 0.35/255, so slow drift counts as held); **WARNING when the end hold exceeds `--hold-warn` (default 1.4 s)**. Real film: end hold 4.5 s. | A resolved end card that sits for seconds is dead air; the warning gives the trim command. |

Hold rule: after the last element resolves keep 0.6-1.4 s (gate G3), then end. If `look.py` warns (or its G3 line FAILs), shorten the film or keep the exit moving.

---

## 5. Text lead and word landing

**WHEN** a word, row, or tint is tied to a spoken word **DO** land it 0-2 frames before the word's start frame; use up to 5 frames (0.16 s) for a reveal that must be complete when spoken, such as a name or a wipe (M967 2 f lead; M926 5 f; M939 5 f) **because** the viewer reads the word as it is said; text that lands after the voice reads as late, and a pop 2 f early reads as simultaneous (the 2 f figure is the corpus value; the sync perception reason is *practice, not from the corpus*).

**WHEN** a word is typed or built from parts **DO** let the last part land at the word's start and fill the word's span with the build (M968: the first word typed at 0.07-0.27 s against a voice start at 0.20 s; the second word typed 1.67-1.87 s) **because** a build that outlasts the word breaks sync.

**WHEN** a scene transition happens **DO** start it 3-6 f (0.1-0.2 s) before the voice line ends and enter the next hero 3 f before the transition completes (M939 wipe leads voice by 0.16 s; hero starts 0.12 s before the wipe ends) **because** overlap removes dead time and the voice carries across the seam.

**WHEN** a line has an emphasis word **DO** give the word a longer gap before it (M921: build gaps of 6-7 f at 60 fps, then 10 f at 60 fps before the last word) or a slower build (M966: the last word typed glyph by glyph every 3 f) **because** the gap before the word is the emphasis.

**WHEN** voice and picture disagree **DO** treat the spoken word as the authority and move the picture **because** retimed TTS audio sounds wrong and picture moves are free.

---

## 6. Music and the cut grid

**WHEN** a film is music-led or hybrid **DO** choose one beat unit g in frames and put every cut, big hit and cut-through on multiples of g (the grid is a *cut* discipline, not a licence to put a sound on every cut: section 6a) (M962 g = 10 f at 30 fps; M955 g = 11 f; M913 g = 22-24 f at 25 fps; M948 strobe g = 4 f at 60 fps) **because** constant cadence reads as music even when the audio is simple.

**WHEN** picking a tempo **DO** choose one whose beat is a whole number of frames *(practice, not from the corpus)*:

| fps | 90 BPM | 100 BPM | 120 BPM | 150 BPM | 180 BPM |
|---|---|---|---|---|---|
| 30 | 20 f | 18 f | 15 f | 12 f | 10 f |
| 24 | 16 f | 14.4 f | 12 f | 9.6 f | 8 f |
| 25 | 16.7 f | 15 f | 12.5 f | 10 f | 8.3 f |

(30 fps: 120 BPM = 15 f exactly; 10 f is the M962 cadence, i.e. quarter notes at 180 BPM or eighth notes at 90 BPM.)

**WHEN** generating music **DO** pass the tempo, the length in milliseconds (plus an optional `--plan plan.json`) to `voice.py music --prompt ... --ms N --out audio/music.mp3` (use `--dry-run` first: it prints the request and spends nothing; read the audible-span line it prints afterwards and run `music-fit` when it warns, section 4a) and leave out `--vocals` unless the film is a sting **because** a vocal fights VO and the corpus uses vocal only in one hybrid piece (M914, 1.0-2.4 s).

**WHEN** a voice-led film also has music **DO** keep the music's cuts and the VO's words as separate grids that meet only at the payoff (the brand slam, the click) *(practice, not from the corpus)*.

**WHEN** the final beat is a lingering mark **DO** let the music resolve on the last grid unit before the end and keep SFX off the lingering part except a tail (M946's 3.66 s hold is a measured outlier, M920 1.0 s; your hold stays <= 1.4 s) *(practice, not from the corpus)*.

---

## 6a. Sound has an arc: phrase-level decisions

A bed at one level with a hit on every cut is the sound version of a slide. Pros shape sections and place a few sounds on purpose. Decide these per film, in the storyboard's sound column (director.md section 4 item 8).

**WHEN** the film has a first big sound (a hit, a music entrance, a swell) **DO** tie it to something visible, or tie the *silence* to it: the cursor clicks the headline and the music jumps 15-18 dB on the click; the room goes quiet as the object lifts **because** a sound the eye can account for reads as caused; a sound with no visible cause is wallpaper.

**WHEN** the viewer has to read (a claim, a number, a UI fragment) **DO** pull the music down 6-10 dB for the length of the read and bring it back after **because** speech, reading and a busy bed fight for the same attention.

**WHEN** a major move is coming (a transformation, the product reveal, the name) **DO** clear the sound first: drop the music 8-15 dB, or cut it out entirely, for 0.2-0.5 s before the move, and let the move bring it back **because** a gap is how the ear learns where the peak is (section 7 repeats this for the strongest single hit). A flat bed at one level for 40 s is a large part of why long holds drag.

**WHEN** you place hits **DO** sync at the phrase level: shape the sections, and land one to three hand-picked hits on the moments that matter (the click, the name, the turn). **Wall-to-wall hits are a tell**: a sound on every cut and every word makes the few that matter indistinguishable. Arrangement should change at the cuts that change the film (a new section at the turn), not run through them untouched; music that ignores the edit has lost to music that follows it in the user's own tests.

**WHEN** the story event *is* the climax (a real launch, a real result) **DO** consider no swell at all **because** a musical swell turns proof into an advert; "no swell" is sometimes the right swell.

**WHEN** the film is a short silent-autoplay social piece **DO** decide whether it is built to be watched muted; silence (or near silence with a few designed hits) is a valid choice, but decide it, never default to it. A silent draft still keeps the grid and records the intended score (section 9).

**WHEN** you set the score's length **DO** make it cover the **whole cut**: plan and fit the music to the *final* picture length (`voice.py music-fit --duration <s>`), and re-fit after any trim. A score planned for an earlier cut left a test film ending in about 3 s of digital silence; the silent tail reads as a mistake, and `look.py`'s audio audit flags it. The music should resolve on the last grid unit, with at most a short natural tail, not run out before the picture does.

Check list for the sound column (answer each in one line in NOTE.md): what is the first big sound or silence, and what visible event is it tied to? Where does the music drop for reading? Where is it cleared before the biggest move? How many hits are there (1-3 hand-picked is the target; a hit per cut is a FAIL by taste)? Does the score cover the whole cut? Is the beat a metronome on a printed BPM (a tell)?

---

## 7. SFX: what sound goes with which event

All entries below are **practice, not from the corpus**; the corpus fixes the *picture events*, not their sounds. Place each sound so its transient lands on the event frame (trim leading silence; pre-roll the file by 1-2 f if its attack is soft).

| Picture event (corpus) | SFX | Placement | Gain vs VO peak |
|---|---|---|---|
| Press / click (cursor squash 2-3 f; M914, M919, M959) | short dry click, one layer | on the press frame | -6 to -10 dB |
| Hard cut at max velocity (M924, M959, M946) | soft thud or tick with 0.15 s tail | on the cut frame | -8 to -12 dB |
| Whip pan / smear move (M916, M928, M931, M934) | airy whoosh, 0.3-0.5 s | starts 3-4 f before peak velocity so its peak meets the peak smear | -10 to -14 dB |
| Counter / roll one value per frame (M923, M936, M954, M958) | one soft riser across the roll, or a tick on every 3rd-4th value | span of the roll; end on the final frame | -16 to -20 dB for ticks |
| Typing (3.4 chars/frame bursts, M914, M919; 21-30 cps, M928, M931) | quiet keyboard texture for the whole span, or a tick per word; never one tick per character | span of the typing | -16 to -22 dB |
| Logo / name slam (M929, M932) | low hit plus 0.6-1.0 s tail | on the first big frame | -6 to -10 dB |
| One-frame state flips (ring pop M926, drop M931, toggle M933) | tiny pop | on that frame | -12 to -16 dB |
| Cascade of rows or switches (M933, M935) | sparse ticks, uneven, 2-3 of the 5-7 items | on the cascade's strongest items | -14 to -18 dB |
| Wipe / stair wipe (M939, M946) | filtered sweep | span of the wipe | -12 to -16 dB |
| Lingering mark (M946, M920) | nothing, or a soft shimmer | tail only | -18 dB or lower |

Choose 3-5 SFX kinds per film and reuse them **because** a film with fifteen distinct sounds sounds like a library demo; one click, one whoosh, one hit, one tick family is a system (same logic as the single accent).

**WHEN** generating SFX **DO** use `voice.py sfx --prompt "<sound>" --seconds 0.4 --out audio/sfx/<id>.mp3`, or `--batch sfx.json --out audio/sfx` for a list (`[{"id","prompt","seconds"}]`, existing files are skipped; each is peak-normalised to -3 dBFS, section 4a); name each file by the event it serves **because** the mix script and any later retiming must find the right sound for the right frame.

**WHEN** an event is the film's strongest frame **DO** thin the other sound around it: duck the music 6-10 dB for 0.2-0.3 s before the hit (8-15 dB when it precedes a whole transformation, section 6a) and let the hit be the loudest SFX *(practice, not from the corpus)* **because** a gap before a hit is how the ear learns where the peak is.

---

## 8. Mixing targets

All **practice, not from the corpus** except where the brief's tools set the target.

| Layer | Level / treatment |
|---|---|
| Overall | -14 LUFS integrated, -1 dBTP (set by `mix.py`; it also fades the music out over the last 1.0 s, with no fade-in) |
| VO | the loudest sustained layer; -16 to -12 dBFS peaks |
| Music under VO | `mix.py --duck` (9 dB, from the VO's speech regions, 80 ms in / 300 ms out); back to full in gaps longer than 0.4 s and at the end |
| Music with no VO | up to the target level |
| SFX | per the table in section 7, relative to the VO peak; none louder than the VO peak except the one strongest hit |
| Silence | leave 0.2-0.3 s of reduced sound before the strongest hit; silence is a valid choice (section 6a), never an accident |
| Coverage | the score covers the whole cut: no silent tail, no digital silence over the last seconds (`look.py` audio audit: integrated LUFS, true peak, silent tail, hit count; quote the numbers in NOTE.md) |

**WHEN** the mix is ready **DO** loudness-check the final file and scrub the render once at each hit frame, once at each word-onset frame **because** a sync fault is invisible in a continuous playback.

---

## 9. Fallbacks when ElevenLabs is absent

`voice.py` can hold several keys (`ELEVENLABS_API_KEY`, `ELEVENLABS_API_KEY_2` ... `_9` or a comma list in `ELEVENLABS_API_KEYS`, in the environment or `.env`): they are tried in order, a key out of credits or invalid is skipped for the run, and `voice.py keys` lists them with their credits. It exits with code 3 when no key is found (`ELEVENLABS_API_KEY`, `./.env`, `~/.elevenlabs`, `~/.config/elevenlabs`) and with code 4 when every key refuses the feature (HTTP 401/402/403; a free or trial key typically refuses `music` and may still allow `sfx`). Do not stall: pick one fallback, say which in the report, and build the film so a real voice can drop in later. For music and SFX the first fallback is **native audio** (section 9a): `voice.py music|sfx --source auto --score audio/score.json` tries ElevenLabs and falls back per kind, printing `FALLBACK <kind>: native (<reason>)`.

| Fallback | How | Sync accuracy | When |
|---|---|---|---|
| **Silent draft** | Render with no audio. Build the beats from an *estimated* words.json (0.36-0.40 s per word at 2.5-2.8 w/s; add 0.2 s after commas and 0.4 s after full stops). Keep beats.json so a real VO and music slot in | picture only | no voice or music wanted, or fast iteration |
| **Local macOS voice** | `python3 scripts/voice.py vo-local --script script.txt --out audio/vo.aiff` uses `say`, writes a wav and **estimated** word timings (flagged `"est": true`) | word timings +/- 100-200 ms (*practice, not from the corpus*) | want audible pacing without a key |
| **Native music + SFX** | `scripts/score.mjs` synthesizes a bed and an SFX stem from the film's own score (section 9a); no key, no credits, deterministic | music on the film's own grid; SFX transients on their event frames (measured within 2 ms) | no key, or the plan refuses music/sfx; the user chose native in step 4 |
| **Text-only rhythm** | Fixed word cadence: 3-4 f (0.10-0.13 s) for kinetic builds (M921, M936), 6-9 f for read-speed pops (M964 8-9 f at 24 fps; M929 5, 8, 8 f), a 15-30 f hold after the last word, one hard cut per 10-20 f on a grid | picture only | no audio at all, or music-led with no music file |

**WHEN** timings are estimated **DO** (a) lead text by 2-3 f, not 0-2, (b) cut on line boundaries, not mid-word, (c) put no frame-exact hit on a word you have not measured, (d) re-run `sync.mjs` when real timings arrive and move only the picture **because** an estimate drifts more over a long line than a short one.

**WHEN** no music is possible **DO** keep the cut grid anyway (section 6) and record the intended tempo in the report so music can be laid later without re-cutting *(practice, not from the corpus)*.

**WHEN** the user supplies their own music or voice **DO** use it, measure its BPM or word times, set g and the frame table from it, and leave generation out.

## 9a. Native score: music and SFX from the film itself (`scripts/score.mjs`)

Ask in step 4, once: **ElevenLabs or native**. Record it in STORYBOARD.md. Native is a clean, synced, licence-free bed; it is plainer than a generated or recorded track, so say so when you offer it, and always listen before delivery. The rule that makes native work: **the score is derived from this film, never picked from a preset.** Nothing in it may be arbitrary; every field carries a `why`.

**1. Plan from the film** (after a draft render, so the events exist):
```bash
node scripts/score.mjs plan --events film/draft.mp4.events.json --duration <s> --hero <frame | label text> --mood <mood> \
     --vo-wav film/audio/vo_only.wav [--roles hook,proof,proof,turn,cta] [--close <frame>] --out film/audio/score.json
```
What `plan` decides, and from what:

| Decision | Derived from | Rule |
|---|---|---|
| Tempo + bar offset | the hero hit and the closing cut (render events) | inside the mood's BPM range, both land on bar downbeats (else the close on a beat); bar 1 sits at or before 0 s. `why.cut_alignment` lists how far every other cut is from a beat |
| Sections | the film's cuts (one per act) and the beat table's roles | energy arc: hook 0.3, proofs 0.45 -> 0.57 building, turn/hero 0.72, close 0.3 (ends smaller than it began) |
| Accents | the hero hit, the closing cut | `drop` with `stop`: one beat of music silence, then the impact on the hero (silence before the hit, section 6a); `stinger` on the closing cut |
| Melody vs voice | the VO stem's speech regions | no lead note starts inside speech (+-120 ms); a ringing lead sits 6 dB lower under it. `mix.py --duck` still ducks the whole bed |
| SFX | every picture event (`hit`, `snap`, `press`, `type`, `whip`, `dive`, `focus`, `count`) | one kind per event type (3-5 kinds reused as a system, section 7); the hero hit gets `lock`; transients land on the event frame, swells (whoosh, focus) peak on it |

**2. Review before rendering.** Read score.json against STORYBOARD.md and the brand inventory, and change what does not fit:
- **Mood = the brand's voice and the PAGE emotion**, not the category's habit: `node scripts/score.mjs moods` lists them. `product` (felt keys, pulse bass, shaker: B2B / analytics / SaaS, confident and unhurried), `calm` (pads, wellness, editorial), `cinematic` (space, big reveals), `tense` (problem or risk acts, minor, little melody), `playful` (plucks, swing, consumer and character films), `punchy` / `hype` (montages, launches with energy). A calm brand never gets `hype`; a joke never gets `cinematic`.
- **Energy follows importance**: the hero act is the only peak; a proof act that is a breath gets less, not more. Use `breakdown: true` to drop the drums under a quiet beat, `lead: "none"` to keep melody away from a dense read.
- **Progression and key**: change `progression` / `transpose` when the emotion asks for it (major for "relieved / confident", minor for "tense / before"). One progression per film unless an act turns.
- **SFX**: delete sounds on events that do not deserve one (the rule in section 7: a few hits, not every move); lower gains under dense speech.
- Write what you changed into the `why` fields; they go into NOTE.md.

**3. Render, mix, listen.**
```bash
node scripts/score.mjs render film/audio/score.json            # -> music.native.wav (-14 LUFS) + sfx.native.wav (authored gains)
python3 scripts/mix.py --duration <s> --vo ... --music film/audio/music.native.wav --music-gain -17 --duck --sfx film/audio/sfx.native.wav@0:0 --out film/audio/mix.wav
```
Both files start at film time 0, so they mix at `@0`. Listen to the mix against the picture; `look.py` checks loudness and silences. Report in NOTE.md: source per kind, tempo and mood with their why, and any FALLBACK line. `--stems` writes drums/bass/chords/lead/fx separately when one layer needs checking.

**WHEN** the film is re-cut **DO** re-run `plan` from the new render's events (the tempo and every SFX move with the picture) and re-apply your review edits **because** a score derived from old frames drifts off the new cuts.

---

## Slop tells for this topic

| An AI default would | The designer does |
|---|---|
| Build the picture first, then lay voice over it and nudge | Script, VO, word timings, then picture on those frames |
| Caption every spoken word on screen | Speech uncaptioned; on-screen text carries the next fragment, a different one from the transcript (M939, M964) |
| Land words on round-number frames | Land them 0-2 f before the spoken word's frame, up to 5 f for a name or wipe |
| Narrate every click in the proof beats | Voice on hook, turn, cta; proofs run under SFX and music, or carry one line |
| Cut on arbitrary frames | One beat unit g (10-20 f), every cut and hit on a multiple of g |
| Tick once per typed character, or once per counter value | One quiet texture across the span; a tick per word or per 3rd-4th value |
| Give every event its own bespoke sound | 3-5 SFX kinds reused as a system |
| Ride the music at full level under the voice | Duck 8-10 dB under speech; thin sound around the strongest hit |
| Stop with an error when the key is missing | Pick a named fallback (silent draft, local voice, text-only rhythm), keep beats.json, report it |
| Let a fade of music end the film | Resolve on a grid unit; let a living mark linger with almost no sound |
| Put a hit on every cut and every word, on a printed BPM | One to three hand-picked hits on the moments that matter; sections shaped, not looped (section 6a) |
| Start the first big sound on a bar line | Tie it to something visible (a click, a lift), or tie the silence to it |
| Keep the music at one level while the viewer reads | Pull it down 6-10 dB for the read; clear it 8-15 dB before the biggest move |
| Fit the music to an early cut and trim the picture afterwards | Fit the score to the final length; re-fit after any trim; no silent tail |
| Swell the music over a real result | Consider no swell: the event is the climax |
| Silence by default on a short film | Decide silence deliberately (muted social) and say so in NOTE.md |
