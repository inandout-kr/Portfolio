#!/bin/bash
set -euo pipefail

# Only run dependency installation in Claude Code on the web (remote env).
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Install Python dependencies so kairos_verifier.py runs in the session.
# numpy + scipy are the only runtime deps (see CLAUDE.md §9).
python3 -m pip install --quiet numpy scipy
