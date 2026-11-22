#!/usr/bin/env python3
"""voice.py - ElevenLabs voice-over / SFX / music + local fallback. Python 3.8+, stdlib only.

Usage:
  python3 voice.py voices
  python3 voice.py vo --text "..." | --script script.txt --out audio/vo.mp3
        [--voice ID|name] [--model eleven_multilingual_v2] [--stability .5] [--similarity .75]
        [--style 0] [--speed 1.0] [--force]
      -> out.mp3 (or .wav), <stem>.words.json  [{"word","start","end"}]  and  <stem>.lines.json [{"text","start","end"}]
         (lines = script line breaks; a one-line script is split into sentences)
         Word/line times are then REFINED against the audio (ffmpeg silencedetect -40 dB, d 0.08): starts snap to the speech onset,
         ends to the speech offset; the ElevenLabs alignment is kept as raw_start/raw_end. --no-refine skips this.
  python3 voice.py refine --vo audio/vo.mp3 [--words vo.words.json] [--lines vo.lines.json]     (re-run the refinement on existing files)
  python3 voice.py split --vo audio/vo.mp3 --lines audio/vo.lines.json --out audio/vo
      -> audio/vo/line01.wav ... (speech only, 30 ms pads, 8 ms fades) + lines.index.json [{i,text,clip,dur,lead,start,end}]
         (i is 1-based = the NN in lineNN.wav; lead = seconds from clip start to the first speech sample: put the clip at
          beat_time - lead; place with mix.py --vo audio/vo/line03.wav@5.43 (repeatable))
  python3 voice.py sfx --prompt "soft whoosh" --seconds 1.2 --out audio/sfx/x.mp3 [--influence .5] [--force] [--peak -3] [--keep-raw] [--no-normalize]
  python3 voice.py sfx --batch sfx.json --out audio/sfx          ([{"id","prompt","seconds"}], skips existing files)
      -> every generated file is peak-normalised to --peak (-3 dBFS) with leading silence trimmed; peak/LUFS printed per file.
         The raw generation is kept as x.raw.mp3 only with --keep-raw.
  python3 voice.py sfx-norm --in audio/sfx/*.mp3 [--peak -3] [--keep-raw]       (same normalisation for existing files, in place)
  python3 voice.py music --prompt "warm minimal piano" --ms 20000 --out audio/music.mp3
        [--plan plan.json] [--vocals] [--dry-run]               (--dry-run prints the exact request, spends nothing)
      -> then analyses the file: prints the AUDIBLE SPAN and a WARNING (with a ready-to-run fix) if leading silence > 0.5 s,
         trailing silence > 1 s or audible < 85 % of the requested length (the API often returns a late-starting / early-ending file).
  python3 voice.py music-check --in audio/music.mp3 [--ms 16000]                (the same analysis on an existing file)
  python3 voice.py music-fit --in audio/music.mp3 --out audio/music_fit.wav --duration 16 [--loop-bars] [--bpm N] [--xfade 0.2] [--tail 1.0]
      -> trims leading silence, then loops/extends the audible section (equal-power crossfades) to EXACTLY --duration seconds
         (48 kHz stereo wav) with a --tail second fade-out. --loop-bars estimates the tempo (or takes --bpm) and loops on whole
         bars so the beat grid is kept (assumes the audible start is a downbeat; override with --beats-per-bar).
  python3 voice.py vo-local --text "..." | --script f.txt --out audio/vo.aiff [--voice Samantha] [--rate 175]
      -> macOS `say` + wav + ESTIMATED word timings (flagged "est": true)

  --source elevenlabs|native|auto (music and sfx; default elevenlabs) + --score audio/score.json
      native  render locally with scripts/score.mjs from the film's score (no key, no credits): music -> --out (.wav),
              sfx -> one film-length stem at --out (a .wav file, or <dir>/sfx.native.wav)
      auto    try ElevenLabs; if there is no key (3) or the key/plan refuses the feature (4: HTTP 401/402/403), fall back to
              native for THIS kind only (a trial key can refuse music and still make sfx). The fallback is printed as
              "FALLBACK music: native (reason)": copy that line into NOTE.md.
      Make the score first: node scripts/score.mjs plan --events out.mp4.events.json --duration S --hero <frame> ...

  python3 voice.py keys          every key found (masked), where it came from, and its credits left + next reset (spends nothing)

Keys: several can be held, tried in order; when one is out of credits (or invalid) the next one is used, so a key whose
credits reset monthly never has to be replaced. Sources, all merged in this order (duplicates dropped):
  $ELEVENLABS_API_KEYS (comma/space separated), $ELEVENLABS_API_KEY, $ELEVENLABS_API_KEY_2 .. _9,
  then ./.env, <skill>/.env, ~/.elevenlabs, ~/.config/elevenlabs, with the same names, one per line, e.g.
      ELEVENLABS_API_KEY=sk_first          (tried first)
      ELEVENLABS_API_KEY_2=sk_second
      ELEVENLABS_API_KEY_3=sk_third
  A key refused for credits / validity (HTTP 401 quota_exceeded or invalid_api_key, 402) is skipped for the rest of the run;
  a key refused for a permission or plan (missing_permissions, 403) is skipped for that request only. ElevenLabs checks the
  quota before generating, so a refused request costs nothing.
Exit codes: 0 ok, 1 error, 2 bad usage, 3 no ElevenLabs key, 4 the key or plan does not allow this feature (HTTP 401/402/403).
"""
from __future__ import annotations
import argparse, base64, glob, json, math, os, re, shutil, struct, subprocess, sys, tempfile, time, wave
import urllib.error, urllib.request

API = "https://api.elevenlabs.io"
PREFERRED = ["Brian", "Daniel", "Adam", "Sarah", "River", "George", "Roger", "Eric", "Chris", "Liam", "Will", "Charlie"]
NOKEY = "no ElevenLabs key: film will be made without VO/music; set ELEVENLABS_API_KEY"


def die(msg, code=1):
    print("error: " + msg, file=sys.stderr)
    sys.exit(code)


KEY_RE = re.compile(r"\s*(?:export\s+)?(ELEVENLABS_API_KEYS?(?:_\d+)?|ELEVEN_API_KEY|XI_API_KEY|api[_-]?key)\s*[=:]\s*['\"]?([^'\"#]+?)['\"]?\s*(?:#.*)?$", re.I)
SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _split(v):
    return [x for x in re.split(r"[,\s]+", v or "") if re.fullmatch(r"[A-Za-z0-9_\-]{20,}", x)]


