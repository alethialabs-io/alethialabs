// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build !e2e_t1 && !e2e_t2 && !e2e_b6

package e2e

import (
	"strings"
	"testing"
)

// describeShape is the order kubectl actually prints: identity, then the spec, then the part that
// says what went wrong.
func describeShape(specLen int) string {
	return "Name:         addon-kube-prometheus-stack\nNamespace:    argocd\n" +
		"Labels:       alethia.io/addon-id=kube-prometheus-stack\n" +
		"Spec:\n" + strings.Repeat("v", specLen) +
		"\nStatus:\n  Health:  Missing\n  Conditions:  ComparisonError\nEvents:  ResourceUpdateFailed\n"
}

func TestTruncateDescribeKeepsTheStatusAndTheIdentity(t *testing.T) {
	in := describeShape(20000)
	got := truncateDescribe(in, 600, 2500)

	// The head: what the app IS.
	if !strings.Contains(got, "Name:         addon-kube-prometheus-stack") {
		t.Error("the identity block was dropped")
	}
	// The tail: what went WRONG. This is the half the old truncation cut, and it is the reason the
	// function exists.
	for _, want := range []string{"Status:", "Health:  Missing", "ComparisonError", "Events:"} {
		if !strings.Contains(got, want) {
			t.Errorf("the tail lost %q — that is the whole point", want)
		}
	}
	if len(got) > 2500+200 {
		t.Errorf("kept %d characters against a budget of 2500", len(got))
	}
}

func TestTruncateDescribeSaysHowMuchItDropped(t *testing.T) {
	got := truncateDescribe(describeShape(20000), 600, 2500)
	if !strings.Contains(got, "characters of the spec dropped") {
		t.Errorf("a truncation that does not admit its size reads as a complete document:\n%s", got[:200])
	}
}

func TestTruncateDescribeLeavesShortOutputAlone(t *testing.T) {
	in := describeShape(10)
	if got := truncateDescribe(in, 600, 2500); got != in {
		t.Errorf("output under budget was modified")
	}
}

// A head budget that swallows the whole allowance would reproduce the bug this replaced: all head,
// no tail. It must fall back to keeping the tail rather than honour it.
func TestTruncateDescribeRefusesAHeadThatLeavesNoTail(t *testing.T) {
	got := truncateDescribe(describeShape(20000), 2500, 2500)
	if !strings.Contains(got, "Health:  Missing") {
		t.Errorf("a head budget equal to the total dropped the status:\n%s", got[:200])
	}
	got = truncateDescribe(describeShape(20000), -5, 2500)
	if !strings.Contains(got, "Health:  Missing") {
		t.Errorf("a negative head budget dropped the status")
	}
}
