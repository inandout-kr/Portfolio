#!/bin/bash
set -euo pipefail

# Only run dependency installation in Claude Code on the web (remote env).
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Install Python dependencies so the kairos modules and tests run in the session.
# numpy + scipy are runtime deps (see CLAUDE.md §9); pytest runs the test suite.
python3 -m pip install --quiet numpy scipy pytest
