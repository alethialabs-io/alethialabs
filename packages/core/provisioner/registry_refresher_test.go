// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// ecrXacctProject selects the cross-account keyless ECR registry with a complete provider_config.
func ecrXacctProject() *types.ProjectConfig {
	return &types.ProjectConfig{
		ContainerRegistries: []types.ProjectContainerRegistryConfig{{
			Name:     "app",
			Provider: "ecr-xacct",
			ProviderConfig: map[string]any{
				"target_account_id": "999999999999",
				"region":            "us-east-1",
				"registry_host":     "999999999999.dkr.ecr.us-east-1.amazonaws.com",
				"target_role_arn":   "arn:aws:iam::999999999999:role/alethia-pull",
			},
		}},
	}
}

func refresherFile(dir string) string { return filepath.Join(dir, "registry-pull-refresher.yaml") }

func TestWriteRegistryRefresher_FlagOff(t *testing.T) {
	// Flag unset → byte-identical: nothing rendered even with a keyless registry selected.
	os.Unsetenv("ALETHIA_XACCT_REGISTRY_ENABLED")
	dir := t.TempDir()
	skips, err := writeRegistryRefresher(dir, ecrXacctProject(), map[string]string{"ecr_pull_irsa_arn": "arn:x"}, io.Discard)
	if err != nil || len(skips) != 0 {
		t.Fatalf("flag off: skips=%v err=%v", skips, err)
	}
	if _, statErr := os.Stat(refresherFile(dir)); statErr == nil {
		t.Fatal("flag off must render NO refresher manifest")
	}
}

func TestWriteRegistryRefresher_On(t *testing.T) {
	t.Setenv("ALETHIA_XACCT_REGISTRY_ENABLED", "true")
	t.Setenv("ALETHIA_RUNNER_IMAGE", "ghcr.io/alethialabs-io/runner:test")
	dir := t.TempDir()
	skips, err := writeRegistryRefresher(dir, ecrXacctProject(), map[string]string{"ecr_pull_irsa_arn": "arn:aws:iam::111:role/ecr-pull"}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if len(skips) != 0 {
		t.Fatalf("unexpected skips: %v", skips)
	}
	if _, statErr := os.Stat(refresherFile(dir)); statErr != nil {
		t.Fatalf("expected a rendered refresher manifest: %v", statErr)
	}
}

func TestWriteRegistryRefresher_MissingOutputFailClosed(t *testing.T) {
	t.Setenv("ALETHIA_XACCT_REGISTRY_ENABLED", "true")
	t.Setenv("ALETHIA_RUNNER_IMAGE", "img:1")
	dir := t.TempDir()
	// Flag on + keyless registry selected, but the B4 pull-identity output is absent → fail closed
	// (skip reported, no manifest), never a refresher without its Workload Identity.
	skips, err := writeRegistryRefresher(dir, ecrXacctProject(), map[string]string{}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if len(skips) == 0 {
		t.Fatal("missing pull-identity output must be reported as a skip")
	}
	if _, statErr := os.Stat(refresherFile(dir)); statErr == nil {
		t.Fatal("must not render a refresher without its pull identity")
	}
}

func TestWriteRegistryRefresher_NoKeylessRegistry(t *testing.T) {
	t.Setenv("ALETHIA_XACCT_REGISTRY_ENABLED", "true")
	dir := t.TempDir()
	// Flag on but no keyless registry selected → nothing rendered.
	skips, err := writeRegistryRefresher(dir, &types.ProjectConfig{}, map[string]string{}, io.Discard)
	if err != nil || len(skips) != 0 {
		t.Fatalf("no keyless registry: skips=%v err=%v", skips, err)
	}
	if _, statErr := os.Stat(refresherFile(dir)); statErr == nil {
		t.Fatal("no keyless registry must render nothing")
	}
}
