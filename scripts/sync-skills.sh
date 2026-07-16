#!/usr/bin/env bash
#
# Sync Alethia's shared Claude Code skills from the source-of-truth repo
# (alethialabs-io/skills) into this repo's .claude/skills/.
#
# The skills are COMMITTED here on purpose: every worktree / autonomous instance gets them with
# zero setup — no plugin, no marketplace trust prompt. This script pulls the latest from the
# source repo; review the diff and commit it. **Edit skills in alethialabs-io/skills, not here** —
# a sync overwrites the local copy of each synced skill.
#
# The plugin-marketplace path (interactive, autoUpdate, namespaced /alethia:grill) is the other way
# to consume the same repo — see its README. This repo uses SYNC (autonomous-safe), not the plugin,
# so the two don't double up.
#
# Usage:
#   bash scripts/sync-skills.sh                 # sync from alethialabs-io/skills@main
#   ALETHIA_SKILLS_REF=v0.1.0 bash scripts/sync-skills.sh   # pin to a tag
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${ALETHIA_SKILLS_REPO:-alethialabs-io/skills}"
REF="${ALETHIA_SKILLS_REF:-main}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "▶ fetching $REPO@$REF …"
if ! gh repo clone "$REPO" "$tmp/skills" -- --depth 1 --branch "$REF" >/dev/null 2>&1; then
  git clone --depth 1 --branch "$REF" "https://github.com/$REPO.git" "$tmp/skills" >/dev/null 2>&1 \
    || { echo "✗ could not fetch $REPO@$REF (check gh auth / access to the private repo)" >&2; exit 1; }
fi

src="$tmp/skills/plugins/alethia/skills"
[ -d "$src" ] || { echo "✗ $src not found in $REPO — wrong layout?" >&2; exit 1; }

mkdir -p .claude/skills
count=0
for d in "$src"/*/; do
  name="$(basename "$d")"
  rm -rf ".claude/skills/$name"
  cp -R "$d" ".claude/skills/$name"
  echo "  synced $name"
  count=$((count + 1))
done
[ -f "$tmp/skills/NOTICE" ] && cp "$tmp/skills/NOTICE" .claude/skills/NOTICE

echo "✓ synced $count skills from $REPO@$REF into .claude/skills/. Review + commit the diff."
echo "  (skills not present upstream — e.g. an app-only skill — are left untouched, never pruned.)"
