// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"context"
	"errors"
	"testing"

	tfjson "github.com/hashicorp/terraform-json"
)

// scriptedRemediator returns a pre-set sequence of candidate fixtures, one per
// attempt (and an error if attempts exceed the script).
type scriptedRemediator struct {
	t       *testing.T
	plans   []string // fixture names, one per attempt
	calls   int
	failAt  int // 1-based attempt to return an error (0 = never)
	nilPlan bool
}

func (s *scriptedRemediator) Attempt(_ context.Context, _ *Report, attempt int) (*tfjson.Plan, error) {
	s.calls++
	if s.failAt == attempt {
		return nil, errors.New("propose failed")
	}
	if s.nilPlan {
		return nil, nil
	}
	idx := attempt - 1
	if idx >= len(s.plans) {
		return nil, errors.New("script exhausted")
	}
	return loadPlan(s.t, s.plans[idx]), nil
}

func TestRemediationLoopSucceedsWhenFixAccepted(t *testing.T) {
	original := evalFixture(t, "fail_static_key_admin.json")
	rem := &scriptedRemediator{
		t: t,
		// attempt 1: still failing (same bad plan); attempt 2: clean fix.
		plans: []string{"fail_static_key_admin.json", "pass_keyless_least_priv.json"},
	}
	out, err := RunRemediationLoop(context.Background(), original, rem, 3)
	if err != nil {
		t.Fatal(err)
	}
	if !out.Succeeded {
		t.Fatalf("loop should succeed by attempt 2, got %+v", out)
	}
	if out.Attempts != 2 {
		t.Errorf("Attempts = %d, want 2", out.Attempts)
	}
}

func TestRemediationLoopExhausts(t *testing.T) {
	original := evalFixture(t, "fail_static_key_admin.json")
	rem := &scriptedRemediator{
		t:     t,
		plans: []string{"fail_static_key_admin.json", "fail_static_key_admin.json"},
	}
	out, err := RunRemediationLoop(context.Background(), original, rem, 2)
	if err != nil {
		t.Fatal(err)
	}
	if out.Succeeded {
		t.Fatal("loop must not succeed when no candidate is ever accepted")
	}
	if out.Attempts != 2 {
		t.Errorf("Attempts = %d, want 2 (exhausted)", out.Attempts)
	}
}

func TestRemediationLoopStopsOnError(t *testing.T) {
	original := evalFixture(t, "fail_static_key_admin.json")
	rem := &scriptedRemediator{t: t, failAt: 1, plans: []string{"pass_keyless_least_priv.json"}}
	out, err := RunRemediationLoop(context.Background(), original, rem, 3)
	if err == nil {
		t.Fatal("a proposer error should surface")
	}
	if out.Succeeded {
		t.Error("outcome must not be succeeded on error")
	}
}

func TestRemediationLoopNilPlanEndsCleanly(t *testing.T) {
	original := evalFixture(t, "fail_static_key_admin.json")
	rem := &scriptedRemediator{t: t, nilPlan: true}
	out, err := RunRemediationLoop(context.Background(), original, rem, 3)
	if err != nil {
		t.Fatal(err)
	}
	if out.Succeeded || out.Attempts != 0 {
		t.Errorf("a nil candidate should end the loop without success, got %+v", out)
	}
}

// TestReVerifyAcceptsCleanFix: a candidate plan that resolves the original
// failures with no regression is accepted.
func TestReVerifyAcceptsCleanFix(t *testing.T) {
	original := evalFixture(t, "fail_static_key_admin.json")
	candidate := loadPlan(t, "pass_keyless_least_priv.json")

	res, err := ReVerify(context.Background(), original, candidate)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Accepted {
		t.Fatalf("clean fix must be accepted; still=%v newly=%v", res.StillFailing, res.NewlyFailing)
	}
	// KEYLESS-001 + LEASTPRIV-001 were failing originally and must be resolved.
	if len(res.Resolved) != 2 {
		t.Errorf("Resolved = %v, want the 2 originally-failing controls", res.Resolved)
	}
	if len(res.StillFailing) != 0 || len(res.NewlyFailing) != 0 {
		t.Errorf("unexpected unresolved/regressions: still=%v newly=%v", res.StillFailing, res.NewlyFailing)
	}
}

// TestReVerifyRejectsRegression: a candidate that fixes the original failures but
// introduces a NEW failure is rejected (the regression guard).
func TestReVerifyRejectsRegression(t *testing.T) {
	original := evalFixture(t, "fail_static_key_admin.json")
	// Candidate "fixes" by removing the key + admin attach but introduces a
	// wildcard-sub federated role — a new OIDC-001 failure.
	candidate := loadPlan(t, "fail_wildcard_sub.json")

	res, err := ReVerify(context.Background(), original, candidate)
	if err != nil {
		t.Fatal(err)
	}
	if res.Accepted {
		t.Fatal("a candidate that introduces a new failure must NOT be accepted")
	}
	found := false
	for _, id := range res.NewlyFailing {
		if id == "OIDC-001" {
			found = true
		}
	}
	if !found {
		t.Errorf("NewlyFailing = %v, want it to include OIDC-001", res.NewlyFailing)
	}
}

// TestReVerifyPartialFix: a candidate that resolves only some original failures is
// rejected, with the unresolved ones reported.
func TestReVerifyPartialFix(t *testing.T) {
	original := evalFixture(t, "fail_static_key_admin.json")
	// Still has the AdministratorAccess attach (LEASTPRIV-001 fails) but no static
	// key (KEYLESS-001 resolved).
	candidate := mustPlan(t, `{
      "format_version": "1.2",
      "resource_changes": [
        {"address":"aws_iam_role_policy_attachment.admin","mode":"managed",
         "type":"aws_iam_role_policy_attachment","name":"admin",
         "change":{"actions":["create"],"after":{"role":"app","policy_arn":"arn:aws:iam::aws:policy/AdministratorAccess"},"after_unknown":{}}}
      ]}`)

	res, err := ReVerify(context.Background(), original, candidate)
	if err != nil {
		t.Fatal(err)
	}
	if res.Accepted {
		t.Fatal("a partial fix must not be accepted")
	}
	if len(res.StillFailing) != 1 || res.StillFailing[0] != "LEASTPRIV-001" {
		t.Errorf("StillFailing = %v, want [LEASTPRIV-001]", res.StillFailing)
	}
	if len(res.Resolved) != 1 || res.Resolved[0] != "KEYLESS-001" {
		t.Errorf("Resolved = %v, want [KEYLESS-001]", res.Resolved)
	}
}
