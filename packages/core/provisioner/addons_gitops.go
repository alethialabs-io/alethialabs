// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/mod/semver"
	"gopkg.in/yaml.v3"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/git"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

const addonsRepoDir = "addons"

// writeAddOnGitOps seeds gitops-mode add-ons into the customer's apps repo under `addons/`, so
// they own + edit the manifests (the existing `addon-apps` app-of-apps syncs them). It is
// **seed-once**: a manifest is written only when absent, so a customer's edits are never
// clobbered (mirrors generateAppManifests' bring-your-own philosophy). Manifests for add-ons
// no longer enabled in gitops mode are pruned (only files WE authored — identified by the
// marketplace label — so a customer's own files are left alone). No-op when there are no
// gitops add-ons and nothing of ours to prune. commonLabels are the classification/sweep labels
// stamped onto each seeded Application (BYOC B1.4) — the app-of-apps syncs these into the cluster
// as ArgoCD Applications, so they must carry the same sweep handles as their managed-mode twins.
//
// It also READS each already-seeded manifest and returns one drift entry for every add-on whose file
// installs an older chart than the one this deploy would seed (#6537). Each entry carries the
// Deploy-tab sentence as well as its structured fields (#6549). It never rewrites the file to fix
// that: seed-once is the guarantee that a customer's edits are theirs, and a version is an edit like
// any other. The entries are returned even when the commit or push fails, because the clone that
// produced them succeeded.
func writeAddOnGitOps(ctx context.Context, vc *types.ProjectConfig, token string, commonLabels map[string]string, stdout, stderr io.Writer) ([]argocd.AddonDriftStatus, error) {
	if vc.Repositories.AppsDestinationRepo == "" || token == "" {
		return nil, nil
	}

	// Desired gitops add-ons, keyed by catalog id.
	desired := map[string]types.AddOnInstall{}
	for _, a := range vc.AddOns {
		if a.Mode == "gitops" {
			desired[a.ID] = a
		}
	}

	dir, err := os.MkdirTemp("", "alethia-addons-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)

	repo := git.NewGITWithToken(vc.Repositories.AppsDestinationRepo, dir, false, token, gitProviderFor(vc, vc.Repositories.AppsDestinationRepo))
	if err := repo.Clone(ctx, "", false); err != nil {
		return nil, fmt.Errorf("clone apps repo: %w", err)
	}

	addonsPath := filepath.Join(dir, addonsRepoDir)
	if err := os.MkdirAll(addonsPath, 0755); err != nil {
		return nil, err
	}

	// Seed-once: write a manifest only when the file is absent. A file that IS present is read for
	// its chart version, and only read.
	var warnings []argocd.AddonDriftStatus
	seeded := 0
	for _, id := range sortedAddOnIDs(desired) {
		a := desired[id]
		file := filepath.Join(addonsPath, id+".yaml")
		if body, readErr := os.ReadFile(file); readErr == nil {
			if d, drifted := gitopsAddOnDrift(id, body, a); drifted {
				warnings = append(warnings, d)
			}
			continue // already present — respect customer edits
		}
		manifest, renderErr := renderSeedManifest(a, commonLabels)
		if renderErr != nil {
			return warnings, fmt.Errorf("render gitops add-on %s: %w", id, renderErr)
		}
		if err := os.WriteFile(file, []byte(manifest), 0644); err != nil {
			return warnings, err
		}
		seeded++
	}

	// Prune our own orphans: a manifest we authored (carries the marketplace label) whose
	// add-on is no longer gitops-enabled.
	pruned := pruneOrphanAddOnManifests(addonsPath, desired, stdout, stderr)

	if seeded == 0 && pruned == 0 {
		return warnings, nil // nothing changed — no commit
	}
	if err := repo.AddAndCommit("chore: sync marketplace add-ons (alethia)"); err != nil {
		return warnings, fmt.Errorf("commit add-on manifests: %w", err)
	}
	if err := repo.Push(ctx); err != nil {
		return warnings, fmt.Errorf("push add-on manifests: %w", err)
	}
	fmt.Fprintf(stdout, "Synced GitOps add-ons: %d seeded, %d pruned.\n", seeded, pruned)
	return warnings, nil
}

// sortedAddOnIDs returns the map's ids in order, so the Deploy-tab warnings read the same on every
// deploy rather than in Go's randomised map order.
func sortedAddOnIDs(m map[string]types.AddOnInstall) []string {
	ids := make([]string, 0, len(m))
	for id := range m {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// seededAddOnApplication is the part of an `addons/<id>.yaml` the drift check reads.
type seededAddOnApplication struct {
	Kind string `yaml:"kind"`
	Spec struct {
		Source struct {
			Chart          string `yaml:"chart"`
			TargetRevision string `yaml:"targetRevision"`
		} `yaml:"source"`
	} `yaml:"spec"`
}

// gitopsAddOnDrift reports an already-present GitOps add-on manifest whose chart version is OLDER
// than the one this deploy would seed (`a.Version`: the catalogue's version, or the user's pin), with
// its Deploy-tab sentence; ok is false when there is nothing to say (#6537, #6549).
//
// It says nothing unless it is sure, because a warning that cries wolf on every deploy is one the
// customer learns to skip. So nothing for a file that does not parse, is not an ArgoCD Application,
// has no single `spec.source` (a multi-source Application is the customer's own design), installs a
// DIFFERENT chart (they replaced ours), or carries a version that is not SemVer (a range such as
// `4.*` is theirs to choose). And nothing for a version at or above the desired one: a customer
// ahead of the catalogue is not drift worth a warning.
func gitopsAddOnDrift(id string, body []byte, a types.AddOnInstall) (d argocd.AddonDriftStatus, ok bool) {
	var app seededAddOnApplication
	if err := yaml.Unmarshal(body, &app); err != nil {
		return d, false
	}
	src := app.Spec.Source
	if app.Kind != "Application" || src.Chart == "" || src.Chart != a.Chart {
		return d, false
	}
	seeded, desired := canonicalSemver(src.TargetRevision), canonicalSemver(a.Version)
	if seeded == "" || desired == "" || semver.Compare(seeded, desired) >= 0 {
		return d, false
	}
	d = argocd.AddonDriftStatus{
		AddonID:        id,
		File:           addonsRepoDir + "/" + id + ".yaml",
		Chart:          src.Chart,
		SeededVersion:  src.TargetRevision,
		DesiredVersion: a.Version,
	}
	d.Warning = gitopsAddOnDriftWarning(d)
	return d, true
}

// gitopsAddOnDriftWarning is the Deploy-tab sentence for one drifted GitOps add-on. It is what a
// console that predates `addon_drift` shows; see argocd.AddonDriftStatus.Warning.
func gitopsAddOnDriftWarning(d argocd.AddonDriftStatus) string {
	return fmt.Sprintf("GitOps add-on %s: %s/%s.yaml in your apps repo installs chart %s %s, and Alethia would seed %s "+
		"today. Alethia does not rewrite a file it has already seeded, so this add-on stays on %s until you set "+
		"spec.source.targetRevision in that file to %s. The add-on's card in the console says whether %s is a security release.",
		d.AddonID, addonsRepoDir, d.AddonID, d.Chart, d.SeededVersion, d.DesiredVersion, d.SeededVersion, d.DesiredVersion, d.DesiredVersion)
}

// canonicalSemver returns v in the "vMAJOR.MINOR.PATCH" form golang.org/x/mod/semver compares, or
// "" when it is not a full SemVer version. Chart versions are written without the `v`; a few chart
// repositories tag with it, and both spell the same version.
func canonicalSemver(v string) string {
	v = strings.TrimSpace(v)
	if !strings.HasPrefix(v, "v") {
		v = "v" + v
	}
	// semver.IsValid accepts the shorthand "v1" and "v1.2"; a chart version is always all three parts.
	if !semver.IsValid(v) || semver.Canonical(v) != strings.SplitN(v, "+", 2)[0] {
		return ""
	}
	return v
}

// renderSeedManifest renders a gitops-mode add-on Application and stamps the classification/sweep
// labels onto it (BYOC B1.4), so the seeded manifest the app-of-apps syncs into the cluster carries
// the same sweep handles as the managed-mode twin from argocd.RenderManagedAddOns. Pure + testable:
// no repo/network. The marketplace identity label the template already sets is preserved (injection
// never clobbers), so prune-by-label still recognizes our files.
func renderSeedManifest(a types.AddOnInstall, commonLabels map[string]string) (string, error) {
	manifest, err := argocd.RenderAddOnApplication(a)
	if err != nil {
		return "", err
	}
	return argocd.InjectCommonLabels(manifest, commonLabels)
}

// pruneOrphanAddOnManifests deletes `addons/*.yaml` files that WE authored (they carry the
// `alethia.io/managed-by: addon-marketplace` label) whose add-on id is not in `desired`.
// Files without our label (customer-authored) are left untouched. Returns the count removed.
func pruneOrphanAddOnManifests(
	addonsPath string,
	desired map[string]types.AddOnInstall,
	stdout, stderr io.Writer,
) int {
	entries, err := os.ReadDir(addonsPath)
	if err != nil {
		return 0
	}
	removed := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".yaml") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".yaml")
		if _, keep := desired[id]; keep {
			continue
		}
		full := filepath.Join(addonsPath, e.Name())
		body, readErr := os.ReadFile(full)
		if readErr != nil {
			continue
		}
		// Only prune manifests we authored — never a customer's own file.
		if !strings.Contains(string(body), "alethia.io/managed-by: addon-marketplace") {
			continue
		}
		if err := os.Remove(full); err != nil {
			fmt.Fprintf(stderr, "Warning: could not prune add-on manifest %s: %v\n", e.Name(), err)
			continue
		}
		fmt.Fprintf(stdout, "Pruned GitOps add-on manifest: %s\n", e.Name())
		removed++
	}
	return removed
}
