#!/usr/bin/env bash
#
# Release a completed work unit. The merged PR (with "Closes #<n>") normally auto-closes the
# issue; this makes sure it is closed and de-claimed, then nudges you to run coordinate.sh so
# downstream units unblock. See .claude/COORDINATION.md.
#
# Usage: scripts/complete-work.sh <issue-number>
set -euo pipefail
cd "$(dirname "$0")/.."

n="${1:?usage: complete-work.sh <issue-number>}"
command -v gh >/dev/null || { echo "gh (GitHub CLI) required" >&2; exit 1; }

state="$(gh issue view "$n" --json state --jq .state)"
if [ "$state" != "CLOSED" ]; then
  gh issue close "$n" --comment "completed" >/dev/null || true
fi
# Drop the claim label so the board reads clean (assignee is left as the historical record).
gh issue edit "$n" --remove-label claimed >/dev/null 2>&1 || true

echo "✓ Released #$n."
echo "  Run: scripts/coordinate.sh   # unblock downstream + refresh the board"
