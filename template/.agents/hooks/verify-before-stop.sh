#!/usr/bin/env bash
set -euo pipefail

# Stop hook: nudges the agent to run `just verify` if circuit or
# spec files changed since the last check, or if the last check had errors.
# Caps continuation to executionNum <= 2 to avoid infinite loops.

INPUT="$(cat)"

if ! command -v jq >/dev/null 2>&1; then
	printf '{}'
	exit 0
fi

REASON="$(printf '%s' "${INPUT}" | jq -r '.terminationReason // ""')"
EXEC_NUM="$(printf '%s' "${INPUT}" | jq -r '.executionNum // 1')"
FULLY_IDLE="$(printf '%s' "${INPUT}" | jq -r 'if has("fullyIdle") then (.fullyIdle | tostring) else "true" end')"

if [ "${FULLY_IDLE}" != "true" ] || [ "${REASON}" != "NO_TOOL_CALL" ] || [ "${EXEC_NUM}" -gt 2 ]; then
	printf '{}'
	exit 0
fi

# Skip nudging if another verification, export, or routing process is already active.
if command -v pgrep >/dev/null 2>&1 && pgrep -f "checks/index\.ts|tscircuit-cli|freerouting" >/dev/null 2>&1; then
	printf '{}'
	exit 0
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPORT="${REPO_ROOT}/dist/checks-report.json"

if [ ! -f "${REPORT}" ]; then
	printf '{}'
	exit 0
fi

NEW_FILES="$(find "${REPO_ROOT}/src" "${REPO_ROOT}/specs" -type f \( -name '*.tsx' -o -name '*.json' \) -newer "${REPORT}" 2>/dev/null | head -n 5 || true)"
if [ -n "${NEW_FILES}" ]; then
	printf '{"decision":"continue","reason":"Circuit or spec files changed since the last verification run. Run just verify to confirm all TDD PCB checks pass before stopping."}'
	exit 0
fi

PASSED="$(jq -r '.passed // true' "${REPORT}" 2>/dev/null || echo "true")"
ERR_COUNT="$(jq -r '.errorCount // 0' "${REPORT}" 2>/dev/null || echo "0")"

if [ "${PASSED}" = "false" ] && [ "${ERR_COUNT}" -gt 0 ]; then
	printf '{"decision":"continue","reason":"dist/checks-report.json has %s failing error(s). Fix them or explain any remaining blocker before stopping."}' "${ERR_COUNT}"
	exit 0
fi

printf '{}'
