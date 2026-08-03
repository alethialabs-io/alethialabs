// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestBuildFromOutputs_SecretsXacct locks the vc→facts wiring for the cross-account keyless secret
// manager: the target comes from the connector provider_config (not tofu outputs), is guarded on the
// cluster cloud, and is left empty (fail-closed → no store) for non-keyless or mismatched selections.
func TestBuildFromOutputs_SecretsXacct(t *testing.T) {
	awsSecret := func(pc map[string]any) *types.ProjectConfig {
		return &types.ProjectConfig{
			Provider: "aws",
			Secrets:  []types.ProjectSecretConfig{{Name: "s", Provider: "aws-sm-xacct", ProviderConfig: pc}},
		}
	}

	t.Run("populates the target from provider_config", func(t *testing.T) {
		f := BuildFromOutputs(map[string]interface{}{}, awsSecret(map[string]any{
			"target_account_id": "999999999999", "region": "eu-west-1",
			"target_role_arn": "arn:aws:iam::999999999999:role/read",
		}))
		if f.SecretsXacctRef != "arn:aws:iam::999999999999:role/read" || f.SecretsXacctRegion != "eu-west-1" {
			t.Fatalf("aws-sm-xacct facts not wired: ref=%q region=%q", f.SecretsXacctRef, f.SecretsXacctRegion)
		}
	})

	t.Run("vault (non-keyless) leaves the xacct facts empty", func(t *testing.T) {
		vc := &types.ProjectConfig{
			Provider: "aws",
			Secrets:  []types.ProjectSecretConfig{{Name: "s", Provider: "vault", ProviderConfig: map[string]any{"mount_path": "kv"}}},
		}
		if f := BuildFromOutputs(map[string]interface{}{}, vc); f.SecretsXacctRef != "" {
			t.Fatalf("vault must not populate a cross-account target, got %q", f.SecretsXacctRef)
		}
	})

	t.Run("no secrets → empty (fail-closed)", func(t *testing.T) {
		if f := BuildFromOutputs(map[string]interface{}{}, &types.ProjectConfig{Provider: "aws"}); f.SecretsXacctRef != "" {
			t.Fatalf("no secrets must leave the target empty, got %q", f.SecretsXacctRef)
		}
	})
}

// TestBuildFromOutputs_WAFWebACLArn locks the output→fact wiring for the regional web ACL.
// The fact only exists so the ArgoCD ingress can carry the wafv2-acl-arn annotation, and it is
// AWS-only: no other cloud declares a web-ACL output, and reading one on another cloud would
// hand the ALB controller a reference from a cloud it cannot associate.
func TestBuildFromOutputs_WAFWebACLArn(t *testing.T) {
	const arn = "arn:aws:wafv2:us-east-1:123456789012:regional/webacl/app-waf/0c4e-1"

	t.Run("aws reads waf_webacl_arn", func(t *testing.T) {
		f := BuildFromOutputs(map[string]interface{}{"waf_webacl_arn": arn}, &types.ProjectConfig{Provider: "aws"})
		if f.WAFWebACLArn != arn {
			t.Fatalf("WAFWebACLArn = %q, want %q", f.WAFWebACLArn, arn)
		}
	})

	// The switch off makes the output null; ExtractOutput yields "" — the "attach nothing"
	// signal both the annotation and wafDecision key on. An empty annotation VALUE would wedge
	// the ALB controller's ingress reconcile, so this must never become a present-but-empty ARN.
	t.Run("waf off (null output) leaves the fact empty", func(t *testing.T) {
		f := BuildFromOutputs(map[string]interface{}{"waf_webacl_arn": nil}, &types.ProjectConfig{Provider: "aws"})
		if f.WAFWebACLArn != "" {
			t.Fatalf("WAFWebACLArn = %q, want empty", f.WAFWebACLArn)
		}
		if d := decisionFor(t, InfraServiceDecisions(f), "waf"); d.Status != infraStatusSkipped {
			t.Fatalf("waf decision = %s, want skipped", d.Status)
		}
	})

	t.Run("no other cloud reads the key", func(t *testing.T) {
		for _, p := range []string{"gcp", "azure", "alibaba", "hetzner", "digitalocean"} {
			f := BuildFromOutputs(map[string]interface{}{"waf_webacl_arn": arn}, &types.ProjectConfig{Provider: types.CloudProvider(p)})
			if f.WAFWebACLArn != "" {
				t.Errorf("%s: WAFWebACLArn = %q, want empty — the key is AWS-only", p, f.WAFWebACLArn)
			}
		}
	})
}

// The Application Gateway lane's facts, from the outputs that carry them. `ingress_client_id` is
// the notable one: InfraFacts read it from the day AzureIngressClient was added and NO template
// ever exported it, so the fact was permanently "" and every gate reading it was dead. Pinning the
// extraction here is what stops that regressing into a dead fact a second time.
func TestBuildFromOutputs_AzureApplicationGatewayFacts(t *testing.T) {
	vc := &types.ProjectConfig{
		ProjectName:      "demo",
		EnvironmentStage: "development",
		Region:           "westeurope",
		Provider:         "azure",
		CloudAccountID:   "00000000-0000-0000-0000-000000000009",
	}
	f := BuildFromOutputs(map[string]interface{}{
		"aks_cluster_name":         "aks-demo",
		"resource_group_name":      "rg-demo-development",
		"azure_subscription_id":    "00000000-0000-0000-0000-000000000001",
		"ingress_client_id":        "00000000-0000-0000-0000-0000000000dd",
		"application_gateway_name": "agw-weu-development-demo",
		"waf_policy_id":            "/subscriptions/x/resourceGroups/y/providers/Microsoft.Network/applicationGatewayWebApplicationFirewallPolicies/demo",
	}, vc)

	if f.AzureIngressClient != "00000000-0000-0000-0000-0000000000dd" {
		t.Errorf("AzureIngressClient = %q, want the ingress_client_id output", f.AzureIngressClient)
	}
	if f.AzureAppGatewayName != "agw-weu-development-demo" {
		t.Errorf("AzureAppGatewayName = %q", f.AzureAppGatewayName)
	}
	if f.AzureWAFPolicyID == "" {
		t.Errorf("AzureWAFPolicyID must carry the waf_policy_id output, got %q", f.AzureWAFPolicyID)
	}
	if f.AzureSubscriptionID != "00000000-0000-0000-0000-000000000001" {
		t.Errorf("AzureSubscriptionID = %q, want the output to win over CloudAccountID", f.AzureSubscriptionID)
	}

	// The switch off / gateway off shape: the outputs are null, which ExtractOutput turns into "" —
	// exactly the "nothing to attach, no controller" signal the decisions read. The subscription
	// still resolves, from the config, because the template is handed it as an input.
	off := BuildFromOutputs(map[string]interface{}{
		"aks_cluster_name":         "aks-demo",
		"ingress_client_id":        nil,
		"application_gateway_name": nil,
		"waf_policy_id":            nil,
	}, vc)
	if off.AzureIngressClient != "" || off.AzureAppGatewayName != "" || off.AzureWAFPolicyID != "" {
		t.Errorf("null outputs must yield empty facts, got %+v", off)
	}
	if off.AzureSubscriptionID != "00000000-0000-0000-0000-000000000009" {
		t.Errorf("AzureSubscriptionID must fall back to the config's cloud account id, got %q", off.AzureSubscriptionID)
	}
}
