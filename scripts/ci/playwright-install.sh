#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# `playwright install --with-deps chromium`, with the third-party apt source it does not need taken
# out of the way, and a retry that clears apt's cache — for the transient case only.
#
# WHY THIS EXISTS (#4499). `--with-deps` shells out to `apt-get update && apt-get install`. GitHub's
# ubuntu runner image ships Google's Chrome channel in `/etc/apt/sources.list.d/`, so every install
# fetches an index from `dl.google.com` — a host this repo does not control and does not need.
#
# On 2026-09-09 that index went bad and stayed bad:
#
#   Err:29 https://dl.google.com/linux/chrome-stable/deb stable/main amd64 Packages
#     Hash Sum mismatch
#   E: Failed to fetch …/binary-amd64/Packages.gz  Hash Sum mismatch
#   E: Some index files failed to download.
#
# `apt-get update` exits non-zero, `--with-deps` aborts, and the leg dies before a browser exists.
# Measured across three branches and three lanes: five-plus failures, zero successes, in ninety
# minutes. Every Playwright job in the repo was affected — including `release-gate.yml`'s, which
# becomes a REQUIRED check on `main`.
#
# ── WHY REMOVING THE SOURCE, NOT ONLY RETRYING ──────────────────────────────────────────────────
#
# A `Hash Sum mismatch` is usually a CACHED bad index: apt keeps the file under
# `/var/lib/apt/lists/` and re-reads it, so a bare re-run fails identically. That is not a guess —
# two dispatches of the same ref twenty-six minutes apart failed the same way, which is precisely
# what a naive retry would have bought.
#
# So the primary fix is to stop depending on that host at all. Playwright's bundled Chromium is
# downloaded from Playwright's own CDN; the Google channel is incidental to the runner image and
# nothing here needs it. The source is moved ASIDE and restored on exit rather than deleted, so a
# later step in the same job that does want it is unaffected.
#
# The retry underneath is for the genuinely transient case — a reset, a timeout, a mirror blip on
# Ubuntu's own hosts — and it CLEARS THE LISTS between attempts, because a retry that re-reads the
# same corrupt cache is theatre.
#
# ── WHAT IT REFUSES TO DO ───────────────────────────────────────────────────────────────────────
#
# A failure that is not apt-shaped fails on the FIRST attempt. Retrying a real failure is how a gate
# quietly stops gating — the same rule `scripts/ci/tofu-test-retry-fetch.sh` states for chart
# fetches, and the reason its self-test pins both directions rather than only the happy one.
#
# Playwright's own errors — a bad browser name, a corrupt download, a version mismatch — are real
# and are not retried.

set -uo pipefail

ATTEMPTS="${PW_INSTALL_ATTEMPTS:-3}"
# The sources Playwright does not need. Kept as a list because the runner image has carried more
# than one third-party channel over time, and a second one failing the same way should cost a line
# rather than a debugging session.
UNNEEDED_SOURCES=(
	/etc/apt/sources.list.d/google-chrome.list
	/etc/apt/sources.list.d/google-chrome-unstable.list
)

# ── the classifier ──────────────────────────────────────────────────────────────────────────────
#
# Kept HERE rather than in a shared file, unlike the chart-fetch classifier: that one is read by two
# consumers and would drift; this one has a single reader. If a second consumer appears, move it
# out — the drift risk is the reason, not the file count.
#
# Deliberately NOT matched: "Unable to locate package" (a real, permanent error — the package name
# is wrong), and any Playwright-level failure. Both are things a retry would only make slower.
is_transient_apt_failure() {
	grep -qiE \
		'Hash Sum mismatch|Failed to fetch|Could not resolve|Connection (timed out|failed|reset)|Temporary failure resolving|index files failed to download|503 +Service Unavailable|Undetermined Error' \
		"$1"
}

# ── the run ─────────────────────────────────────────────────────────────────────────────────────

# The restore state is FILE-SCOPED, not `local` to main, and that is the whole point (#4511).
#
# An EXIT trap runs after `main` has returned, so bash's dynamic scoping has already discarded
# anything `local` to it. With `set -u` in force the trap then dies on `restore_needed: unbound
# variable` — and because a trap's failure is the script's exit status, EVERY Playwright leg went
# red immediately AFTER reporting `playwright-install: ok on attempt 1`. An install that succeeds
# and then fails the job is worse than one that fails outright: the log's last useful line says it
# worked.
MOVED_SOURCES=()
RESTORE_NEEDED=0

# Restore on EVERY exit path, so a later step in the same job sees the image it expected.
restore() {
	[ "$RESTORE_NEEDED" = "1" ] || return 0
	local src
	for src in "${MOVED_SOURCES[@]}"; do sudo mv "$src.alethia-disabled" "$src" 2>/dev/null || true; done
}

