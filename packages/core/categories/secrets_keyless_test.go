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
				// external_id is OPTIONAL — a trust policy without an sts:ExternalId condition is the
				// default and must stay valid, carrying an empty id (the store then omits the field).
				if tgt.TargetExternalID != "" {
					t.Fatalf("aws target external id = %q, want empty when provider_config omits it", tgt.TargetExternalID)
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

// An sts:ExternalId condition on the target role's trust policy is OPTIONAL defense-in-depth, but when
// the customer's bootstrap sets one the same value must reach the store or STS rejects every assume —
// which is exactly the dangling-control bug this covers (the module offered external_id while nothing
// carried it through). AWS-only: the other lanes bind the grant to a concrete principal instead.
func TestKeylessSecretTargetCarriesAWSExternalID(t *testing.T) {
	p, err := Get("secrets", "aws-sm-xacct")
	if err != nil {
		t.Fatal(err)
	}
	pc := map[string]any{
		"target_account_id": "123456789012", "region": "us-east-1",
		"target_role_arn": "arn:aws:iam::123456789012:role/alethia-secrets-read",
		"external_id":     "acme-7f3c",
	}
	ctx := ComponentContext{ProviderConfig: pc}
	if err := p.Validate(ctx); err != nil {
		t.Fatalf("external_id must not affect validation: %v", err)
	}
	tgt, ok := p.KeylessSecretStore(ctx)
	if !ok {
		t.Fatal("aws-sm-xacct: KeylessSecretStore not ok")
	}
	if tgt.TargetExternalID != "acme-7f3c" {
		t.Fatalf("TargetExternalID = %q, want acme-7f3c", tgt.TargetExternalID)
	}
}

// The store NAME is keyed on the CLOUD, not the connector slug. The slug is "aws-sm-xacct" but the
// store is "secretstore-aws-xacct", so the tempting "secretstore-"+slug is wrong on every lane — and
// a wrong name means an ExternalSecret pointing at a store that does not exist.
func TestXacctStoreName(t *testing.T) {
	for cloud, want := range map[string]string{
		"aws":     "secretstore-aws-xacct",
		"gcp":     "secretstore-gcp-xacct",
		"azure":   "secretstore-azure-xacct",
		"alibaba": "secretstore-alibaba-xacct",
		// no cross-account store on these — "" so callers fail closed
		"hetzner": "",
		"":        "",
		"nonsuch": "",
	} {
		if got := XacctStoreName(cloud); got != want {
			t.Errorf("XacctStoreName(%q) = %q, want %q", cloud, got, want)
		}
	}
	if got := len(AllXacctStoreNames()); got != 4 {
		t.Errorf("AllXacctStoreNames returned %d names, want 4 — the stale-store reaper enumerates this", got)
	}
	for _, n := range AllXacctStoreNames() {
		if n == "" {
			t.Error("AllXacctStoreNames must not contain an empty name — the reaper would kubectl-delete a nameless object")
		}
	}
}

// Every *-xacct slug's built target must resolve to its cloud's store, proving the slug→cloud→name
// hop is wired (this is where "secretstore-"+slug would silently produce "secretstore-aws-sm-xacct").
func TestKeylessSecretTargetStoreName(t *testing.T) {
	for slug, want := range map[string]string{
		"aws-sm-xacct":      "secretstore-aws-xacct",
		"gcp-sm-xacct":      "secretstore-gcp-xacct",
		"azure-kv-xacct":    "secretstore-azure-xacct",
		"alibaba-kms-xacct": "secretstore-alibaba-xacct",
	} {
		p, err := Get("secrets", slug)
		if err != nil {
			t.Fatalf("Get(secrets, %s): %v", slug, err)
		}
		tgt, ok := p.KeylessSecretStore(ComponentContext{ProviderConfig: keylessSecretFixture(slug)})
		if !ok {
			t.Fatalf("%s: KeylessSecretStore not ok", slug)
		}
		if got := tgt.StoreName(); got != want {
			t.Errorf("%s: StoreName() = %q, want %q", slug, got, want)
		}
	}
}

// keylessSecretFixture is a minimal valid provider_config per *-xacct slug.
func keylessSecretFixture(slug string) map[string]any {
	switch slug {
	case "aws-sm-xacct":
		return map[string]any{"target_account_id": "123456789012", "region": "us-east-1",
			"target_role_arn": "arn:aws:iam::123456789012:role/read"}
	case "gcp-sm-xacct":
		return map[string]any{"target_project_id": "secrets-project-b"}
	case "azure-kv-xacct":
		return map[string]any{"target_subscription_id": "sub-b", "vault_url": "https://target.vault.azure.net/"}
	case "alibaba-kms-xacct":
		return map[string]any{"target_account_id": "1234567890", "region": "cn-hangzhou",
			"target_role_arn": "acs:ram::1234567890:role/read", "target_oidc_provider_arn": "acs:ram::1234567890:oidc-provider/ack"}
	}
	return nil
}

// The manifest lane branches on IsSaaSSecretStore first and the cross-account gate second. If any
// slug were BOTH, the two branches would fight over one map key and which store a workload reads
// would depend on branch order — so they must be provably disjoint.
func TestSaaSAndKeylessSecretStoresAreDisjoint(t *testing.T) {
	for _, slug := range []string{"aws-sm-xacct", "gcp-sm-xacct", "azure-kv-xacct", "alibaba-kms-xacct",
		"vault", "doppler", "generic", "infisical", "1password", "native"} {
		if IsSaaSSecretStore(slug) && IsKeylessSecretStore(slug) {
			t.Errorf("%q is BOTH a SaaS store and a cross-account keyless store — the two secretStoreRefs branches would collide", slug)
		}
	}
}
