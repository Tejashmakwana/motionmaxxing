# Tools: every script in `scripts/`

`SKILL` = the skill folder. All scripts print `--help`. Zero dependencies unless noted (Node 22+, Chrome, ffmpeg, Python 3.9+). Nothing here calls a paid API except `voice.py` (ElevenLabs) and, only when asked, `imagegen.py` (Codex login, no key). Scratch to delete after tests: frame sequences, drafts, `look/` dirs.

| step | script | one line |
|---|---|---|
| 0 | `providers.sh` | what this machine has (Chrome, ffmpeg, ElevenLabs key, Codex + `image_generation`, disk) |
| 1 | `brand.mjs`, `fetch_logo.mjs` | capture a site's brand; fetch an official third-party mark |
| 3 | `precedent.py` | rule-only precedent per beat |
| 4 | `imagegen.py` | generated SURFACE plates (never text/logo/UI/people) |
| 5, 8 | `voice.py`, `sync.mjs`, `mix.py` | voice, word timings to frames (5); SFX, music, final mix (8) |
| 6-7, 9 | `render.mjs`, `look.py`, `lint.mjs` | render, inspect (G0 G2 G3 + audio), page-chrome lint (G5); final render with sound (9) |
| 9 | `blind_review.py` | blind A/B page for the user |

## Gates and who computes them
Same definitions as SKILL.md and `slop.md` Part 2.
| gate | computed by | note |
|---|---|---|
| G0 render exists (decodes, non-blank, moves, right length, audio) | `look.py --expect S --expect-audio` | FAIL lines name the cause |
| G1 proof readable | by eye on `look/sheet.jpg` and stills (no script number) | text >= 0.04 H, fragment >= 0.55 W or edge-cropped |
| G2 no empty frame | `look.py` | a run of > 3 flat frames; <= 3 f dips inside a transition ignored |
| G3 end card short | `look.py` | end hold (picture unchanged at the end) <= 1.4 s, i.e. a resolved hold of 0.6-1.4 s; under 0.6 s is a NOTE (ends mid-motion); final shot (last cut to end) <= 25 % of the film |
| G4 one hero per frame | by eye on the sheet (no script number) | two panels only if one is >= 2x the other's area or the camera moves between them |
| G5 no page chrome | `lint.mjs` (`GATE G5: PASS/FAIL`, exit 1 on FAIL) | C1-C4, C6, C7, P1, V1, V2, V5 FAIL; D1 FAILs with media/sub-line/kicker beside it (WARN alone); T1 FAILs when letters grow (a caret alone is WARN); C5, V3, V4 are WARN |
`look.py` writes G0, G2, G3 to `look/gates.json` and prints them in its GATES block as `G0 render exists`, `G2 no empty frame`, `G3 end card hold, CTA share` (G1, G4 and G5 are named there as not computed by it); `lint.mjs` prints `GATE G5: PASS|FAIL`. Quote the numbers in `NOTE.md`. A PASS is not good taste; a lint is a lead, not a verdict.

## providers.sh
`bash "$SKILL/scripts/providers.sh"` -> JSON: `ready`, chrome, ffmpeg (+missing filters), `elevenlabs.key`, `codex.image_generation` (true / false / null), `disk_free_gb`, `disk_low`. Never installs. Low disk (< 3 GB): short low-res drafts, delete outputs.

Browser selection: `CHROME_PATH` (must be executable), installed Chrome for Testing / Playwright Chromium, then system Chrome. `PLAYWRIGHT_BROWSERS_PATH` overrides the Playwright cache root. The same selection is used by `providers.sh` and `_cdp.mjs`; `node scripts/_chrome.mjs` prints the selected executable without launching it. macOS launches disable app-bundle code-sign clones; normal close waits for browser exit, then deletes only that run's temporary profile.

Browser regression checks: `node --test tests/chrome.test.mjs`. Run the real-browser lifecycle/clone checks with `MOTIONMAXXING_BROWSER_TESTS=1 node --test tests/browser.test.mjs` (uses the selected local browser; requires no network).

## brand.mjs
`node "$SKILL/scripts/brand.mjs" https://site.com film/brand` -> `brand.json`, `BRAND.md`, `board.png` (LOOK at it), `logo/`, `fonts/`, `screens/`, `media/`. Flags colour roles, blank images, nav-strip screenshots. Empty page = blocked: say so, fall back to `fetch_logo.mjs` + what the user supplies.

## fetch_logo.mjs
`node "$SKILL/scripts/fetch_logo.mjs" "<brand name>" <domain> --out film/assets/logo [--slug simple-icons-slug] [--json]` -> `logo.svg` (mark), `wordmark.svg`, `logo-light.svg`, `logo.json` (source URLs, official hex, guidelines link). Order SVGL -> Simple Icons -> the site's own icon/header SVG -> raster icon. Never draws or recolours; if nothing is found, set the name in type. Nominative use only; render the SVG once and look. Exit 1 = no SVG mark.

## precedent.py
`python3 "$SKILL/scripts/precedent.py" query --beat proof --content ui --text "selection becomes result" --k 6` (beat hook|turn|proof|cta; content ui|type|logo|number|3d; `--src rule,hf,lib`). Also `show PR-A02`, `rules --beat cta`, `stats`. Returns rules with ids: `PR-Xnn` measured WHEN/DO/BECAUSE rules (evidence M-ids), `PM###` the 53 study moments (role, mechanic, why), `PL####` rules from 39 other films (opaque film id). In the beat table write the ONE rule you adopt and its id. Rows are model-decoded and unverified: open the cited M-moment before trusting a number; never outrank `references/` or `taste/verdicts.md`. Data: `library/moments.jsonl` (no copy, frames or brand names).

