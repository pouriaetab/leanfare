#!/bin/sh
# Leanfare's installer for macOS and Linux. It downloads the one-file Leanfare for this computer
# from the latest GitHub release, checks it against the release's checksums, puts it in
# ~/.leanfare/bin and adds that folder to your PATH. Nothing else is installed or changed.
#
#   curl -fsSL https://raw.githubusercontent.com/pouriaetab/leanfare/main/install.sh | sh
#
# LEANFARE_VERSION=v0.4.0 installs that release; LEANFARE_INSTALL_DIR puts it in another folder;
# LEANFARE_NO_PATH=1 leaves your shell's settings alone.
set -eu

REPO="pouriaetab/leanfare"
DIR="${LEANFARE_INSTALL_DIR:-$HOME/.leanfare/bin}"
VERSION="${LEANFARE_VERSION:-latest}"

say() { printf '%s\n' "$*"; }
fail() { printf 'Leanfare was not installed: %s\n' "$*" >&2; exit 1; }

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "this installer is for macOS and Linux. On Windows, use install.ps1 (see the README)." ;;
esac
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "there is no build for a $arch processor yet." ;;
esac
# A Mac with Apple silicon running this shell under Rosetta still gets the Apple silicon build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
name="leanfare-$os-$arch"

if [ -n "${LEANFARE_DOWNLOAD_BASE:-}" ]; then base="$LEANFARE_DOWNLOAD_BASE"; https=""   # for testing this script
elif [ "$VERSION" = latest ]; then base="https://github.com/$REPO/releases/latest/download"; https="--proto =https --tlsv1.2"
else base="https://github.com/$REPO/releases/download/$VERSION"; https="--proto =https --tlsv1.2"
fi

command -v curl >/dev/null 2>&1 || fail "curl is needed to download it."
command -v tar >/dev/null 2>&1 || fail "tar is needed to unpack it."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading $name ($VERSION)..."
# shellcheck disable=SC2086
curl -fsSL $https "$base/$name.tar.gz" -o "$tmp/$name.tar.gz" || fail "could not download $base/$name.tar.gz"
# shellcheck disable=SC2086
curl -fsSL $https "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "could not download the release's checksums."
want="$(grep " $name.tar.gz\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
[ -n "$want" ] || fail "the release's checksums do not list $name.tar.gz."
if command -v shasum >/dev/null 2>&1; then got="$(shasum -a 256 "$tmp/$name.tar.gz" | cut -d' ' -f1)"
else got="$(sha256sum "$tmp/$name.tar.gz" | cut -d' ' -f1)"
fi
[ "$got" = "$want" ] || fail "the download does not match the release's checksum, so nothing was changed."

tar -xzf "$tmp/$name.tar.gz" -C "$tmp" leanfare || fail "the download could not be unpacked."
chmod 755 "$tmp/leanfare"
if [ "$os" = darwin ]; then
  # Downloaded with curl it has no quarantine flag; these make sure, and give it a fresh local signature.
  xattr -d com.apple.quarantine "$tmp/leanfare" 2>/dev/null || true
  codesign --force --sign - "$tmp/leanfare" >/dev/null 2>&1 || true
fi
# It must start here before it replaces anything: a copy you have stays until the new one works.
installed="$("$tmp/leanfare" --version 2>/dev/null)" || fail "the downloaded Leanfare did not start on this computer, so nothing was changed."
mkdir -p "$DIR"
mv -f "$tmp/leanfare" "$DIR/leanfare"
say "Installed Leanfare $installed in $DIR."

# The PATH line, once, in the file your shell reads at start.
on_path=0
case ":$PATH:" in *":$DIR:"*) on_path=1 ;; esac
if [ "$on_path" = 0 ] && [ "${LEANFARE_NO_PATH:-}" != 1 ]; then
  case "$(basename "${SHELL:-sh}")" in
    zsh) rc="${ZDOTDIR:-$HOME}/.zshrc"; line="export PATH=\"$DIR:\$PATH\"" ;;
    bash)
      line="export PATH=\"$DIR:\$PATH\""
      if [ "$os" = darwin ]; then
        # A login shell reads the first of these it finds: a new .bash_profile would hide a .profile.
        rc="$HOME/.bash_profile"
        for f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do if [ -f "$f" ]; then rc="$f"; break; fi; done
      else rc="$HOME/.bashrc"
      fi ;;
    fish) rc="$HOME/.config/fish/config.fish"; line="fish_add_path \"$DIR\"" ;;
    *) rc="$HOME/.profile"; line="export PATH=\"$DIR:\$PATH\"" ;;
  esac
  mkdir -p "$(dirname "$rc")"
  if [ -f "$rc" ] && grep -F "$DIR" "$rc" >/dev/null 2>&1; then :
  else printf '\n# Leanfare\n%s\n' "$line" >> "$rc"; say "Added $DIR to your PATH in $rc."
  fi
  say "Open a new terminal window for the leanfare command to work there, or run: $line"
fi

say ""
say "Start it:            leanfare        (it opens http://127.0.0.1:4747 in your browser)"
say "In your AI apps:     Leanfare, Settings, \"In your apps\": one press adds its tools to Claude Desktop, Claude Code, Cursor and others"
say "Measure it first:   leanfare trial  (how well the models you tick answer, before Claude relies on them)"
