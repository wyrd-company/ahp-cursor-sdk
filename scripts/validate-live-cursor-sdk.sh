#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "set CURSOR_API_KEY to run live Cursor SDK validation" >&2
  exit 0
fi

CURSOR_MODEL="${CURSOR_MODEL:-composer-2}" node --test --import tsx test/live-cursor-sdk.test.ts
