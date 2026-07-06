// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package state

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	"gopkg.in/yaml.v3"
)

// readInfraServices runs the REAL SaveInfraFacts in an isolated cwd and returns the written
// infra-services map. Previously these tests re-implemented the filter inline and never called
// the function (≈0 mutation score) — now they drive it end to end.
func readInfraServices(t *testing.T, raw, outputs map[string]interface{}, dryRun bool) map[string]interface{} {
	t.Helper()
	t.Chdir(t.TempDir()) // SaveInfraFacts writes ./temp/infra-facts.yaml
	if err := (&State{}).SaveInfraFacts(raw, outputs, dryRun, utils.NewLogger(nil, "")); err != nil {
		t.Fatalf("SaveInfraFacts: %v", err)
	}
	data, err := os.ReadFile(filepath.Join("temp", "infra-facts.yaml"))
	if err != nil {
		t.Fatalf("read infra-facts.yaml: %v", err)
	}
	var parsed map[string]map[string]interface{}
	if err := yaml.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return parsed["infra-services"]
}

func TestSaveInfraFacts_FiltersSensitiveFields(t *testing.T) {
	svc := readInfraServices(t, map[string]interface{}{
		"project_name":                   "test",
		"region":                         "eu-west-1",
		"gitops_argo_access_token":       "secret-token-123",
		"applications_argo_access_token": "another-secret",
	}, map[string]interface{}{"cluster_endpoint": "https://x"}, false)

	if _, ok := svc["gitops_argo_access_token"]; ok {
		t.Error("gitops_argo_access_token must be filtered out")
	}
	if _, ok := svc["applications_argo_access_token"]; ok {
		t.Error("applications_argo_access_token must be filtered out")
	}
	if svc["project_name"] != "test" || svc["region"] != "eu-west-1" {
		t.Errorf("scalar fields not preserved: %v", svc)
	}
	if svc["cluster_endpoint"] != "https://x" {
		t.Errorf("OpenTofu outputs not merged in: %v", svc)
	}
}

func TestSaveInfraFacts_OnlyScalarsKept(t *testing.T) {
	svc := readInfraServices(t, map[string]interface{}{
		"project_name": "test",
		"count":        float64(42),
		"enabled":      true,
		"nested_map":   map[string]interface{}{"key": "val"},
		"slice":        []string{"a", "b"},
	}, map[string]interface{}{"out": "v"}, false)

	if _, ok := svc["nested_map"]; ok {
		t.Error("nested maps should be dropped")
	}
	if _, ok := svc["slice"]; ok {
		t.Error("slices should be dropped")
	}
	if svc["project_name"] != "test" || svc["count"] != 42 || svc["enabled"] != true {
		t.Errorf("scalars not kept: %v", svc)
	}
}

func TestSaveInfraFacts_RequiresOutputsWhenNotDryRun(t *testing.T) {
	t.Chdir(t.TempDir())
	err := (&State{}).SaveInfraFacts(
		map[string]interface{}{"project_name": "test"},
		map[string]interface{}{}, // no outputs
		false,                    // not dry-run → must error
		utils.NewLogger(nil, ""),
	)
	if err == nil {
		t.Error("expected an error when outputs are empty and not in dry-run mode")
	}
}
