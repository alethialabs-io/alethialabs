// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import "testing"

// TestMultiCloudVerdicts pins verdicts + provider detection for the GCP/Azure
// control sets, parallel to the AWS coverage in verify_test.go.
func TestMultiCloudVerdicts(t *testing.T) {
	cases := []struct {
		fixture      string
		wantProvider string
		wantVerdict  Status
	}{
		{"gcp_fail_sa_key.json", "gcp", StatusFail},
		{"gcp_pass.json", "gcp", StatusPass},
		{"gcp_fail_owner.json", "gcp", StatusFail},
		{"azure_fail_secret.json", "azure", StatusFail},
		{"azure_pass.json", "azure", StatusPass},
		{"azure_fail_owner.json", "azure", StatusFail},
	}
	for _, tc := range cases {
		t.Run(tc.fixture, func(t *testing.T) {
			rep := evalFixture(t, tc.fixture)
			if rep.Provider != tc.wantProvider {
				t.Errorf("provider = %q, want %q", rep.Provider, tc.wantProvider)
			}
			if rep.Verdict != tc.wantVerdict {
				t.Errorf("verdict = %q, want %q (controls: %+v)", rep.Verdict, tc.wantVerdict, rep.Controls)
			}
			// Every control on a provider-specific plan must carry that provider.
			for _, c := range rep.Controls {
				if c.Provider != tc.wantProvider {
					t.Errorf("control %s provider = %q, want %q", c.ID, c.Provider, tc.wantProvider)
				}
			}
		})
	}
}

// TestGCPControlsSelected asserts an AWS plan does not run GCP/Azure controls (and
// vice versa) — output stays scoped to the plan's cloud.
func TestProviderScopedControls(t *testing.T) {
	aws := evalFixture(t, "pass_keyless_least_priv.json")
	for _, c := range aws.Controls {
		if c.Provider != "aws" {
			t.Errorf("AWS plan ran a non-AWS control: %s (%s)", c.ID, c.Provider)
		}
	}
	gcp := evalFixture(t, "gcp_pass.json")
	for _, c := range gcp.Controls {
		if c.ID == "KEYLESS-001" || c.ID == "OIDC-001" || c.ID == "LEASTPRIV-001" {
			t.Errorf("GCP plan ran an AWS control: %s", c.ID)
		}
	}
}

// TestGCPWildcardWifMissingCondition asserts a WIF provider without an
// attribute_condition fails GCP-WIF-001.
func TestGCPWifMissingCondition(t *testing.T) {
	plan := mustPlan(t, `{
      "format_version": "1.2",
      "resource_changes": [
        {"address":"google_iam_workload_identity_pool_provider.x","mode":"managed",
         "type":"google_iam_workload_identity_pool_provider","name":"x",
         "change":{"actions":["create"],"after":{"attribute_condition":""},"after_unknown":{}}}
      ]}`)
	rep, err := Evaluate(t.Context(), plan)
	if err != nil {
		t.Fatal(err)
	}
	c := controlByID(t, rep, "GCP-WIF-001")
	if c.Status != StatusFail {
		t.Fatalf("GCP-WIF-001 = %q, want fail for missing attribute_condition", c.Status)
	}
}
