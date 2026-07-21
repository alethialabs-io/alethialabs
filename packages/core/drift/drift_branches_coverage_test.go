// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package drift

import (
	"testing"

	tfjson "github.com/hashicorp/terraform-json"
)

// managedChange builds a managed ResourceChange with the given drift actions.
func managedChange(addr, typ string, acts tfjson.Actions) *tfjson.ResourceChange {
	return &tfjson.ResourceChange{
		Address: addr,
		Mode:    tfjson.ManagedResourceMode,
		Type:    typ,
		Change:  &tfjson.Change{Actions: acts},
	}
}

// TestClassifyKinds exercises classify (via Analyze) across every action shape,
// including the default → KindOther branch that the existing suite never hits.
func TestClassifyKinds(t *testing.T) {
	cases := []struct {
		name string
		acts tfjson.Actions
		want Kind
	}{
		{"delete", tfjson.Actions{tfjson.ActionDelete}, KindDeleted},
		{"update", tfjson.Actions{tfjson.ActionUpdate}, KindModified},
		{"create", tfjson.Actions{tfjson.ActionCreate}, KindOther},
		{"replace", tfjson.Actions{tfjson.ActionDelete, tfjson.ActionCreate}, KindOther},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			plan := &tfjson.Plan{
				ResourceDrift: []*tfjson.ResourceChange{
					managedChange("aws_s3_bucket.b", "aws_s3_bucket", tc.acts),
				},
			}
			p := Analyze(plan)
			if p.InSync {
				t.Fatalf("%s: a real drift action must not be in-sync", tc.name)
			}
			if p.Drifted != 1 || len(p.Details) != 1 {
				t.Fatalf("%s: Drifted=%d len(Details)=%d, want 1/1", tc.name, p.Drifted, len(p.Details))
			}
			if got := p.Details[0].Kind; got != tc.want {
				t.Errorf("%s: Kind = %q, want %q", tc.name, got, tc.want)
			}
			if p.Details[0].Address != "aws_s3_bucket.b" || p.Details[0].Type != "aws_s3_bucket" {
				t.Errorf("%s: detail address/type not preserved: %+v", tc.name, p.Details[0])
			}
		})
	}
}

// TestAnalyzeSkipsNilEntries covers the two guard branches in Analyze: a nil
// ResourceChange pointer and a ResourceChange with a nil Change. Both must be
// skipped without panicking, leaving only the real drift counted.
func TestAnalyzeSkipsNilEntries(t *testing.T) {
	plan := &tfjson.Plan{
		ResourceDrift: []*tfjson.ResourceChange{
			nil, // nil entry — must be skipped, not a nil-deref panic
			{Address: "aws_db_instance.x", Mode: tfjson.ManagedResourceMode, Type: "aws_db_instance", Change: nil}, // nil Change — skipped
			managedChange("aws_db_instance.real", "aws_db_instance", tfjson.Actions{tfjson.ActionUpdate}),
		},
	}
	p := Analyze(plan)
	if p.Drifted != 1 {
		t.Fatalf("Drifted = %d, want 1 (nil entries skipped)", p.Drifted)
	}
	if p.InSync {
		t.Error("one real drift must not be in-sync")
	}
	if p.Details[0].Address != "aws_db_instance.real" {
		t.Errorf("wrong surviving detail: %+v", p.Details[0])
	}
}

// TestAnalyzeEmptyDriftIsInSync covers a non-nil plan whose drift section is
// empty — the loop body never runs and the posture is in-sync.
func TestAnalyzeEmptyDriftIsInSync(t *testing.T) {
	p := Analyze(&tfjson.Plan{ResourceDrift: nil})
	if !p.InSync || p.Drifted != 0 {
		t.Fatalf("empty drift: InSync=%v Drifted=%d, want true/0", p.InSync, p.Drifted)
	}
}

// TestUnmanagedNeverClaimedChecked pins the honest-scope contract: a refresh-only
// plan can never see unmanaged resources, so Analyze must always report
// Unmanaged=0 and UnmanagedKnown=false regardless of how much managed drift exists.
func TestUnmanagedNeverClaimedChecked(t *testing.T) {
	plan := &tfjson.Plan{
		ResourceDrift: []*tfjson.ResourceChange{
			managedChange("a.a", "a", tfjson.Actions{tfjson.ActionDelete}),
			managedChange("b.b", "b", tfjson.Actions{tfjson.ActionUpdate}),
		},
	}
	p := Analyze(plan)
	if p.Unmanaged != 0 {
		t.Errorf("Unmanaged = %d, want 0 (refresh-only cannot see unmanaged)", p.Unmanaged)
	}
	if p.UnmanagedKnown {
		t.Error("UnmanagedKnown must be false — unmanaged detection did not run")
	}
}

// TestSummaryNilReceiver covers the nil-posture branch of Summary.
func TestSummaryNilReceiver(t *testing.T) {
	var p *Posture
	if got := p.Summary(); got != "drift: unknown" {
		t.Errorf("nil Summary() = %q, want %q", got, "drift: unknown")
	}
}

// TestSummaryAllKinds covers the KindOther branch of Summary and the ordering of
// the modified/deleted/other segments in the rendered one-liner.
func TestSummaryAllKinds(t *testing.T) {
	plan := &tfjson.Plan{
		ResourceDrift: []*tfjson.ResourceChange{
			managedChange("m.m", "m", tfjson.Actions{tfjson.ActionUpdate}),
			managedChange("d.d", "d", tfjson.Actions{tfjson.ActionDelete}),
			managedChange("o.o", "o", tfjson.Actions{tfjson.ActionCreate}),
		},
	}
	p := Analyze(plan)
	want := "drift: 3 resource(s) (1 modified, 1 deleted, 1 other)"
	if got := p.Summary(); got != want {
		t.Errorf("Summary() = %q, want %q", got, want)
	}
}

// TestSummaryOtherOnly covers the branch where only KindOther drift exists, so the
// summary must omit the modified/deleted segments entirely.
func TestSummaryOtherOnly(t *testing.T) {
	plan := &tfjson.Plan{
		ResourceDrift: []*tfjson.ResourceChange{
			managedChange("o1.o", "o", tfjson.Actions{tfjson.ActionCreate}),
			managedChange("o2.o", "o", tfjson.Actions{tfjson.ActionDelete, tfjson.ActionCreate}),
		},
	}
	p := Analyze(plan)
	want := "drift: 2 resource(s) (2 other)"
	if got := p.Summary(); got != want {
		t.Errorf("Summary() = %q, want %q", got, want)
	}
}
