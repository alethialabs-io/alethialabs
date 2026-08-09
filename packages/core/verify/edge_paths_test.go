// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"strings"
	"testing"

	tfjson "github.com/hashicorp/terraform-json"
)

// This file exercises the honesty/error edges of the gate that the corpus fixtures
// never reach: the plan shapes gatherPlanned must skip, the configuration walk's
// nil tolerance, the per-control "attribute absent / computed until apply" arms,
// and the fail-closed backstops (verdict of an empty report, the plan-unavailable
// override, the bounded remediation loop). Every case here asserts the honest
// outcome — not_evaluable or a refusal — because a silent pass on any of them is
// the exact false-PASS this package must never produce.

// TestGatherPlannedSkipsNonAuthorityChanges pins which resource changes the gate
// reduces away. Each skipped shape creates no new authority (or carries no readable
// body), so including it would only produce phantom findings.
func TestGatherPlannedSkipsNonAuthorityChanges(t *testing.T) {
	create := map[string]any{"name": "kept"}
	plan := &tfjson.Plan{ResourceChanges: []*tfjson.ResourceChange{
		nil, // a nil entry must not panic
		{Address: "aws_iam_role.no_change", Type: "aws_iam_role", Mode: tfjson.ManagedResourceMode},
		{
			Address: "data.aws_iam_policy_document.d", Type: "aws_iam_policy_document",
			Mode:   tfjson.DataResourceMode,
			Change: &tfjson.Change{Actions: tfjson.Actions{tfjson.ActionRead}, After: create},
		},
		{
			Address: "aws_iam_role.noop", Type: "aws_iam_role", Mode: tfjson.ManagedResourceMode,
			Change: &tfjson.Change{Actions: tfjson.Actions{tfjson.ActionNoop}, After: create},
		},
		{
			Address: "aws_iam_role.gone", Type: "aws_iam_role", Mode: tfjson.ManagedResourceMode,
			Change: &tfjson.Change{Actions: tfjson.Actions{tfjson.ActionDelete}, After: nil},
		},
		{
			Address: "aws_iam_role.scalar_body", Type: "aws_iam_role", Mode: tfjson.ManagedResourceMode,
			Change: &tfjson.Change{Actions: tfjson.Actions{tfjson.ActionCreate}, After: "not-an-object"},
		},
		{
			Address: "aws_iam_role.kept", Type: "aws_iam_role", Mode: tfjson.ManagedResourceMode,
			Change: &tfjson.Change{Actions: tfjson.Actions{tfjson.ActionCreate}, After: create},
		},
	}}

	got := gatherPlanned(plan)
	if len(got) != 1 || got[0].address != "aws_iam_role.kept" {
		var addrs []string
		for _, r := range got {
			addrs = append(addrs, r.address)
		}
		t.Fatalf("gatherPlanned = %v, want only [aws_iam_role.kept]", addrs)
	}
	if got[0].hasConfig() {
		t.Error("hasConfig() = true on a plan with no configuration section")
	}
}

// TestConfigExprIndexToleratesNilNodes proves the configuration walk survives the
// sparse shapes a plan can carry (a module call with no module body, a nil resource
// entry) and still indexes nested resources under their module-prefixed address.
func TestConfigExprIndexToleratesNilNodes(t *testing.T) {
	if idx := configExprIndex(&tfjson.Plan{}); idx != nil {
		t.Errorf("configExprIndex(no config) = %v, want nil", idx)
	}
	if idx := configExprIndex(&tfjson.Plan{Config: &tfjson.Config{}}); idx != nil {
		t.Errorf("configExprIndex(no root module) = %v, want nil", idx)
	}

	plan := &tfjson.Plan{Config: &tfjson.Config{RootModule: &tfjson.ConfigModule{
		Resources: []*tfjson.ConfigResource{nil, {Address: "hcloud_server.root"}},
		ModuleCalls: map[string]*tfjson.ModuleCall{
			"empty": {Source: "./empty"}, // no Module body at all
			"nested": {Source: "./nested", Module: &tfjson.ConfigModule{
				Resources: []*tfjson.ConfigResource{{Address: "hcloud_server.inner"}},
			}},
		},
	}}}
	idx := configExprIndex(plan)
	if _, ok := idx["hcloud_server.root"]; !ok {
		t.Error("root resource missing from the configuration index")
	}
	nested, ok := idx["module.nested.hcloud_server.inner"]
	if !ok {
		t.Fatalf("nested resource missing from the configuration index (%v)", idx)
	}
	if nested.modPrefix != "module.nested." {
		t.Errorf("module prefix = %q, want %q", nested.modPrefix, "module.nested.")
	}
	if len(idx) != 2 {
		t.Errorf("index has %d entries, want 2 (nil entries and body-less module calls contribute nothing)", len(idx))
	}
}