def _keys_from_text(txt):
    out = [k for ln in txt.splitlines() for m in [KEY_RE.match(ln)] if m for k in _split(m.group(2))]
    t = txt.strip()
    return out or ([t] if re.fullmatch(r"[A-Za-z0-9_\-]{20,}", t) else [])


_POOL = []          # [(key, source)] in priority order
_DEAD = set()       # keys refused for credits / validity during this run


def all_keys():
    """Every key found, in priority order, as [(key, source)]. Cached for the run."""
    if _POOL:
        return _POOL
    seen = set()
    def add(ks, src):
        for k in ks:
            k = k.strip()
            if k and k not in seen:
                seen.add(k); _POOL.append((k, src))
    add(_split(os.environ.get("ELEVENLABS_API_KEYS")), "$ELEVENLABS_API_KEYS")
    add(_split(os.environ.get("ELEVENLABS_API_KEY")), "$ELEVENLABS_API_KEY")
    for i in range(2, 10):
        add(_split(os.environ.get("ELEVENLABS_API_KEY_%d" % i)), "$ELEVENLABS_API_KEY_%d" % i)
    for p in ("./.env", os.path.join(SKILL_DIR, ".env"), "~/.elevenlabs", "~/.config/elevenlabs", "~/.elevenlabs/api_key", "~/.config/elevenlabs/api_key"):
        p = os.path.abspath(os.path.expanduser(p))
        if os.path.isfile(p):
            try:
                add(_keys_from_text(open(p).read()), p)
            except OSError:
                pass
    return _POOL


def mask(k):
    return "key #%d (...%s)" % (next((i + 1 for i, (x, _) in enumerate(all_keys()) if x == k), 0), k[-4:])


def get_key(required=True):
    """The first key not yet refused for credits; http() moves on to the next keys by itself when a request is refused."""
    live = [k for k, _ in all_keys() if k not in _DEAD]
    if live:
        return live[0]
    if required:
        die(NOKEY, 3)
    return None


class ApiError(Exception):
    def __init__(self, msg, code=1, status=""):
        super().__init__(msg)
        self.code = code
        self.status = status          # ElevenLabs detail.status, e.g. quota_exceeded, invalid_api_key, missing_permissions


DEAD_STATUS = ("quota_exceeded", "invalid_api_key", "insufficient", "payment")


def _http1(method, url, data, key, raw, retries):
    hdr = {"xi-api-key": key or "", "User-Agent": "motionmaxxing/1.0", "Accept": "*/*"}
    if data is not None:
        hdr["Content-Type"] = "application/json"
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=data, headers=hdr, method=method)
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                out = r.read()
                return out if raw else json.loads(out.decode() or "{}")
        except urllib.error.HTTPError as e:
            txt, status = e.read().decode("utf-8", "replace"), ""
            try:
                j = json.loads(txt)
                d = j.get("detail", j)
                if isinstance(d, dict):
                    status = str(d.get("status") or d.get("code") or "")
                txt = d.get("message") if isinstance(d, dict) and d.get("message") else json.dumps(d)
            except ValueError:
                pass
            if e.code in (429, 500, 502, 503) and attempt < retries:
                time.sleep(2 * (attempt + 1))
                continue
            hint = {401: " (invalid key or key lacks this permission)", 402: " (needs a paid plan / credits)",
                    403: " (forbidden: plan or key permission)", 422: " (bad request parameters)", 429: " (rate/concurrency limit)"}.get(e.code, "")
            raise ApiError("ElevenLabs HTTP %d%s: %s" % (e.code, hint, txt[:500]), e.code, status)
        except urllib.error.URLError as e:
            if attempt < retries:
                time.sleep(2)
                continue
            raise ApiError("network error: %s" % e.reason)


def http(method, path, body=None, key=None, raw=False, retries=2, quiet=False):
    """One API call. When the key is refused (401/402/403) the next held key is tried; a key refused for credits or
    validity is skipped for the rest of the run. Raises the last refusal when every key has been tried."""
    url = path if path.startswith("http") else API + path
    data = json.dumps(body).encode() if body is not None else None
    pool = [k for k, _ in all_keys()]
    if key in _DEAD:
        key = get_key()
    order = ([key] if key else []) + [k for k in pool if k != key and k not in _DEAD]
    last = None
    for i, k in enumerate(order):
        try:
            out = _http1(method, url, data, k, raw, retries)
            if i and not quiet:
                print("keys: %s worked" % mask(k), file=sys.stderr)
            return out
        except ApiError as e:
            if e.code not in (401, 402, 403) or k not in pool:
                raise
            last = e
            dead = e.code == 402 or any(s in (e.status + " " + str(e)).lower() for s in DEAD_STATUS + ("exceeds your quota",))
            if dead:
                _DEAD.add(k)
            nxt = next((x for x in order[i + 1:] if x not in _DEAD), None)
            if not quiet:
                print("keys: %s refused (%s%s)%s" % (mask(k), e.status or "HTTP %d" % e.code, ", skipped for this run" if dead else "",
                      "; trying %s" % mask(nxt) if nxt else "; no other key left"), file=sys.stderr)
    raise last


def cmd_keys(a):
    ks = all_keys()
    if not ks:
        die(NOKEY, 3)
    for i, (k, src) in enumerate(ks):
        line = "key #%d  ...%s  %s" % (i + 1, k[-4:], src)
        try:
            sub = _http1("GET", API + "/v1/user/subscription", None, k, False, 1)
            used, lim = sub.get("character_count", 0), sub.get("character_limit", 0)
            reset = sub.get("next_character_count_reset_unix")
            when = time.strftime("%Y-%m-%d", time.localtime(reset)) if reset else "?"
            line += "  %s  %d / %d credits left, resets %s" % (sub.get("tier", "?"), max(0, lim - used), lim, when)
        except ApiError as e:
            line += "  credits unknown (%s)" % (e.status or "HTTP %s" % e.code)
        print(line)


def write(path, data):
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def jwrite(path, obj):
    write(path, (json.dumps(obj, indent=1, ensure_ascii=False) + "\n").encode())


# ---------------------------------------------------------------- voices
def list_voices(key):
    return http("GET", "/v1/voices", key=key, quiet=True).get("voices", [])


# ElevenLabs premade voices (stable public IDs) - used when the key cannot list voices (no voices_read permission)
BUILTIN = {"brian": "nPczCjzI2devNBz1zQrb", "daniel": "onwK4e9ZLuTAKqWW03F9", "adam": "pNInz6obpgDQGcFmaJgB",
           "sarah": "EXAVITQu4vr4xnSDxMaL", "river": "SAz9YHcvj6GT2YYXdXww", "george": "JBFqnCBsd6RMkjVDRZzb",
           "roger": "CwhRBWXzGAHq8TQ4Fs17"}


