#!/usr/bin/env python3
"""precedent.py - rule-only precedent retrieval: "what did human motion designers do at this kind of beat?" Python 3.8+, stdlib only.

Usage:
  python3 precedent.py query --beat hook|turn|proof|cta [--content ui|type|logo|number|3d] [--text "selection becomes result"]
                             [--k 6] [--src lib,hf,rule]
  python3 precedent.py show ID                 (one row in full, e.g. PR-A02, PM913, PL0042)
  python3 precedent.py rules [--beat B] [--src rule]   (every rule of that kind, grouped by beat)
  python3 precedent.py stats                   (what the library holds: counts by beat x content x source)
  python3 precedent.py --help

Library: ../library/moments.jsonl (override with --lib FILE). 716 rows of three kinds, all our own words, none carrying third-party
copy, frames or brand names:
  PR-Xnn   156 designer rules (WHEN / DO / BECAUSE, with frame and pixel numbers) distilled from the 53 measured HyperFrames recreations;
           the evidence moments (M913..M974) are listed: the same ids as in references/*.md.
  PM###    the 53 study moments themselves: role, mechanic, and why it works (what the viewer is bought).
  PL####   507 rules decoded from 39 human-made reference films; "film" is an opaque id f-xxxxxxxx = sha1(original name)[:8].
Roles: hook | turn | proof | cta (library beats map: problem/claim -> hook; tension/name-reveal/contrast/emotion/breath -> turn;
demo/feature/number/list -> proof; lockup -> cta). Contents: ui | type | logo | number | 3d (also abstract, photo).

How to use it. Step "per beat": run one query per beat of the storyboard, read the top 3-6, and write in the beat table's "why" column the ONE
rule you adopt and its id (e.g. "PR-A02: cause lands first, effect 1-2 f later"). Retrieve the RULE and the WHY, not the technique name:
human techniques are mostly bespoke. These rows are study-derived and model-decoded: UNVERIFIED. Open the cited M-moment (private study
folder, or the measured numbers in references/) before relying on a number, and never let a precedent outrank a measured number in
references/ or the user's verdicts in taste/. Ranking: beat +3, content +2 (+1 secondary), text tokens (idf-weighted) up to ~+4,
measured rules +0.8, one row per film in the first pass.
Exit: 0 ok, 1 library missing/unreadable, 2 bad usage.
"""
from __future__ import annotations

import argparse
import collections
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_LIB = os.path.join(HERE, "..", "library", "moments.jsonl")
BEATS = ("hook", "turn", "proof", "cta")
CONTENTS = ("ui", "type", "logo", "number", "3d", "abstract", "photo")
BEAT_ALIAS = {"problem": "hook", "claim": "hook", "tension": "turn", "name-reveal": "turn", "contrast": "turn", "emotion": "turn", "breath": "turn",
              "demo": "proof", "feature": "proof", "number": "proof", "list": "proof", "lockup": "cta"}
CONTENT_ALIAS = {"product-ui": "ui", "screen": "ui", "word": "type", "phrase": "type", "sentence": "type", "question": "type", "text": "type", "typography": "type",
                 "counter": "number", "stat": "number", "mark": "logo", "wordmark": "logo", "three-d": "3d", "abstract-idea": "abstract", "none": "abstract", "person": "photo"}
TOK = re.compile(r"[a-z0-9\u0621-\u064a]+")
AR_DIACRITICS = re.compile(r"[\u064B-\u065F\u0670\u0640]")
AR_CONCEPTS = {
    "شعار": ["logo", "mark", "wordmark"],
    "واجهة": ["ui", "screen", "interface"],
    "واجهه": ["ui", "screen", "interface"],
    "مؤشر": ["cursor", "click", "press"],
    "فأرة": ["cursor", "click", "press"],
    "نقر": ["click", "press", "button"],
    "نص": ["type", "word", "headline", "typography"],
    "كتابة": ["type", "typing", "caret", "input"],
    "عنوان": ["headline", "title", "type"],
    "قطع": ["cut", "hard", "transition"],
    "انتقال": ["transition", "handoff", "cut"],
    "خاتمة": ["cta", "lockup", "end", "close"],
    "دعوة": ["cta", "lockup", "button"],
    "إثبات": ["proof", "demo", "ui"],
    "اثبات": ["proof", "demo", "ui"],
    "خطاف": ["hook", "claim", "opening"],
    "بداية": ["hook", "entry", "arrive"],
    "تحول": ["turn", "contrast", "reveal"],
    "ثلاثي": ["3d", "extrude", "depth"],
    "رقم": ["number", "count", "counter", "stat"],
    "عداد": ["count", "counter", "number"],
    "كاميرا": ["camera", "zoom", "push", "macro"],
    "تكبير": ["zoom", "macro", "scale", "camera"],
    "تلاشي": ["fade", "opacity"],
    "حركة": ["motion", "move", "ease", "decel"],
}
STOP = set("the a an and or of to in on for with is are be it this that you your we our i my at by as from into than then when do does not no من في على إلى عن مع هذا هذه التي الذي".split())


