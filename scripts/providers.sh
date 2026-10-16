#!/usr/bin/env bash
# providers.sh - detect which tools/providers are available for the motion pipeline.
#
# Usage:  bash providers.sh [--help]
# Prints a JSON report on stdout (human warnings go to stderr). "codex.image_generation" is true only when the Codex CLI's
# image_generation feature is on (needed by scripts/imagegen.py); null when it cannot be read.
# Exit code: 0 always if the script ran; 1 only if the hard requirements
# (ffmpeg, node, chrome) are missing -- check "ready" in the report.
#
# Never installs anything. `npx hyperframes` is only probed with --no-install
# and by looking for a cached copy in ~/.npm/_npx.

if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0
fi

PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n\r'; }
str() { if [ -n "$1" ]; then printf '"%s"' "$(esc "$1")"; else printf 'null'; fi; }
bool() { if [ "$1" = 1 ]; then printf true; else printf false; fi; }

# --- chrome
CHROME="$(node "$(dirname "${BASH_SOURCE[0]}")/_chrome.mjs" 2>/dev/null || true)"

# --- ffmpeg
FFMPEG="$(command -v ffmpeg)"; FFPROBE="$(command -v ffprobe)"
FFVER=""; [ -n "$FFMPEG" ] && FFVER="$(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"
FILTERS=""
if [ -n "$FFMPEG" ]; then
  FL="$(ffmpeg -hide_banner -filters 2>/dev/null)"
  for f in loudnorm sidechaincompress freezedetect ebur128 tile; do
    echo "$FL" | grep -qw "$f" || FILTERS="$FILTERS $f"
  done
fi

# --- node / python
NODEV="$(node -v 2>/dev/null)"
PYV="$(python3 -V 2>&1 | awk '{print $2}')"
pymod() { python3 -c "import $1;print(getattr($1,'__version__','ok'))" 2>/dev/null; }
NUMPY="$(pymod numpy)"; PIL="$(pymod PIL)"

# --- hyperframes
HF=""; HFHOW=""
if command -v hyperframes >/dev/null 2>&1; then HF="$(hyperframes --version 2>/dev/null | head -1)"; HFHOW="global binary"; fi
if [ -z "$HF" ] && command -v npx >/dev/null 2>&1; then
  if command -v timeout >/dev/null 2>&1; then T="timeout 15"; else T=""; fi
  HF="$(cd /tmp && $T npx --no-install hyperframes --version 2>/dev/null | head -1)"
  [ -n "$HF" ] && HFHOW="npx --no-install"
fi
if [ -z "$HF" ] && ls -d "$HOME"/.npm/_npx/*/node_modules/hyperframes >/dev/null 2>&1; then
  HF="cached"; HFHOW="~/.npm/_npx cache (run: npx hyperframes)"
fi

# --- ElevenLabs
EL=""; ELSRC=""
if [ -n "$ELEVENLABS_API_KEY" ]; then EL=1; ELSRC="env ELEVENLABS_API_KEY"; fi
if [ -z "$EL" ]; then
  for f in ./.env "$HOME/.elevenlabs" "$HOME/.config/elevenlabs"; do
    if [ -f "$f" ] && grep -Eq 'ELEVEN(LABS)?_API_KEY|^[A-Za-z0-9_-]{20,}$|xi[-_]api[-_]key' "$f" 2>/dev/null; then EL=1; ELSRC="$f"; break; fi
  done
fi
if [ -z "$EL" ] && [ -d "$HOME/.elevenlabs" ]; then EL=1; ELSRC="$HOME/.elevenlabs/"; fi
ELMCP=""; grep -qi elevenlabs "$HOME/.claude.json" 2>/dev/null && ELMCP=1

# --- codex (+ the image_generation feature that scripts/imagegen.py needs: on / off / unknown)
CODEX="$(command -v codex)"; CODEXV=""; [ -n "$CODEX" ] && CODEXV="$(codex --version 2>/dev/null | head -1)"
CODEXIMG=""; CODEXIMGNOTE=""
if [ -n "$CODEX" ]; then
  if command -v timeout >/dev/null 2>&1; then CT="timeout 20"; else CT=""; fi
  CFL="$($CT codex features list 2>/dev/null | awk '$1=="image_generation"{print $NF}')"
  case "$CFL" in
    true)  CODEXIMG=1; CODEXIMGNOTE="image_generation feature is on: scripts/imagegen.py can make surface plates (ChatGPT login, ~1-2 min per plate)";;
    false) CODEXIMG=0; CODEXIMGNOTE="image_generation feature is OFF: run 'codex features enable image_generation' or plan code/captured surfaces only";;
    *)     CODEXIMGNOTE="could not read 'codex features list' (old codex or no login): treat image generation as unavailable";;
  esac
fi

# --- say (local TTS fallback)
SAY="$(command -v say)"

# --- disk
FREE_KB="$(df -k . 2>/dev/null | awk 'NR==2{print $4}')"
FREE_GB="$(awk -v k="${FREE_KB:-0}" 'BEGIN{printf "%.1f", k/1048576}')"
LOWDISK=0; awk -v g="$FREE_GB" 'BEGIN{exit !(g<3)}' && LOWDISK=1
[ "$LOWDISK" = 1 ] && echo "WARNING: only ${FREE_GB} GB free (< 3 GB). Keep renders short/low-res, never write frame sequences, delete drafts." >&2

READY=1; [ -z "$CHROME" ] || [ -z "$FFMPEG" ] || [ -z "$NODEV" ] && READY=0

cat <<EOF
{
  "ready": $(bool $READY),
  "chrome": $(str "$CHROME"),
  "ffmpeg": $(str "$FFMPEG"),
  "ffmpeg_version": $(str "$FFVER"),
  "ffmpeg_missing_filters": $(str "${FILTERS# }"),
  "ffprobe": $(str "$FFPROBE"),
  "node": $(str "$NODEV"),
  "python3": $(str "$PYV"),
  "python_modules": { "numpy": $(str "$NUMPY"), "PIL": $(str "$PIL") },
  "hyperframes": { "available": $(bool "$([ -n "$HF" ] && echo 1)"), "version": $(str "$HF"), "how": $(str "$HFHOW") },
  "elevenlabs": {
    "key": $(bool "$EL"), "source": $(str "$ELSRC"),
    "mcp_server_may_exist": $(bool "$ELMCP"),
    "hint": $(str "$([ -n "$ELMCP" ] && echo 'ELEVENLABS mentioned in ~/.claude.json: an ElevenLabs MCP server may be configured (tools named like mcp__elevenlabs__*).')")
  },
  "codex": { "available": $(bool "$([ -n "$CODEX" ] && echo 1)"), "path": $(str "$CODEX"), "version": $(str "$CODEXV"),
    "image_generation": $(if [ "$CODEXIMG" = 1 ]; then echo true; elif [ "$CODEXIMG" = 0 ]; then echo false; else echo null; fi),
    "image_note": $(str "$CODEXIMGNOTE") },
  "macos_say": $(bool "$([ -n "$SAY" ] && echo 1)"),
  "disk_free_gb": $FREE_GB,
  "disk_low": $(bool $LOWDISK)
}
EOF
[ "$READY" = 1 ] || { echo "MISSING hard requirement (chrome/ffmpeg/node) - see report" >&2; exit 1; }
