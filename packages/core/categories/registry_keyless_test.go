// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// keylessProject wires a project selecting one cross-account keyless registry with the given
// provider_config (no credentials — keyless reads only provider_config).
func keylessProject(slug string, pc map[string]any) *types.ProjectConfig {
	return &types.ProjectConfig{
		ContainerRegistries: []types.ProjectContainerRegistryConfig{
			{Name: "app", Provider: slug, ProviderConfig: pc},
		},
	}
}

func TestKeylessRegistryValidateAndTarget(t *testing.T) {
	tests := []struct {
		slug     string
		full     map[string]any // a complete provider_config
		wantHost string
		check    func(t *testing.T, tgt KeylessRegistryTarget)
	}{
		{
			slug: "ecr-xacct",
			full: map[string]any{
				"target_account_id": "123456789012", "region": "us-east-1",
				"registry_host":   "123456789012.dkr.ecr.us-east-1.amazonaws.com",
				"target_role_arn": "arn:aws:iam::123456789012:role/alethia-ecr-pull",
			},
			wantHost: "123456789012.dkr.ecr.us-east-1.amazonaws.com",
			check: func(t *testing.T, tgt KeylessRegistryTarget) {
				if tgt.Provider != "aws" || tgt.TargetAccountID != "123456789012" ||
					tgt.TargetIdentityRef != "arn:aws:iam::123456789012:role/alethia-ecr-pull" {
					t.Fatalf("ecr target = %+v", tgt)
				}
			},
		},
		{
			slug: "gar-xacct",
			full: map[string]any{
				"target_project_id": "acme-prod", "region": "us-central1",
				"registry_host":          "us-central1-docker.pkg.dev",
				"target_service_account": "pull@acme-prod.iam.gserviceaccount.com",
			},
			wantHost: "us-central1-docker.pkg.dev",
			check: func(t *testing.T, tgt KeylessRegistryTarget) {
				if tgt.Provider != "gcp" || tgt.TargetProjectID != "acme-prod" ||
					tgt.TargetIdentityRef != "pull@acme-prod.iam.gserviceaccount.com" {
					t.Fatalf("gar target = %+v", tgt)
				}
			},
		},
		{
			slug: "acr-xacct",
			full: map[string]any{
				"target_subscription_id": "0000-sub", "registry_host": "acme.azurecr.io",
				"target_identity_client_id": "11111111-1111-1111-1111-111111111111",
			},
			wantHost: "acme.azurecr.io",
			check: func(t *testing.T, tgt KeylessRegistryTarget) {
				if tgt.Provider != "azure" || tgt.TargetSubscriptionID != "0000-sub" ||
					tgt.TargetIdentityRef != "11111111-1111-1111-1111-111111111111" {
					t.Fatalf("acr target = %+v", tgt)
				}
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.slug, func(t *testing.T) {
			p, err := Get("registry", tt.slug)
			if err != nil {
				t.Fatal(err)
			}
			if !IsKeylessRegistry(tt.slug) {
				t.Fatalf("%s should be a keyless registry", tt.slug)
			}
			// Empty provider_config → fail-closed (no half-built target).
			if err := p.Validate(ComponentContext{}); err == nil {
				t.Fatalf("%s: expected validation error for empty provider_config", tt.slug)
			}
			ctx := ComponentContext{ProviderConfig: tt.full}
			if err := p.Validate(ctx); err != nil {
				t.Fatalf("%s: unexpected validation error: %v", tt.slug, err)
			}
			tgt, ok := p.KeylessRegistry(ctx)
			if !ok {
				t.Fatalf("%s: KeylessRegistry not ok", tt.slug)
			}
			if tgt.Slug != tt.slug || tgt.RegistryHost != tt.wantHost || tgt.SecretName() != tt.slug+"-pull" {
				t.Fatalf("%s: target basics wrong: %+v (secret %q)", tt.slug, tgt, tgt.SecretName())
			}
			tt.check(t, tgt)
		})
	}
}

func TestDominantRegistryKeylessTargetRouting(t *testing.T) {
	full := map[string]any{
		"target_account_id": "123456789012", "region": "us-east-1",
		"registry_host":   "123456789012.dkr.ecr.us-east-1.amazonaws.com",
		"target_role_arn": "arn:aws:iam::123456789012:role/alethia-ecr-pull",
	}

	// A keyless registry → DominantRegistryKeylessTarget returns it, and the STATIC pull-secret path
	// returns nil (the two are mutually exclusive; keyless gets a refresher, not a static secret).
	vc := keylessProject("ecr-xacct", full)
	tgt, err := DominantRegistryKeylessTarget(vc)
	if err != nil {
		t.Fatal(err)
	}
	if tgt == nil || tgt.Slug != "ecr-xacct" {
		t.Fatalf("expected ecr-xacct keyless target, got %+v", tgt)
	}
	spec, err := DominantRegistryPullSecretSpec(vc)
	if err != nil {
		t.Fatalf("static spec unexpected error: %v", err)
	}
	if spec != nil {
		t.Fatalf("keyless registry must NOT get a static pull secret, got %+v", spec)
	}

	// A credential-based registry → the inverse: no keyless target.
	staticVC := &types.ProjectConfig{
		ContainerRegistries:  []types.ProjectContainerRegistryConfig{{Name: "app", Provider: "dockerhub"}},
		ConnectorCredentials: []types.ConnectorCredential{{Category: "registry", Slug: "dockerhub", Credentials: map[string]string{"username": "u", "access_token": "t"}}},
	}
	if tgt, err := DominantRegistryKeylessTarget(staticVC); err != nil || tgt != nil {
		t.Fatalf("dockerhub must NOT be a keyless target: tgt=%+v err=%v", tgt, err)
	}

	// Native / none → nil, no error.
	if tgt, err := DominantRegistryKeylessTarget(&types.ProjectConfig{}); err != nil || tgt != nil {
		t.Fatalf("no registry → nil keyless target: tgt=%+v err=%v", tgt, err)
	}

	// A selected-but-misconfigured keyless registry fails closed.
	if _, err := DominantRegistryKeylessTarget(keylessProject("ecr-xacct", nil)); err == nil {
		t.Fatal("expected fail-closed error for ecr-xacct with no provider_config")
	}
}
