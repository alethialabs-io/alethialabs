// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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

// The mutation gate is the strongest anti-vacuity check in the suite. A hand-authored
// fail fixture matching a hand-authored expectation only proves the two artifacts
// agree — not that the control DISCRIMINATES. These tests start from a plan the gate
// scores PASS, then programmatically inject exactly one control's violation, and
// assert the verdict FLIPS to fail. If a control were gutted to always pass, its
// mutation would stop flipping and this test would fail. One mutator per control.

// loadBasePlan reads a clean pass plan from the in-repo corpus (always testdata, never
// ELENCH_CORPUS_DIR — the mutation baseline must be the known-good checked-in plan).
func loadBasePlan(t *testing.T, name string) *tfjson.Plan {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "corpus", name))
	if err != nil {
		t.Fatalf("read base plan %s: %v", name, err)
	}
	var plan tfjson.Plan
	if err := json.Unmarshal(b, &plan); err != nil {
		t.Fatalf("unmarshal base plan %s: %v", name, err)
	}
	return &plan
}

// findChange returns the resource change with the given address (fatal if absent).
func findChange(t *testing.T, plan *tfjson.Plan, address string) *tfjson.ResourceChange {
	t.Helper()
	for _, rc := range plan.ResourceChanges {
		if rc != nil && rc.Address == address {
			return rc
		}
	}
	t.Fatalf("base plan has no resource %q to mutate", address)
	return nil
}

// afterOf returns the (mutable) `after` object of a resource change.
func afterOf(t *testing.T, plan *tfjson.Plan, address string) map[string]any {
	t.Helper()
	rc := findChange(t, plan, address)
	m, ok := rc.Change.After.(map[string]any)
	if !ok {
		t.Fatalf("resource %q after is not an object", address)
	}
	return m
}

// injectCreate appends a freshly-created managed resource to the plan.
func injectCreate(plan *tfjson.Plan, address, rtype, provider string, after, afterUnknown map[string]any) {
	plan.ResourceChanges = append(plan.ResourceChanges, &tfjson.ResourceChange{
		Address: address,
		Mode:    tfjson.ManagedResourceMode,
		Type:    rtype,
		Name:    address,
		Change: &tfjson.Change{
			Actions:      tfjson.Actions{tfjson.ActionCreate},
			Before:       nil,
			After:        after,
			AfterUnknown: afterUnknown,
		},
	})
	_ = provider
}