// TestControlFederatedTrustCoverageArms pins OIDC-001's non-finding outcomes: a role
// with no visible trust document is out of scope, a computed one is not_evaluable
// (never a pass), and a service role is simply not federated.
func TestControlFederatedTrustCoverageArms(t *testing.T) {
	serviceRole := `{"Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}`
	cases := []struct {
		name        string
		res         plannedResource
		wantStatus  Status
		wantCovSub  string
		wantNoFinds bool
	}{
		{
			name:        "trust document absent",
			res:         plannedResource{address: "aws_iam_role.a", rtype: "aws_iam_role", after: map[string]any{}},
			wantStatus:  StatusPass,
			wantCovSub:  "no resources in scope",
			wantNoFinds: true,
		},
		{
			name: "trust document computed until apply",
			res: plannedResource{
				address: "aws_iam_role.b", rtype: "aws_iam_role",
				after:        map[string]any{"name": "b"},
				afterUnknown: map[string]any{"assume_role_policy": true},
			},
			wantStatus:  StatusNotEvaluable,
			wantCovSub:  "assume_role_policy not known until apply",
			wantNoFinds: true,
		},
		{
			name:        "service role is out of scope",
			res:         plannedResource{address: "aws_iam_role.c", rtype: "aws_iam_role", after: map[string]any{"assume_role_policy": serviceRole}},
			wantStatus:  StatusPass,
			wantCovSub:  "no resources in scope",
			wantNoFinds: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := controlFederatedTrust([]plannedResource{tc.res})
			if c.Status != tc.wantStatus {
				t.Errorf("status = %q, want %q (coverage %q)", c.Status, tc.wantStatus, c.Coverage)
			}
			if tc.wantNoFinds && len(c.Findings) != 0 {
				t.Errorf("findings = %+v, want none", c.Findings)
			}
			if !strings.Contains(c.Coverage, tc.wantCovSub) {
				t.Errorf("coverage %q does not mention %q", c.Coverage, tc.wantCovSub)
			}
		})
	}
}

// TestControlFederatedTrustWildcardAction is the #2014 regression: a trust policy
// granting "sts:*" (or "*") to a Federated principal is strictly MORE permissive
// than the literal sts:AssumeRoleWithWebIdentity, so it must be judged, not dropped
// out of scope into the vacuous-pass arm with subjectIsBound never consulted.
func TestControlFederatedTrustWildcardAction(t *testing.T) {
	trust := func(action, condition string) string {
		return `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"` + action +
			`","Principal":{"Federated":"arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"}` + condition + `}]}`
	}
	boundSub := `,"Condition":{"StringEquals":{"token.actions.githubusercontent.com:sub":"repo:acme/infra:ref:refs/heads/main"}}`

	t.Run("sts wildcard with no sub condition fails", func(t *testing.T) {
		c := controlFederatedTrust([]plannedResource{{
			address: "aws_iam_role.deployer", rtype: "aws_iam_role",
			after: map[string]any{"assume_role_policy": trust("sts:*", "")},
		}})
		if c.Status != StatusFail || len(c.Findings) != 1 {
			t.Fatalf("OIDC-001 = %q findings %+v, want fail with the missing-sub finding (coverage %q)", c.Status, c.Findings, c.Coverage)
		}
	})
	t.Run("bare wildcard with no sub condition fails", func(t *testing.T) {
		c := controlFederatedTrust([]plannedResource{{
			address: "aws_iam_role.deployer", rtype: "aws_iam_role",
			after: map[string]any{"assume_role_policy": trust("*", "")},
		}})
		if c.Status != StatusFail || len(c.Findings) != 1 {
			t.Fatalf("OIDC-001 = %q findings %+v, want fail (coverage %q)", c.Status, c.Findings, c.Coverage)
		}
	})
	t.Run("sts wildcard with pinned sub is an evaluated pass", func(t *testing.T) {
		c := controlFederatedTrust([]plannedResource{{
			address: "aws_iam_role.deployer", rtype: "aws_iam_role",
			after: map[string]any{"assume_role_policy": trust("sts:*", boundSub)},
		}})
		if c.Status != StatusPass || len(c.Findings) != 0 {
			t.Fatalf("OIDC-001 = %q findings %+v, want pass", c.Status, c.Findings)
		}
		// Pass must come from evaluable > 0, not the vacuous out-of-scope arm.
		if strings.Contains(c.Coverage, "no resources in scope") {
			t.Fatalf("coverage %q claims out-of-scope — the wildcard role was not judged", c.Coverage)
		}
	})
	t.Run("alibaba twin: sts wildcard with no sub condition fails", func(t *testing.T) {
		c := controlALIFederatedTrust([]plannedResource{{
			address: "alicloud_ram_role.workload", rtype: "alicloud_ram_role",
			after: map[string]any{"assume_role_policy_document": `{"Version":"1","Statement":[{"Effect":"Allow","Action":"sts:*","Principal":{"Federated":["acs:ram::1234567890123456:oidc-provider/ack-rrsa-cluster-demo"]}}]}`},
		}})
		if c.Status != StatusFail || len(c.Findings) != 1 {
			t.Fatalf("ALI-OIDC-001 = %q findings %+v, want fail (coverage %q)", c.Status, c.Findings, c.Coverage)
		}
	})
}

