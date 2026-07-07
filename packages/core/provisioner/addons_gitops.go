// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

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
// gitops add-ons and nothing of ours to prune.
func writeAddOnGitOps(vc *types.ProjectConfig, token string, stdout, stderr io.Writer) error {
	if vc.Repositories.AppsDestinationRepo == "" || token == "" {
		return nil
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
		return err
	}
	defer os.RemoveAll(dir)

	repo := git.NewGITWithToken(vc.Repositories.AppsDestinationRepo, dir, false, token)
	if err := repo.Clone("", false); err != nil {
		return fmt.Errorf("clone apps repo: %w", err)
	}

	addonsPath := filepath.Join(dir, addonsRepoDir)
	if err := os.MkdirAll(addonsPath, 0755); err != nil {
		return err
	}

	// Seed-once: write a manifest only when the file is absent.
	seeded := 0
	for id, a := range desired {
		file := filepath.Join(addonsPath, id+".yaml")
		if _, statErr := os.Stat(file); statErr == nil {
			continue // already present — respect customer edits
		}
		manifest, renderErr := argocd.RenderAddOnApplication(a)
		if renderErr != nil {
			return fmt.Errorf("render gitops add-on %s: %w", id, renderErr)
		}
		if err := os.WriteFile(file, []byte(manifest), 0644); err != nil {
			return err
		}
		seeded++
	}

	// Prune our own orphans: a manifest we authored (carries the marketplace label) whose
	// add-on is no longer gitops-enabled.
	pruned := pruneOrphanAddOnManifests(addonsPath, desired, stdout, stderr)

	if seeded == 0 && pruned == 0 {
		return nil // nothing changed — no commit
	}
	if err := repo.AddAndCommit("chore: sync marketplace add-ons (alethia)"); err != nil {
		return fmt.Errorf("commit add-on manifests: %w", err)
	}
	if err := repo.Push(); err != nil {
		return fmt.Errorf("push add-on manifests: %w", err)
	}
	fmt.Fprintf(stdout, "Synced GitOps add-ons: %d seeded, %d pruned.\n", seeded, pruned)
	return nil
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