def resolve_voice(key, want):
    try:
        vs = list_voices(key)
    except ApiError as e:
        print("warn: cannot list voices (HTTP %s, key lacks voices_read?); using built-in premade voice table" % e.code, file=sys.stderr)
        n = (want or "brian").lower()
        if n in BUILTIN:
            return BUILTIN[n], n.capitalize() + " (built-in id)"
        if want and re.fullmatch(r"[A-Za-z0-9]{16,}", want):
            return want, "(id as given)"
        die("voice '%s' unknown and the key cannot list voices; pass a voice id" % want, 2)
    if want:
        for v in vs:
            if v["voice_id"] == want or v["name"].lower() == want.lower() or v["name"].lower().startswith(want.lower() + " ") or v["name"].lower().startswith(want.lower() + " -"):
                return v["voice_id"], v["name"]
        if re.fullmatch(r"[A-Za-z0-9]{16,}", want):
            return want, "(id as given)"
        die("voice '%s' not found in this account (run: voice.py voices)" % want)
    names = {v["name"].split(" - ")[0].split()[0].lower(): v for v in vs}
    for n in PREFERRED:
        if n.lower() in names:
            v = names[n.lower()]
            return v["voice_id"], v["name"]
    if vs:
        return vs[0]["voice_id"], vs[0]["name"]
    die("account has no voices")


def cmd_voices(a):
    key = get_key()
    for v in sorted(list_voices(key), key=lambda v: (v.get("category") or "", v["name"])):
        lab = v.get("labels") or {}
        tags = ",".join(str(lab[k]) for k in ("gender", "age", "accent", "descriptive", "use_case") if lab.get(k))
        print("%s  %-28s %-10s %s" % (v["voice_id"], v["name"][:28], v.get("category", ""), tags))


# ---------------------------------------------------------------- timings
def words_from_alignment(text, al):
    ch, st, en = al["characters"], al["character_start_times_seconds"], al["character_end_times_seconds"]
    words, cur = [], None
    for i, c in enumerate(ch):
        if c.isspace():
            if cur:
                words.append(cur)
                cur = None
            continue
        if cur is None:
            cur = {"word": c, "start": st[i], "end": en[i], "_i0": i, "_i1": i}
        else:
            cur["word"] += c
            cur["end"] = en[i]
            cur["_i1"] = i
    if cur:
        words.append(cur)
    return words  # _i0/_i1 are char offsets into the text actually spoken


def split_spans(text):
    """Return [(i0,i1)] spans of lines; if only one line, sentences."""
    lines = [(m.start(), m.end()) for m in re.finditer(r"[^\n]+", text) if m.group().strip()]
    if len(lines) > 1:
        return lines
    spans = []
    for m in re.finditer(r"[^.!?…\n]+(?:[.!?…]+[\"')\]]*|$)", text):
        if m.group().strip():
            spans.append((m.start(), m.end()))
    return spans or lines


def lines_from_words(text, words):
    out = []
    for i0, i1 in split_spans(text):
        ws = [w for w in words if w["_i0"] >= i0 and w["_i1"] < i1 + 1 and w["_i1"] >= i0]
        if ws:
            out.append({"text": text[i0:i1].strip(), "start": ws[0]["start"], "end": ws[-1]["end"]})
    return out


def clean_words(ws, est=False):
    r = []
    for w in ws:
        d = {"word": w["word"], "start": round(w["start"], 3), "end": round(w["end"], 3)}
        if est:
            d["est"] = True
        r.append(d)
    return r


# ---------------------------------------------------------------- vo
def get_text(a):
    if a.script:
        if not os.path.isfile(a.script):
            die("script not found: " + a.script, 2)
        t = open(a.script, encoding="utf-8").read()
    elif a.text:
        t = a.text
    else:
        die("give --text or --script", 2)
    t = re.sub(r"[ \t]+\n", "\n", t.strip().replace("\r", ""))
    t = re.sub(r"\n{3,}", "\n\n", t)
    if not t:
        die("empty text", 2)
    return t


def stem(out):
    return os.path.splitext(out)[0]


def cmd_vo(a):
    text = get_text(a)
    key = get_key()
    vid, vname = resolve_voice(key, a.voice)
    print("voice: %s (%s)  model: %s" % (vname, vid, a.model), file=sys.stderr)
    wav = a.out.lower().endswith(".wav")
    fmt = "pcm_44100" if wav else "mp3_44100_128"
    body = {"text": text, "model_id": a.model,
            "voice_settings": {"stability": a.stability, "similarity_boost": a.similarity, "style": a.style, "use_speaker_boost": True, "speed": a.speed}}
    if os.path.exists(a.out) and not a.force and os.path.exists(stem(a.out) + ".words.json"):
        die("%s exists (use --force to spend credits regenerating)" % a.out)
    r = http("POST", "/v1/text-to-speech/%s/with-timestamps?output_format=%s" % (vid, fmt), body, key)
    audio = base64.b64decode(r["audio_base64"])
    al = r.get("alignment") or r.get("normalized_alignment")
    if not al:
        die("response had no alignment")
    if wav:
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        with wave.open(a.out, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100); w.writeframes(audio)
    else:
        write(a.out, audio)
    words = words_from_alignment(text, al)
    wl, ll = clean_words(words), lines_from_words(text, words)
    if not a.no_refine and shutil.which("ffmpeg"):
        wl, ll = refine_timings(wl, ll, speech_regions(a.out))
    jwrite(stem(a.out) + ".words.json", wl)
    jwrite(stem(a.out) + ".lines.json", ll)
    dur = al["character_end_times_seconds"][-1]
    print("%s  (%.2fs, %d words, %d lines) -> %s.words.json, %s.lines.json%s" % (a.out, dur, len(words), len(ll), stem(a.out), stem(a.out), "" if a.no_refine else "  (refined to audible speech; raw_start/raw_end kept)"))
    if not a.no_refine:
        report_refine(ll)


# ---------------------------------------------------------------- audio analysis helpers (ffmpeg)
def need_ffmpeg():
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        die("ffmpeg/ffprobe not found")


def ffq(args):
    return subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-y"] + args, capture_output=True, text=True)


