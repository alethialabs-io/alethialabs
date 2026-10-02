// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// reasonsTSRel is the console's fixed set of mint failure sentences (#5281). The console stores a
// posted reason only on an EXACT match, so a Go sentence that drifts by one byte degrades every such
// failure to the generic one — silently, with every test on both sides still green. This file pins
// the two lists to each other.
const reasonsTSRel = "apps/console/lib/kubeconfig-mint/reasons.ts"

// tsStringLiteral matches one double-quoted TS string literal.
var tsStringLiteral = regexp.MustCompile(`"((?:[^"\\]|\\.)*)"`)

// parseConsoleReasons reads KUBECONFIG_MINT_FAILURE_REASONS out of reasons.ts: its entries are string
// literals or the KUBECONFIG_MINT_UNKNOWN_FAILURE constant, with line comments allowed between them.
func parseConsoleReasons(t *testing.T, src string) []string {
	t.Helper()
	unknownRe := regexp.MustCompile(`(?s)export const KUBECONFIG_MINT_UNKNOWN_FAILURE\s*=\s*("(?:[^"\\]|\\.)*")\s*;`)
	m := unknownRe.FindStringSubmatch(src)
	if m == nil {
		t.Fatalf("%s: KUBECONFIG_MINT_UNKNOWN_FAILURE not found", reasonsTSRel)
	}
	unknown, err := strconv.Unquote(m[1])
	if err != nil {
		t.Fatalf("unquote %s: %v", m[1], err)
	}
	listRe := regexp.MustCompile(`(?s)export const KUBECONFIG_MINT_FAILURE_REASONS[^=]*=\s*\[(.*?)\];`)
	lm := listRe.FindStringSubmatch(src)
	if lm == nil {
		t.Fatalf("%s: KUBECONFIG_MINT_FAILURE_REASONS not found", reasonsTSRel)
	}
	var out []string
	for _, line := range strings.Split(lm[1], "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "//") {
			continue
		}
		if strings.TrimSuffix(line, ",") == "KUBECONFIG_MINT_UNKNOWN_FAILURE" {
			out = append(out, unknown)
			continue
		}
		lit := tsStringLiteral.FindStringSubmatch(line)
		if lit == nil || strings.TrimSuffix(strings.TrimPrefix(line, lit[0]), ",") != "" {
			t.Fatalf("%s: an entry this test cannot read: %q", reasonsTSRel, line)
		}
		s, err := strconv.Unquote(lit[0])
		if err != nil {
			t.Fatalf("unquote %s: %v", lit[0], err)
		}
		out = append(out, s)
	}
	return out
}

// TestMintFailureReasons_MatchTheConsoleList fails when the Go sentences and the console's drift
// apart in any direction: a sentence added, removed, reordered or changed by one byte on either side.
func TestMintFailureReasons_MatchTheConsoleList(t *testing.T) {
	root := monorepoRoot(t)
	if root == "" {
		t.Skip("not inside the monorepo (no go.work above); the console's reasons.ts is not here to compare")
	}
	src, err := os.ReadFile(filepath.Join(root, reasonsTSRel))
	if err != nil {
		t.Fatalf("read %s: %v", reasonsTSRel, err)
	}
	ts := parseConsoleReasons(t, string(src))
	if len(ts) != len(mintFailureReasons) {
		t.Fatalf("console has %d reasons, Go has %d:\nconsole: %q\ngo:      %q", len(ts), len(mintFailureReasons), ts, mintFailureReasons)
	}
	for i := range ts {
		if ts[i] != mintFailureReasons[i] {
			t.Fatalf("reason %d differs:\nconsole: %q\ngo:      %q", i, ts[i], mintFailureReasons[i])
		}
	}
	if mintFailureReasons[0] != mintReasonUnknown {
		t.Fatal("the generic sentence must be the console's KUBECONFIG_MINT_UNKNOWN_FAILURE")
	}
	for _, r := range mintFailureReasons {
		if len(r) > types.KubeconfigMintFailureReasonMaxLength {
			t.Fatalf("%q is over the wire bound", r)
		}
	}
}

// TestParseConsoleReasons_ReadsTheShapes proves the parser itself: it takes the constant, literals
// and comments, and refuses an entry it does not understand rather than skipping it.
func TestParseConsoleReasons_ReadsTheShapes(t *testing.T) {
	src := `export const KUBECONFIG_MINT_UNKNOWN_FAILURE =
	"Generic.";
export const KUBECONFIG_MINT_FAILURE_REASONS: readonly string[] = [
	KUBECONFIG_MINT_UNKNOWN_FAILURE,
	// a comment with "quotes"
	"The cluster's \"A\".",
];`
	got := parseConsoleReasons(t, src)
	if len(got) != 2 || got[0] != "Generic." || got[1] != `The cluster's "A".` {
		t.Fatalf("parsed %q", got)
	}
}
