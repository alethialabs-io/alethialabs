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
