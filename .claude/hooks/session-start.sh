#!/bin/bash
set -euo pipefail

# Only run dependency installation in Claude Code on the web (remote env).
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Install npm dependencies so tests, linters and typechecks work in the session.
# `npm install` (not `npm ci`) so the cached container state can be reused.
npm install
