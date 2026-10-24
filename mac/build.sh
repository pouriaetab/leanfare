#!/bin/bash
# Builds the Mac app, Leanfare.app, from this folder: the menu bar app in
# mac/Leanfare.swift, with this folder's Leanfare inside it. It uses Apple's
# Swift compiler from the Command Line Tools; nothing is downloaded.
#
#   bash mac/build.sh             build it, in mac/build/Leanfare.app
#   bash mac/build.sh --install   build it, put it in your Applications folder, open it
#
# Everything it does is also written to mac/build.log.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
LOG="$HERE/build.log"
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1
step() { printf '\n== %s\n' "$*"; }
fail() { printf '\nThe build stopped: %s\n' "$*"; exit 1; }

INSTALL=0
for a in "$@"; do
  case "$a" in
    --install) INSTALL=1 ;;
    *) fail "unknown option $a (use --install, or nothing)" ;;
  esac
done

step "Checking this Mac"
[ "$(uname -s)" = "Darwin" ] || fail "this builds a Mac app, so it runs on a Mac."
sw_vers || true
SWIFTC="$(xcrun --find swiftc 2>/dev/null || command -v swiftc || true)"
[ -n "$SWIFTC" ] || fail "Apple's Swift compiler is missing. Install the Command Line Tools with: xcode-select --install"
SDK="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"
[ -n "$SDK" ] || fail "the macOS SDK is missing. Install the Command Line Tools with: xcode-select --install"
"$SWIFTC" --version
echo "SDK: $SDK"
BUN="$(command -v bun || true)"
[ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ] && BUN="$HOME/.bun/bin/bun"
# The app records this Bun, so it finds it when opened from Finder, the Dock or at
# login (where your shell's PATH is not set). Bun names its own file, past any shim.
BUN_PATH=""
if [ -n "$BUN" ]; then
  BUN_PATH="$("$BUN" -e 'console.log(process.execPath)' 2>/dev/null || true)"
  [ -x "$BUN_PATH" ] || BUN_PATH="$BUN"
  echo "Bun: $BUN_PATH ($("$BUN_PATH" --version))"
else
  echo "Bun is not installed: the app will say how to install it when it opens."
fi

VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
BUILD="$(date +%Y%m%d%H%M)"
APP="$HERE/build/Leanfare.app"
# Notes jotted in the menu go to annoyances.md in the notes folder: the folder this
# copy sits in when that folder is named notes, or a notes folder inside this copy.
# Otherwise they go to ~/.leanfare/notes.md. LEANFARE_NOTES_FILE names another file.
NOTES="${LEANFARE_NOTES_FILE:-}"
if [ -z "$NOTES" ]; then
  if [ "$(basename "$(dirname "$ROOT")")" = "notes" ]; then NOTES="$(dirname "$ROOT")/annoyances.md"
  elif [ -d "$ROOT/notes" ]; then NOTES="$ROOT/notes/annoyances.md"
  fi
fi

step "Compiling Leanfare $VERSION for $(uname -m)"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/leanfare/data"
"$SWIFTC" -O -swift-version 5 -parse-as-library -sdk "$SDK" -target "$(uname -m)-apple-macos13.0" "$HERE/Leanfare.swift" -o "$APP/Contents/MacOS/Leanfare"

step "Putting the app together"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$BUILD" "$APP/Contents/Info.plist"
plutil -replace LeanfareNotesFile -string "$NOTES" "$APP/Contents/Info.plist"
plutil -replace LeanfareBun -string "$BUN_PATH" "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist"
cp "$HERE/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp -R "$ROOT/src" "$ROOT/ui" "$APP/Contents/Resources/leanfare/"
cp "$ROOT/package.json" "$ROOT/LICENSE" "$APP/Contents/Resources/leanfare/"
cp "$ROOT/data/catalog.json" "$APP/Contents/Resources/leanfare/data/"
echo "Notes from the menu go to: ${NOTES:-~/.leanfare/notes.md}"

step "Signing it for this Mac (ad hoc: no Apple account needed to run it here)"
codesign --force --deep --sign - "$APP"
codesign --verify --verbose "$APP"

if [ "$INSTALL" = 1 ]; then
  step "Putting it in your Applications folder"
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
  osascript -e 'if application "Leanfare" is running then tell application "Leanfare" to quit' >/dev/null 2>&1 || true
  sleep 1
  rm -rf "$DEST/Leanfare.app"
  cp -R "$APP" "$DEST/"
  open "$DEST/Leanfare.app"
  echo "Done: Leanfare is in $DEST and open. Its spend for today is in the menu bar, at the top right of the screen."
else
  echo
  echo "Done: $APP"
  echo "Open it with: open \"$APP\"   (or build with --install to put it in your Applications folder)"
fi
