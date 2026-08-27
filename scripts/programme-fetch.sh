#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# programme-fetch.sh — capture the LIVE board state that PROGRAMME.md's status half cannot derive
# from the tree, as one committed JSON file.
#
# WHY A SNAPSHOT AND NOT A DIRECT QUERY. `scripts/programme-rollup.mjs` is diff-gated on every PR.
# A diff gate whose input is a live GitHub query is flaky by construction — the same PR would be
# "stale" or "in sync" depending on whether somebody relabelled an issue in the meantime, and every
# PR's status would depend on the board. So the live read happens ONCE, in a cron, and is COMMITTED;
# the rollup then stays a deterministic function of files in the tree.
#
# WHY THIS FILE HAS NO LOGIC, AND NO --self-test. It is a pure `gh` transport: query, shape, write.
# Every judgement — what counts as blocked, whether a cited issue is closed, how staleness is
# reported — lives in the rollup, which IS self-tested against fixtures. That split is deliberate:
# the untestable part (the network) is kept trivial enough to read, and the part worth testing is
# kept offline. The same argument nightly-rollup.sh makes for its own derive/emit split.
#
# SECRETS: this writes variable and secret NAMES, never values. `gh variable list` returns values
# for variables (they are not secret) but we deliberately drop them anyway — the rollup only ever
# asks "is this gate wired?", and a committed file in a PUBLIC repo is the wrong place for even a
# non-secret role ARN. `gh secret list` cannot return values at all.
#
# Usage:  scripts/programme-fetch.sh [output-path]
#         GH_REPO=owner/repo scripts/programme-fetch.sh   # override the target repo
set -euo pipefail

OUT="${1:-docs/testing/programme-snapshot.json}"
REPO="${GH_REPO:-alethialabs-io/alethialabs}"

command -v gh >/dev/null || {
	echo "programme-fetch: gh is required" >&2
	exit 3
}
command -v jq >/dev/null || {
	echo "programme-fetch: jq is required" >&2
	exit 3
}

# `derived_at` is the ONLY timestamp in the whole mechanism, and it lives here rather than in
# PROGRAMME.md's rendered text on purpose: a timestamp inside a diff-gated region would make every
# PR stale the moment it was opened. The rollup reads it to report staleness.
derived_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Open issues. `--limit 500` is well above the ~40 the board carries; if it is ever hit the count
# below makes the truncation visible rather than silently dropping the tail.
issues="$(gh issue list --repo "$REPO" --state open --limit 500 \
	--json number,title,labels,createdAt,updatedAt \
	--jq '[.[] | {number, title, labels: [.labels[].name], createdAt, updatedAt}]')"

# Issues the tree CITES must be resolvable even when closed — that is the whole point of the
# stale-citation check — so closed issues are captured too, most-recently-updated first.
closed="$(gh issue list --repo "$REPO" --state closed --limit 500 \
	--json number,title,labels \
	--jq '[.[] | {number, title, labels: [.labels[].name]}]')"

# Gate reality: NAMES ONLY (see the header).
#
# ⚠️ DO NOT restore a `2>/dev/null || echo '[]'` fallback here. That is what this used to do, and
# it turned "the token cannot read repo variables" into "this repo has no variables" — silently.
# programme.yml grants the default GITHUB_TOKEN only contents+pull-requests, which cannot list
# variables or secrets at all, so every refresh committed `variables: [], secrets: []` next to 42
# correctly-fetched issues, and PROGRAMME.md rendered EVERY gate `⛔ unwired` — including ones a
# green run had already proven wired. An empty list and a failed read must not look the same.
#
# The rollup now treats an empty inventory as `unknown` rather than `unwired`, so a failure here is
# no longer load-bearing for correctness — but it should still be LOUD rather than mistaken for a
# measurement.
#
# ── AND DO NOT DISCARD AN INVENTORY WE ALREADY HAVE. ──
#
# Writing `[]` on a failed read does not invent "unwired" — the rollup reads empty as `unknown` —
# but it does THROW AWAY a reading that was already made, which manufactures unknown out of
# knowledge. §4's rule is "`unknown` never collapses"; erasing an observed inventory collapses the
# other way, and it is not hypothetical: this workflow runs NIGHTLY and its token can never read
# these, so every night it reverted a hand-refreshed inventory and PROGRAMME.md went back to
# reporting ten gates as unknown while all ten were wired.
#
# So a failed read CARRIES FORWARD what the previous snapshot held, and records WHEN that was
# actually observed. A variable name does not rot quickly, and the snapshot's own 7-day staleness
# rule still bounds how long a carried reading can stand.
prev_vars='[]'
prev_secrets='[]'
prev_observed=''
if [ -f "$OUT" ]; then
	prev_vars="$(jq -c '.variables // []' "$OUT" 2>/dev/null || echo '[]')"
	prev_secrets="$(jq -c '.secrets // []' "$OUT" 2>/dev/null || echo '[]')"
	prev_observed="$(jq -r '.inventory_observed_at // ""' "$OUT" 2>/dev/null || echo '')"
fi

inventory_observed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
carried=0
if ! vars="$(gh variable list --repo "$REPO" --json name --jq '[.[].name]')"; then
	echo "::warning::programme-fetch: could not list repo VARIABLES (the token likely lacks the scope). CARRYING FORWARD the previous inventory rather than erasing it." >&2
	vars="$prev_vars"
	carried=1
fi
if ! secrets="$(gh secret list --repo "$REPO" --json name --jq '[.[].name]')"; then
	echo "::warning::programme-fetch: could not list repo SECRETS (the token likely lacks the scope). CARRYING FORWARD the previous inventory rather than erasing it." >&2
	secrets="$prev_secrets"
	carried=1
