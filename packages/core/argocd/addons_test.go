// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func sampleAddOn() types.AddOnInstall {
	return types.AddOnInstall{
		ID:        "kube-prometheus-stack",
		Mode:      "managed",
		ChartRepo: "https://prometheus-community.github.io/helm-charts",
		Chart:     "kube-prometheus-stack",
		Version:   "61.9.0",
		Namespace: "monitoring",
		Values: map[string]interface{}{
			"grafana": map[string]interface{}{"enabled": true},
			"prometheus": map[string]interface{}{
				"prometheusSpec": map[string]interface{}{"retention": "15d"},
			},
		},
		SyncWave: 2,
	}
}

func TestRenderAddOnApplication(t *testing.T) {
	manifest, err := RenderAddOnApplication(sampleAddOn())
	if err != nil {
		t.Fatalf("render failed: %v", err)
	}
	// The manifest must be a well-formed ArgoCD Helm Application with the chart coords.
	for _, want := range []string{
		"kind: Application",
		"name: addon-kube-prometheus-stack",
		"repoURL: https://prometheus-community.github.io/helm-charts",
		"chart: kube-prometheus-stack",
		`targetRevision: "61.9.0"`,
		"namespace: monitoring",
		`sync-wave: "2"`,
		"alethia.io/addon-id: kube-prometheus-stack",
		"alethia.io/addon-mode: managed",
		"retention: 15d", // the merged values, indented under helm.values
	} {
		if !strings.Contains(manifest, want) {
			t.Errorf("manifest missing %q\n---\n%s", want, manifest)
		}
	}
}

func TestRenderManagedAddOnsSkipsGitops(t *testing.T) {
	managed := sampleAddOn()
	gitops := sampleAddOn()
	gitops.ID = "loki"
	gitops.Mode = "gitops"

	dir, err := RenderManagedAddOns([]types.AddOnInstall{managed, gitops})
	if err != nil {
		t.Fatalf("render failed: %v", err)
	}
	defer os.RemoveAll(dir)

	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("expected 1 managed manifest, got %d", len(entries))
	}
	if entries[0].Name() != "addon-kube-prometheus-stack.yaml" {
		t.Errorf("unexpected file %q", entries[0].Name())
	}
	// The gitops add-on must not have been written to the managed dir.
	if _, err := os.Stat(filepath.Join(dir, "addon-loki.yaml")); err == nil {
		t.Error("gitops add-on should not be rendered in managed mode")
	}
}

func TestManagedAddOnNames(t *testing.T) {
	names := ManagedAddOnNames([]types.AddOnInstall{
		{ID: "loki", Mode: "managed"},
		{ID: "vault", Mode: "gitops"},
		{ID: "kube-prometheus-stack", Mode: "managed"},
	})
	// Only managed add-ons, sorted, prefixed.
	if len(names) != 2 || names[0] != "addon-kube-prometheus-stack" || names[1] != "addon-loki" {
		t.Errorf("unexpected names: %v", names)
	}
}

func TestAllAddOnNames(t *testing.T) {
	names := AllAddOnNames([]types.AddOnInstall{
		{ID: "loki", Mode: "managed"},
		{ID: "vault", Mode: "gitops"},
	})
	// Every mode, sorted.
	if len(names) != 2 || names[0] != "addon-loki" || names[1] != "addon-vault" {
		t.Errorf("unexpected names: %v", names)
	}
}

func TestRenderGitopsModeLabel(t *testing.T) {
	a := sampleAddOn()
	a.Mode = "gitops"
	manifest, err := RenderAddOnApplication(a)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(manifest, "alethia.io/addon-mode: gitops") {
		t.Errorf("expected gitops mode label\n%s", manifest)
	}
}

func TestMarshalValuesEmpty(t *testing.T) {
	got, err := marshalValues(nil)
	if err != nil {
		t.Fatal(err)
	}
	if got != "{}" {
		t.Errorf("expected {} for empty values, got %q", got)
	}
}

func TestReadAddOnHealthUnknownFallback(t *testing.T) {
	// With no cluster reachable, every requested add-on falls back to Unknown (never errors).
	out := ReadAddOnHealth([]string{"addon-loki"}, os.Stdout, os.Stderr)
	h, ok := out["addon-loki"]
	if !ok {
		t.Fatal("expected addon-loki in the result")
	}
	if h.Health != "Unknown" || h.Sync != "Unknown" {
		t.Errorf("expected Unknown fallback, got %+v", h)
	}
}

func TestArgoAppListParse(t *testing.T) {
	// Sanity-check the trimmed shape we unmarshal ArgoCD's list into.
	raw := `{"items":[{"metadata":{"name":"addon-loki"},"status":{"health":{"status":"Healthy"},"sync":{"status":"Synced"}}}]}`
	var list argoAppList
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 1 || list.Items[0].Status.Health.Status != "Healthy" {
		t.Errorf("parse mismatch: %+v", list)
	}
}
