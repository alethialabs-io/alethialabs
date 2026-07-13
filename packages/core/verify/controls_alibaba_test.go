// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"strings"
	"testing"
)

// Every alibaba_* fixture in this suite is REAL `tofu show -json` output (OpenTofu
// v1.12.3 + aliyun/alicloud provider v1.285.0) — see the _comment in each fixture.
// That is load-bearing: the trust attribute is `assume_role_policy_document` (known)
// while the provider ALSO emits a computed read-only `document` mirror
// (after_unknown:true); reading the wrong one would make ALI-OIDC-001 spuriously
// not_evaluable. These tests run against the real shapes so that defect cannot recur.

// TestAlibabaProviderDetected asserts an alicloud plan is recognized as "alibaba" and
// runs the RAM/RRSA control set — no longer a not_evaluable SCOPE-001 pass-through.
func TestAlibabaProviderDetected(t *testing.T) {
	rep := evalCorpus(t, "alibaba_pass.json")
	if rep.Provider != "alibaba" {
		t.Errorf("provider = %q, want %q", rep.Provider, "alibaba")
	}
	for _, id := range []string{"ALI-KEYLESS-001", "ALI-OIDC-001", "ALI-LEASTPRIV-001"} {
		if !hasControl(rep, id) {
			t.Errorf("alibaba control set missing %s from an alicloud plan (controls: %+v)", id, rep.Controls)
		}
	}
	// The SCOPE-001 backstop must NOT fire: alicloud is now a controlled provider.
	if hasControl(rep, "SCOPE-001") {
		t.Error("SCOPE-001 fired on an all-alicloud plan — alicloud should be controlled, not unrecognized")
	}
}

// TestAlibabaShippedTemplateNoHardFail is the LOAD-BEARING proof required by the BYOC
// grill: the CURRENT shipped Alibaba template shapes (RRSA role trust from
// workload-identity.tf, a least-priv KMS-read policy, a Custom attachment) must NOT
// hard-fail at the fail-closed gate — otherwise an Alibaba `tofu apply` would block.
//
// alibaba_pass.json is a real plan from a faithful mirror of workload-identity.tf with
// LITERAL trust/policy values (so the docs are known-at-plan and the controls are
// EVALUABLE, not merely non-failing). In the real shipped template these interpolate
// cluster-module outputs (computed until apply) => per-resource not_evaluable, which is
// ALSO zero hard fails — so this pass fixture is the STRONGER guarantee (even fully
// known, the shipped shapes pass).
//
// Strengthened for anti-inertness: the controls must be EVALUABLE here, not just
// non-failing — a not_evaluable pass-through (the gate silently seeing nothing) fails
// this test too.
func TestAlibabaShippedTemplateNoHardFail(t *testing.T) {
	rep := evalCorpus(t, "alibaba_pass.json")

	if rep.Blocking() {
		t.Fatalf("shipped Alibaba template shapes BLOCK at the gate (verdict=%s) — this bricks the Alibaba apply", rep.Verdict)
	}
	for _, c := range rep.Controls {
		if c.Status == StatusFail {
			t.Errorf("control %s hard-failed on the shipped template shapes (findings: %+v) — must not fail", c.ID, c.Findings)
		}
	}
	if rep.Summary.Fail != 0 {
		t.Errorf("shipped template summary.Fail = %d, want 0", rep.Summary.Fail)
	}

	// Anti-inertness: every control actually evaluated the plan (pass, not blind
	// not_evaluable). A federated role + a policy body + an attachment are all present
	// and known, so resolveStatus can only yield pass via evaluable > 0.
	if rep.Summary.NotEvaluable != 0 {
		t.Errorf("shipped template summary.NotEvaluable = %d, want 0 — a control went blind on the real plan shape", rep.Summary.NotEvaluable)
	}
	for _, id := range []string{"ALI-KEYLESS-001", "ALI-OIDC-001", "ALI-LEASTPRIV-001"} {
		if c := controlByID(t, rep, id); c.Status != StatusPass {
			t.Errorf("%s = %q, want pass on the shipped template shapes (coverage: %q)", id, c.Status, c.Coverage)
		}
	}
	if rep.Verdict != StatusPass {
		t.Errorf("shipped template verdict = %q, want pass", rep.Verdict)
	}
}

