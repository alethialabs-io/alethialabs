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
	write("kyverno.yaml", ours)          // disabled → prune
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
	if err := writeAddOnGitOps(vc, "", io.Discard, io.Discard); err != nil {
		t.Errorf("expected no-op without a repo, got %v", err)
	}
}
