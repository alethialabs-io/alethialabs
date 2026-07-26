// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import (
	"io"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// keylessSecretProject wires a project selecting one cross-account keyless secret manager with the
// given provider_config (no credentials — keyless reads only provider_config).
func keylessSecretProject(slug string, pc map[string]any) *types.ProjectConfig {
	return &types.ProjectConfig{
		Secrets: []types.ProjectSecretConfig{
			{Name: "app-secret", Provider: slug, ProviderConfig: pc},
		},
	}
}

func TestComposeKeylessSecretSetsXacctGuard(t *testing.T) {
	vc := keylessSecretProject("aws-sm-xacct", map[string]any{
		"target_account_id": "999999999999", "region": "us-east-1",
		"target_role_arn": "arn:aws:iam::999999999999:role/alethia-secrets-read",
	})
	tfvars := map[string]any{}
	if _, err := Compose(t.TempDir(), "", vc, tfvars, io.Discard); err != nil {
		t.Fatal(err)
	}
	// The separate cross-account guard is set to the slug…
	if tfvars["secrets_xacct_provider"] != "aws-sm-xacct" {
		t.Fatalf("secrets_xacct_provider = %v, want aws-sm-xacct", tfvars["secrets_xacct_provider"])
	}
	// …the AWS cluster-side assume leg gets the target role ARN…
	if tfvars["secrets_xacct_target_role_arn"] != "arn:aws:iam::999999999999:role/alethia-secrets-read" {
		t.Fatalf("secrets_xacct_target_role_arn = %v", tfvars["secrets_xacct_target_role_arn"])
	}
	// …and the NATIVE store is UNTOUCHED (secrets_provider stays native — a cross-account manager is an
	// additional read source, never a replacement).
	if tfvars["secrets_provider"] != "native" {
		t.Fatalf("secrets_provider must stay native for a keyless secret store, got %v", tfvars["secrets_provider"])
	}
}

func TestComposeKeylessSecretGCPAzureNoAssumeLeg(t *testing.T) {
	// GCP, Azure and Alibaba need NO cluster-side assume leg — the read grant lives entirely in the
	// target account (Model B): GCP/Azure bind our workload identity in the target project/subscription;
	// Alibaba exchanges the RRSA OIDC token directly for the target role. So secrets_xacct_target_role_arn
	// must stay unset for all three.
	for _, tc := range []struct {
		slug string
		pc   map[string]any
	}{
		{"gcp-sm-xacct", map[string]any{"target_project_id": "acme-secrets"}},
		{"azure-kv-xacct", map[string]any{"target_subscription_id": "sub-b", "vault_url": "https://acme.vault.azure.net"}},
		{"alibaba-kms-xacct", map[string]any{
			"target_account_id": "5551234", "region": "cn-hangzhou",
			"target_role_arn":          "acs:ram::5551234:role/read",
			"target_oidc_provider_arn": "acs:ram::5551234:oidc-provider/ack",
		}},
	} {
		t.Run(tc.slug, func(t *testing.T) {
			tfvars := map[string]any{}
			if _, err := Compose(t.TempDir(), "", keylessSecretProject(tc.slug, tc.pc), tfvars, io.Discard); err != nil {
				t.Fatal(err)
			}
			if tfvars["secrets_xacct_provider"] != tc.slug {
				t.Fatalf("secrets_xacct_provider = %v, want %s", tfvars["secrets_xacct_provider"], tc.slug)
			}
			if _, set := tfvars["secrets_xacct_target_role_arn"]; set {
				t.Fatalf("%s must NOT set a cluster-side assume role (grant lives in the target account)", tc.slug)
			}
			if tfvars["secrets_provider"] != "native" {
				t.Fatalf("secrets_provider must stay native, got %v", tfvars["secrets_provider"])
			}
		})
	}
}