main() {
	local src
	for src in "${UNNEEDED_SOURCES[@]}"; do
		if [ -f "$src" ]; then
			if sudo mv "$src" "$src.alethia-disabled" 2>/dev/null; then
				MOVED_SOURCES+=("$src")
				RESTORE_NEEDED=1
				echo "playwright-install: set aside $src (not needed for Chromium; #4499)"
			fi
		fi
	done
	trap restore EXIT

	local log attempt=1 rc
	log="$(mktemp)"
	while :; do
		echo "playwright-install: attempt ${attempt}/${ATTEMPTS}"
		set +e
		pnpm -F console exec playwright install --with-deps chromium 2>&1 | tee "$log"
		rc=${PIPESTATUS[0]}
		set -e
		[ "$rc" -eq 0 ] && { echo "playwright-install: ok on attempt ${attempt}"; return 0; }

		if ! is_transient_apt_failure "$log"; then
			echo "::error::playwright install failed for a reason that is not a transient apt fetch — NOT retrying. Retrying a real failure is how a gate stops gating."
			return "$rc"
		fi
		if [ "$attempt" -ge "$ATTEMPTS" ]; then
			echo "::error::playwright install failed ${ATTEMPTS} times on a transient apt fetch. This is an availability problem on an apt mirror, NOT this branch — see #4499 before reading it as a broken suite."
			return "$rc"
		fi
		# The cache is the point: a Hash Sum mismatch re-reads the bad file otherwise.
		echo "playwright-install: transient apt failure — clearing lists and retrying"
		sudo rm -rf /var/lib/apt/lists/* 2>/dev/null || true
		attempt=$((attempt + 1))
		sleep $((attempt * 5))
	done
}

# ── --self-test ─────────────────────────────────────────────────────────────────────────────────
#
# What it has to prove, and why each earns its place:
#
#  · a REAL failure is not retried — the whole risk of this file;
#  · a transient one IS, and the cache is cleared between attempts — asserting the exit code alone
#    cannot see either, so the classifier is driven directly over recorded fixtures;
#  · the classifier recognises the shape that actually happened on 2026-09-09, byte for byte from
#    the run log, so a future edit that "tidies" the pattern fails here rather than in a promotion.
self_test() {
	local pass=0 fail=0 t
	check() { if [ "$2" = "1" ]; then echo "ok   - $1"; pass=$((pass+1)); else echo "FAIL - $1"; fail=$((fail+1)); fi; }

	t="$(mktemp)"
	# The exact text from run 34383287381.
	cat > "$t" <<'FIX'
Get:29 https://dl.google.com/linux/chrome-stable/deb stable/main amd64 Packages [1405 B]
Err:29 https://dl.google.com/linux/chrome-stable/deb stable/main amd64 Packages
  Hash Sum mismatch
E: Failed to fetch https://dl.google.com/linux/chrome-stable/deb/dists/stable/main/binary-amd64/Packages.gz  Hash Sum mismatch
E: Some index files failed to download. They have been ignored, or old ones used instead.
FIX
	is_transient_apt_failure "$t" && check "the 2026-09-09 Hash Sum mismatch is classified transient" 1 || check "the 2026-09-09 Hash Sum mismatch is classified transient" 0

	printf 'E: Unable to locate package chromiumm\n' > "$t"
	is_transient_apt_failure "$t" && check "a wrong package name is NOT retried" 0 || check "a wrong package name is NOT retried" 1

	printf 'Error: Unknown browser "chromiumm"\n' > "$t"
	is_transient_apt_failure "$t" && check "a Playwright-level error is NOT retried" 0 || check "a Playwright-level error is NOT retried" 1

	printf 'browserType.launch: Executable does not exist\n' > "$t"
	is_transient_apt_failure "$t" && check "a launch failure is NOT retried" 0 || check "a launch failure is NOT retried" 1

	printf 'E: Failed to fetch http://archive.ubuntu.com/... Connection timed out\n' > "$t"
	is_transient_apt_failure "$t" && check "an Ubuntu-mirror timeout IS retried" 1 || check "an Ubuntu-mirror timeout IS retried" 0

	printf 'Temporary failure resolving archive.ubuntu.com\n' > "$t"
	is_transient_apt_failure "$t" && check "a DNS blip IS retried" 1 || check "a DNS blip IS retried" 0

	: > "$t"
	is_transient_apt_failure "$t" && check "an EMPTY log is not read as transient" 0 || check "an EMPTY log is not read as transient" 1

	# The source list must name the file that actually failed, or the primary fix is inert.
	printf '%s\n' "${UNNEEDED_SOURCES[@]}" | grep -q 'google-chrome.list' \
		&& check "the source that failed on 2026-09-09 is in UNNEEDED_SOURCES" 1 \
		|| check "the source that failed on 2026-09-09 is in UNNEEDED_SOURCES" 0

	# THE CASE THIS SUITE DID NOT HAVE, AND THAT COST EVERY PLAYWRIGHT LEG (#4511).
	#
	# Every check above reads the CLASSIFIER — a pure function over a log file. Nothing ran the
	# EXIT trap, so nothing noticed that its state was `local` to `main`: the trap fires after main
	# returns, bash has already discarded those locals, and `set -u` turned that into
	# `restore_needed: unbound variable`. A trap's failure is the script's exit status, so the leg
	# died with `playwright-install: ok on attempt 1` as its last useful line.
	#
	# The subshell reproduces the trap's real conditions — `set -u` on, no function frame in scope.
	# It fails before the fix and passes after, which is the only property that makes it a test
	# rather than a restatement.
	if ( set -u; restore ) >/dev/null 2>&1; then
		check "restore runs under set -u with no function frame, as the EXIT trap does" 1
	else
		check "restore runs under set -u with no function frame, as the EXIT trap does" 0
	fi

	echo
	echo "  ${pass} passed, ${fail} failed"
	[ "$fail" -eq 0 ]
}

case "${1:-}" in
	--self-test) self_test ;;
	*) main "$@" ;;
esac
