// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// ecrHelmProject selects one cross-account keyless OCI ECR Helm chart repo with a complete config.
func ecrHelmProject() *types.ProjectConfig {
	return &types.ProjectConfig{
		HelmRegistries: []types.ProjectHelmRegistryConfig{{
			Name:     "charts",
			Provider: "oci-ecr",
			ProviderConfig: map[string]any{
				"target_account_id": "999999999999",
				"region":            "us-east-1",
				"registry_host":     "999999999999.dkr.ecr.us-east-1.amazonaws.com",
				"target_role_arn":   "arn:aws:iam::999999999999:role/helm-pull",
			},
		}},
	}
}

func TestRenderKeylessHelmRefreshers_NoTargets(t *testing.T) {
	res := renderKeylessHelmRefreshers(&types.ProjectConfig{}, "arn:x", "img:1")
	if res.Manifest != "" || res.Skip != "" || len(res.DesiredRefreshers) != 0 || len(res.DesiredSecrets) != 0 {
		t.Fatalf("no targets → empty result: %+v", res)
	}
}

func TestRenderKeylessHelmRefreshers_MissingIRSAFailClosed(t *testing.T) {
	// Keyless ECR repo connected but the tofu pull-identity output is absent → fail closed (skip
	// reported, NO manifest), never a refresher without its Workload Identity.
	res := renderKeylessHelmRefreshers(ecrHelmProject(), "", "img:1")
	if res.Manifest != "" {
		t.Fatal("missing IRSA must render no manifest (fail-closed)")
	}
	if res.Skip == "" {
		t.Fatal("missing IRSA must report a fail-closed skip")
	}
}

func TestRenderKeylessHelmRefreshers_On(t *testing.T) {
	res := renderKeylessHelmRefreshers(ecrHelmProject(), "arn:aws:iam::111:role/helm-pull", "ghcr.io/runner:test")
	if res.Skip != "" {
		t.Fatalf("unexpected skip: %s", res.Skip)
	}
	if res.Manifest == "" {
		t.Fatal("expected a rendered manifest")
	}
	if len(res.DesiredSecrets) != 1 || len(res.DesiredRefreshers) != 1 {
		t.Fatalf("want 1 desired secret + 1 refresher, got %+v", res)
	}
}

func TestRenderKeylessHelmRefreshers_MisconfiguredSkipped(t *testing.T) {
	// A connected ECR repo with an empty provider_config is skipped fail-closed with its error surfaced
	// via SkippedTargets — and since it is the only target, nothing is rendered.
	bad := &types.ProjectConfig{HelmRegistries: []types.ProjectHelmRegistryConfig{{Name: "c", Provider: "oci-ecr"}}}
	res := renderKeylessHelmRefreshers(bad, "arn:aws:iam::111:role/helm-pull", "img:1")
	if res.SkippedTargets == nil {
		t.Fatal("a misconfigured target must surface via SkippedTargets")
	}
	if res.Manifest != "" {
		t.Fatal("no valid target → no manifest")
	}
}
