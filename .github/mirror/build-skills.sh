#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Builds the public Claude Code plugin marketplace that mirror-skills.yml pushes to
# alethialabs-io/skills: one plugin, `alethia`, holding the skills listed in PUBLISHED.
#
# Only ORIGINAL Alethia skills are published. The skills vendored from mattpocock/skills (grilling,
# research, handoff, domain-modeling, codebase-design; see .claude/skills/NOTICE) are left out on
# purpose: republishing them here would present someone else's work under our name. The README
# points to their source instead. Skills that only make sense inside this repo and its
# infrastructure (dev, console-prod-qa, foundry, db-pipeline, decompose) stay out too.
#
# Usage: bash .github/mirror/build-skills.sh <out-dir>
set -euo pipefail

PUBLISHED=(alethia-design alethia-docs alethia-security-review)

out="${1:?usage: build-skills.sh <out-dir>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
rm -rf "$out"
mkdir -p "$out/.claude-plugin" "$out/plugins/alethia/.claude-plugin" "$out/plugins/alethia/skills"

for s in "${PUBLISHED[@]}"; do
	[ -f "$root/.claude/skills/$s/SKILL.md" ] || { echo "build-skills: $s has no SKILL.md" >&2; exit 1; }
	cp -a "$root/.claude/skills/$s" "$out/plugins/alethia/skills/$s"
done

cat >"$out/.claude-plugin/marketplace.json" <<'JSON'
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "alethia",
  "description": "Claude Code skills from Alethia Labs: the Alethia design system, docs bar and security review.",
  "owner": { "name": "Alethia Labs", "url": "https://alethialabs.io" },
  "plugins": [
    {
      "name": "alethia",
      "description": "Alethia design system, docs authoring bar (Diátaxis + Vale) and threat-surface security review.",
      "source": "./plugins/alethia",
      "category": "development",
      "homepage": "https://github.com/alethialabs-io/skills"
    }
  ]
}
JSON

cat >"$out/plugins/alethia/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "alethia",
  "description": "Alethia design system, docs authoring bar (Diátaxis + Vale) and threat-surface security review.",
  "author": { "name": "Alethia Labs", "url": "https://alethialabs.io" },
  "homepage": "https://github.com/alethialabs-io/skills",
  "repository": "https://github.com/alethialabs-io/alethialabs",
  "keywords": ["alethia", "kubernetes", "design-system", "docs", "security-review"]
}
JSON

cp "$root/LICENSE" "$out/LICENSE"

{
	echo "# Alethia skills for Claude Code"
	echo
	echo "Claude Code skills from [Alethia Labs](https://alethialabs.io). This repository is generated"
	echo "from [\`.claude/skills/\`](https://github.com/alethialabs-io/alethialabs/tree/main/.claude/skills)"
	echo "in the main repository, so open issues and PRs there."
	echo
	echo '```'
	echo "/plugin marketplace add alethialabs-io/skills"
	echo "/plugin install alethia@alethia"
	echo '```'
	echo
	echo "| Skill | What it does |"
	echo "| --- | --- |"
	for s in "${PUBLISHED[@]}"; do
		desc="$(sed -n 's/^description: *//p' "$root/.claude/skills/$s/SKILL.md" | head -1 | cut -d. -f1)"
		echo "| \`$s\` | $desc |"
	done
	echo
	echo "The general-purpose skills our repo also uses (grilling, research, handoff, domain-modeling,"
	echo "codebase-design) come from [mattpocock/skills](https://github.com/mattpocock/skills); install"
	echo "them from there."
	echo
	echo "Licensed AGPL-3.0-only (see LICENSE), except where a skill's \`license:\` field says otherwise."
} >"$out/README.md"

echo "build-skills: staged ${#PUBLISHED[@]} skills in $out"
