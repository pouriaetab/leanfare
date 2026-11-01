#!/bin/sh
# Runs the Leanfare app installed on this computer, for this plugin's MCP server and hooks. The plugin carries no
# program of its own: it starts the one you installed (README.md says how), from the places its installers use.
LEANFARE_HOOK_FROM=plugin
export LEANFARE_HOOK_FROM
for c in "$(command -v leanfare 2>/dev/null)" "$HOME/.leanfare/bin/leanfare" "/opt/homebrew/bin/leanfare" "/usr/local/bin/leanfare"; do
  if [ -n "$c" ] && [ -x "$c" ]; then exec "$c" "$@"; fi
done
# The Mac app (Leanfare.app) runs Leanfare with Bun from inside the app.
for app in "$HOME/Applications/Leanfare.app" "/Applications/Leanfare.app"; do
  cli="$app/Contents/Resources/leanfare/src/cli.ts"
  if [ -f "$cli" ]; then
    for b in "$(command -v bun 2>/dev/null)" "$HOME/.bun/bin/bun" "/opt/homebrew/bin/bun" "/usr/local/bin/bun"; do
      if [ -n "$b" ] && [ -x "$b" ]; then exec "$b" "$cli" "$@"; fi
    done
  fi
done
# Not installed: a hook does nothing, and the MCP server says how to install Leanfare.
if [ "$1" = "hook" ]; then exit 0; fi
echo "Leanfare is not installed on this computer. Install it with one line from https://github.com/pouriaetab/leanfare#get-started, open it once, then restart this app." >&2
exit 1
