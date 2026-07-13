// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// pruneOrphanAddOnManifests must remove only OUR files (carrying the marketplace label) whose
// add-on is no longer desired — never a still-desired add-on, never a customer's own file.
func TestPruneOrphanAddOnManifests(t *testing.T) {
	dir := t.TempDir()
	ours := "metadata:\n  labels:\n    alethia.io/managed-by: addon-marketplace\n"

	// A desired add-on (must be kept), a disabled add-on we authored (must be pruned), and a
	// customer's own file (no label — must be kept).
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
	write("loki.yaml", ours)
	write("kyverno.yaml", ours)                       // disabled → prune
	write("my-custom-app.yaml", "kind: Deployment\n") // customer's own → keep

	desired := map[string]types.AddOnInstall{
		"loki": {ID: "loki", Mode: "gitops"},
	}
	removed := pruneOrphanAddOnManifests(dir, desired, io.Discard, io.Discard)
	if removed != 1 {
		t.Fatalf("expected 1 pruned, got %d", removed)
	}
	if _, err := os.Stat(filepath.Join(dir, "kyverno.yaml")); !os.IsNotExist(err) {
		t.Error("disabled add-on manifest should have been pruned")
	}
	if _, err := os.Stat(filepath.Join(dir, "loki.yaml")); err != nil {
		t.Error("desired add-on manifest should have been kept")
	}
	if _, err := os.Stat(filepath.Join(dir, "my-custom-app.yaml")); err != nil {
		t.Error("customer's own manifest (no marketplace label) must not be pruned")
	}
}

// writeAddOnGitOps is a no-op when there's no apps repo / token (nothing to seed).
func TestWriteAddOnGitOpsNoRepo(t *testing.T) {
	vc := &types.ProjectConfig{}
	vc.AddOns = []types.AddOnInstall{{ID: "loki", Mode: "gitops"}}
	if err := writeAddOnGitOps(vc, "", nil, io.Discard, io.Discard); err != nil {
		t.Errorf("expected no-op without a repo, got %v", err)
	}
}

// A gitops-mode add-on seeded into the customer repo must carry the SAME classification/sweep
// labels as its managed-mode twin (BYOC B1.4) — the app-of-apps syncs it into the cluster as an
// ArgoCD Application, so a sweeper/selector keying off alethia.io/project-id must match it.
func TestRenderSeedManifest_StampsClassificationLabels(t *testing.T) {
	labels := map[string]string{
		"alethia.io/project-id":     "proj-1",
		"alethia.io/environment-id": "env-1",
		"alethia.io/tier":           "prod",
	}
	manifest, err := renderSeedManifest(types.AddOnInstall{
		ID: "loki", Mode: "gitops", ChartRepo: "https://grafana.github.io/helm-charts",
		Chart: "loki", Version: "6.6.0", Namespace: "logging",
	}, labels)
	if err != nil {
		t.Fatalf("renderSeedManifest: %v", err)
	}
	for k, v := range labels {
		if !strings.Contains(manifest, k+": "+v) {
			t.Errorf("seeded manifest missing label %q: %q\n%s", k, v, manifest)
		}
	}
	// The marketplace identity label must survive so prune-by-label still recognizes our file.
	if !strings.Contains(manifest, "alethia.io/managed-by: addon-marketplace") {
		t.Errorf("seeded manifest lost its managed-by label:\n%s", manifest)
	}
}
