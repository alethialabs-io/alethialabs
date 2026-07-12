// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package iacsafety

import (
	"path/filepath"
	"testing"
)

// Security regression (SOC 2 CC8.1 — changes are gated before they take effect): the static
// BYO-IaC gate must DENY untrusted modules, and — crucially — must fail CLOSED on AMBIGUITY,
// not just on an explicit red flag. A module whose `source` is a non-literal expression
// (`source = var.src`) cannot be statically resolved, so `tofu init` would fetch who-knows-what;
// the gate must treat "I can't tell" as DENY, never ALLOW.
//
// This reuses the checked-in evil/unresolvable fixtures under testdata/ and asserts each is
// rejected (Report.OK == false) with the expected fail-closed rule. A `clean` control fixture
// proves the gate CAN pass — so a green run is meaningful, not a scanner that denies everything.
// NON-VACUOUS: relaxing any rule (e.g. treating an unresolvable source as allowed) flips OK to
// true → the matching case fails. See docs/compliance/security-e2e-matrix.md.

// hasRule reports whether the report carries an error-severity finding with the given rule.
func hasRule(r *Report, rule string) bool {
	for _, f := range r.Findings {
		if f.Severity == SeverityError && f.Rule == rule {
			return true
		}
	}
	return false
}

func TestFailClosed_IacSafetyDeniesEvilAndUnresolvableModules(t *testing.T) {
	allowlist := DefaultProviderAllowlist()

	cases := []struct {
		fixture  string
		wantRule string
		why      string
	}{
		{
			fixture:  "unresolvable",
			wantRule: RuleModuleSourceUnresolvable,
			why:      "a non-literal module source (source = var.src) is unresolvable → DENY on ambiguity (fail-closed)",
		},
		{
			fixture:  "badprovider",
			wantRule: RuleProviderNotAllowlisted,
			why:      "a non-allowlisted provider (evilcorp/backdoor) tofu would download → DENY",
		},
		{
			fixture:  "external",
			wantRule: RuleExternalDataSource,
			why:      "a data \"external\" source runs an arbitrary command at plan time → DENY",
		},
		{
			fixture:  "provisioner",
			wantRule: RuleProvisionerBlock,
			why:      "a local-exec/remote-exec provisioner runs arbitrary commands → DENY",
		},
		{
			fixture:  "escape",
			wantRule: RuleModuleEscapesRoot,
			why:      "a ../ module source escapes the scan root → DENY",
		},
	}

	for _, tc := range cases {
		t.Run(tc.fixture, func(t *testing.T) {
			rep, err := Scan(filepath.Join("testdata", tc.fixture), allowlist)
			if err != nil {
				t.Fatalf("Scan(%s): %v", tc.fixture, err)
			}
			if rep.OK {
				t.Fatalf("SECURITY HOLE: fixture %q was ALLOWED (Report.OK=true) — %s", tc.fixture, tc.why)
			}
			if !hasRule(rep, tc.wantRule) {
				t.Errorf("fixture %q denied but WITHOUT the expected rule %q (findings: %+v)", tc.fixture, tc.wantRule, rep.Findings)
			}
		})
	}
}

// TestFailClosed_IacSafetyAllowsCleanModule is the non-vacuity control: a well-formed module
// using only allowlisted providers and no dangerous constructs PASSES. Without this, a scanner
// that simply denied everything would make the deny-cases above trivially green.
func TestFailClosed_IacSafetyAllowsCleanModule(t *testing.T) {
	rep, err := Scan(filepath.Join("testdata", "clean"), DefaultProviderAllowlist())
	if err != nil {
		t.Fatalf("Scan(clean): %v", err)
	}
	if !rep.OK {
		t.Fatalf("the clean control fixture was DENIED — the gate is not discriminating (findings: %+v)", rep.Findings)
	}
}
