#!/usr/bin/env python3
"""look.py - make a finished film inspectable: contact sheet, cuts, frozen stretches, end hold, pre-cut frames, loudness. stdlib + ffmpeg.

Usage:
  python3 look.py film.mp4 [--out look] [--frames 16] [--scene 0.3] [--scene-low 0.12] [--freeze-min 0.6]
                  [--events events.json] [--hold-warn 1.4] [--hold-eps 0.35] [--shown 12]
                  [--expect S] [--expect-tol 0.15] [--expect-audio] [--strict]

Cuts - two sources, events win:
  1. EVENTS (authoritative). If --events FILE is given, or <film>.events.json / <film stem>.events.json exists (render.mjs writes
     <out>.mp4.events.json from window.__events), every event whose "type" is cut/show/hide or contains "cut" is a cut at
     "t" seconds (or "frame"/fps). Events without a "type" (e.g. an SFX list) are ignored. Detection still runs and anything it
     finds that the events do not explain is printed as a cross-check.
  2. DETECTION (no events). A cut is a frame where (a) ffmpeg scene score >= --scene, or (b) scene >= --scene-low AND the picture is
     structurally different from the previous frame (luma correlation < 0.7) AND the change is abrupt (not a multi-frame animation), or (c) a pixel-difference spike (>= 2.5x the median of
     the neighbouring frame diffs, mean |diff| >= 5/255 on a 96x54 luma) with correlation < 0.6. (c) catches cuts between
     similar-toned shots that the scene score misses; the correlation test rejects fast pushes/zooms of one picture. Candidates
     within 3 frames of each other are merged (strongest kept).

Writes (nothing per-frame ever touches the disk; frames are tiled inside ffmpeg):
  look/sheet.jpg   contact sheet, N evenly spaced frames (4 columns) with timecodes burned in
  look/cuts.txt    cut times (s, frame, timecode, source)
  look/still.txt   stretches >= --freeze-min seconds where the picture does not change (ffmpeg freezedetect)
  look/mid.jpg     frames 2 frames BEFORE each cut (max --shown) - where broken transitions hide
  look/strips.jpg  one row per cut (max --shown): frames cut-1 | cut | cut+1
Report adds: longest static-ish stretch (mean frame diff < --hold-eps /255), the final shot (last cut -> end) and the END HOLD:
how long the picture is unchanged at the end (trailing frames with diff < --hold-eps, so slow scale/position drift counts as held).
--hold-warn S (default 1.4, 0 = off) prints a WARNING when the end hold exceeds S seconds.
GATES block (printed last, also written to look/gates.json): the gates this script can compute from the finished file.
  G0 render exists: decodes, is not blank (>= 5 % of frames have picture content), moves (>= 5 % of frames change), duration matches
     --expect S (+-0.15 s, --expect-tol) when given, an audio stream exists and is not silent when --expect-audio.
  G2 no empty frame: a run of MORE than 3 consecutive frames that are one flat field (luma std < 1.5 and range < 8 on the 96x54 analysis
     frame) is a FAIL with its times; runs of <= 3 frames (a dip inside a transition) are ignored.
  G3 end card: the picture-unchanged end hold must be <= --hold-warn (1.4 s); a hold under 0.6 s is a NOTE (the film ends mid-motion:
     fine when intended); the final shot (last cut -> end) must be <= 25 % of the film.
  G1 (proof readable), G4 (one hero per frame) are judged by eye on sheet.jpg; G5 (no page chrome) is lint.mjs.
AUDIO block (when the film has sound): integrated LUFS / LRA / true peak (peak above -1 dBTP is flagged), audible span (leading and
  trailing silence, dropouts of digital silence in the middle), silent tail > 0.5 s at the end, and audio onsets next to the picture
  cuts (share of cuts that land within +-80 ms of a sound onset; pros land about a third of their cuts on a hit).
MOTION note: mean frame-to-frame luma change (0-255 on the 96x54 analysis frame). Human-made films: median 6.8, IQR 4.4-9.8. A QUESTION,
  never a gate: below the band ask what is alive between beats; above it ask whether the picture is too busy to read.
Options for the gates: --expect S (expected duration)  --expect-tol S  --expect-audio  --strict (exit 3 when any gate FAILs).
Facts only, no scores. Exit: 0 ok, 1 failure, 2 bad usage, 3 a gate FAILed under --strict.
"""
from __future__ import annotations
import argparse, json, math, operator, os, re, shutil, subprocess, sys

