// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"testing"
	"time"
)

// failingReport builds a report with two failing controls for override tests.
func failingReport() *Report {
	return &Report{
		Verdict:        StatusFail,
		CatalogVersion: CatalogVersion,
		Controls: []ControlResult{
			{ID: "KEYLESS-001", Status: StatusFail},
			{ID: "LEASTPRIV-001", Status: StatusFail},
			{ID: "OIDC-001", Status: StatusPass},
		},
	}
}

func TestUnwaived_NoOverride(t *testing.T) {
	got := failingReport().Unwaived(nil)
	if len(got) != 2 {
		t.Fatalf("no override: want 2 unwaived, got %v", got)
	}
}

func TestUnwaived_PartialOverride(t *testing.T) {
	ov := &Override{Controls: []string{"KEYLESS-001"}, Reason: "legacy CI", By: "alice", Expiry: time.Now().Add(time.Hour)}
	got := failingReport().Unwaived(ov)
	if len(got) != 1 || got[0] != "LEASTPRIV-001" {
		t.Fatalf("partial override: want [LEASTPRIV-001], got %v", got)
	}
}

func TestUnwaived_FullOverride(t *testing.T) {
	ov := &Override{Controls: []string{"KEYLESS-001", "LEASTPRIV-001"}, Expiry: time.Now().Add(time.Hour)}
	if got := failingReport().Unwaived(ov); len(got) != 0 {
		t.Fatalf("full override: want none unwaived, got %v", got)
	}
}

func TestUnwaived_ExpiredOverrideIgnored(t *testing.T) {
	ov := &Override{Controls: []string{"KEYLESS-001", "LEASTPRIV-001"}, Expiry: time.Now().Add(-time.Minute)}
	if got := failingReport().Unwaived(ov); len(got) != 2 {
		t.Fatalf("expired override must not waive anything, got %v", got)
	}
}
