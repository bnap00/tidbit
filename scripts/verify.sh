#!/usr/bin/env bash
# The gate every milestone must pass: codegen freshness, typecheck, lint, tests.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "codegen is up to date"
pnpm --silent --filter @tidbit/protocol exec tsx scripts/codegen.ts --check

step "typecheck"
pnpm --silent -r --if-present run typecheck

step "lint"
pnpm --silent exec eslint . --max-warnings 0
pnpm --silent exec prettier --check . --log-level warn

step "unit + snapshot tests"
pnpm --silent exec vitest run

if [ -x scripts/verify-extra.sh ]; then
  step "extra checks"
  scripts/verify-extra.sh
fi

printf '\n\033[32mverify: all checks passed\033[0m\n'
