// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// gitopsAddOn builds a gitops-mode marketplace add-on install spec for the repo fixtures.
func gitopsAddOn(id string) types.AddOnInstall {
	return types.AddOnInstall{
		ID: id, Mode: "gitops",
		ChartRepo: "https://grafana.github.io/helm-charts",
		Chart:     id, Version: "1.0.0", Namespace: "observability",
	}
}

// writeAddOnGitOps must SEED a gitops add-on into `addons/` and push it, must NOT re-write a
// manifest the customer already has (seed-once), and must PRUNE only manifests we authored.
func TestWriteAddOnGitOps_SeedPruneAndSeedOnce(t *testing.T) {
	labels := map[string]string{"alethia.io/project-id": "proj-1"}

	tests := []struct {
		name        string
		seedFiles   map[string]string
		addons      []types.AddOnInstall
		wantPresent []string
		wantAbsent  []string
		wantCommits int
	}{
		{
			name:        "seeds a gitops add-on into addons/",
			addons:      []types.AddOnInstall{gitopsAddOn("loki")},
			wantPresent: []string{"addons/loki.yaml"},
			wantCommits: 2,
		},
		{
			name: "prunes our own manifest once the add-on is disabled",
			seedFiles: map[string]string{
				"addons/kyverno.yaml": "metadata:\n  labels:\n    alethia.io/managed-by: addon-marketplace\n",
			},
			addons:      []types.AddOnInstall{gitopsAddOn("loki")},
			wantPresent: []string{"addons/loki.yaml"},
			wantAbsent:  []string{"addons/kyverno.yaml"},
			wantCommits: 2,
		},
		{
			name: "leaves a customer-authored manifest alone and makes no commit",
			seedFiles: map[string]string{
				"addons/my-app.yaml": "kind: Deployment\n",
			},
			addons:      nil,
			wantPresent: []string{"addons/my-app.yaml"},
			wantCommits: 1, // nothing seeded, nothing pruned → no commit
		},
		{
			name: "seed-once: an existing manifest for a desired add-on is not rewritten",
			seedFiles: map[string]string{
				"addons/loki.yaml": "# customer edited\n",
			},
			addons:      []types.AddOnInstall{gitopsAddOn("loki")},
			wantPresent: []string{"addons/loki.yaml"},
			wantCommits: 1,
		},
		{
			name:        "managed-mode add-ons are not seeded into the repo",
			addons:      []types.AddOnInstall{{ID: "loki", Mode: "managed", Chart: "loki", ChartRepo: "https://x", Version: "1", Namespace: "o"}},
			wantAbsent:  []string{"addons/loki.yaml"},
			wantCommits: 1,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			bare := newBareAppsRepo(t, tc.seedFiles)
			vc := &types.ProjectConfig{ProjectName: "acme"}
			vc.Repositories.AppsDestinationRepo = "file://" + bare
			vc.AddOns = tc.addons

			var out, errb bytes.Buffer
			if err := writeAddOnGitOps(t.Context(), vc, "tok", labels, &out, &errb); err != nil {
				t.Fatalf("writeAddOnGitOps: %v", err)
			}

			files := readBareRepo(t, bare)
			for _, want := range tc.wantPresent {
				if _, ok := files[want]; !ok {
					t.Errorf("expected %s in the apps repo, got %v", want, keysOf(files))
				}
			}
			for _, absent := range tc.wantAbsent {
				if _, ok := files[absent]; ok {
					t.Errorf("expected %s to be absent from the apps repo", absent)
				}
			}
			if got := commitCount(t, bare); got != tc.wantCommits {
				t.Errorf("commit count = %d, want %d (stdout: %s)", got, tc.wantCommits, out.String())
			}
		})
	}
}

// A seeded manifest must carry BOTH the marketplace identity label (so the prune recognizes it)
// and the classification/sweep labels, exactly like its managed-mode twin.
func TestWriteAddOnGitOps_SeededManifestCarriesLabels(t *testing.T) {
	bare := newBareAppsRepo(t, nil)
	vc := &types.ProjectConfig{ProjectName: "acme"}
	vc.Repositories.AppsDestinationRepo = "file://" + bare
	vc.AddOns = []types.AddOnInstall{gitopsAddOn("tempo")}

	var out, errb bytes.Buffer
	if err := writeAddOnGitOps(t.Context(), vc, "tok",
		map[string]string{"alethia.io/environment-id": "env-9"}, &out, &errb); err != nil {
		t.Fatalf("writeAddOnGitOps: %v", err)
	}

	body := readBareRepo(t, bare)["addons/tempo.yaml"]
	for _, want := range []string{
		"alethia.io/managed-by: addon-marketplace",
		"alethia.io/environment-id: env-9",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("seeded manifest missing %q:\n%s", want, body)
		}
	}
}

// A repo the runner cannot clone must surface an error rather than silently skipping the sync.
func TestWriteAddOnGitOps_CloneFailureIsReported(t *testing.T) {
	vc := &types.ProjectConfig{ProjectName: "acme"}
	vc.Repositories.AppsDestinationRepo = "file://" + t.TempDir() + "/does-not-exist"
	vc.AddOns = []types.AddOnInstall{gitopsAddOn("loki")}

	var out, errb bytes.Buffer
	err := writeAddOnGitOps(t.Context(), vc, "tok", nil, &out, &errb)
	if err == nil {
		t.Fatal("expected a clone error for an unreachable apps repo")
	}
	if !strings.Contains(err.Error(), "clone apps repo") {
		t.Errorf("error should name the clone step, got %v", err)
	}
}

// keysOf lists a map's keys for assertion messages.
func keysOf(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