def silences(path, noise_db=-40, d=0.08):
    """[(start, end)] of silence (ffmpeg silencedetect); a silence running to EOF ends at the file duration."""
    dur = probe_duration(path)
    r = ffq(["-i", path, "-af", "silencedetect=n=%sdB:d=%s" % (noise_db, d), "-f", "null", "-"])
    out, cur = [], None
    for m in re.finditer(r"silence_(start|end): (-?[\d.]+)", r.stderr):
        v = max(0.0, float(m.group(2)))
        if m.group(1) == "start":
            cur = v
        elif cur is not None:
            out.append((cur, v)); cur = None
    if cur is not None:
        out.append((cur, dur))
    return out, dur


def speech_regions(path, noise_db=-40, d=0.08, edge_d=0.01):
    """[(onset, offset)] of audible speech. Gaps are silences >= d; the file's own leading/trailing silence counts from edge_d (so a
    47 ms lead-in is found, which d=0.08 alone would miss)."""
    sil, dur = silences(path, noise_db, edge_d)
    gaps = []
    for s0, e0 in sil:
        edge = s0 <= 0.001 or e0 >= dur - 0.001
        if edge or e0 - s0 >= d:
            gaps.append((s0, e0))
    regs, t = [], 0.0
    for s0, e0 in gaps:
        if s0 - t > 0.02:
            regs.append((t, s0))
        t = max(t, e0)
    if dur - t > 0.02:
        regs.append((t, dur))
    return regs


def refine_timings(words, lines, regs):
    """Snap word/line starts to the speech onset and ends to the speech offset (only ever moves inward); keeps raw_start/raw_end."""
    def snap(it):
        rs = it.get("raw_start", it["start"]); re_ = it.get("raw_end", it["end"])
        ov = [(a, b) for a, b in regs if min(b, re_) - max(a, rs) > 0.015]
        s0, e0 = rs, re_
        if ov:
            s0, e0 = max(rs, ov[0][0]), min(re_, ov[-1][1])
            if e0 - s0 < 0.02:
                s0, e0 = rs, re_
        d = dict(it)
        d.update({"start": round(s0, 3), "end": round(e0, 3), "raw_start": round(rs, 3), "raw_end": round(re_, 3)})
        return d
    L = [snap(l) for l in lines]
    W = [snap(w) for w in words]
    for w in W:  # keep words inside their refined line (sync.mjs matches words to lines by containment)
        mid = (w["raw_start"] + w["raw_end"]) / 2
        for l in L:
            if l["raw_start"] - 0.001 <= mid <= l["raw_end"] + 0.001:
                w["start"], w["end"] = round(max(w["start"], l["start"]), 3), round(min(w["end"], l["end"]), 3)
                if w["end"] < w["start"]:
                    w["end"] = w["start"]
                break
    return W, L


def report_refine(lines):
    for i, l in enumerate(lines, 1):
        print("  line %d  %.3f-%.3f  (raw %.3f-%.3f, start %+.0f ms, end %+.0f ms)  %s" % (
            i, l["start"], l["end"], l["raw_start"], l["raw_end"], (l["start"] - l["raw_start"]) * 1000, (l["end"] - l["raw_end"]) * 1000, l["text"][:44]))


def cmd_refine(a):
    need_ffmpeg()
    wf = a.words or stem(a.vo) + ".words.json"
    lf = a.lines or stem(a.vo) + ".lines.json"
    for f in (a.vo, wf, lf):
        if not os.path.isfile(f):
            die("not found: " + f, 2)
    words, lines = json.load(open(wf)), json.load(open(lf))
    regs = speech_regions(a.vo)
    W, L = refine_timings(words, lines, regs)
    jwrite(wf, W)
    jwrite(lf, L)
    print("%d speech regions: %s" % (len(regs), "  ".join("%.3f-%.3f" % r for r in regs)))
    report_refine(L)


# ---------------------------------------------------------------- split
def cmd_split(a):
    need_ffmpeg()
    for f in (a.vo, a.lines):
        if not os.path.isfile(f):
            die("not found: " + f, 2)
    lines = json.load(open(a.lines))
    dur = probe_duration(a.vo)
    regs = speech_regions(a.vo)
    _, lines = refine_timings([], lines, regs)       # idempotent: clamps to speech (uses raw_start/raw_end when present)
    os.makedirs(a.out, exist_ok=True)
    pad, fade = a.pad, 0.008
    index = []
    for i, l in enumerate(lines, 1):
        s0, e0 = max(0.0, l["start"] - pad), min(dur, l["end"] + pad)
        clip = os.path.join(a.out, "line%02d.wav" % i)
        d = e0 - s0
        r = ffq(["-i", a.vo, "-af", "atrim=%.4f:%.4f,asetpts=PTS-STARTPTS,afade=t=in:d=%s,afade=t=out:st=%.4f:d=%s" % (s0, e0, fade, max(0.0, d - fade), fade),
                 "-c:a", "pcm_s16le", clip])
        if r.returncode:
            die("ffmpeg failed on line %d:\n%s" % (i, r.stderr[-600:]))
        index.append({"i": i, "text": l["text"], "clip": clip, "dur": round(probe_duration(clip), 3), "lead": round(l["start"] - s0, 3),
                      "start": l["start"], "end": l["end"]})
    jwrite(os.path.join(a.out, "lines.index.json"), index)
    print("%d clips -> %s  (+ lines.index.json)" % (len(index), a.out))
    for x in index:
        print("  line%02d  dur %.3fs  lead %.3fs  source %.3f-%.3f  %s" % (x["i"], x["dur"], x["lead"], x["start"], x["end"], x["text"][:44]))
    print("place: mix.py --vo %s@<beat_time - lead> (repeatable); node sync.mjs prints the onset frames" % os.path.join(a.out, "line01.wav"))


# ---------------------------------------------------------------- sfx
def peak_db(path):
    """sample peak in dBFS (float domain, so a clipped-on-decode file reads above 0)"""
    r = ffq(["-i", path, "-af", "astats=metadata=1,ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-", "-f", "null", "-"])
    v = re.findall(r"Peak_level=(-?[\d.]+|-inf)", r.stdout)
    return float(v[-1]) if v and v[-1] != "-inf" else None


def lufs_of(path):
    r = ffq(["-i", path, "-af", "ebur128=peak=true", "-f", "null", "-"])
    s = r.stderr[r.stderr.rfind("Summary:"):]
    m = re.search(r"I:\s+(-?[\d.]+) LUFS", s)
    if not m or float(m.group(1)) <= -69.9:
        return None
    return float(m.group(1))


