#!/usr/bin/env sh
# install.sh — Install the admp-client skill into AI agent skill directories
#
# Usage (run from repo root):
#   ./skill/admp-client/install.sh
#
# Must be run from the repository root so that relative paths
# (.claude/skills, .gemini/skills, .codex/skills) resolve correctly.
#
# Installs SKILL.md into any detected skill directories:
#   .claude/skills/admp-client/
#   .gemini/skills/admp-client/
#   .codex/skills/admp-client/

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_FILE="$SCRIPT_DIR/SKILL.md"
SKILL_NAME="admp-client"
INSTALLED=0

install_into() {
  dir="$1"
  if [ -d "$dir" ]; then
    target="$dir/$SKILL_NAME"
    mkdir -p "$target"
    cp "$SKILL_FILE" "$target/SKILL.md"
    echo "  ✓ Installed to $target/"
    INSTALLED=$((INSTALLED + 1))
  fi
}

echo "Installing admp-client skill..."

# Claude Code
install_into ".claude/skills"

# Gemini CLI
install_into ".gemini/skills"

# Codex
install_into ".codex/skills"

if [ "$INSTALLED" -eq 0 ]; then
  echo "  No skill directories found (.claude/skills, .gemini/skills, .codex/skills)."
  echo "  Create the directory for your AI tool and re-run, or copy SKILL.md manually."
  exit 1
fi

echo ""
echo "Done. The 'admp-client' skill is now available to your AI agents."
echo "Make sure the CLI is installed: npm install -g @agentdispatch/cli"