## imagegen.py
`python3 "$SKILL/scripts/imagegen.py" plates.json --out film/assets/gen --dry-run` first (guard + exact prompts, spends nothing), then without `--dry-run` (`--jobs 3`, `--only id`, `--force`). One private working dir per plate, md5 collision check, alpha >= 250 snapped to 255, `<id>@WxH.png` cover crop, `ledger.jsonl`. The guard refuses (exit 2) any plate that asks for text, logos or brands, UI/screens/charts, people/faces. Code first, captured asset second, generate last; every plate must perform (parallax, light, occlusion, mask, rack focus); label as illustrative; never replaces product proof. Needs `codex.image_generation: true`; about 1-2 min per plate.

## voice.py, sync.mjs, mix.py
- `voice.py` subcommands: `voices`, `vo --script script.txt --out audio/vo.mp3` (writes `vo.words.json`, `vo.lines.json`; `--no-refine` skips the audio refinement), `vo-local` (macOS `say`, estimated timings), `refine`, `split --vo ... --lines ... --out audio/vo` (per-line clips + `lines.index.json`), `sfx --prompt ... --out ...` or `--batch sfx.json`, `sfx-norm`, `music --prompt ... --ms N --out ... [--dry-run]`, `music-check`, `music-fit --duration N [--loop-bars]`. Word and line times are refined against the audio. Reads the ElevenLabs key (exit 3 without one); `--dry-run` (music) shows the request.
- `node sync.mjs audio/vo.words.json --fps 30` -> `beats.json` / `beats.js`: word -> frame table, on-screen onset frames (2 f before the word), clip table for `mix.py`.
- `python3 mix.py --duration 16 --vo clip@t ... --music m.wav --sfx f@t:gain --duck --out mix.wav` -> -14 LUFS / -1 dBTP stereo 48 kHz. Duck is predictable (`--duck-db 9`).

## render.mjs
`node "$SKILL/scripts/render.mjs" film/index.html film/final.mp4 --audio audio/mix.wav` (any `__seek` / `__timelines` / gsap page; `--fps`, `--from/--to`, `--scale 0.5` for drafts, `--still 0.5,2,4` for PNG stills). Writes `final.mp4.events.json` from `window.__events` (`look.py` uses it for exact cuts).
- **Finish, single pass:** `--shutter 180 --subframes 8 [--grain 0.03 --grain-seed 7]`. N sub-frame seeks per frame across the open shutter (forward from the frame time, so a hard cut never ghosts), averaged by ffmpeg `tmix` inside the same encode; no intermediate files. Cost = N x render time, so use `--from/--to` for hero ranges. Stepped content (typing, counters, `clock:'twos'`, 1-frame kf steps) stays crisp; smooth motion blurs. ONE blur grammar per film: shutter OR per-element smear OR crisp steps, never shutter over smear. Grain 0.03-0.06 only on gradient/photo/3D films; same seed gives the same bytes. Stills ignore both.
- WebGL pages: do not mix GPU and software GL in one render; `--scale` does not cut WebGL cost.

## look.py
`python3 "$SKILL/scripts/look.py" film/final.mp4 --out film/look --expect 16 --expect-audio` -> `sheet.jpg` (describe each frame in one sentence), `cuts.txt`, `still.txt`, `mid.jpg` (2 f before each cut), `strips.jpg`, `gates.json`, and a printed report: cuts (events win), shots, end hold, then the **AUDIO** block (LUFS, LRA, true peak > -1 dBTP flagged, audible span, silent tail > 0.5 s, dropouts, sound onsets, share of cuts within +-80 ms of an onset vs chance), the **GATES** block (G0 G2 G3 PASS/FAIL with times) and the **MOTION** note (mean luma change vs the human band, median 6.8, IQR 4.4-9.8: a question, never a gate). `--strict` exits 3 on any FAIL. Shutter-blurred mid frames are expected; judge the thumbnail, the cover and the mid-change frame.

## lint.mjs
`node "$SKILL/scripts/lint.mjs" film/index.html [--times 0.5,2,4] [--samples N] [--json]` -> PASS / WARN / FAIL per rule (C1 corner/edge label, C2 tracked caps, C3 counter, C4 metadata, C5 mono label, C6 bar/row, C7 kicker, D1 deck layout, P1 progress bar, T1 letter-typed headline, V1-V5 vibe-coded UI) with sample times, element snippet and bbox, then `GATE G5`. Each position rule must hold across 0.1 s (a label flying through a corner is not chrome). Text inside a UI surface (card-sized fill + radius, or `[data-ui]`) is exempt except greetings, "label . value" and the V5 cluster; `[data-ui="captured"]` (a faithful rebuild of a captured screen) also skips V5 and is printed. Fix by deleting the element; do not justify it. Cannot see text inside `<canvas>`/images. Exit 1 on FAIL.

## blind_review.py
`python3 "$SKILL/scripts/blind_review.py" film/review --round "before vs after" v1/final.mp4 v2/final.mp4` (the first argument is the output dir, default `review`) -> `film/review/index.html` (random L/R, synced play, frame step, sound per film, pick / slop / 1-10 / notes, Copy verdict), videos hard-linked, key in hidden `.answer-key.json` (do not open). Offer it when two versions exist; append the pasted verdict to `taste/verdicts.md`. Judge picture silent first, then each soundtrack alone.
