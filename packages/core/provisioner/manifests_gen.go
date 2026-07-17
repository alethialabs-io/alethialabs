// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
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
func generateAppManifests(vc *types.ProjectConfig, outputs map[string]interface{}, token string, stdout, stderr io.Writer) error {
	if vc.Repositories.AppsDestinationRepo == "" || token == "" {
		return nil
	}
	// Normalize the tofu outputs to string values so the pure renderer can resolve a service's
	// W3 binding endpoints (a database's endpoint, etc.) into concrete env values.
	strOutputs := make(map[string]string, len(outputs))
	for k, v := range outputs {
		if s, ok := v.(string); ok {
			strOutputs[k] = s
		}
	}
	apps, skipped := manifests.FromServices(vc.Services, manifests.Options{
		Domain:   vc.DNS.DomainName,
		Outputs:  strOutputs,
		Provider: vc.Provider, // selects the per-cloud tofu endpoint output keys (#711)
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
	// W3 — the keyless credential last hop: for each service's credential-facet bindings, write an
	// ExternalSecret alongside the app manifests. ArgoCD applies it; ESO (via the per-cloud
	// ClusterSecretStore) materializes the k8s Secret the workload's secretKeyRef reads. The Secret
	// name matches BindingSecretName(s.Name, target) — exactly the secretKeyRef.name the renderer
	// emitted for this service (per-service, so no two ExternalSecrets fight over one Secret).
	esCount, err := writeBindingExternalSecrets(dir, vc, strOutputs, stdout)
	if err != nil {
		return err
	}
	if err := repo.AddAndCommit("chore: scaffold app manifests (alethia)"); err != nil {
		return fmt.Errorf("commit generated manifests: %w", err)
	}
	if err := repo.Push(); err != nil {
		return fmt.Errorf("push generated manifests: %w", err)
	}
	fmt.Fprintf(stdout, "Scaffolded %d app manifest(s)%s into the GitOps repo: %s\n",
		len(written), esCountSuffix(esCount), strings.Join(written, ", "))
	return nil
}

// appNamespace is the namespace both the generated Deployments (via App.normalize's default) and
// their binding ExternalSecrets deploy into. They MUST match — a secretKeyRef reads a Secret in its
// own namespace — so this single constant keeps them aligned.
const appNamespace = "default"

// esCountSuffix renders the ExternalSecret count for the summary line (nothing when zero).
func esCountSuffix(n int) string {
	if n == 0 {
		return ""
	}
	return fmt.Sprintf(" + %d ExternalSecret(s)", n)
}

// credentialSecretOutputKey maps a binding kind to the tofu output holding the resource's
// provisioned master-credentials secret name. AWS-first; "" → no provisioned credential secret for
// that kind, so RenderExternalSecret reports the facet unsatisfiable (never silently dropped).
func credentialSecretOutputKey(kind string) string {
	switch kind {
	case "database":
		return "rds_master_credentials_secret_name"
	default:
		return ""
	}
}

// writeBindingExternalSecrets renders an ExternalSecret per service credential-facet binding and
// writes it into dir (alongside the app manifests) for ArgoCD to apply. It passes ServiceName:
// s.Name so the materialized Secret's name equals the renderer's per-service secretKeyRef target.
// Unsatisfiable facets (no store for the cloud, no provisioned secret, a facet the secret lacks)
// are reported to stdout, never dropped silently. Returns the count written.
func writeBindingExternalSecrets(dir string, vc *types.ProjectConfig, outputs map[string]string, stdout io.Writer) (int, error) {
	count := 0
	for _, s := range vc.Services {
		for _, b := range s.Bindings {
			facets := manifests.CredentialFacetNames(b)
			if len(facets) == 0 {
				continue // endpoint/port-only binding needs no Secret
			}
			yaml, skipped, err := manifests.RenderExternalSecret(manifests.ExternalSecretParams{
				ServiceName: s.Name,
				Namespace:   appNamespace,
				Target:      b.Target,
				Provider:    vc.Provider,
				RemoteKey:   outputs[credentialSecretOutputKey(b.Target.Kind)],
				Facets:      facets,
			})
			if err != nil {
				return count, fmt.Errorf("render ExternalSecret for %s→%s/%s: %w", s.Name, b.Target.Kind, b.Target.Name, err)
			}
			for _, reason := range skipped {
				fmt.Fprintf(stdout, "ExternalSecret skipped %s\n", reason)
			}
			if yaml == "" {
				continue
			}
			file := filepath.Join(dir, manifests.BindingSecretName(s.Name, b.Target)+"-externalsecret.yaml")
			if err := os.WriteFile(file, []byte(yaml), 0o644); err != nil {
				return count, err
			}
			count++
		}
	}
	return count, nil
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
