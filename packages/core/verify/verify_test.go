// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	tfjson "github.com/hashicorp/terraform-json"
)

// loadPlan reads a fixture plan JSON from testdata.
func loadPlan(t *testing.T, name string) *tfjson.Plan {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	var plan tfjson.Plan
	if err := json.Unmarshal(b, &plan); err != nil {
		t.Fatalf("unmarshal fixture %s: %v", name, err)
	}
	return &plan
}

// mustPlan parses an inline plan JSON string into a *tfjson.Plan.
func mustPlan(t *testing.T, raw string) *tfjson.Plan {
	t.Helper()
	var plan tfjson.Plan
	if err := json.Unmarshal([]byte(raw), &plan); err != nil {
		t.Fatalf("unmarshal inline plan: %v", err)
	}
	return &plan
}

// evalFixture is a convenience that loads + evaluates a fixture.
func evalFixture(t *testing.T, name string) *Report {
	t.Helper()
	rep, err := Evaluate(context.Background(), loadPlan(t, name))
	if err != nil {
		t.Fatalf("Evaluate(%s): %v", name, err)
	}
	return rep
}

// controlByID finds a control in a report.
func controlByID(t *testing.T, rep *Report, id string) ControlResult {
	t.Helper()
	for _, c := range rep.Controls {
		if c.ID == id {
			return c
		}
	}
	t.Fatalf("control %s not found in report", id)
	return ControlResult{}
}

// TestVerdicts pins the overall gate verdict for each fixture — the headline
// Phase-0 behaviour: a bad plan is blocked, a clean keyless plan passes, and an
// un-inspectable plan is surfaced as not_evaluable (never a silent pass).
func TestVerdicts(t *testing.T) {
	cases := []struct {
		fixture string
		want    Status
	}{
		{"fail_static_key_admin.json", StatusFail},
		{"pass_keyless_least_priv.json", StatusPass},
		{"not_evaluable_computed_policy.json", StatusNotEvaluable},
		{"fail_wildcard_sub.json", StatusFail},
		{"warn_sensitive_wildcard.json", StatusWarn},
		{"fail_notaction.json", StatusFail},
	}
	for _, tc := range cases {
		t.Run(tc.fixture, func(t *testing.T) {
			rep := evalFixture(t, tc.fixture)
			if rep.Verdict != tc.want {
				t.Errorf("verdict = %q, want %q (controls: %+v)", rep.Verdict, tc.want, rep.Controls)
			}
			if rep.CatalogVersion != CatalogVersion {
				t.Errorf("catalog version = %q, want %q", rep.CatalogVersion, CatalogVersion)
			}
		})
	}
}

// TestStaticKeyBlocks asserts the static-key control fails and names the key,
// and that the report blocks a real apply.
func TestStaticKeyBlocks(t *testing.T) {
	rep := evalFixture(t, "fail_static_key_admin.json")
	if !rep.Blocking() {
		t.Fatal("report with a static key + admin attach must block")
	}
	keyless := controlByID(t, rep, "KEYLESS-001")
	if keyless.Status != StatusFail {
		t.Errorf("KEYLESS-001 = %q, want fail", keyless.Status)
	}
	if len(keyless.Findings) != 1 || keyless.Findings[0].Address != "aws_iam_access_key.ci" {
		t.Errorf("KEYLESS-001 findings = %+v, want one for aws_iam_access_key.ci", keyless.Findings)
	}
	// The AdministratorAccess attachment must also trip least-privilege.
	lp := controlByID(t, rep, "LEASTPRIV-001")
	if lp.Status != StatusFail {
		t.Errorf("LEASTPRIV-001 = %q, want fail (AdministratorAccess attach)", lp.Status)
	}
}

// TestWildcardSubBlocks is the regression test for the OIDC footgun: a `sub`
// constrained only by StringLike with a wildcard must fail (it previously would
// have passed — the spec bug the red-team caught).
func TestWildcardSubBlocks(t *testing.T) {
	rep := evalFixture(t, "fail_wildcard_sub.json")
	oidc := controlByID(t, rep, "OIDC-001")
	if oidc.Status != StatusFail {
		t.Fatalf("OIDC-001 = %q, want fail for wildcard StringLike sub", oidc.Status)
	}
	if len(oidc.Findings) == 0 {
		t.Fatal("OIDC-001 must report a finding for the wildcard sub")
	}
}

// TestKeylessPasses asserts the good keyless/least-privilege plan passes every
// control cleanly.
func TestKeylessPasses(t *testing.T) {
	rep := evalFixture(t, "pass_keyless_least_priv.json")
	if rep.Verdict != StatusPass {
		t.Fatalf("verdict = %q, want pass", rep.Verdict)
	}
	for _, c := range rep.Controls {
		if c.Status == StatusFail || c.Status == StatusWarn {
			t.Errorf("control %s = %q with findings %+v, want pass", c.ID, c.Status, c.Findings)
		}
	}
	oidc := controlByID(t, rep, "OIDC-001")
	if oidc.Status != StatusPass {
		t.Errorf("OIDC-001 = %q, want pass (StringEquals sub)", oidc.Status)
	}
}

// TestComputedPolicyNotEvaluable asserts an unknown-until-apply policy body is
// surfaced as not_evaluable with a coverage note — the anti-false-PASS guarantee.
func TestComputedPolicyNotEvaluable(t *testing.T) {
	rep := evalFixture(t, "not_evaluable_computed_policy.json")
	lp := controlByID(t, rep, "LEASTPRIV-001")
	if lp.Status != StatusNotEvaluable {
		t.Fatalf("LEASTPRIV-001 = %q, want not_evaluable for computed policy body", lp.Status)
	}
	if lp.Coverage == "" {
		t.Error("not_evaluable control must carry a coverage note explaining why")
	}
}

// TestNilPlan asserts a nil plan is handled fail-safe (not_evaluable, no panic).
func TestNilPlan(t *testing.T) {
	rep, err := Evaluate(context.Background(), nil)
	if err != nil {
		t.Fatalf("Evaluate(nil): %v", err)
	}
	if rep.Verdict != StatusNotEvaluable {
		t.Errorf("nil plan verdict = %q, want not_evaluable", rep.Verdict)
	}
}

// TestSummaryTally checks the summary counts add up to the number of controls.
func TestSummaryTally(t *testing.T) {
	rep := evalFixture(t, "fail_static_key_admin.json")
	total := rep.Summary.Pass + rep.Summary.Fail + rep.Summary.Warn + rep.Summary.NotEvaluable
	if total != len(rep.Controls) {
		t.Errorf("summary total %d != control count %d", total, len(rep.Controls))
	}
}

// TestDeletesIgnored ensures a pure delete of a static key is not flagged (the
// key is going away, not being created).
func TestDeletesIgnored(t *testing.T) {
	plan := &tfjson.Plan{
		ResourceChanges: []*tfjson.ResourceChange{
			{
				Address: "aws_iam_access_key.old",
				Mode:    tfjson.ManagedResourceMode,
				Type:    "aws_iam_access_key",
				Change: &tfjson.Change{
					Actions: tfjson.Actions{tfjson.ActionDelete},
					Before:  map[string]any{"user": "old"},
					After:   nil,
				},
			},
		},
	}
	rep, err := Evaluate(context.Background(), plan)
	if err != nil {
		t.Fatal(err)
	}
	keyless := controlByID(t, rep, "KEYLESS-001")
	if keyless.Status != StatusPass {
		t.Errorf("deleting a static key should pass KEYLESS-001, got %q", keyless.Status)
	}
}