def normalize_sfx(path, peak=-3.0, keep_raw=False):
    """Trim leading silence and peak-normalise `path` in place to `peak` dBFS (re-measured after the mp3 encode and corrected). Prints peak/LUFS."""
    need_ffmpeg()
    pk = peak_db(path)
    if pk is None:
        print("warn: %s is silent; left untouched" % path, file=sys.stderr)
        return
    sil, _ = silences(path, -50, 0.004)
    lead = sil[0][1] if sil and sil[0][0] <= 0.001 else 0.0
    gain = peak - pk
    if abs(gain) < 0.3 and lead < 0.01:
        print("%s  peak %.1f dBFS  LUFS %s  (already normalised)" % (path, pk, fmt_lufs(lufs_of(path))))
        return
    base, ext = os.path.splitext(path)
    if keep_raw:
        shutil.copyfile(path, base + ".raw" + ext)
    tmp = base + ".norm.tmp" + ext
    codec = ["-c:a", "pcm_s16le"] if ext.lower() == ".wav" else (["-c:a", "libmp3lame", "-q:a", "2", "-ar", "44100"] if ext.lower() == ".mp3" else [])
    def encode(g):
        af = "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.003:start_duration=0.004,volume=%.3fdB" % g
        r = ffq(["-i", path, "-af", af] + codec + [tmp])
        if r.returncode:
            die("ffmpeg failed normalising %s:\n%s" % (path, r.stderr[-500:]))
        return peak_db(tmp)
    best = None                              # the mp3 encoder moves a transient's peak by up to ~1 dB: measure, correct, keep the closest
    for k in range(6):
        got = encode(gain)
        if got is None:
            break
        if best is None or abs(got - peak) < abs(best[1] - peak):
            best = (gain, got)
        if abs(got - peak) <= 0.15:
            break
        gain -= (got - peak) * (1.0 if k < 3 else 0.5)
        gain += 0.07 * (k % 2)               # nudge off a quantisation plateau
    if best and best[0] != gain:
        encode(best[0])
    gain, got = best if best else (gain, None)
    os.replace(tmp, path)
    print("%s  peak %.1f dBFS  LUFS %s  (gain %+.1f dB, trimmed %.0f ms lead%s)" % (path, got if got is not None else 0.0, fmt_lufs(lufs_of(path)), gain, lead * 1000, ", raw kept" if keep_raw else ""))


def fmt_lufs(v):
    return "n/a(<0.4 s)" if v is None else "%.1f" % v


def sfx_one(key, prompt, seconds, out, influence, force, norm=True, peak=-3.0, keep_raw=False):
    if os.path.exists(out) and not force:
        print("skip (exists): " + out, file=sys.stderr)
        return
    body = {"text": prompt, "prompt_influence": influence}
    if seconds:
        body["duration_seconds"] = max(0.5, min(30.0, float(seconds)))
    write(out, http("POST", "/v1/sound-generation?output_format=mp3_44100_128", body, key, raw=True))
    print("%s  (%s)" % (out, prompt[:50]))
    if norm:
        normalize_sfx(out, peak, keep_raw)


def cmd_sfx(a):
    return with_source("sfx", a, eleven_sfx)


def eleven_sfx(a):
    key = get_key()
    norm = not a.no_normalize
    if a.batch:
        items = json.load(open(a.batch))
        os.makedirs(a.out, exist_ok=True)
        for it in items:
            sfx_one(key, it["prompt"], it.get("seconds"), os.path.join(a.out, "%s.mp3" % it["id"]), a.influence, a.force, norm, a.peak, a.keep_raw)
    elif a.prompt:
        sfx_one(key, a.prompt, a.seconds, a.out, a.influence, a.force, norm, a.peak, a.keep_raw)
    else:
        die("give --prompt or --batch", 2)


def cmd_sfx_norm(a):
    files = [f for pat in a.inp for f in (sorted(glob.glob(pat)) or [pat])]
    for f in files:
        if not os.path.isfile(f):
            die("not found: " + f, 2)
        if ".raw." in os.path.basename(f):
            continue
        normalize_sfx(f, a.peak, a.keep_raw)


# ---------------------------------------------------------------- music
def rms_env(path, win=0.02, start=0.0, end=None):
    """per-window RMS in dBFS (mono, 22.05 kHz) -> (list_of_dB, win_seconds). -inf for digital silence."""
    n = max(1, int(round(22050 * win)))
    sel = ""
    if start > 0 or end is not None:
        sel = "atrim=%s%s,asetpts=PTS-STARTPTS," % (start, ":%s" % end if end is not None else "")
    r = ffq(["-i", path, "-af", sel + "aresample=22050,aformat=channel_layouts=mono,asetnsamples=n=%d:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-" % n, "-f", "null", "-"])
    env = []
    for m in re.finditer(r"RMS_level=(-?[\d.]+|-inf|nan)", r.stdout):
        v = m.group(1)
        env.append(float(v) if v not in ("-inf", "nan") else -120.0)
    return env, n / 22050.0


def audible_span(env, win, total, rel_db=12.0, floor_db=-55.0):
    """Audible part = windows within rel_db of the loud level (90th percentile), >= 3 consecutive windows. -> dict or None"""
    fin = sorted(v for v in env if v > -119)
    if not fin:
        return None
    ref = fin[int(0.9 * (len(fin) - 1))]
    thr = max(ref - rel_db, floor_db)
    ok = [v >= thr for v in env]
    first = next((i for i in range(len(ok) - 2) if ok[i] and ok[i + 1] and ok[i + 2]), None)
    last = next((i for i in range(len(ok) - 1, 1, -1) if ok[i] and ok[i - 1] and ok[i - 2]), None)
    if first is None or last is None:
        return None
    start, end = first * win, min(total, (last + 1) * win)
    return {"start": start, "end": end, "audible": end - start, "lead": start, "trail": max(0.0, total - end), "ref_db": ref, "thr_db": thr, "total": total}


