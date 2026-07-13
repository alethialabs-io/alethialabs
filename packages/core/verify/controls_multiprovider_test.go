// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"strings"
	"testing"
)

// mixedPlanJSON builds a two-cloud plan: a clean AWS IAM role (service trust, no
// federation) plus an Azure role assignment whose role name is `azureRole`. With
// azureRole="Owner" the Azure least-privilege control must hard-fail; with "Reader"
// the whole plan is clean. The AWS resource is listed FIRST so the pre-fix
// first-match detection would have selected "aws" and never run the Azure controls.
func mixedPlanJSON(azureRole string) string {
	return `{
      "format_version": "1.2",
      "resource_changes": [
        {"address":"aws_iam_role.eks","mode":"managed","type":"aws_iam_role","name":"eks",
         "provider_name":"registry.terraform.io/hashicorp/aws",
         "change":{"actions":["create"],"after":{
           "assume_role_policy":"{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"eks.amazonaws.com\"},\"Action\":\"sts:AssumeRole\"}]}"
         },"after_unknown":{}}},
        {"address":"azurerm_role_assignment.a","mode":"managed","type":"azurerm_role_assignment","name":"a",
         "provider_name":"registry.terraform.io/hashicorp/azurerm",
         "change":{"actions":["create"],"after":{"role_definition_name":"` + azureRole + `","scope":"/subscriptions/abc"},"after_unknown":{}}}
      ]}`
}

// TestMultiProviderRunsAllPresentClouds is the core regression for gap #42: a plan
// mixing AWS + Azure must run BOTH clouds' controls. Pre-fix, first-match detection
// picked "aws" and the Azure Owner assignment passed unchecked (a silent false-PASS
// for the fail-closed gate). The discrimination half (Owner→fail vs Reader→pass over
// the identical plan shape) proves the Azure control actually ran and is not vacuous.
func TestMultiProviderRunsAllPresentClouds(t *testing.T) {
	// Owner: the Azure violation must surface even though AWS is clean and first.
	bad := mustPlan(t, mixedPlanJSON("Owner"))
	rep, err := Evaluate(t.Context(), bad)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Verdict != StatusFail {
		t.Fatalf("mixed AWS(clean)+Azure(Owner): verdict = %q, want fail — Azure controls did not run", rep.Verdict)
	}
	if rep.Provider != "aws+azure" {
		t.Errorf("provider = %q, want %q (both clouds present)", rep.Provider, "aws+azure")
	}
	// Both providers' control sets must be present in the report.
	if !hasControl(rep, "KEYLESS-001") {
		t.Error("AWS control set missing from a mixed plan")
	}
	az := controlByID(t, rep, "AZURE-LEASTPRIV-001")
	if az.Status != StatusFail {
		t.Errorf("AZURE-LEASTPRIV-001 = %q, want fail (Owner assignment)", az.Status)
	}

	// Reader: same plan shape, non-violating role — the whole plan is clean. This is
	// the discrimination check: if the verdict didn't move, the control would be
	// vacuous. It also guards against a false-DENY regression on legitimate
	// multi-cloud plans.
	good := mustPlan(t, mixedPlanJSON("Reader"))
	repGood, err := Evaluate(t.Context(), good)
	if err != nil {
		t.Fatal(err)
	}
	if repGood.Verdict != StatusPass {
		t.Fatalf("mixed AWS(clean)+Azure(Reader): verdict = %q, want pass (no false DENY)", repGood.Verdict)
	}
}

