// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package drift

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	tfjson "github.com/hashicorp/terraform-json"
)

func loadPlan(t *testing.T, name string) *tfjson.Plan {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	var plan tfjson.Plan
	if err := json.Unmarshal(b, &plan); err != nil {
		t.Fatalf("unmarshal %s: %v", name, err)
	}
	return &plan
}

func TestAnalyzeDrifted(t *testing.T) {
	p := Analyze(loadPlan(t, "drifted.json"))
	if p.InSync {
		t.Fatal("a plan with resource_drift must not be in sync")
	}
	if p.Drifted != 2 {
		t.Fatalf("Drifted = %d, want 2", p.Drifted)
	}
	kinds := map[Kind]int{}
	for _, d := range p.Details {
		kinds[d.Kind]++
	}
	if kinds[KindModified] != 1 || kinds[KindDeleted] != 1 {
		t.Errorf("kinds = %+v, want 1 modified + 1 deleted", kinds)
	}
	// Refresh-only cannot see unmanaged resources — the posture must say so.
	if p.UnmanagedKnown {
		t.Error("UnmanagedKnown must be false for a refresh-only plan")
	}
}

func TestAnalyzeInSync(t *testing.T) {
	p := Analyze(loadPlan(t, "in_sync.json"))
	if !p.InSync || p.Drifted != 0 {
		t.Fatalf("expected in-sync, got InSync=%v Drifted=%d", p.InSync, p.Drifted)
	}
	if p.Summary() != "drift: in sync" {
		t.Errorf("summary = %q", p.Summary())
	}
}

func TestAnalyzeNilPlan(t *testing.T) {
	p := Analyze(nil)
	if !p.InSync {
		t.Error("nil plan should be reported in-sync (nothing to compare)")
	}
}

func TestSummaryDrifted(t *testing.T) {
	p := Analyze(loadPlan(t, "drifted.json"))
	got := p.Summary()
	want := "drift: 2 resource(s) (1 modified, 1 deleted)"
	if got != want {
		t.Errorf("summary = %q, want %q", got, want)
	}
}

func TestDataSourcesAndNoOpIgnored(t *testing.T) {
	plan := &tfjson.Plan{
		ResourceDrift: []*tfjson.ResourceChange{
			{
				Address: "data.aws_ami.x",
				Mode:    tfjson.DataResourceMode,
				Type:    "aws_ami",
				Change:  &tfjson.Change{Actions: tfjson.Actions{tfjson.ActionUpdate}},
			},
			{
				Address: "aws_s3_bucket.y",
				Mode:    tfjson.ManagedResourceMode,
				Type:    "aws_s3_bucket",
				Change:  &tfjson.Change{Actions: tfjson.Actions{tfjson.ActionNoop}},
			},
		},
	}
	p := Analyze(plan)
	if !p.InSync {
		t.Errorf("data-source + no-op drift entries must be ignored, got Drifted=%d", p.Drifted)
	}
}