// TestAlibabaAccessKeyHardFails pins the static-credential case: creating an
// alicloud_ram_access_key is always a hard fail (keyless is the whole point of RRSA).
func TestAlibabaAccessKeyHardFails(t *testing.T) {
	rep := evalCorpus(t, "alibaba_fail_access_key.json")
	if !rep.Blocking() {
		t.Fatalf("a static RAM access key did not block (verdict=%s)", rep.Verdict)
	}
	if c := controlByID(t, rep, "ALI-KEYLESS-001"); c.Status != StatusFail {
		t.Errorf("ALI-KEYLESS-001 = %q, want fail for an alicloud_ram_access_key", c.Status)
	}
}

// TestAlibabaWildcardSubHardFails: an RRSA role binding oidc:sub only with a
// StringLike wildcard lets any pod from the issuer assume it — a hard fail on the real
// plan shape (trust on assume_role_policy_document, computed `document` mirror ignored).
func TestAlibabaWildcardSubHardFails(t *testing.T) {
	rep := evalCorpus(t, "alibaba_fail_wildcard_sub.json")
	if !rep.Blocking() {
		t.Fatalf("wildcard oidc:sub did not block (verdict=%s) — the control may be inert on the real trust shape", rep.Verdict)
	}
	c := controlByID(t, rep, "ALI-OIDC-001")
	if c.Status != StatusFail {
		t.Errorf("ALI-OIDC-001 = %q, want fail for a wildcard oidc:sub", c.Status)
	}
	found := false
	for _, f := range c.Findings {
		if strings.Contains(f.Message, "wildcard") {
			found = true
		}
	}
	if !found {
		t.Errorf("ALI-OIDC-001 findings %+v should explain the wildcard sub", c.Findings)
	}
}

// TestAlibabaAdminAttachHardFails: attaching the System AdministratorAccess managed
// policy is full account admin — a hard fail. The role trusts a Service principal, so
// ALI-OIDC-001 is a vacuous pass, isolating the block to least-priv.
func TestAlibabaAdminAttachHardFails(t *testing.T) {
	rep := evalCorpus(t, "alibaba_fail_admin_attach.json")
	if !rep.Blocking() {
		t.Fatalf("attaching AdministratorAccess did not block (verdict=%s)", rep.Verdict)
	}
	if c := controlByID(t, rep, "ALI-LEASTPRIV-001"); c.Status != StatusFail {
		t.Errorf("ALI-LEASTPRIV-001 = %q, want fail for a System AdministratorAccess attachment", c.Status)
	}
	// A Service-principal role is NOT federated → OIDC must be a (non-blocking) pass.
	if c := controlByID(t, rep, "ALI-OIDC-001"); c.Status == StatusFail {
		t.Errorf("ALI-OIDC-001 = fail on a Service-principal role — a non-federated role is out of scope")
	}
}

// TestAlibabaWildcardPolicyHardFails: an inline RAM policy granting Action:"*" on
// Resource:"*" is full admin — the inline branch of ALI-LEASTPRIV-001 (distinct from
// the attachment branch above).
func TestAlibabaWildcardPolicyHardFails(t *testing.T) {
	rep := evalCorpus(t, "alibaba_fail_wildcard_policy.json")
	if !rep.Blocking() {
		t.Fatalf("Action:* on Resource:* did not block (verdict=%s)", rep.Verdict)
	}
	if c := controlByID(t, rep, "ALI-LEASTPRIV-001"); c.Status != StatusFail {
		t.Errorf("ALI-LEASTPRIV-001 = %q, want fail for a god-mode RAM policy", c.Status)
	}
}

// TestAlibabaServiceWildcardWarns: a service-level wildcard (ecs:*) on Resource:"*" is
// broad but not full admin — a WARN that records posture without blocking the apply.
func TestAlibabaServiceWildcardWarns(t *testing.T) {
	rep := evalCorpus(t, "alibaba_warn.json")
	if rep.Blocking() {
		t.Fatalf("a service-wildcard policy blocked (verdict=%s) — should warn, not fail", rep.Verdict)
	}
	c := controlByID(t, rep, "ALI-LEASTPRIV-001")
	if c.Status != StatusWarn {
		t.Errorf("ALI-LEASTPRIV-001 = %q, want warn for ecs:* on Resource:*", c.Status)
	}
}
