// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"strings"
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

// TestBuildFromOutputs_AlibabaWAFInstanceID locks the output→fact wiring for the WAF 3.0
// instance. It is the mirror image of the AWS fact above and must never be confused with it:
// the AWS ARN exists so the ingress can be ANNOTATED with it, while this id exists so the deploy
// can REPORT that nothing is bound to it. The pinned alicloud provider binds a hostname only in
// CNAME mode, whose origin is created after the cluster is up (see modules/waf/main.tf).
func TestBuildFromOutputs_AlibabaWAFInstanceID(t *testing.T) {
	const id = "waf_v3prepaid_public_cn-0xldbqt0007"

	t.Run("alibaba reads waf_instance_id", func(t *testing.T) {
		f := BuildFromOutputs(map[string]interface{}{"waf_instance_id": id}, &types.ProjectConfig{Provider: "alibaba"})
		if f.AlibabaWAFInstanceID != id {
			t.Fatalf("AlibabaWAFInstanceID = %q, want %q", f.AlibabaWAFInstanceID, id)
		}
		// The reference must reach the DECISION, not just the struct — that round trip is the
		// entire reason the output was added.
		d := decisionFor(t, InfraServiceDecisions(f), "waf")
		if d.Status != infraStatusSkipped {
			t.Fatalf("waf decision = %s (%s), want skipped — nothing binds the instance", d.Status, d.Reason)
		}
		if !strings.Contains(d.Reason, id) {
			t.Errorf("waf decision should name the unattached instance, got %q", d.Reason)
		}
	})

	// The switch off makes the output null; ExtractOutput yields "". Without this the "you are
	// paying for a firewall that filters nothing" report would fire on every Alibaba project.
	t.Run("waf off (null output) leaves the fact empty", func(t *testing.T) {
		f := BuildFromOutputs(map[string]interface{}{"waf_instance_id": nil}, &types.ProjectConfig{Provider: "alibaba"})
		if f.AlibabaWAFInstanceID != "" {
			t.Fatalf("AlibabaWAFInstanceID = %q, want empty", f.AlibabaWAFInstanceID)
		}
		if d := decisionFor(t, InfraServiceDecisions(f), "waf"); !strings.Contains(d.Reason, "no WAF instance was built") {
			t.Fatalf("waf decision reason = %q, want the switch-off reason", d.Reason)
		}
	})

	t.Run("no other cloud reads the key", func(t *testing.T) {
		for _, p := range []string{"aws", "gcp", "azure", "hetzner", "digitalocean"} {
			f := BuildFromOutputs(map[string]interface{}{"waf_instance_id": id}, &types.ProjectConfig{Provider: types.CloudProvider(p)})
			if f.AlibabaWAFInstanceID != "" {
				t.Errorf("%s: AlibabaWAFInstanceID = %q, want empty — the key is Alibaba-only", p, f.AlibabaWAFInstanceID)
			}
		}
	})
}