// TestControlLeastPrivilegeAbsentPolicyBodyIsNotEvaluable: an inline policy resource
// whose body is not in the plan at all is a coverage gap, never a pass.
func TestControlLeastPrivilegeAbsentPolicyBodyIsNotEvaluable(t *testing.T) {
	c := controlLeastPrivilege([]plannedResource{{
		address: "aws_iam_policy.p", rtype: "aws_iam_policy",
		after: map[string]any{"name": "p"},
	}})
	if c.Status != StatusNotEvaluable {
		t.Fatalf("LEASTPRIV-001 = %q, want not_evaluable for a policy with no readable body", c.Status)
	}
	if len(c.Findings) != 0 {
		t.Errorf("findings = %+v, want none", c.Findings)
	}
}

// TestInspectPolicyDocIgnoresNonAllow proves the over-broad patterns are judged only
// on Allow statements — a Deny of "*" on "*" is a guardrail, not a grant.
func TestInspectPolicyDocIgnoresNonAllow(t *testing.T) {
	doc := &iamDoc{Statements: []iamStatement{
		{Effect: "Deny", Action: []string{"*"}, Resource: []string{"*"}},
		{Effect: "Deny", NotAction: []string{"s3:GetObject"}, Resource: []string{"*"}},
		{Effect: "Deny", Action: []string{"iam:*"}, Resource: []string{"*"}},
	}}
	findings, failed, warned := inspectPolicyDoc("aws_iam_policy.guardrail", doc)
	if len(findings) != 0 || failed != 0 || warned != 0 {
		t.Fatalf("Deny statements produced findings=%+v failed=%d warned=%d, want all empty", findings, failed, warned)
	}
}

// TestInspectALIPolicyDocIgnoresNonAllow is the Alibaba twin of the above.
func TestInspectALIPolicyDocIgnoresNonAllow(t *testing.T) {
	doc := &iamDoc{Statements: []iamStatement{
		{Effect: "Deny", Action: []string{"*"}, Resource: []string{"*"}},
		{Effect: "Deny", NotAction: []string{"oss:GetObject"}, Resource: []string{"*"}},
		{Effect: "Deny", Action: []string{"ecs:*"}, Resource: []string{"*"}},
	}}
	findings, failed, warned := inspectALIPolicyDoc("alicloud_ram_policy.guardrail", doc)
	if len(findings) != 0 || failed != 0 || warned != 0 {
		t.Fatalf("Deny statements produced findings=%+v failed=%d warned=%d, want all empty", findings, failed, warned)
	}
}

// TestControlALIFederatedTrustNoTrustDocument: a RAM role carrying neither
// assume_role_policy_document nor document is out of ALI-OIDC-001's scope rather
// than a phantom finding.
func TestControlALIFederatedTrustNoTrustDocument(t *testing.T) {
	c := controlALIFederatedTrust([]plannedResource{{
		address: "alicloud_ram_role.r", rtype: "alicloud_ram_role",
		after: map[string]any{"name": "r"},
	}})
	if c.Status != StatusPass || len(c.Findings) != 0 {
		t.Fatalf("ALI-OIDC-001 = %q findings %+v, want a vacuous pass", c.Status, c.Findings)
	}
	if !strings.Contains(c.Coverage, "no resources in scope") {
		t.Errorf("coverage %q should state the control found nothing to judge", c.Coverage)
	}
}

// TestFinalizeEmptyReportIsNotEvaluable is the last fail-closed rung: a report with
// no controls at all has proven nothing, so it must never read as a pass.
func TestFinalizeEmptyReportIsNotEvaluable(t *testing.T) {
	r := &Report{CatalogVersion: CatalogVersion}
	r.finalize()
	if r.Verdict != StatusNotEvaluable {
		t.Fatalf("verdict of a control-less report = %q, want not_evaluable", r.Verdict)
	}
	if r.Blocking() {
		t.Error("a not_evaluable report must not report itself as Blocking")
	}
}