def music_report(path, requested=None, label="music"):
    need_ffmpeg()
    total = probe_duration(path)
    env, win = rms_env(path)
    sp = audible_span(env, win, total)
    if not sp:
        print("WARNING: %s is silent (no audible audio found in %s)" % (label, path), file=sys.stderr)
        return None
    req = requested if requested else total
    print("audible span  %.2f-%.2f s  (%.2f s audible of %.2f s file%s; loud level %.1f dBFS RMS, counted down to %.1f)" % (
        sp["start"], sp["end"], sp["audible"], total, ", %.2f s requested" % requested if requested else "", sp["ref_db"], sp["thr_db"]))
    sys.stdout.flush()
    bad = []
    if sp["lead"] > 0.5:
        bad.append("leading silence %.2f s" % sp["lead"])
    if sp["trail"] > 1.0:
        bad.append("trailing silence %.2f s" % sp["trail"])
    if sp["audible"] < 0.85 * req:
        bad.append("audible %.0f%% of the requested %.1f s" % (100 * sp["audible"] / req, req))
    if bad:
        me = os.path.abspath(__file__)
        fit = os.path.splitext(path)[0] + "_fit.wav"
        print("WARNING: %s: %s. Audible span is %.2f-%.2f s." % (path, "; ".join(bad), sp["start"], sp["end"]), file=sys.stderr)
        print("  fix (loops the audible bars to the film length; change --duration):  python3 %s music-fit --in %s --out %s --duration %.1f --loop-bars" % (me, path, fit, req), file=sys.stderr)
        print("  or just trim:                                        ffmpeg -ss %.2f -i %s -t %.2f -c:a pcm_s16le %s_trim.wav" % (sp["start"], path, sp["audible"], os.path.splitext(path)[0]), file=sys.stderr)
    return sp


def estimate_bpm(path, start, end):
    """Tempo from the onset envelope (5 ms RMS windows), autocorrelation 70-190 BPM, refined over several beats. -> bpm or None"""
    env, win = rms_env(path, 0.005, start, end)
    if len(env) < 400:
        return None
    lin = [10 ** (v / 20) for v in env]
    on = [max(0.0, lin[i] - lin[i - 1]) for i in range(1, len(lin))]
    mean = sum(on) / len(on)
    on = [v - mean for v in on]
    N = len(on)

    def ac(lag):
        return sum(on[i] * on[i + lag] for i in range(N - lag)) / (N - lag)
    lo, hi = int(60 / 190 / win), int(60 / 70 / win)
    best, bl = -1e18, None
    for lag in range(lo, hi + 1):
        w = math.exp(-0.5 * (math.log2((60 / (lag * win)) / 120.0) / 0.6) ** 2)   # mild prior around 120 BPM
        v = ac(lag) * w
        if v > best:
            best, bl = v, lag
    if bl is None:
        return None
    beat = bl * win
    for m in (8, 16, 32):                       # refine: the peak near m beats, divided by m
        if m * beat > (N * win) / 2:
            break
        c = int(round(m * bl))
        span = max(2, int(round(c * 0.03)))
        vals = {l: ac(l) for l in range(c - span, c + span + 1)}
        lb = max(vals, key=vals.get)
        if c - span < lb < c + span:             # parabolic peak
            y0, y1, y2 = vals[lb - 1], vals[lb], vals[lb + 1]
            den = y0 - 2 * y1 + y2
            frac = 0.5 * (y0 - y2) / den if den else 0.0
            beat = (lb + frac) * win / m
            bl = beat / win
    return 60.0 / beat


def cmd_music_check(a):
    if not os.path.isfile(a.inp):
        die("not found: " + a.inp, 2)
    music_report(a.inp, a.ms / 1000.0 if a.ms else None)