func TestKeylessSecretStoreValidateAndTarget(t *testing.T) {
	tests := []struct {
		slug  string
		full  map[string]any // a complete provider_config
		check func(t *testing.T, tgt KeylessSecretTarget)
	}{
		{
			slug: "aws-sm-xacct",
			full: map[string]any{
				"target_account_id": "123456789012", "region": "us-east-1",
				"target_role_arn": "arn:aws:iam::123456789012:role/alethia-secrets-read",
			},
			check: func(t *testing.T, tgt KeylessSecretTarget) {
				if tgt.Provider != "aws" || tgt.TargetAccountID != "123456789012" ||
					tgt.Region != "us-east-1" || tgt.TargetRef != "arn:aws:iam::123456789012:role/alethia-secrets-read" {
					t.Fatalf("aws target = %+v", tgt)
				}
			},
		},
		{
			slug: "gcp-sm-xacct",
			full: map[string]any{"target_project_id": "acme-prod", "region": "us-central1"},
			check: func(t *testing.T, tgt KeylessSecretTarget) {
				if tgt.Provider != "gcp" || tgt.TargetProjectID != "acme-prod" || tgt.TargetRef != "" {
					t.Fatalf("gcp target = %+v", tgt)
				}
			},
		},
		{
			slug: "azure-kv-xacct",
			full: map[string]any{"target_subscription_id": "sub-b", "vault_url": "https://acme.vault.azure.net"},
			check: func(t *testing.T, tgt KeylessSecretTarget) {
				if tgt.Provider != "azure" || tgt.TargetSubscriptionID != "sub-b" ||
					tgt.TargetRef != "https://acme.vault.azure.net" {
					t.Fatalf("azure target = %+v", tgt)
				}
			},
		},
		{
			slug: "alibaba-kms-xacct",
			full: map[string]any{
				"target_account_id": "5551234", "region": "cn-hangzhou",
				"target_role_arn":          "acs:ram::5551234:role/alethia-secrets-read",
				"target_oidc_provider_arn": "acs:ram::5551234:oidc-provider/ack-rrsa",
			},
			check: func(t *testing.T, tgt KeylessSecretTarget) {
				if tgt.Provider != "alibaba" || tgt.TargetAccountID != "5551234" ||
					tgt.TargetRef != "acs:ram::5551234:role/alethia-secrets-read" ||
					tgt.TargetOIDCProviderRef != "acs:ram::5551234:oidc-provider/ack-rrsa" {
					t.Fatalf("alibaba target = %+v", tgt)
				}
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.slug, func(t *testing.T) {
			p, err := Get("secrets", tt.slug)
			if err != nil {
				t.Fatal(err)
			}
			if !IsKeylessSecretStore(tt.slug) {
				t.Fatalf("%s should be a keyless secret store", tt.slug)
			}
			// Empty provider_config → fail-closed (no half-built target).
			if err := p.Validate(ComponentContext{}); err == nil {
				t.Fatalf("%s: expected validation error for empty provider_config", tt.slug)
			}
			ctx := ComponentContext{ProviderConfig: tt.full}
			if err := p.Validate(ctx); err != nil {
				t.Fatalf("%s: unexpected validation error: %v", tt.slug, err)
			}
			tgt, ok := p.KeylessSecretStore(ctx)
			if !ok {
				t.Fatalf("%s: KeylessSecretStore not ok", tt.slug)
			}
			if tgt.Slug != tt.slug {
				t.Fatalf("%s: slug wrong: %+v", tt.slug, tgt)
			}
			tt.check(t, tgt)
		})
	}
}

func TestDominantKeylessSecretTargetRouting(t *testing.T) {
	full := map[string]any{
		"target_account_id": "123456789012", "region": "us-east-1",
		"target_role_arn": "arn:aws:iam::123456789012:role/alethia-secrets-read",
	}

	// A keyless secret store → DominantKeylessSecretTarget returns it.
	tgt, err := DominantKeylessSecretTarget(keylessSecretProject("aws-sm-xacct", full))
	if err != nil {
		t.Fatal(err)
	}
	if tgt == nil || tgt.Slug != "aws-sm-xacct" {
		t.Fatalf("expected aws-sm-xacct keyless target, got %+v", tgt)
	}

	// A credential-based store (vault) → NOT a keyless target.
	vaultVC := &types.ProjectConfig{
		Secrets: []types.ProjectSecretConfig{{Name: "s", Provider: "vault", ProviderConfig: map[string]any{"mount_path": "kv"}}},
	}
	if tgt, err := DominantKeylessSecretTarget(vaultVC); err != nil || tgt != nil {
		t.Fatalf("vault must NOT be a keyless target: tgt=%+v err=%v", tgt, err)
	}

	// Native / none → nil, no error.
	if tgt, err := DominantKeylessSecretTarget(&types.ProjectConfig{}); err != nil || tgt != nil {
		t.Fatalf("no secrets → nil keyless target: tgt=%+v err=%v", tgt, err)
	}

	// A selected-but-misconfigured keyless secret store fails closed.
	if _, err := DominantKeylessSecretTarget(keylessSecretProject("aws-sm-xacct", nil)); err == nil {
		t.Fatal("expected fail-closed error for aws-sm-xacct with no provider_config")
	}
}