// TestThreeCloudMiddleProviderEvaluated proves the union is exhaustive, not just
// "first + last": an AWS + GCP + Azure plan whose ONLY violation is a GCP owner
// binding (the middle provider) must still fail via GCP-LEASTPRIV-001.
func TestThreeCloudMiddleProviderEvaluated(t *testing.T) {
	plan := mustPlan(t, `{
      "format_version": "1.2",
      "resource_changes": [
        {"address":"aws_iam_role.eks","mode":"managed","type":"aws_iam_role","name":"eks",
         "provider_name":"registry.terraform.io/hashicorp/aws",
         "change":{"actions":["create"],"after":{
           "assume_role_policy":"{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"eks.amazonaws.com\"},\"Action\":\"sts:AssumeRole\"}]}"
         },"after_unknown":{}}},
        {"address":"google_project_iam_member.owner","mode":"managed","type":"google_project_iam_member","name":"owner",
         "provider_name":"registry.terraform.io/hashicorp/google",
         "change":{"actions":["create"],"after":{"role":"roles/owner","member":"serviceAccount:ci@proj.iam"},"after_unknown":{}}},
        {"address":"azuread_application_federated_identity_credential.gh","mode":"managed",
         "type":"azuread_application_federated_identity_credential","name":"gh",
         "provider_name":"registry.terraform.io/hashicorp/azuread",
         "change":{"actions":["create"],"after":{"subject":"repo:acme/infra:ref:refs/heads/main","issuer":"https://token.actions.githubusercontent.com"},"after_unknown":{}}}
      ]}`)
	rep, err := Evaluate(t.Context(), plan)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Provider != "aws+azure+gcp" {
		t.Errorf("provider = %q, want %q", rep.Provider, "aws+azure+gcp")
	}
	if rep.Verdict != StatusFail {
		t.Fatalf("verdict = %q, want fail (GCP roles/owner) — the middle provider was skipped", rep.Verdict)
	}
	gcp := controlByID(t, rep, "GCP-LEASTPRIV-001")
	if gcp.Status != StatusFail {
		t.Errorf("GCP-LEASTPRIV-001 = %q, want fail (roles/owner)", gcp.Status)
	}
}

// TestMultiProviderControlsScopedToOwnResources asserts each control on a mixed plan
// only reports findings against its own provider's resources — the union must not
// cross-apply (e.g. the AWS least-priv control must not fire on the Azure Owner).
func TestMultiProviderControlsScopedToOwnResources(t *testing.T) {
	rep, err := Evaluate(t.Context(), mustPlan(t, mixedPlanJSON("Owner")))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range rep.Controls {
		prefix := controlAddressPrefix(c.Provider)
		for _, f := range c.Findings {
			if prefix != "" && !strings.HasPrefix(f.Address, prefix) {
				t.Errorf("control %s (%s) reported a finding against a foreign resource: %s", c.ID, c.Provider, f.Address)
			}
		}
	}
}

// controlAddressPrefix maps a control's provider to the resource-address prefix its
// findings must carry, so the scoping assertion above can catch cross-provider bleed.
func controlAddressPrefix(provider string) string {
	switch provider {
	case "aws":
		return "aws_"
	case "gcp":
		return "google_"
	case "azure":
		return "azure" // azurerm_ / azuread_
	case "hetzner":
		return "hcloud_"
	default:
		return ""
	}
}

// TestMultiProviderAwsPlusHetzner extends the union regression to hcloud: a plan
// mixing a clean AWS role with an hcloud_server whose firewall_ids is KNOWN-empty
// must run the Hetzner posture set and fail on the bare server — hcloud resources
// in a mixed plan are not waved through just because another cloud is present.
func TestMultiProviderAwsPlusHetzner(t *testing.T) {
	plan := mustPlan(t, `{
      "format_version": "1.2",
      "resource_changes": [
        {"address":"aws_iam_role.eks","mode":"managed","type":"aws_iam_role","name":"eks",
         "provider_name":"registry.terraform.io/hashicorp/aws",
         "change":{"actions":["create"],"after":{
           "assume_role_policy":"{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"eks.amazonaws.com\"},\"Action\":\"sts:AssumeRole\"}]}"
         },"after_unknown":{}}},
        {"address":"hcloud_server.bare","mode":"managed","type":"hcloud_server","name":"bare",
         "provider_name":"registry.terraform.io/hetznercloud/hcloud",
         "change":{"actions":["create"],"after":{"name":"n1","server_type":"cpx31","firewall_ids":[]},"after_unknown":{}}}
      ]}`)
	rep, err := Evaluate(t.Context(), plan)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Provider != "aws+hetzner" {
		t.Errorf("provider = %q, want %q", rep.Provider, "aws+hetzner")
	}
	if rep.Verdict != StatusFail {
		t.Fatalf("mixed AWS(clean)+hcloud(bare server): verdict = %q, want fail — the Hetzner controls did not run", rep.Verdict)
	}
	if fw := controlByID(t, rep, "HCLOUD-FW-001"); fw.Status != StatusFail {
		t.Errorf("HCLOUD-FW-001 = %q, want fail (known-empty firewall_ids)", fw.Status)
	}
	if !hasControl(rep, "KEYLESS-001") {
		t.Error("AWS control set missing from the mixed plan")
	}
}

// hasControl reports whether a report contains a control with the given ID.
func hasControl(rep *Report, id string) bool {
	for _, c := range rep.Controls {
		if c.ID == id {
			return true
		}
	}
	return false
}
