# shellcheck shell=bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# offered-clouds.sh — the clouds a real-cloud measurement is SCORED on, read from the catalog on
# every call. Sourced, never executed: it defines one function and stops.
#
# WHY THIS EXISTS (#6959). scripts/e2e/nightly-rollup.sh carried `PROVIDERS="hetzner aws gcp azure
# alibaba"` and `TOTAL=5`, and scripts/programme-fetch.sh carried the same five for the reaper walk.
# When the catalog retired alibaba (#6766) neither literal moved, so a scheduled nightly on the
# promoted tree would have reported a retired cloud as an inert leg and coverage as 4 of 5 — a
# number about a set nobody offers. The list is now a QUESTION asked of the catalog, never typed.
#
# THE DEFINITION is the one every other reader of "the clouds the release is scored on" uses: a slug
# in `.providers[]` (the catalog can PROVISION it) whose `.live.providers.<slug>.availability` is
# exactly `available`. That is `catalogClouds().available` in scripts/check-e2e-spend-guard.mjs
# (rule R6, which holds the nightly's scheduled matrix to the same set), the `clouds` of
# test/e2e/generated/programme.json, and — for every cloud the catalog can provision —
# AVAILABLE_CLOUDS in packages/cloud-catalog. A `hidden` cloud is retired: dispatchable by hand,
# never scored. Order is the catalog's `.providers[]` order.
#
# ITS FAILURE BRANCH IS ITS MAIN BRANCH. Every way of not knowing the answer — no catalog path, a
# file that is missing or unreadable, JSON that does not parse, a catalog with no `.providers[]` or
# no `.live.providers`, or one that offers nothing at all — prints NOTHING on stdout, one
# `REFUSED: …` line on stderr, and returns 2. An empty list is never an answer: a caller that
# scored against it would report 0 of 0, which reads as "nothing to prove" rather than "could not
# read what to prove".

# offered_clouds <catalog.json> — print the scored clouds, space-separated, on one line; return 0.
# On any failure print `REFUSED: <why>` to stderr, nothing to stdout, and return 2.
offered_clouds() {
	local catalog="${1:-}" out
	if [ -z "$catalog" ]; then
		echo "REFUSED: no catalog path was given — the scored cloud set cannot be read" >&2
		return 2
	fi
	if [ ! -f "$catalog" ] || [ ! -r "$catalog" ]; then
		echo "REFUSED: ${catalog} is missing or unreadable — the scored cloud set cannot be read" >&2
		return 2
	fi
	if ! command -v jq >/dev/null 2>&1; then
		echo "REFUSED: jq is not installed — ${catalog} cannot be read" >&2
		return 2
	fi
	# `error(...)` inside jq exits non-zero, so a catalog missing either half is a refusal, not an
	# empty list. The two halves are checked separately because a missing `.live.providers` would
	# otherwise make every cloud's availability null and the set silently empty.
	if ! out="$(jq -r '
		if (.providers | type) != "array" then error("no .providers[] array — nothing says which clouds can be provisioned")
		elif (.live.providers | type) != "object" then error("no .live.providers object — nothing says which clouds are available")
		else . end
		| .live.providers as $live
		| [.providers[] | .slug? | strings | select($live[.].availability? == "available")]
		| join(" ")
	' "$catalog" 2>&1)"; then
		echo "REFUSED: ${catalog} could not be read as the catalog — ${out//$'\n'/ }" >&2
		return 2
	fi
	if [ -z "${out// /}" ]; then
		echo "REFUSED: ${catalog} offers no provisionable cloud as available — a score over zero clouds would read as nothing to prove" >&2
		return 2
	fi
	printf '%s\n' "$out"
}