FONTS = ["/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Supplemental/Courier New.ttf",
         "/System/Library/Fonts/Helvetica.ttc", "/Library/Fonts/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"]
AW, AH = 96, 54          # analysis resolution (luma)
ST = {}                  # per-frame luma stats filled by analyse(): mean, std, range
MERGE = 3                # frames: candidates closer than this are one cut


def die(msg, code=1):
    print("error: " + msg, file=sys.stderr)
    sys.exit(code)


def ff(args, check=True):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-y"] + args, capture_output=True, text=True)
    if check and r.returncode:
        die("ffmpeg failed: " + " ".join(args[:6]) + " ...\n" + r.stderr[-1000:])
    return r


def probe(f):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", f], capture_output=True, text=True)
    if r.returncode:
        die("ffprobe cannot read %s: %s" % (f, r.stderr.strip()[:300]))
    return json.loads(r.stdout)


def tc(t):
    return "%d:%05.2f" % (int(t // 60), t % 60)


def drawtext_filter(font):
    if not font:
        return ""
    return ("drawtext=fontfile='%s':text='%%{pts\\:hms}':x=6:y=h-th-6:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4," % font)


def median(v):
    s = sorted(v)
    n = len(s)
    return 0.0 if not n else (s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2)


def analyse(film):
    """One streamed pass over a tiny luma version of the film -> per-frame (mean |diff| to previous, luma correlation to previous)."""
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", film, "-an", "-vf", "scale=%d:%d:flags=area,format=gray" % (AW, AH), "-f", "rawvideo", "-"],
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    size = AW * AH
    prev = None
    M, C = [], []
    sub, mul = operator.sub, operator.mul
    prev_stats = None
    ST.clear(); ST.update(mean=[], std=[], rng=[])
    while True:
        buf = p.stdout.read(size)
        if len(buf) < size:
            break
        fr = buf
        mean = sum(fr) / size
        var = sum(map(mul, fr, fr)) - size * mean * mean
        ST["mean"].append(mean); ST["std"].append(math.sqrt(max(0.0, var) / size)); ST["rng"].append(max(fr) - min(fr))
        if prev is None:
            M.append(0.0); C.append(1.0)
        else:
            M.append(sum(map(abs, map(sub, fr, prev))) / size)
            pm, pv = prev_stats
            if var < 1e-3 and pv < 1e-3:
                C.append(1.0 if abs(mean - pm) < 2 else 0.0)
            elif var < 1e-3 or pv < 1e-3:
                C.append(0.0)
            else:
                cov = sum(map(mul, fr, prev)) - size * mean * pm
                C.append(cov / math.sqrt(var * pv))
        prev, prev_stats = fr, (mean, var)
    p.wait()
    return M, C


def merge_frames(cands, gap=MERGE):
    """cands: [(frame, info[, strength])] -> non-max suppression: the strongest of every group closer than gap+1 frames survives
    (equal strength: the earlier one). Events carry no strength, so the first one wins."""
    order = sorted(cands, key=lambda x: (-(x[2] if len(x) > 2 else 0.0), x[0]))
    kept = []
    for c in order:
        if all(abs(c[0] - k[0]) > gap for k in kept):
            kept.append(c)
    return [(k[0], k[1]) for k in sorted(kept, key=lambda x: x[0])]


def detect(M, C, scene, scene_hi, scene_lo):
    n = len(M)
    cands = []
    for i in range(2, n):
        sc = scene.get(i, 0.0)
        strength = max(sc, min(1.0, M[i] / 150.0))
        if sc >= scene_hi:
            cands.append((i, "scene %.2f" % sc, strength)); continue
        before = median(M[max(1, i - 4):i])
        after = median(M[i + 1:i + 5]) if i + 1 < n else 0.0
        r = M[i] / (max(before, after) + 0.3)       # how much this frame stands out from its neighbours (an abrupt change, not an animation)
        if sc >= scene_lo and C[i] < 0.7 and M[i] >= 3.0 and r >= 1.8:
            cands.append((i, "scene %.2f + corr %.2f spike x%.1f" % (sc, C[i], r), strength)); continue
        if r >= 2.5 and M[i] >= 5.0 and C[i] < 0.6:
            cands.append((i, "pixel spike x%.1f diff %.1f corr %.2f scene %.2f" % (r, M[i], C[i], sc), strength))
    return merge_frames(cands)


def find_events(film, given):
    cands = [given] if given else [film + ".events.json", os.path.splitext(film)[0] + ".events.json"]
    for c in cands:
        if c and os.path.isfile(c):
            return c
    if given:
        die("events file not found: " + given, 2)
    return None


def events_to_cuts(path, fps, nframes):
    try:
        ev = json.load(open(path))
    except (OSError, ValueError) as e:
        die("cannot read events %s: %s" % (path, e))
    if isinstance(ev, dict):
        ev = ev.get("events", [])
    out, kinds = [], {}
    for e in ev if isinstance(ev, list) else []:
        if not isinstance(e, dict):
            continue
        ty = str(e.get("type", "")).lower()
        if not ty or not (ty in ("cut", "show", "hide") or "cut" in ty):
            continue
        if isinstance(e.get("t"), (int, float)):
            fr = int(round(e["t"] * fps))
        elif isinstance(e.get("frame"), (int, float)):
            fr = int(round(e["frame"]))
        else:
            continue
        if 0 < fr < nframes:
            out.append((fr, "event %s%s" % (ty, " '%s'" % e["label"] if e.get("label") else "")))
            kinds[ty] = kinds.get(ty, 0) + 1
    return merge_frames(out), kinds


def runs_below(M, eps):
    """[(first_frame, last_frame)] of consecutive frames (index>=1) whose diff to the previous frame is < eps."""
    out, s = [], None
    for i in range(1, len(M)):
        if M[i] < eps:
            s = i if s is None else s
        elif s is not None:
            out.append((s, i - 1)); s = None
    if s is not None:
        out.append((s, len(M) - 1))
    return out


# ------------------------------------------------------------------ gates + audio audit
HUMAN_MOTION = (6.8, 4.4, 9.8)    # median, Q1, Q3 of mean |frame diff| over human-made launch films (same 96x54 luma measure)
FLAT_STD, FLAT_RNG, FLAT_MAX_OK = 1.5, 8, 3


def audio_env(film, sr=8000, hop=0.01):
    """Mono 8 kHz decode -> RMS level in dBFS per 10 ms window. Pure python (array); ~0.3 s per 10 s of film."""
    import array
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", film, "-vn", "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"], capture_output=True)
    raw = r.stdout[: len(r.stdout) // 2 * 2]
    a = array.array("h")
    a.frombytes(raw)
    n = int(sr * hop)
    env = []
    full = 32768.0 ** 2
    for i in range(0, len(a) - n + 1, n):
        seg = a[i:i + n]
        env.append(10 * math.log10(max(sum(x * x for x in seg) / n / full, 1e-12)))
    return env, hop


def audio_audit(film, dur, cut_times):
    env, hop = audio_env(film)
    if len(env) < 10:
        return None
    AUD, DIG = -50.0, -70.0
    idx = [i for i, v in enumerate(env) if v >= AUD]
    res = {"dur": dur, "env_n": len(env)}
    if not idx:
        res.update(audible=None, lead=dur, tail=dur, dropouts=[], onsets=[], silent=True)
        return res
    first, last = idx[0] * hop, (idx[-1] + 1) * hop
    # dropouts: digital silence (< -70 dB) of >= 0.25 s strictly between first and last audible
    drops, s0 = [], None
    for i in range(idx[0], idx[-1] + 1):
        if env[i] < DIG:
            s0 = i if s0 is None else s0
        elif s0 is not None:
            if (i - s0) * hop >= 0.25:
                drops.append((s0 * hop, i * hop))
            s0 = None
    # onsets: >= 8 dB above the median of the previous 70 ms, and above -38 dB; merged within 80 ms
    on = []
    for i in range(8, len(env) - 1):
        peak = max(env[i], env[i + 1])
        if peak >= -38 and peak - median(env[i - 8:i - 1]) >= 8 and env[i - 1] < peak - 3:
            t = i * hop
            if not on or t - on[-1] > 0.08:
                on.append(t)
    res.update(audible=(first, last), lead=first, tail=max(0.0, dur - last), dropouts=drops, onsets=on, silent=False)
    if cut_times and on:
        offs = []
        for c in cut_times:
            o = min(on, key=lambda x: abs(x - c))
            offs.append((c, o - c))
        res["cut_offsets"] = offs
    return res


def print_audio(res, loud, au, cut_times):
    if not au:
        return
    print("AUDIO")
    tp = loud.get("true_peak_dbfs") if loud else None
    flags = []
    try:
        if tp is not None and float(tp) > -1.0:
            flags.append("true peak %s dBFS is above -1 dBTP (inter-sample clipping risk on lossy encode)" % tp)
        lu = float(loud["integrated_lufs"]) if loud and loud.get("integrated_lufs") else None
        if lu is not None and not (-17.5 <= lu <= -11.5):
            flags.append("integrated %.1f LUFS is far from the -14 LUFS delivery target" % lu)
    except (TypeError, ValueError):
        pass
    if loud:
        print("  loudness   integrated %s LUFS   LRA %s LU   true peak %s dBFS" % (loud["integrated_lufs"], loud["lra_lu"], loud["true_peak_dbfs"]))
    if res is None:
        print("  (audio too short to analyse)")
    elif res["silent"]:
        print("  audible    NONE: the whole soundtrack is below -50 dBFS")
        flags.append("soundtrack is silent")
    else:
        a0, a1 = res["audible"]
        span = a1 - a0
        print("  audible    %.2f-%.2f s of %.2f s (%.0f %%)   lead silence %.2f s   tail silence %.2f s" % (a0, a1, res["dur"], 100 * span / res["dur"], res["lead"], res["tail"]))
        if res["tail"] > 0.5:
            flags.append("silent tail %.2f s at the end (> 0.5 s): the music ends early or the file is longer than the track; refit it (voice.py music-fit) or end the picture sooner" % res["tail"])
        if res["lead"] > 0.5:
            flags.append("silence for the first %.2f s" % res["lead"])
        if res["dropouts"]:
            flags.append("digital-silence dropouts inside the film: " + ", ".join("%.2f-%.2f s" % d for d in res["dropouts"][:6]))
        on = res["onsets"]
        print("  onsets     %d sound onsets (>= 8 dB jump)%s" % (len(on), ": " + ", ".join("%.2f" % t for t in on[:16]) + (" ..." if len(on) > 16 else "") if on else ""))
        offs = res.get("cut_offsets")
        if offs:
            hit = [o for o in offs if abs(o[1]) <= 0.08]
            chance = min(1.0, len(on) * 0.16 / res["dur"])
            print("  cut sync   %d of %d cuts land within +-80 ms of a sound onset (%.0f %%; pros ~35 %%; chance level with %d onsets in %.0f s is ~%.0f %%)" % (len(hit), len(offs), 100.0 * len(hit) / len(offs), len(on), res["dur"], 100 * chance))
            near = [(c, d) for c, d in offs if 0.08 < abs(d) <= 0.3]
            if near:
                print("             near misses: " + ", ".join("cut %.2f s -> onset %+d ms" % (c, round(d * 1000)) for c, d in near[:8]) + "  (a hit 80-300 ms off the picture reads as late/early)")
        elif cut_times and not on:
            print("  cut sync   no onsets found: the sound has no hits to line up with the cuts")
    for f in flags:
        print("  FLAG       " + f)
    if not flags:
        print("  flags      none")


def compute_gates(a, dur, fps, nf, M, C, vs, au, cut_times, hold, final_dur, probe_ok=True):
    G = []
    std, rng, mean = ST["std"], ST["rng"], ST["mean"]
    n = len(std)
    # ---- G0
    why, st = [], "PASS"
    nonflat = sum(1 for v in std if v >= FLAT_STD)
    moving = sum(1 for v in M[1:] if v >= 0.35)
    if n == 0 or nonflat < max(1, 0.05 * n):
        why.append("BLANK: only %d of %d frames have picture content (std >= %.1f)" % (nonflat, n, FLAT_STD)); st = "FAIL"
    if n and max(mean) < 3:
        why.append("all frames are black"); st = "FAIL"
    if n > 1 and moving < max(2, 0.05 * (n - 1)):
        why.append("NO MOTION: only %d of %d frames differ from the previous one" % (moving, n - 1)); st = "FAIL"
    if a.expect is not None:
        tol = a.expect_tol
        if abs(dur - a.expect) > tol:
            why.append("duration %.2f s but --expect %.2f s (+-%.2f)" % (dur, a.expect, tol)); st = "FAIL"
        else:
            why.append("duration %.2f s matches --expect %.2f s" % (dur, a.expect))
    else:
        why.append("duration %.2f s (not checked: no --expect)" % dur)
    if a.expect_audio:
        if not au:
            why.append("NO AUDIO STREAM but --expect-audio"); st = "FAIL"
        else:
            why.append("audio stream present")
    else:
        why.append("audio %s" % ("present" if au else "none (not required)"))
    G.append(("G0", "render exists", st, "; ".join(why)))
    # ---- G2: runs of > 3 flat frames
    runs, s0 = [], None
    for i in range(n):
        flat = std[i] < FLAT_STD and rng[i] < FLAT_RNG
        if flat:
            s0 = i if s0 is None else s0
        elif s0 is not None:
            runs.append((s0, i - 1)); s0 = None
    if s0 is not None:
        runs.append((s0, n - 1))
    bad = [(s, e) for s, e in runs if e - s + 1 > FLAT_MAX_OK]
    ign = [(s, e) for s, e in runs if e - s + 1 <= FLAT_MAX_OK]
    if bad:
        d = "; ".join("%.2f-%.2f s (%d f, luma %.0f)" % (s / fps, (e + 1) / fps, e - s + 1, mean[s]) for s, e in bad[:8])
        G.append(("G2", "no empty frame", "FAIL", "flat-field runs of > %d frames: %s" % (FLAT_MAX_OK, d)))
    else:
        G.append(("G2", "no empty frame", "PASS", "no run of > %d flat frames%s" % (FLAT_MAX_OK, ("; %d short dip(s) ignored: %s" % (len(ign), ", ".join("%.2fs" % (s / fps) for s, _ in ign[:6]))) if ign else "")))
    # ---- G3
    share = final_dur / dur if dur else 0
    st, why = "PASS", []
    if a.hold_warn > 0 and hold > a.hold_warn:
        st = "FAIL"; why.append("end hold %.2f s > %.2f s" % (hold, a.hold_warn))
    elif hold < 0.6:
        why.append("end hold %.2f s: ends mid-motion (NOTE: fine when intended)" % hold)
    else:
        why.append("end hold %.2f s (0.6-%.1f)" % (hold, a.hold_warn))
    if cut_times:
        if share > 0.25:
            st = "FAIL"; why.append("final shot %.2f s = %.0f %% of the film (> 25 %%)" % (final_dur, 100 * share))
        else:
            why.append("final shot %.2f s = %.0f %% of the film (<= 25 %%)" % (final_dur, 100 * share))
    else:
        why.append("no cuts: final-shot share not computed")
    G.append(("G3", "end card hold, CTA share", st, "; ".join(why)))
    return G


def print_gates(G, M, fps):
    print("GATES")
    for gid, name, st, why in G:
        print("  %s %-26s %-4s  %s" % (gid, name, st, why))
    print("  G1 proof readable / G4 one hero per frame: by eye on the sheet.   G5 no page chrome: node lint.mjs index.html")
    if len(M) > 2:
        mm = sum(M[1:]) / (len(M) - 1)
        med, q1, q3 = HUMAN_MOTION
        band = "inside" if q1 <= mm <= q3 else ("below" if mm < q1 else "above")
        print("MOTION")
        print("  mean frame-to-frame luma change %.1f/255 (human-made films: median %.1f, IQR %.1f-%.1f): %s the human band" % (mm, med, q1, q3, band))
        if band == "below":
            print("  question: between the beats, what on screen is alive? (drift, creep, a caret, a loop), or is the film mostly held?")
        elif band == "above":
            print("  question: is the picture busy enough that the proof frame cannot be read? Which frame is the one to remember?")
        else:
            print("  question: is the motion spent where the story needs it, or spread evenly?")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("film")
    ap.add_argument("--out", default="look")
    ap.add_argument("--frames", type=int, default=16)
    ap.add_argument("--scene", type=float, default=0.3, help="scene score that alone makes a cut")
    ap.add_argument("--scene-low", type=float, default=0.12, help="lower scene score that counts when the picture also changed structurally")
    ap.add_argument("--freeze-min", type=float, default=0.6)
    ap.add_argument("--events", help="events.json from render.mjs (default: <film>.events.json if present)")
    ap.add_argument("--hold-warn", type=float, default=1.4, help="warn when the end hold exceeds this many seconds (0 = off)")
    ap.add_argument("--hold-eps", type=float, default=0.35, help="mean |frame diff| (0-255, 96x54 luma) below which the picture counts as held")
    ap.add_argument("--shown", type=int, default=12, help="max cuts shown in mid.jpg / strips.jpg")
    ap.add_argument("--expect", type=float, default=None, help="G0: expected film duration in seconds")
    ap.add_argument("--expect-tol", type=float, default=0.15, help="G0: duration tolerance in seconds")
    ap.add_argument("--expect-audio", action="store_true", help="G0: the film must contain an audio stream")
    ap.add_argument("--strict", action="store_true", help="exit 3 when any gate FAILs")
    a = ap.parse_args()
    if not os.path.isfile(a.film):
        die("film not found: " + a.film, 2)
    for t in ("ffmpeg", "ffprobe"):
        if not shutil.which(t):
            die(t + " not found")
    os.makedirs(a.out, exist_ok=True)
    font = next((f for f in FONTS if os.path.exists(f)), None)
    if not font:
        print("warn: no font found for timecodes; sheet will have none", file=sys.stderr)

    info = probe(a.film)
    vs = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    au = next((s for s in info["streams"] if s["codec_type"] == "audio"), None)
    if not vs:
        die("no video stream in " + a.film)
    dur = float(info["format"].get("duration") or vs.get("duration") or 0)
    n_, d_ = (vs.get("avg_frame_rate") or "0/1").split("/")
    fps = float(n_) / float(d_) if float(d_) else 0.0
    if dur <= 0 or fps <= 0:
        die("cannot determine duration/fps")
    nframes = int(vs.get("nb_frames") or round(dur * fps))
    W, H = vs["width"], vs["height"]

    # ---- contact sheet (frame-number select = exact, evenly spaced, centred in their slots)
    N = max(1, min(a.frames, nframes))
    idx = sorted({min(nframes - 1, int((k + 0.5) * nframes / N)) for k in range(N)})
    sel = "+".join("eq(n\\,%d)" % i for i in idx)
    cols = 4 if len(idx) > 4 else len(idx)
    rows = math.ceil(len(idx) / cols)
    tw = 480 if cols >= 4 else 640
    ff(["-i", a.film, "-an", "-vf", "select='%s',%sscale=%d:-2,tile=%dx%d:padding=4:margin=4:color=0x111111" % (sel, drawtext_filter(font), tw, cols, rows),
        "-frames:v", "1", "-q:v", "3", "-fps_mode", "passthrough", os.path.join(a.out, "sheet.jpg")])

    # ---- one decode pass: scene scores + freezedetect;  one tiny-luma pass: frame diffs + correlation
    r = ff(["-i", a.film, "-an", "-vf", "freezedetect=n=-50dB:d=%s,select='gte(scene\\,0)',metadata=print:file=-" % a.freeze_min, "-f", "null", "-"])
    scene, cur = {}, None
    for ln in r.stdout.splitlines():
        m = re.match(r"frame:(\d+)", ln)
        if m:
            cur = int(m.group(1))
        m = re.search(r"scene_score=([\d.]+)", ln)
        if m and cur is not None:
            scene[cur] = float(m.group(1))
    frozen, cur = [], None
    for kind, val in re.findall(r"freeze_(start|end): ([\d.]+)", r.stderr):
        v = float(val)
        if kind == "start":
            cur = v
        elif cur is not None:
            frozen.append((cur, v)); cur = None
    if cur is not None:
        frozen.append((cur, dur))
    frozen = [(s, e) for s, e in frozen if e - s >= a.freeze_min]
    M, C = analyse(a.film)
    if len(M) < 2:
        die("could not decode frames for analysis")
    nf = len(M)

    # ---- cuts
    detected = detect(M, C, scene, a.scene, a.scene_low)
    ev_path = find_events(a.film, a.events)
    ev_cuts, ev_kinds = events_to_cuts(ev_path, fps, nf) if ev_path else ([], {})
    if ev_path and not ev_cuts:
        print("note: %s has no cut/show/hide events; using detection" % ev_path, file=sys.stderr)
    cut_list = ev_cuts if ev_cuts else detected          # [(frame, source)]
    source = "events" if ev_cuts else "detected"
    cuts = [f / fps for f, _ in cut_list]
    unexplained = []
    if ev_cuts:
        evf = [f for f, _ in ev_cuts]
        unexplained = [(f, s) for f, s in detected if min(abs(f - e) for e in evf) > MERGE]

    with open(os.path.join(a.out, "cuts.txt"), "w") as f:
        f.write("# cuts from %s%s (time s, frame, timecode, source)\n" % (source, " " + ev_path if ev_cuts else " scene>=%s | scene>=%s+structure | pixel spike" % (a.scene, a.scene_low)))
        for (fr, s) in cut_list:
            f.write("%.3f\tframe %d\t%s\t%s\n" % (fr / fps, fr, tc(fr / fps), s))
        if not cut_list:
            f.write("none\n")
        if unexplained:
            f.write("# detected but not in events:\n")
            for fr, s in unexplained:
                f.write("%.3f\tframe %d\t%s\t%s\n" % (fr / fps, fr, tc(fr / fps), s))
    with open(os.path.join(a.out, "still.txt"), "w") as f:
        f.write("# stretches >= %.2fs with no picture change (start end duration)\n" % a.freeze_min)
        for s, e in frozen:
            f.write("%.3f\t%.3f\t%.2f\n" % (s, e, e - s))
        if not frozen:
            f.write("none\n")

    # ---- mid.jpg (2 frames before each cut) and strips.jpg (cut-1 | cut | cut+1)
    shown = [f for f, _ in cut_list]
    if len(shown) > a.shown:
        shown = [shown[int(i * len(shown) / a.shown)] for i in range(a.shown)]
    mid, strips = os.path.join(a.out, "mid.jpg"), os.path.join(a.out, "strips.jpg")
    for p in (mid, strips):
        if os.path.exists(p):
            os.remove(p)
    if shown:
        before = sorted({max(0, f - 2) for f in shown})
        sel = "+".join("eq(n\\,%d)" % i for i in before)
        c = min(len(before), 6)
        ff(["-i", a.film, "-an", "-vf", "select='%s',%sscale=320:-2,tile=%dx%d:padding=4:margin=4:color=0x111111" % (sel, drawtext_filter(font), c, math.ceil(len(before) / c)),
            "-frames:v", "1", "-q:v", "3", "-fps_mode", "passthrough", mid])
    srows = [f for f in shown if 1 <= f <= nf - 2]
    if srows:
        sel = "+".join("eq(n\\,%d)" % i for f in srows for i in (f - 1, f, f + 1))
        ff(["-i", a.film, "-an", "-vf", "select='%s',%sscale=256:-2,tile=3x%d:padding=3:margin=4:color=0x111111" % (sel, drawtext_filter(font), len(srows)),
            "-frames:v", "1", "-q:v", "3", "-fps_mode", "passthrough", strips])

    # ---- static-ish stretches and the end hold
    runs = runs_below(M, a.hold_eps)
    longest = max(runs, key=lambda r_: r_[1] - r_[0], default=None)
    hold = 0.0
    tail_slack = max(2, int(round(0.25 * fps)))
    if runs and runs[-1][1] >= nf - 1 - tail_slack:
        hold = (runs[-1][1] - runs[-1][0] + 1) / fps
    last_cut = max(cuts) if cuts else 0.0
    final_dur = dur - last_cut

    # ---- loudness
    loud = None
    if au:
        r = ff(["-i", a.film, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"], check=False)
        s = r.stderr[r.stderr.rfind("Summary:"):]
        g = lambda p: (re.search(p, s) or [None, None])[1]
        loud = {"integrated_lufs": g(r"I:\s+(-?[\d.]+) LUFS"), "lra_lu": g(r"LRA:\s+([\d.]+) LU"), "true_peak_dbfs": g(r"Peak:\s+(-?[\d.]+) dBFS")}

    # ---- report
    print("file        %s" % a.film)
    print("duration    %.2fs   fps %.3f   size %dx%d   codec %s   frames %d" % (dur, fps, W, H, vs.get("codec_name"), nframes))
    lst = ", ".join("%.2f" % t for t in cuts[:20]) + (" ..." if len(cuts) > 20 else "")
    if ev_cuts:
        print("cuts        %d from events (%s; %s): %s" % (len(cuts), os.path.basename(ev_path), ", ".join("%s %d" % kv for kv in sorted(ev_kinds.items())), lst))
        print("detected    %d by analysis; %s" % (len(detected), ("not in events: " + ", ".join("%.2f" % (f / fps) for f, _ in unexplained)) if unexplained else "all explained by events"))
    else:
        print("cuts        %d detected (scene>=%.2f | scene>=%.2f+structure | pixel spike)%s" % (len(cuts), a.scene, a.scene_low, ": " + lst if cuts else ""))
    print("shot length mean %.2fs over %d shots" % (dur / (len(cuts) + 1), len(cuts) + 1))
    if cuts:
        bounds = [0.0] + cuts + [dur]
        ls = [bounds[i + 1] - bounds[i] for i in range(len(bounds) - 1)]
        print("            min %.2fs  max %.2fs" % (min(ls), max(ls)))
    print("still       %s" % ("; ".join("%.2f-%.2fs (%.2fs)" % (s, e, e - s) for s, e in frozen) if frozen else "no frozen stretch >= %.1fs" % a.freeze_min))
    if longest:
        s0, e0 = (longest[0] - 1) / fps, (longest[1] + 1) / fps
        print("static-ish  longest %.2f-%.2fs (%.2fs, frame diff < %.2f/255; slow drift counts)" % (s0, e0, e0 - s0, a.hold_eps))
    else:
        print("static-ish  none (every frame changes by >= %.2f/255)" % a.hold_eps)
    print("final shot  %.2f-%.2fs (%.2fs)   end hold ~ %.2f s (picture unchanged for the last %d frames)" % (last_cut, dur, final_dur, hold, round(hold * fps)))
    if a.hold_warn > 0 and hold > a.hold_warn:
        print("WARNING     end hold %.2fs > %.2fs: the last element sits resolved from %.2fs to the end. Trim: ffmpeg -i %s -t %.2f -c copy trimmed.mp4  (or keep the exit moving)" % (hold, a.hold_warn, dur - hold, a.film, min(dur, dur - hold + 0.8)))
    if au:
        print("audio       %s %s Hz ch %s   integrated %s LUFS   LRA %s LU   true peak %s dBFS" % (au.get("codec_name"), au.get("sample_rate"), au.get("channels"), loud["integrated_lufs"], loud["lra_lu"], loud["true_peak_dbfs"]))
    else:
        print("audio       none")
    print("files       %s/sheet.jpg  cuts.txt  still.txt  %s" % (a.out, ("mid.jpg  " if shown else "(no mid.jpg: no cuts)") + ("strips.jpg" if srows else "")))

    # ---- audio audit, gates, motion note
    print()
    ares = audio_audit(a.film, dur, cuts) if au else None
    print_audio(ares, loud, au, cuts)
    G = compute_gates(a, dur, fps, nf, M, C, vs, au, cuts, hold, final_dur)
    print_gates(G, M, fps)
    mm = sum(M[1:]) / max(1, len(M) - 1)
    with open(os.path.join(a.out, "gates.json"), "w") as f:
        json.dump({"film": a.film, "duration": dur, "fps": fps, "gates": [{"id": g, "name": n, "status": st, "detail": w} for g, n, st, w in G],
                   "motion_mean_luma_diff": round(mm, 2), "human_band": {"median": HUMAN_MOTION[0], "q1": HUMAN_MOTION[1], "q3": HUMAN_MOTION[2]},
                   "audio": ({k: v for k, v in ares.items() if k not in ("env_n",)} if ares else None), "loudness": loud}, f, indent=1)
    if a.strict and any(st == "FAIL" for _, _, st, _ in G):
        sys.exit(3)


if __name__ == "__main__":
    main()
