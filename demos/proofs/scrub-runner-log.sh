#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# scrub-runner-log.sh — produce an uploadable copy of the T2 runner log (#1854).
#
# The nightly uploads the runner log as a short-retention debug artifact. It used to upload
# `t2-runner.log` VERBATIM, which published a live HCLOUD_TOKEN on a public repository: the
# harness writes a `tofu show -json` plan into that log, and OpenTofu emits the root module's
# `variables` map with RAW values — `sensitive = true` on the variable does not cover it.
#
# capture-proof.sh already scrubbed the same file into the proof bundle. The leak and the scrub
# read the same source; only the upload path differed. This script closes that path, and is
# FAIL-CLOSED: if any secret survives the scrub, it exits non-zero and the step goes red rather
# than uploading. Losing a debug artifact is cheaper than publishing a credential.
#
# Usage:  scrub-runner-log.sh <raw-log> <output-dir>
# Writes: <output-dir>/t2-runner.log  (scrubbed)
#
# Exits 0 and writes nothing when the raw log is absent — a leg that green-skips or dies before
# the harness runs produces no log, and that is not an error.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=demos/proofs/scrub.sh
source "$root/demos/proofs/scrub.sh"

raw="${1:?usage: scrub-runner-log.sh <raw-log> <output-dir>}"
out="${2:?usage: scrub-runner-log.sh <raw-log> <output-dir>}"

if [ ! -f "$raw" ]; then
	echo "no runner log at $raw — nothing to scrub (leg skipped or died before the harness)"
	exit 0
fi

mkdir -p "$out"
# Build the exact-value literal list from the run's credentials — the same list capture-proof.sh
# uses, from the same definition, so the two artifacts can never again disagree about what is
# secret.
scrub_literals_from_env
scrub_stream <"$raw" >"$out/t2-runner.log"

# Fail-closed tripwire over what we are about to upload. Deliberately the same assertion the
# proof bundle gets: an artifact is either scrubbed or it is not published.
if ! assert_grep_clean "$out"; then
	echo "::error::scrub-runner-log: refusing to upload — a secret survived the scrub of $raw" >&2
	rm -f "$out/t2-runner.log"
	exit 1
fi

echo "✓ runner log scrubbed + grep-clean: $out/t2-runner.log"