def die(msg, code=2):
    print("error: " + msg, file=sys.stderr)
    sys.exit(code)


def toks(s):
    cleaned = AR_DIACRITICS.sub("", (s or "").lower())
    raw = [t for t in TOK.findall(cleaned) if t not in STOP and len(t) > 1]
    expanded = list(raw)
    for t in raw:
        for k, vals in AR_CONCEPTS.items():
            if k in t or t in k:
                expanded.extend(vals)
    return expanded


def load(path):
    if not os.path.isfile(path):
        die("library not found: %s" % path, 1)
    rows = []
    try:
        for ln, line in enumerate(open(path, encoding="utf-8"), 1):
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if not r.get("_meta"):
                rows.append(r)
    except ValueError as e:
        die("library %s line %d is not valid JSON: %s" % (path, ln, e), 1)
    if not rows:
        die("library %s has no rows" % path, 1)
    return rows


def text_of(r):
    return " ".join(str(x) for x in [r.get("rule"), r.get("why"), r.get("title"), r.get("mechanic") if isinstance(r.get("mechanic"), str) else " ".join(r.get("mechanic") or []),
                                     " ".join(r.get("tags") or []), " ".join(r.get("content") or [])] if x)


def norm_beat(b):
    if b is None:
        return None
    b = BEAT_ALIAS.get(b.lower(), b.lower())
    if b not in BEATS:
        die("--beat must be one of %s (got %r)" % ("|".join(BEATS), b))
    return b


def norm_content(c):
    if c is None:
        return None
    c = CONTENT_ALIAS.get(c.lower(), c.lower())
    if c not in CONTENTS:
        die("--content must be one of %s (got %r)" % ("|".join(CONTENTS), c))
    return c


def srcs_of(spec):
    if not spec:
        return None
    s = {x.strip() for x in spec.split(",") if x.strip()}
    bad = s - {"lib", "hf", "rule"}
    if bad:
        die("--src takes lib, hf, rule (got %s)" % ", ".join(sorted(bad)))
    return s


def rank(rows, beat, content, text, srcs):
    pool = [r for r in rows if not srcs or r.get("src") in srcs]
    docs = [set(toks(text_of(r))) for r in pool]
    df = collections.Counter()
    for d in docs:
        df.update(d)
    n = len(pool)
    q = set(toks(text))
    out = []
    for r, d in zip(pool, docs):
        s = 0.0
        if beat and r.get("beat") == beat:
            s += 3
        if content and r.get("content"):
            if r["content"][0] == content:
                s += 2
            elif content in r["content"]:
                s += 1
        if q:
            s += min(4.0, sum(math.log(1 + n / (1 + df[t])) for t in q if t in d) * 0.6)
        if r.get("src") == "rule":
            s += 0.8
        elif r.get("src") == "hf":
            s += 0.4
        out.append((s, r))
    out.sort(key=lambda x: (-x[0], x[1].get("id", "")))
    return out


def fmt(r, s=None):
    ct = ", ".join(r.get("content") or [])
    mech = r.get("mechanic")
    mech = ", ".join(mech) if isinstance(mech, list) else (mech or "")
    ev = r.get("moments") or ([r["moment"]] if r.get("moment") else [])
    head = "%-8s [%s . %s]  %s%s%s" % (r["id"], r.get("beat"), ct, {"rule": "measured rule", "hf": "study moment", "lib": "film rule"}.get(r.get("src"), r.get("src")),
                                       ("  evidence " + " ".join(ev)) if ev else "", ("  film %s @ %s" % (r.get("film"), r.get("t"))) if r.get("src") == "lib" else "")
    lines = [head + (("   score %.1f" % s) if s is not None else "")]
    if mech:
        lines.append("    mechanic: %s%s" % (mech, ("  (%s)" % ", ".join(r["tags"])) if r.get("tags") else ""))
    if r.get("title"):
        lines.append("    moment:   %s%s" % (r["title"], ("  %.1f s" % r["dur"]) if r.get("dur") else ""))
    if r.get("why"):
        lines.append("    WHY:      %s" % r["why"])
    if r.get("rule"):
        lines.append("    RULE:     %s" % r["rule"])
    return "\n".join(lines)


