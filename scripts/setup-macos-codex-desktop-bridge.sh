#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This setup is only supported on macOS." >&2
  exit 1
fi

codex_binary=""
for candidate in \
  "/Applications/Codex.app/Contents/Resources/codex" \
  "$HOME/Applications/Codex.app/Contents/Resources/codex" \
  "/Applications/ChatGPT.app/Contents/Resources/codex" \
  "$HOME/Applications/ChatGPT.app/Contents/Resources/codex"
do
  if [ -x "$candidate" ]; then
    codex_binary="$candidate"
    break
  fi
done

if [ -z "$codex_binary" ]; then
  echo "Install and sign in to the Codex desktop app before running this setup." >&2
  exit 1
fi

echo "Using $codex_binary"
"$codex_binary" --version

if [ -d "/Applications/Codex.app" ] || [ -d "$HOME/Applications/Codex.app" ]; then
  open -a Codex
else
  open -a ChatGPT
fi

codex_home="${CODEX_HOME:-$HOME/.codex}"
managed_codex="$codex_home/packages/standalone/current/codex"
if [ ! -x "$managed_codex" ]; then
  echo >&2
  echo "The desktop app was found, but its bundled CLI cannot bootstrap the managed daemon." >&2
  echo "Install the standalone Codex CLI from the official instructions:" >&2
  echo "https://developers.openai.com/codex/cli/" >&2
  echo "Then rerun this script. Expected managed CLI: $managed_codex" >&2
  exit 1
fi

echo "Using managed Codex CLI at $managed_codex"

echo "Bootstrapping the managed Codex app-server daemon..."
"$managed_codex" app-server daemon bootstrap

echo "Checking the managed Codex app-server daemon..."
"$managed_codex" app-server daemon version

echo
echo "The host bridge is ready. In T3 Code, open Settings > Providers > Codex"
echo "and enable 'Use Codex desktop bridge'. Leave Binary path as 'codex' so"
echo "T3 can auto-discover this app-bundled binary, or paste the path above."