fi
if [ "$carried" = "1" ]; then
	# Keep the ORIGINAL observation time: the point of the field is to say how old the reading is,
	# and stamping it now would make a carried inventory look freshly measured.
	inventory_observed_at="$prev_observed"
fi

# ── GATE REALITY, OBSERVED. ──
#
# The variable inventory above answers "is this gate DECLARED?". That is not the question the board
# is actually asking, and the difference has bitten: `E2E_GCP_WIF_PROVIDER` was set the whole time
# while every workflow_dispatch died at *Configure GCP credentials*, because a bare apply on
# infra/gcp-e2e narrowed the WIF trust to ref-only. A listing would have printed a confident ✅ for
# a cloud that had not federated in weeks.
#
# So ALSO record what the nightly OBSERVED. The workflow's `Record gate-off proof` step runs only
# when the gate is off, so its conclusion is a direct reading:
#
#   skipped  → the gate was ON and the leg proceeded   (reached)
#   success  → the gate was OFF and a gate-off proof was recorded  (not reached)
#
# This needs only `actions: read`, which a GITHUB_TOKEN *can* be granted — unlike variables and
# secrets, for which no workflow permission scope exists at all. The system is, in effect, telling us
# which question it is willing to answer honestly.
#
# Most recent observation per provider wins; runs are walked newest-first. A provider no recent run
# covers simply has no observation, and the rollup falls back to the declared inventory rather than
# inventing one.
gate_runs=20
if ! runs="$(gh api "repos/$REPO/actions/workflows/e2e-nightly.yml/runs?per_page=$gate_runs" --jq '[.workflow_runs[] | {id, created_at}]')"; then
	echo "::warning::programme-fetch: could not list e2e-nightly runs; gate reality falls back to the declared inventory." >&2
	runs='[]'
fi

observations='[]'
seen_providers=""
for run_id in $(printf '%s' "$runs" | jq -r '.[].id'); do
	jobs="$(gh api "repos/$REPO/actions/runs/$run_id/jobs?per_page=100" 2>/dev/null || echo '{"jobs":[]}')"
	# The provider is the parenthesised matrix value in the job name; the gate reading is the
	# `Record gate-off proof` step's conclusion. A job missing that step tells us nothing and is
	# skipped rather than guessed at.
	# RAW FACTS ONLY. Whether those facts amount to "the gate was reached" is a JUDGEMENT, and this
	# file deliberately holds none — see the header. The rollup decides, and its self-test can drive
	# every combination offline, which a shell pipeline against a live API never could.
	#
	# `earlier_failure` is the fact that makes the judgement possible. `Record gate-off proof` carries
	# a bare `if:`, which implies success(), so `skipped` means EITHER "the gate was on and the leg
	# proceeded" OR "an earlier step failed and we never got here". Those are opposite readings, and
	# the second would print a confident ✅ for a leg that never started — the exact false-green this
	# whole change exists to avoid, pointing the other way. The step numbers are already in the
	# payload, so distinguishing them costs no extra call.
	obs="$(printf '%s' "$jobs" | jq -c --arg run "$run_id" '
    [ .jobs[]
      | select(.name | test("^Provision .*\\(([a-z]+)\\)$"))
      | { provider: (.name | capture("\\((?<p>[a-z]+)\\)$").p),
          steps: (.steps // []),
          run: $run,
          at: .started_at }
      | . as $j
      | ($j.steps | map(select(.name == "Record gate-off proof")) | first) as $gate
      | select($gate != null)
      | { provider: $j.provider,
          gate_off: $gate.conclusion,
          earlier_failure: ([ $j.steps[] | select(.number < $gate.number) | select(.conclusion == "failure") ] | length > 0),
          run: $j.run,
          at: $j.at } ]' 2>/dev/null || echo '[]')"
	for provider in $(printf '%s' "$obs" | jq -r '.[].provider'); do
		case " $seen_providers " in *" $provider "*) continue ;; esac
		seen_providers="$seen_providers $provider"
		one="$(printf '%s' "$obs" | jq -c --arg p "$provider" '[.[] | select(.provider == $p)][0]')"
		observations="$(printf '%s' "$observations" | jq -c --argjson o "$one" '. + [$o]')"
	done
done

jq -n \
	--arg derived_at "$derived_at" \
	--arg repo "$REPO" \
	--argjson open_issues "$issues" \
	--argjson closed_issues "$closed" \
	--argjson variables "$vars" \
	--argjson secrets "$secrets" \
	--argjson gate_observations "$observations" \
	--arg inventory_observed_at "$inventory_observed_at" \
	'{
    "_doc": "GENERATED by scripts/programme-fetch.sh. Do not edit. The LIVE board state PROGRAMME.md cannot derive from the tree. Variable and secret NAMES only — never values.",
    derived_at: $derived_at,
    repo: $repo,
    open_issues: $open_issues,
    closed_issues: $closed_issues,
    variables: $variables,
    secrets: $secrets,
    inventory_observed_at: $inventory_observed_at,
    gate_observations: $gate_observations
  }' >"$OUT"

printf 'programme-fetch: wrote %s — %s open / %s closed issues, %s variables, %s secrets, %s gate observations\n' \
	"$OUT" \
	"$(jq '.open_issues | length' "$OUT")" \
	"$(jq '.closed_issues | length' "$OUT")" \
	"$(jq '.variables | length' "$OUT")" \
	"$(jq '.secrets | length' "$OUT")" \
	"$(jq '.gate_observations | length' "$OUT")"
