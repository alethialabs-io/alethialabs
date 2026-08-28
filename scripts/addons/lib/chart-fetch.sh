#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# A chart we could not REACH is not a chart that renders wrongly (#2754).
#
# `check-render-determinism.sh` and `check-published-defaults.sh` both fetch every catalogued
# add-on's chart live from its upstream repo on every run — 17 third-party hosts. A TCP reset
# from one of them produced an empty render, which both scripts reported as
#
#     RENDER FAILED  keda — Error: Get "https://kedacore.github.io/charts/keda-2.15.1.tgz":
#                    read: connection reset by peer
#     FAIL: chart(s) did not render at all: keda velero
#
# — a sentence about OUR catalogue, for something that happened on someone else's server. It
# red the `Add-on chart guards` job three times on 2026-08-28 alone.
#
# Both scripts also swallowed the fetch itself: `helm repo add … || true` and
# `helm repo update … || true` discard the error, so a repo that never resolved surfaced later
# as an inscrutable per-chart failure with no mention of the repo.
#
# This is the same correction already made for `tofu test` in
# `scripts/ci/tofu-test-retry-fetch.sh`: retry ONLY a network-shaped failure, name the host,
# and keep the verdict fail-closed. It does NOT weaken either guard — a chart that fetches and
# then renders wrongly still fails on the first attempt, because only the fetch is retried.

# Network-shaped, deliberately not a catch-all. `unexpected EOF` is omitted on purpose: it is
# also how a malformed template fails, and retrying a real template defect three times before
# calling it unreachable is the same misdirection this file exists to remove, pointed the
# other way.
CHART_FETCH_NET_ERR='connection reset by peer|context deadline exceeded|Client\.Timeout|TLS handshake timeout|no such host|i/o timeout|temporary failure in name resolution|502 Bad Gateway|503 Service Unavailable|dial tcp'

CHART_FETCH_ATTEMPTS="${CHART_FETCH_ATTEMPTS:-3}"

# chart_fetch_is_net_err <file> — true when the captured stderr names a transport problem.
chart_fetch_is_net_err() {
	[ -s "${1:-}" ] || return 1
	grep -qEi "$CHART_FETCH_NET_ERR" "$1" 2>/dev/null
}

# chart_fetch_repo_update <errfile> — `helm repo update`, retried on a network-shaped failure.
# Announces a failure instead of discarding it, so the per-chart errors below are readable.
chart_fetch_repo_update() {
	local err="${1:?chart_fetch_repo_update needs an error file}" n=1
	while :; do
		if helm repo update >/dev/null 2>"$err"; then return 0; fi
		if [ "$n" -ge "$CHART_FETCH_ATTEMPTS" ] || ! chart_fetch_is_net_err "$err"; then
			echo "::warning title=chart index fetch (#2754)::helm repo update did not complete after ${n} attempt(s): $(head -1 "$err" | cut -c1-160). Per-chart failures below may be FETCH failures, not render failures."
			return 1
		fi
		sleep $((n * 5))
		n=$((n + 1))
	done
}

# chart_fetch_host <errfile> — the first URL host named in the error, for the operator.
chart_fetch_host() {
	local h
	h="$(grep -oE 'https?://[a-zA-Z0-9._-]+' "${1:-/dev/null}" 2>/dev/null | head -1 || true)"
	printf '%s' "${h:-an upstream chart repository}"
}
