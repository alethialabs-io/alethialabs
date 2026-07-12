// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"context"
	"testing"
	"time"
)

// Security regression (SOC 2 CC8.1 — changes are authorized before deployment): the verify
// gate that runs between `tofu plan` and `tofu apply` is fail-closed. This asserts the two
// halves of that contract, reusing the checked-in fail fixtures:
//
//  1. A hard control failure BLOCKS the apply — Report.Blocking() is true, and the failure
//     stays blocked (Unwaived non-empty) until an AUTHORIZED, unexpired override waives that
//     exact control. An expired override does NOT waive.
//  2. A plan the gate cannot judge is reported honestly as `not_evaluable` — it is NEVER
//     silently upgraded to a pass (deny-on-ambiguity). A nil plan (no plan JSON produced)
//     evaluates to not_evaluable, not pass.
//
// A `pass` control fixture proves the gate CAN clear a clean plan, so a green run is
// meaningful (not a gate that blocks everything). NON-VACUOUS: making Blocking() ignore a
// StatusFail, or letting a nil plan pass, flips these red. See
// docs/compliance/security-e2e-matrix.md.

func TestFailClosed_VerifyBlocksHardControlFailures(t *testing.T) {
	failFixtures := []string{
		"fail_static_key_admin.json", // static IAM key + admin policy (KEYLESS-001, LEASTPRIV-001)
		"fail_wildcard_sub.json",     // federated sub bound with a wildcard (OIDC-001)
		"fail_notaction.json",        // Allow + NotAction (LEASTPRIV-001)
		"gcp_fail_sa_key.json",       // GCP service-account key
		"azure_fail_owner.json",      // Azure Owner role assignment
	}
	for _, name := range failFixtures {
		t.Run(name, func(t *testing.T) {
			rep := evalFixture(t, name)
			if !rep.Blocking() {
				t.Fatalf("SECURITY HOLE: fixture %q verdict=%q did NOT block the apply", name, rep.Verdict)
			}
			// The failing controls keep the apply blocked with no override.
			if unwaived := rep.Unwaived(nil); len(unwaived) == 0 {
				t.Fatalf("fixture %q blocked but Unwaived(nil) was empty — apply would proceed", name)
			}
		})
	}
}

// TestFailClosed_VerifyOverrideMustBeAuthorizedAndUnexpired pins the waiver semantics: a
// failing control is only cleared by an override that names it AND has not expired. This is
// the "who waived what, and why" audit gate — a blanket or stale waiver must not open it.
func TestFailClosed_VerifyOverrideMustBeAuthorizedAndUnexpired(t *testing.T) {
	rep := evalFixture(t, "fail_static_key_admin.json")
	blocked := rep.Unwaived(nil)
	if len(blocked) == 0 {
		t.Fatal("expected the static-key fixture to block")
	}
	target := blocked[0]

	// A valid, unexpired override that names the failing control waives exactly it.
	valid := &Override{Controls: []string{target}, Reason: "accepted risk", By: "secops@example.test", Expiry: time.Now().Add(time.Hour)}
	if remaining := rep.Unwaived(valid); contains(remaining, target) {
		t.Errorf("an authorized, unexpired override did not waive %q (remaining: %v)", target, remaining)
	}

	// An EXPIRED override does NOT waive — the apply stays blocked (fail-closed on stale waivers).
	expired := &Override{Controls: []string{target}, Reason: "stale", By: "secops@example.test", Expiry: time.Now().Add(-time.Hour)}
	if remaining := rep.Unwaived(expired); !contains(remaining, target) {
		t.Errorf("an EXPIRED override wrongly waived %q — waivers must be time-boxed", target)
	}

	// An override for a DIFFERENT control does not waive this one.
	unrelated := &Override{Controls: []string{"SOME-OTHER-CONTROL"}, Reason: "x", By: "y", Expiry: time.Now().Add(time.Hour)}
	if remaining := rep.Unwaived(unrelated); !contains(remaining, target) {
		t.Errorf("an unrelated override wrongly waived %q", target)
	}
}

// TestFailClosed_VerifyNeverSilentlyPassesUninspectablePlan asserts deny-on-ambiguity: a plan
// the gate cannot judge is `not_evaluable`, never `pass`. A nil plan (plan JSON absent) is the
// sharpest case — it must not evaluate to a pass that would let an unchecked apply proceed.
func TestFailClosed_VerifyNeverSilentlyPassesUninspectablePlan(t *testing.T) {
	rep, err := Evaluate(context.Background(), nil)
	if err != nil {
		t.Fatalf("Evaluate(nil): %v", err)
	}
	if rep.Verdict == StatusPass {
		t.Fatal("SECURITY HOLE: a nil plan evaluated to PASS — the gate must fail closed to not_evaluable")
	}
	if rep.Verdict != StatusNotEvaluable {
		t.Errorf("nil plan verdict = %q, want not_evaluable", rep.Verdict)
	}

	// The computed-policy fixture is inspectable-but-opaque → not_evaluable, not pass.
	ne := evalFixture(t, "not_evaluable_computed_policy.json")
	if ne.Verdict == StatusPass {
		t.Errorf("computed-policy fixture silently passed — expected not_evaluable")
	}
}

// TestFailClosed_VerifyCanClearACleanPlan is the non-vacuity control: a keyless, least-priv
// plan clears the gate (Blocking() false). Without this, blocking everything would make the
// deny assertions above trivially green.
func TestFailClosed_VerifyCanClearACleanPlan(t *testing.T) {
	rep := evalFixture(t, "pass_keyless_least_priv.json")
	if rep.Blocking() {
		t.Fatalf("a clean keyless/least-priv plan was BLOCKED (verdict=%q) — the gate is not discriminating", rep.Verdict)
	}
	if rep.Verdict != StatusPass {
		t.Errorf("clean plan verdict = %q, want pass", rep.Verdict)
	}
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}
