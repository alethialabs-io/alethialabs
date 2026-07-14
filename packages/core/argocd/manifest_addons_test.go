// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"os"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// renderedNames lists the files RenderManagedAddOns wrote (one per rendered Application).
func renderedNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func manifestAddOn() types.AddOnInstall {
	return types.AddOnInstall{
		ID:        "rabbitmq-operator",
		Mode:      "managed",
		Source:    "manifest",
		ChartRepo: "https://github.com/rabbitmq/cluster-operator/releases/download/v2.22.2/cluster-operator.yml",
		Version:   "v2.22.2",
		CRDs:      []string{"rabbitmqclusters.rabbitmq.com"},
		Namespace: "rabbitmq-system",
	}
}

func helmAddOn(id string) types.AddOnInstall {
	return types.AddOnInstall{
		ID:        id,
		Mode:      "managed",
		ChartRepo: "https://example.test/charts",
		Chart:     id,
		Version:   "1.0.0",
		Namespace: id,
		Values:    map[string]interface{}{},
	}
}

// The renderer must NOT emit an ArgoCD Application for a manifest add-on: an Application source
// cannot be a bare https://…yaml, so one would be permanently unresolvable ("ComparisonError").
func TestRenderManagedAddOns_SkipsManifestSource(t *testing.T) {
	dir, err := RenderManagedAddOns(
		[]types.AddOnInstall{manifestAddOn(), helmAddOn("reloader")},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	names := renderedNames(t, dir)
	for _, n := range names {
		if strings.Contains(n, "rabbitmq-operator") {
			t.Fatalf("manifest add-on must NOT render an ArgoCD Application, got file %q", n)
		}
	}
	// …but the Helm add-on alongside it still renders (the skip must be surgical).
	found := false
	for _, n := range names {
		if strings.Contains(n, "reloader") {
			found = true
		}
	}
	if !found {
		t.Fatal("helm add-on alongside a manifest add-on must still render an Application")
	}
}

// The health read + the prune both address ArgoCD Applications by name. A manifest add-on has no
// Application, so including it would make the console report it Missing/Unknown forever, and would
// have the prune look for something that can never exist.
func TestAddOnNames_ExcludeManifestSource(t *testing.T) {
	addons := []types.AddOnInstall{manifestAddOn(), helmAddOn("reloader")}

	all := AllAddOnNames(addons)
	for _, n := range all {
		if strings.Contains(n, "rabbitmq-operator") {
			t.Fatalf("AllAddOnNames must exclude manifest add-ons (no Application exists), got %v", all)
		}
	}
	if len(all) != 1 || all[0] != AddOnAppName("reloader") {
		t.Fatalf("AllAddOnNames should keep the helm add-on, got %v", all)
	}

	managed := ManagedAddOnNames(addons)
	for _, n := range managed {
		if strings.Contains(n, "rabbitmq-operator") {
			t.Fatalf("ManagedAddOnNames must exclude manifest add-ons, got %v", managed)
		}
	}
	if len(managed) != 1 {
		t.Fatalf("ManagedAddOnNames should keep the helm add-on, got %v", managed)
	}
}

// ManifestAddOns is the operator wave: managed manifest-source add-ons only, in order.
func TestManifestAddOns_Filter(t *testing.T) {
	gitops := manifestAddOn()
	gitops.ID = "gitops-operator"
	gitops.Mode = "gitops" // written into the customer's repo, not applied by the runner

	got := ManifestAddOns([]types.AddOnInstall{
		helmAddOn("reloader"),
		manifestAddOn(),
		gitops,
	})
	if len(got) != 1 {
		t.Fatalf("expected exactly the managed manifest add-on, got %d: %+v", len(got), got)
	}
	if got[0].ID != "rabbitmq-operator" {
		t.Fatalf("wrong add-on selected: %s", got[0].ID)
	}
	if !got[0].IsManifestSource() || got[0].IsGitSource() {
		t.Fatal("source predicates disagree with the selected add-on")
	}
}

// A helm/git add-on must never be mistaken for a manifest one (regression guard on the predicate).
func TestIsManifestSource_Discriminates(t *testing.T) {
	if helmAddOn("x").IsManifestSource() {
		t.Fatal("a helm add-on must not be a manifest source")
	}
	git := helmAddOn("y")
	git.Source = "git"
	if git.IsManifestSource() {
		t.Fatal("a git add-on must not be a manifest source")
	}
	if !manifestAddOn().IsManifestSource() {
		t.Fatal("a manifest add-on must be a manifest source")
	}
}
