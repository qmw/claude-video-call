#!/bin/sh
# Installs the video-call skill for Claude Code without the plugin system:
#   curl -fsSL https://raw.githubusercontent.com/qmw/claude-video-call/main/install.sh | sh
# Then start a new Claude Code session.
set -eu
REF="${VIDEO_CALL_REF:-main}"
DEST="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}/video-call"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "https://github.com/qmw/claude-video-call/archive/$REF.tar.gz" | tar xz -C "$TMP" --strip-components=1
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R "$TMP/skills/video-call" "$DEST"
echo "Installed to $DEST"
echo "Start a new Claude Code session and say, for example: \"create a Meet and share your screen\"."
