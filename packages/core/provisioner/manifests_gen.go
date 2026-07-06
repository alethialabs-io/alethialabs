// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/git"
	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// generateAppManifests renders Kubernetes manifests for the project's detected services
// and commits them to the apps (GitOps) repo — but ONLY when that repo has no manifests
// yet, so a bring-your-own manifests repo is NEVER clobbered. It is safe-by-construction:
// it writes to an EMPTY manifests repo or does nothing. No-op when there are no
// deployable (containerised) services.
//
// The image defaults to `<service>:latest` (the customer edits it to their registry
// image); the point is a working GitOps skeleton ArgoCD can sync, not a finished app.
func generateAppManifests(vc *types.ProjectConfig, token string, stdout, stderr io.Writer) error {
	if vc.Repositories.AppsDestinationRepo == "" || token == "" {
		return nil
	}
	var services []types.DetectedService
	for _, r := range vc.SourceRepos {
		services = append(services, r.Services...)
	}
	apps := manifests.FromServices(services, manifests.Options{
		Domain: vc.DNS.DomainName,
	})
	if len(apps) == 0 {
		return nil // no containerised services to scaffold
	}

	dir, err := os.MkdirTemp("", "alethia-apps-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)

	repo := git.NewGITWithToken(vc.Repositories.AppsDestinationRepo, dir, false, token)
	if err := repo.Clone("", false); err != nil {
		return fmt.Errorf("clone apps repo: %w", err)
	}

	if hasManifests(dir) {
		fmt.Fprintf(stdout, "Apps repo already contains manifests — leaving it untouched (bring-your-own).\n")
		return nil
	}

	written, err := manifests.WriteManifests(dir, apps)
	if err != nil {
		return err
	}
	if err := repo.AddAndCommit("chore: scaffold app manifests (alethia)"); err != nil {
		return fmt.Errorf("commit generated manifests: %w", err)
	}
	if err := repo.Push(); err != nil {
		return fmt.Errorf("push generated manifests: %w", err)
	}
	fmt.Fprintf(stdout, "Scaffolded %d app manifest(s) into the GitOps repo: %s\n",
		len(written), strings.Join(written, ", "))
	return nil
}

// hasManifests reports whether the repo root already holds any Kubernetes YAML — the
// guard that keeps generation from overwriting a bring-your-own manifests repo.
func hasManifests(dir string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return true // be conservative: unknown state → don't write
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		n := strings.ToLower(e.Name())
		if strings.HasSuffix(n, ".yaml") || strings.HasSuffix(n, ".yml") {
			return true
		}
	}
	return false
}