def cmd_music_fit(a):
    need_ffmpeg()
    if not os.path.isfile(a.inp):
        die("not found: " + a.inp, 2)
    D = a.duration
    if D <= 0.5:
        die("--duration must be > 0.5", 2)
    total = probe_duration(a.inp)
    sp = music_report(a.inp)
    if not sp:
        die("no audible audio in " + a.inp)
    s0, e0 = sp["start"], sp["end"]
    xf, tail = a.xfade, min(a.tail, D / 2)
    L = e0 - s0
    bpm = None
    if a.loop_bars:
        bpm = a.bpm or estimate_bpm(a.inp, s0, e0)
        if bpm:
            bar = 60.0 / bpm * a.beats_per_bar
            bars = int(L // bar)
            if bars >= 1:
                L = bars * bar
                print("tempo %.1f BPM (%s)  bar %.3f s  loop = %d bar%s = %.3f s from %.2f s (audible start taken as the downbeat)" % (bpm, "given" if a.bpm else "estimated", bar, bars, "" if bars == 1 else "s", L, s0))
            else:
                print("warn: audible section (%.2f s) is shorter than one bar (%.2f s); looping without bar snapping" % (L, bar), file=sys.stderr)
                L -= xf
        else:
            print("warn: could not estimate the tempo; looping without bar snapping (pass --bpm)", file=sys.stderr)
            L -= xf
    else:
        L -= xf
    L = max(L, 0.25)
    xf = min(xf, L / 2, max(0.0, total - s0 - L))      # the tail extension has to exist in the source
    K = 1 if (e0 - s0) >= D else int(math.ceil(max(0.0, D - xf) / L))
    if K == 1:
        graph = "[0:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=%.4f:%.4f,asetpts=PTS-STARTPTS,afade=t=in:d=0.01" % (s0, s0 + D)
    else:
        parts = ["[0:a]aformat=sample_rates=48000:channel_layouts=stereo,asplit=%d%s" % (K, "".join("[s%d]" % k for k in range(K)))]
        for k in range(K):
            f = "[s%d]atrim=%.4f:%.4f,asetpts=PTS-STARTPTS" % (k, s0, s0 + L + xf)
            if k == 0:
                f += ",afade=t=in:d=0.01"
            elif xf > 0.005:
                f += ",afade=t=in:d=%.4f:curve=qsin" % xf
            if k < K - 1 and xf > 0.005:
                f += ",afade=t=out:st=%.4f:d=%.4f:curve=qsin" % (L, xf)
            if k > 0:
                f += ",adelay=%d:all=1" % round(k * L * 1000)
            parts.append(f + "[p%d]" % k)
        parts.append("%samix=inputs=%d:normalize=0:duration=longest" % ("".join("[p%d]" % k for k in range(K)), K))
        graph = ";".join(parts)
    graph += ",apad=whole_dur=%.4f,atrim=0:%.4f,asetpts=PTS-STARTPTS,afade=t=out:st=%.4f:d=%.4f" % (D, D, D - tail, tail)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    if os.environ.get("VOICE_DEBUG"):
        print(graph, file=sys.stderr)
    r = ffq(["-i", a.inp, "-filter_complex", graph + "[o]", "-map", "[o]", "-ar", "48000", "-c:a", "pcm_s16le", a.out])
    if r.returncode:
        die("ffmpeg failed:\n" + r.stderr[-1200:])
    got = probe_duration(a.out)
    env, win = rms_env(a.out, 0.1)
    body = [v for v in env[:int(max(0, D - tail - 0.3) / win)] if v > -119]
    med = sorted(body)[len(body) // 2] if body else -120
    print("%s  %.3f s (asked %.3f)  %d section%s of %.2f s, crossfade %.0f ms, tail fade %.1f s;  RMS (100 ms windows) min %.1f / median %.1f dBFS%s" % (
        a.out, got, D, K, "" if K == 1 else "s", L, xf * 1000, tail, min(body) if body else -120, med,
        "  [dip %.1f dB]" % (med - min(body)) if body and med - min(body) > 6 else ""))
    if abs(got - D) > 0.002:
        print("warn: output length %.4f differs from the requested %.4f" % (got, D), file=sys.stderr)


# ---------------------------------------------------------------- native fallback (scripts/score.mjs)
PLAN_REFUSED = (401, 402, 403)


def native_render(kind, a, reason=None):
    """Render music or the sfx stem locally from the film's score.json. kind: 'music' | 'sfx'."""
    if not getattr(a, "score", None):
        die("%snative %s needs --score audio/score.json (make it with: node scripts/score.mjs plan --events <render>.events.json "
            "--duration S --hero <frame> --mood <mood> --vo-wav <vo stem>)" % ("ElevenLabs unavailable (%s); " % reason if reason else "", kind), 4 if reason else 2)
    node = os.environ.get("NODE_BIN") or shutil.which("node")
    if not node:
        die("native %s needs Node 18+ (set NODE_BIN)" % kind, 2)
    score = os.path.join(os.path.dirname(os.path.abspath(__file__)), "score.mjs")
    out = a.out
    if kind == "music":
        if not out.lower().endswith(".wav"):
            out = os.path.splitext(out)[0] + ".native.wav"
        cmd = [node, score, "render", a.score, "--music-out", out, "--sfx-out", "none"]
    else:
        if not out.lower().endswith(".wav"):
            out = os.path.join(out, "sfx.native.wav")
        cmd = [node, score, "render", a.score, "--music-out", "none", "--sfx-out", out]
    if reason:
        print("FALLBACK %s: native (%s) -> %s" % (kind, reason, out), file=sys.stderr)
    r = subprocess.run(cmd)
    if r.returncode:
        die("score.mjs failed (%d)" % r.returncode, r.returncode)


def with_source(kind, a, eleven):
    """Run the ElevenLabs path, the native path, or ElevenLabs with a per-kind native fallback."""
    src = getattr(a, "source", "elevenlabs")
    if src == "native":
        return native_render(kind, a)
    if src == "elevenlabs":
        return eleven(a)
    try:
        return eleven(a)
    except SystemExit as e:
        if e.code == 3:
            return native_render(kind, a, "no ElevenLabs key")
        raise
    except ApiError as e:
        if e.code in PLAN_REFUSED:
            return native_render(kind, a, "ElevenLabs HTTP %d: the key or plan does not allow %s" % (e.code, kind))
        raise


def cmd_music(a):
    return with_source("music", a, eleven_music)


def eleven_music(a):
    body = {"model_id": "music_v1"}
    plan_ms = None
    if a.plan:
        body["composition_plan"] = json.load(open(a.plan))
        try:
            plan_ms = sum(float(s["duration_ms"]) for s in body["composition_plan"]["sections"])
        except (KeyError, TypeError, ValueError):
            plan_ms = None
    else:
        if not a.prompt:
            die("give --prompt or --plan", 2)
        if not 3000 <= a.ms <= 600000:
            die("--ms must be 3000..600000", 2)
        body.update({"prompt": a.prompt, "music_length_ms": a.ms, "force_instrumental": not a.vocals})
    url = "/v1/music?output_format=mp3_44100_128"
    if a.dry_run:
        print(json.dumps({"method": "POST", "url": API + url, "headers": {"xi-api-key": "<masked>", "Content-Type": "application/json"}, "body": body}, indent=2))
        return
    key = get_key()
    if os.path.exists(a.out) and not a.force:
        die("%s exists (use --force to spend credits regenerating)" % a.out)
    write(a.out, http("POST", url, body, key, raw=True))
    req = (plan_ms if a.plan else a.ms)
    print("%s  (%s)" % (a.out, "plan" if a.plan else "%.1fs" % (a.ms / 1000)))
    if shutil.which("ffmpeg"):
        music_report(a.out, req / 1000.0 if req else None)


# ---------------------------------------------------------------- local fallback
def syllables(w):
    w = re.sub(r"[^a-z0-9']", "", w.lower())
    if not w:
        return 0.5
    if w.isdigit():
        return max(1, len(w) * 1.5)
    n = len(re.findall(r"[aeiouy]+", w))
    if w.endswith("e") and not w.endswith(("le", "ee")) and n > 1:
        n -= 1
    return max(1, n)


def probe_duration(f):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        die("ffprobe failed on " + f)


def speech_segments(wavf, dur):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", wavf, "-af", "silencedetect=n=-38dB:d=0.12", "-f", "null", "-"], capture_output=True, text=True)
    sil, cur = [], None
    for m in re.finditer(r"silence_(start|end): ([\d.]+)", r.stderr):
        v = float(m.group(2))
        if m.group(1) == "start":
            cur = v
        elif cur is not None:
            sil.append((cur, v)); cur = None
    if cur is not None:
        sil.append((cur, dur))
    seg, t = [], 0.0
    for s, e in sorted(sil):
        if s - t > 0.03:
            seg.append((t, s))
        t = max(t, e)
    if dur - t > 0.03:
        seg.append((t, dur))
    return seg or [(0.0, dur)]


def estimate_words(text, segs):
    toks = [(m.group(), m.start(), m.end()) for m in re.finditer(r"\S+", text)]
    wts = [syllables(t[0]) for t in toks]
    # phrases: break after , ; : . ! ? or newline
    phrases, cur = [], []
    for i, (t, i0, i1) in enumerate(toks):
        cur.append(i)
        nl = "\n" in text[i1:i1 + 2] if i1 < len(text) else True
        if re.search(r"[,;:.!?…]['\")\]]*$", t) or nl:
            phrases.append(cur); cur = []
    if cur:
        phrases.append(cur)
    out = [None] * len(toks)
    pw = [sum(wts[i] for i in ph) for ph in phrases]
    P, G = len(phrases), len(segs)
    if P >= G:  # DP: split phrases into G consecutive groups whose weight share best matches each segment's duration share
        tw, td = sum(pw), sum(e - s for s, e in segs)
        pre = [0.0]
        for w in pw:
            pre.append(pre[-1] + w)
        INF = float("inf")
        best = [[INF] * (P + 1) for _ in range(G + 1)]
        cut = [[0] * (P + 1) for _ in range(G + 1)]
        best[0][0] = 0.0
        for g in range(1, G + 1):
            gd = (segs[g - 1][1] - segs[g - 1][0]) / td
            for j in range(g, P + 1):
                for i in range(g - 1, j):
                    c = best[g - 1][i] + abs((pre[j] - pre[i]) / tw - gd)
                    if c < best[g][j]:
                        best[g][j], cut[g][j] = c, i
        groups, j = [], P
        for g in range(G, 0, -1):
            i = cut[g][j]
            groups.append([k for ph in phrases[i:j] for k in ph]); j = i
        groups.reverse()
        for idxs, (s, e) in zip(groups, segs):
            tot = sum(wts[i] for i in idxs); t = s
            for i in idxs:
                d = (e - s) * wts[i] / tot
                out[i] = (t, t + d); t += d
    else:  # fewer phrases than pauses: place words on the concatenated speech timeline, map back through the segments
        tot_sp = sum(e - s for s, e in segs); tot_w = sum(wts); acc = 0.0
        def back(x, is_end):
            for s, e in segs:
                if x < e - s - 1e-9 or (is_end and x <= e - s + 1e-9):
                    return s + x
                x -= e - s
            return segs[-1][1]
        for i, w in enumerate(wts):
            out[i] = (back(acc / tot_w * tot_sp, False), back((acc + w) / tot_w * tot_sp, True)); acc += w
    words = [{"word": t[0], "start": o[0], "end": o[1], "_i0": t[1], "_i1": t[2] - 1} for t, o in zip(toks, out)]
    return words


def cmd_vo_local(a):
    text = get_text(a)
    if not shutil.which("say"):
        die("macOS `say` not found")
    out = a.out if os.path.splitext(a.out)[1] else a.out + ".aiff"
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    cmd = ["say", "-o", out]
    if a.voice:
        cmd += ["-v", a.voice]
    if a.rate:
        cmd += ["-r", str(a.rate)]
    r = subprocess.run(cmd + [text], capture_output=True, text=True)
    if r.returncode:
        die("say failed: " + r.stderr.strip())
    wavf = stem(out) + ".wav"
    if wavf != out:
        r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", out, "-ar", "44100", "-ac", "1", wavf], capture_output=True, text=True)
        if r.returncode:
            die("ffmpeg failed: " + r.stderr.strip())
    dur = probe_duration(wavf)
    segs = speech_segments(wavf, dur)
    words = estimate_words(text, segs)
    jwrite(stem(out) + ".words.json", clean_words(words, est=True))
    jwrite(stem(out) + ".lines.json", [dict(l, est=True) for l in lines_from_words(text, words)])
    print("%s + %s  (%.2fs, %d speech segments, %d words)  NOTE: word timings are ESTIMATES (syllable-proportional between detected pauses)" % (out, wavf, dur, len(segs), len(words)))


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("voices")
    sp.add_parser("keys")
    for n in ("vo", "vo-local"):
        p = sp.add_parser(n)
        p.add_argument("--text"); p.add_argument("--script"); p.add_argument("--out", required=True); p.add_argument("--voice")
        if n == "vo":
            p.add_argument("--model", default="eleven_multilingual_v2")
            p.add_argument("--stability", type=float, default=0.5); p.add_argument("--similarity", type=float, default=0.75)
            p.add_argument("--style", type=float, default=0.0); p.add_argument("--speed", type=float, default=1.0)
            p.add_argument("--force", action="store_true"); p.add_argument("--no-refine", action="store_true")
        else:
            p.add_argument("--rate", type=int)
    p = sp.add_parser("refine")
    p.add_argument("--vo", required=True); p.add_argument("--words"); p.add_argument("--lines")
    p = sp.add_parser("split")
    p.add_argument("--vo", required=True); p.add_argument("--lines", required=True); p.add_argument("--out", required=True)
    p.add_argument("--pad", type=float, default=0.03)
    p = sp.add_parser("sfx")
    p.add_argument("--prompt"); p.add_argument("--seconds", type=float); p.add_argument("--out", required=True)
    p.add_argument("--batch"); p.add_argument("--influence", type=float, default=0.5); p.add_argument("--force", action="store_true")
    p.add_argument("--peak", type=float, default=-3.0); p.add_argument("--keep-raw", action="store_true"); p.add_argument("--no-normalize", action="store_true")
    p.add_argument("--source", choices=["elevenlabs", "native", "auto"], default="elevenlabs"); p.add_argument("--score")
    p = sp.add_parser("sfx-norm")
    p.add_argument("--in", dest="inp", nargs="+", required=True); p.add_argument("--peak", type=float, default=-3.0); p.add_argument("--keep-raw", action="store_true")
    p = sp.add_parser("music")
    p.add_argument("--prompt"); p.add_argument("--ms", type=int, default=20000); p.add_argument("--out", default="audio/music.mp3")
    p.add_argument("--plan"); p.add_argument("--vocals", action="store_true"); p.add_argument("--dry-run", action="store_true"); p.add_argument("--force", action="store_true")
    p.add_argument("--source", choices=["elevenlabs", "native", "auto"], default="elevenlabs"); p.add_argument("--score")
    p = sp.add_parser("music-check")
    p.add_argument("--in", dest="inp", required=True); p.add_argument("--ms", type=int)
    p = sp.add_parser("music-fit")
    p.add_argument("--in", dest="inp", required=True); p.add_argument("--out", required=True); p.add_argument("--duration", type=float, required=True)
    p.add_argument("--loop-bars", action="store_true"); p.add_argument("--bpm", type=float); p.add_argument("--beats-per-bar", type=int, default=4)
    p.add_argument("--xfade", type=float, default=0.2); p.add_argument("--tail", type=float, default=1.0)
    a = ap.parse_args()
    try:
        run(a)
    except ApiError as e:
        die(str(e), 4 if e.code in PLAN_REFUSED else 1)


def run(a):
    {"voices": cmd_voices, "keys": cmd_keys, "vo": cmd_vo, "sfx": cmd_sfx, "music": cmd_music, "vo-local": cmd_vo_local, "refine": cmd_refine, "split": cmd_split,
     "sfx-norm": cmd_sfx_norm, "music-check": cmd_music_check, "music-fit": cmd_music_fit}[a.cmd](a)


if __name__ == "__main__":
    main()