NOTE = ("study-derived, model-decoded, UNVERIFIED: open the cited M-moment (or the measured numbers in references/) before relying on a row; "
        "retrieve the rule and why, not the technique name; never outrank a measured number or a user verdict.")


def cmd_query(a, rows):
    beat, content, srcs = norm_beat(a.beat), norm_content(a.content), srcs_of(a.src)
    if not (beat or content or a.text):
        die("query needs at least one of --beat, --content, --text")
    ranked = rank(rows, beat, content, a.text or "", srcs)
    picked, used = [], collections.Counter()
    for s, r in ranked:                                 # diversity: one row per film (rules and moments without a film are unconstrained)
        key = r.get("film") if r.get("src") == "lib" else r["id"]
        if used[key] >= 1:
            continue
        picked.append((s, r)); used[key] += 1
        if len(picked) >= a.k:
            break
    print("precedent query: beat=%s content=%s text=%r src=%s  -> top %d of %d rows" % (beat or "-", content or "-", a.text or "", ",".join(sorted(srcs)) if srcs else "all", len(picked), len(rows)))
    for s, r in picked:
        print()
        print(fmt(r, s))
    print("\n" + NOTE)


def cmd_show(a, rows):
    hit = [r for r in rows if r["id"].lower() == a.id.lower()]
    if not hit:
        close = [r["id"] for r in rows if a.id.lower() in r["id"].lower()][:8]
        die("no row with id %s%s" % (a.id, ("; did you mean " + ", ".join(close)) if close else ""))
    print(fmt(hit[0]))
    print(json.dumps(hit[0], ensure_ascii=False, indent=1))


def cmd_rules(a, rows):
    beat, srcs = norm_beat(a.beat), srcs_of(a.src) or {"rule", "lib"}
    g = collections.defaultdict(list)
    for r in rows:
        if r.get("rule") and r.get("src") in srcs and (not beat or r.get("beat") == beat):
            g[r["beat"]].append(r)
    for b in BEATS:
        if g.get(b):
            print("\n## %s (%d)" % (b, len(g[b])))
            for r in g[b]:
                print("- %s [%s] %s" % (r["id"], ", ".join(r.get("content") or []), r["rule"]))
    print("\n" + NOTE)


def cmd_stats(a, rows):
    print("%d rows" % len(rows))
    by = collections.Counter((r.get("src"), r.get("beat")) for r in rows)
    print("\nsource x beat      " + "  ".join("%5s" % b for b in BEATS))
    for s in ("rule", "hf", "lib"):
        print("%-18s " % s + "  ".join("%5d" % by.get((s, b), 0) for b in BEATS))
    cc = collections.Counter((r.get("beat"), c) for r in rows for c in (r.get("content") or [])[:1])
    print("\nbeat x primary content")
    cols = [c for c in CONTENTS if any(cc.get((b, c)) for b in BEATS)]
    print("%-8s " % "" + "  ".join("%7s" % c for c in cols))
    for b in BEATS:
        print("%-8s " % b + "  ".join("%7d" % cc.get((b, c), 0) for c in cols))
    print("\nfilms (lib rows): %d   moments (hf): %d" % (len({r["film"] for r in rows if r.get("src") == "lib"}), sum(1 for r in rows if r.get("src") == "hf")))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lib", default=DEFAULT_LIB, help="moments.jsonl (default ../library/moments.jsonl)")
    sub = ap.add_subparsers(dest="cmd")
    q = sub.add_parser("query", help="top rules for a beat / content / text")
    q.add_argument("--beat"); q.add_argument("--content"); q.add_argument("--text", default=""); q.add_argument("--k", type=int, default=6); q.add_argument("--src")
    s = sub.add_parser("show", help="one row in full"); s.add_argument("id")
    r = sub.add_parser("rules", help="all rules, grouped by beat"); r.add_argument("--beat"); r.add_argument("--src")
    sub.add_parser("stats", help="what the library holds")
    a = ap.parse_args()
    if not a.cmd:
        ap.print_help()
        sys.exit(2)
    if a.cmd == "query" and a.k < 1:
        die("--k must be >= 1")
    rows = load(a.lib)
    {"query": cmd_query, "show": cmd_show, "rules": cmd_rules, "stats": cmd_stats}[a.cmd](a, rows)


if __name__ == "__main__":
    main()
