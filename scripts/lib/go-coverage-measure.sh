# shellcheck shell=bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The Go statement-coverage measurement, in ONE place.
#
# Extracted from scripts/go-coverage.sh (#1990) so the CLI's absolute-threshold gate
# (apps/cli/scripts/coverage.sh) and the per-package ratchet share a definition instead of
# holding two. They ask different questions — "is this above 90%" versus "did this get worse" —
# but they must agree on what the number IS, and before this they did not: the gate used
# `go tool cover -func` and reported 92.7% for a scope the profile puts at 60.9%.
#
# ── WHY IT PARSES THE PROFILE AND NEVER `go tool cover -func` ─────────────────────────────────
#
# `-func` walks *ast.FuncDecl only. Every statement inside a package-level initializer — which is
# where the entire CLI lives, `var xCmd = &cobra.Command{RunE: func(...) {...}}` — belongs to no
# FuncDecl, so `-func` drops it from BOTH the numerator and the denominator. A gate built on it
# is blind to exactly the code most likely to regress.
#
# This file is SOURCED. It defines one function and runs nothing.

# ── measure: coverprofile -> "<module-relative package> <covered> <total>", sorted ─────────────
# Integers only. Exits 9 on an unrecognised mode line so the caller can fail OPEN.
measure() { # $1 = profile path, $2 = module import path
	awk -v modpath="$2" '
		NR == 1 {
			if ($0 !~ /^mode: (set|count|atomic)$/) { exit 9 }
			next
		}
		NF < 3 { next }   # tolerate a blank or truncated trailing line
		{
			blk = $1                       # "<importpath>/<file>.go:sL.sC,eL.eC" — the dedupe key
			n = $(NF - 1) + 0
			c = $NF + 0
			key = blk
			sub(/:[0-9]+\.[0-9]+,[0-9]+\.[0-9]+$/, "", key)   # -> "<importpath>/<file>.go"
			sub(/\/[^\/]+$/, "", key)                          # -> "<importpath>"
			# A block can legitimately repeat if -coverpkg is ever added. Count its statements
			# ONCE, and treat it as covered if ANY occurrence ran. `c > 0` (never `c == 1`) is
			# what makes this correct for set, count and atomic alike.
			if (!(blk in seen)) { seen[blk] = 1; tot[key] += n }
			if (c > 0 && !(blk in hit)) { hit[blk] = 1; cov[key] += n }
		}
		END {
			for (k in tot) {
				# Exact prefix strip — NOT a regex, because an import path is full of dots that
				# a regex would treat as wildcards.
				if (substr(k, 1, length(modpath)) == modpath) {
					rel = substr(k, length(modpath) + 1)
					sub(/^\//, "", rel)
					if (rel == "") rel = "."
				} else {
					rel = k
				}
				printf "%s %d %d\n", rel, cov[k] + 0, tot[k]
			}
		}
	' "$1" | sort
}
