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

// generateAppManifests renders Kubernetes manifests for the project's FIRST-CLASS
// services (vc.Services — the W1 canvas model; the scanner-DetectedService path is
// retired) and commits them to the apps (GitOps) repo — but ONLY when that repo has no
// manifests yet, so a bring-your-own manifests repo is NEVER clobbered. It is
// safe-by-construction: it writes to an EMPTY manifests repo or does nothing. No-op when
// there are no renderable services.
//
// Images are REAL (W2): each service renders with its ResolvedImage (the BUILD job's
// digest URI) or its prebuilt Source.Image — never a fabricated ":latest" (which the
// elench verify gate fails). Unrenderable services (unbuilt, or a workload type without a
// template yet) are reported to stdout, not silently dropped.
func generateAppManifests(vc *types.ProjectConfig, token string, stdout, stderr io.Writer) error {
	if vc.Repositories.AppsDestinationRepo == "" || token == "" {
		return nil
	}
	apps, skipped := manifests.FromServices(vc.Services, manifests.Options{
		Domain: vc.DNS.DomainName,
	})
	for _, reason := range skipped {
		fmt.Fprintf(stdout, "Manifest generation skipped %s\n", reason)
	}
	if len(apps) == 0 {
		return nil // no renderable services to scaffold
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
