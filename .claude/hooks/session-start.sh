#!/bin/bash
set -euo pipefail

# Only run dependency installation in Claude Code on the web (remote env).
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Install Python dependencies so the kairos modules and tests run in the session.
# numpy + scipy: runtime deps (CLAUDE.md §9); anthropic: LLM adapter (kairos_llm);
# pytest: test suite.
python3 -m pip install --quiet numpy scipy anthropic pytest

# Patina(patina/, TypeScript): 개발 의존성 설치 (typescript, @types/node). 실패해도 Kairos 세션은 막지 않는다.
if [ -f patina/package-lock.json ]; then
  (cd patina && npm ci --no-audit --no-fund --silent) || echo "patina: npm ci 실패 — 'cd patina && npm ci' 로 직접 설치" >&2
fi