// TestMutationFlipsVerdict is the discrimination gate. Per control: start from a
// PASS plan, prove it passes, inject that control's violation, and assert the gate
// now blocks and that specific control now fails.
func TestMutationFlipsVerdict(t *testing.T) {
	cases := []struct {
		name      string
		base      string
		controlID string
		mutate    func(t *testing.T, plan *tfjson.Plan)
	}{
		{
			name:      "KEYLESS-001/inject-static-access-key",
			base:      "aws_pass_keyless_least_priv.json",
			controlID: "KEYLESS-001",
			mutate: func(t *testing.T, plan *tfjson.Plan) {
				injectCreate(plan, "aws_iam_access_key.leaked", "aws_iam_access_key", "aws",
					map[string]any{"user": "ci-user"}, map[string]any{"secret": true})
			},
		},
		{
			name:      "OIDC-001/widen-sub-to-wildcard",
			base:      "aws_pass_keyless_least_priv.json",
			controlID: "OIDC-001",
			mutate: func(t *testing.T, plan *tfjson.Plan) {
				m := afterOf(t, plan, "aws_iam_role.deployer")
				m["assume_role_policy"] = `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sts:AssumeRoleWithWebIdentity","Principal":{"Federated":"arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"},"Condition":{"StringLike":{"token.actions.githubusercontent.com:sub":"repo:acme/*:*"}}}]}`
			},
		},
		{
			name:      "LEASTPRIV-001/widen-policy-to-admin",
			base:      "aws_pass_keyless_least_priv.json",
			controlID: "LEASTPRIV-001",
			mutate: func(t *testing.T, plan *tfjson.Plan) {
				m := afterOf(t, plan, "aws_iam_policy.scoped")
				m["policy"] = `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"*","Resource":"*"}]}`
			},
		},
		{
			// The MANAGED-POLICY-ATTACHMENT sub-path is a distinct branch from the inline
			// widen above (isAdminManagedPolicy over policy_arn). Attaching AdministratorAccess
			// is the most common real over-privilege pattern; without this a regression in the
			// attach detector slips past the inline mutator + the (KEYLESS-over-determined)
			// corpus plan.
			name:      "LEASTPRIV-001/attach-administrator-access",
			base:      "aws_pass_keyless_least_priv.json",
			controlID: "LEASTPRIV-001",
			mutate: func(t *testing.T, plan *tfjson.Plan) {
				injectCreate(plan, "aws_iam_role_policy_attachment.admin", "aws_iam_role_policy_attachment", "aws",
					map[string]any{
						"role":       "app",
						"policy_arn": "arn:aws:iam::aws:policy/AdministratorAccess",
					}, map[string]any{})
			},
		},
		{
			name:      "GCP-KEYLESS-001/inject-sa-key",
			base:      "gcp_pass.json",
			controlID: "GCP-KEYLESS-001",
			mutate: func(t *testing.T, plan *tfjson.Plan) {
				injectCreate(plan, "google_service_account_key.leaked", "google_service_account_key", "gcp",
					map[string]any{"service_account_id": "ci@proj.iam"}, map[string]any{"private_key": true})
			},
		},
		{
			name:      "GCP-WIF-001/strip-attribute-condition",
			base:      "gcp_pass.json",
			controlID: "GCP-WIF-001",
			mutate: func(t *testing.T, plan *tfjson.Plan) {
				m := afterOf(t, plan, "google_iam_workload_identity_pool_provider.gh")
				m["attribute_condition"] = ""
			},
		},
		{
			name:      "GCP-LEASTPRIV-001/escalate-to-owner",
			base:      "gcp_pass.json",
			controlID: "GCP-LEASTPRIV-001",
			mutate: func(t *testing.T, plan *tfjson.Plan) {
				m := afterOf(t, plan, "google_project_iam_member.viewer")
				m["role"] = "roles/owner"
			},
		},
		{
			name:      "AZURE-KEYLESS-001/inject-app-password",
			base:      "azure_pass.json",
			controlID: "AZURE-KEYLESS-001",
			mutate: func(t *testing.T, plan *tfjson.Plan) {
				injectCreate(plan, "azuread_application_password.leaked", "azuread_application_password", "azure",
					map[string]any{"application_object_id": "00000000-0000-0000-0000-000000000000"}, map[string]any{"value": true})
			},
		},
		{
			name:      "AZURE-FED-001/widen-subject-to-wildcard",
			base:      "azure_pass.json",
			controlID: "AZURE-FED-001",
			mutate: func(t *testing.T, plan *tfjson.Plan) {
				m := afterOf(t, plan, "azuread_application_federated_identity_credential.gh")
				m["subject"] = "repo:acme/*"
			},
		},
		{
			name:      "AZURE-LEASTPRIV-001/escalate-to-owner",
			base:      "azure_pass.json",
			controlID: "AZURE-LEASTPRIV-001",
			mutate: func(t *testing.T, plan *tfjson.Plan) {
				m := afterOf(t, plan, "azurerm_role_assignment.reader")
				m["role_definition_name"] = "Owner"
			},
		},
		{
			// Strip a server's firewall to a KNOWN-empty list — a bare public node.
			// (The base is a REAL plan where firewall_ids is computed + proven by the
			// configuration reference; a known-empty plan VALUE overrides that.)
			name:      "HCLOUD-FW-001/strip-server-firewall",
			base:      "hetzner_pass.json",
			controlID: "HCLOUD-FW-001",
			mutate: func(t *testing.T, plan *tfjson.Plan) {
				m := afterOf(t, plan, `hcloud_server.control_planes["demo-cp-1"]`)
				m["firewall_ids"] = []any{}
			},
		},
		{
			// Open SSH (tcp/22) to the whole internet on the firewall — Talos has no
			// SSH, so this is always a hard fail even though the base rules are all
			// confined to bounded CIDRs.
			name:      "HCLOUD-NET-001/open-ssh-to-world",
			base:      "hetzner_pass.json",
			controlID: "HCLOUD-NET-001",
			mutate: func(t *testing.T, plan *tfjson.Plan) {
				m := afterOf(t, plan, "hcloud_firewall.this")
				rules, _ := m["rule"].([]any)
				m["rule"] = append(rules, map[string]any{
					"description": "SSH",
					"direction":   "in",
					"protocol":    "tcp",
					"port":        "22",
					"source_ips":  []any{"0.0.0.0/0", "::/0"},
				})
			},
		},
		{
			name:      "ALI-KEYLESS-001/inject-ram-access-key",
			base:      "alibaba_pass.json",
			controlID: "ALI-KEYLESS-001",
			mutate: func(t *testing.T, plan *tfjson.Plan) {
				injectCreate(plan, "alicloud_ram_access_key.leaked", "alicloud_ram_access_key", "alibaba",
					map[string]any{"user_name": "ci-user"}, map[string]any{"secret": true})
			},
		},
		{
			// Widen the RRSA trust's oidc:sub from a pinned ServiceAccount to a
			// StringLike wildcard — any pod from the cluster issuer could then assume.
			name:      "ALI-OIDC-001/widen-sub-to-wildcard",
			base:      "alibaba_pass.json",
			controlID: "ALI-OIDC-001",
			mutate: func(t *testing.T, plan *tfjson.Plan) {
				m := afterOf(t, plan, "alicloud_ram_role.external_secrets")
				m["assume_role_policy_document"] = `{"Version":"1","Statement":[{"Effect":"Allow","Action":"sts:AssumeRole","Principal":{"Federated":["acs:ram::1234567890123456:oidc-provider/ack-rrsa-cluster-demo"]},"Condition":{"StringEquals":{"oidc:aud":"sts.aliyuncs.com"},"StringLike":{"oidc:sub":"system:serviceaccount:*"}}}]}`
			},
		},
		{
			// The System-managed-policy ATTACHMENT branch (isALIAdminSystemPolicy over
			// policy_type/policy_name) — distinct from the inline policy_document
			// wildcard path. Attaching AdministratorAccess is the most common real
			// over-privilege pattern on Alibaba.
			name:      "ALI-LEASTPRIV-001/attach-administrator-access",
			base:      "alibaba_pass.json",
			controlID: "ALI-LEASTPRIV-001",
			mutate: func(t *testing.T, plan *tfjson.Plan) {
				injectCreate(plan, "alicloud_ram_role_policy_attachment.admin", "alicloud_ram_role_policy_attachment", "alibaba",
					map[string]any{
						"role_name":   "app",
						"policy_name": "AdministratorAccess",
						"policy_type": "System",
					}, map[string]any{})
			},
		},
	}

	// Assert every declared control has a mutator — parity with the corpus coverage
	// gate, so a new control cannot ship without a discrimination proof.
	covered := map[string]bool{}
	for _, tc := range cases {
		covered[tc.controlID] = true
	}
	for _, id := range declaredControlIDs() {
		if !covered[id] {
			t.Errorf("control %s has no mutation case — add one to prove it discriminates", id)
		}
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			plan := loadBasePlan(t, tc.base)

			// 1. Baseline: the unmutated plan must PASS, so any flip is caused solely by
			//    the mutation (not by a pre-existing violation in the base).
			base, err := Evaluate(context.Background(), plan)
			if err != nil {
				t.Fatalf("baseline evaluate: %v", err)
			}
			if base.Verdict != StatusPass {
				t.Fatalf("baseline %s verdict = %q, want pass (base must be clean for the mutation to be the cause)", tc.base, base.Verdict)
			}
			if bc := controlByID(t, base, tc.controlID); bc.Status != StatusPass {
				t.Fatalf("baseline control %s = %q, want pass before mutation", tc.controlID, bc.Status)
			}

			// 2. Mutate toward the violation.
			tc.mutate(t, plan)

			// 3. The verdict must FLIP: the gate blocks and the target control fails.
			after, err := Evaluate(context.Background(), plan)
			if err != nil {
				t.Fatalf("post-mutation evaluate: %v", err)
			}
			if !after.Blocking() {
				t.Errorf("after mutating %s toward a violation, verdict = %q (want fail/blocking) — the control did NOT discriminate", tc.controlID, after.Verdict)
			}
			mc := controlByID(t, after, tc.controlID)
			if mc.Status != StatusFail {
				t.Errorf("after mutation, control %s = %q, want fail (findings: %+v)", tc.controlID, mc.Status, mc.Findings)
			}
		})
	}
}
