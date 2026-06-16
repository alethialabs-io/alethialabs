// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package state

import (
	"testing"
)

func TestSensitiveFieldsFiltered(t *testing.T) {
	fields := map[string]bool{
		"applications_argo_access_token": true,
		"gitops_argo_access_token":       true,
	}

	rawConfig := map[string]interface{}{
		"project_name":                   "test",
		"region":                         "eu-west-1",
		"gitops_argo_access_token":       "secret-token-123",
		"applications_argo_access_token": "another-secret",
	}

	filtered := make(map[string]interface{})
	for k, v := range rawConfig {
		if fields[k] {
			continue
		}
		switch v.(type) {
		case float64, string, int, bool:
			filtered[k] = v
		}
	}

	if _, ok := filtered["gitops_argo_access_token"]; ok {
		t.Error("sensitive field gitops_argo_access_token should be filtered")
	}
	if _, ok := filtered["applications_argo_access_token"]; ok {
		t.Error("sensitive field applications_argo_access_token should be filtered")
	}
	if filtered["project_name"] != "test" {
		t.Errorf("expected project_name 'test', got %v", filtered["project_name"])
	}
	if filtered["region"] != "eu-west-1" {
		t.Errorf("expected region 'eu-west-1', got %v", filtered["region"])
	}
}

func TestOnlyScalarValuesKept(t *testing.T) {
	rawConfig := map[string]interface{}{
		"project_name": "test",
		"count":        float64(42),
		"enabled":      true,
		"nested_map":   map[string]interface{}{"key": "val"},
		"slice":        []string{"a", "b"},
	}

	filtered := make(map[string]interface{})
	for k, v := range rawConfig {
		if sensitiveFields[k] {
			continue
		}
		switch v.(type) {
		case float64, string, int, bool:
			filtered[k] = v
		}
	}

	if _, ok := filtered["nested_map"]; ok {
		t.Error("nested maps should be filtered out")
	}
	if _, ok := filtered["slice"]; ok {
		t.Error("slices should be filtered out")
	}
	if filtered["project_name"] != "test" {
		t.Error("string should be kept")
	}
	if filtered["count"] != float64(42) {
		t.Error("float64 should be kept")
	}
	if filtered["enabled"] != true {
		t.Error("bool should be kept")
	}
}
