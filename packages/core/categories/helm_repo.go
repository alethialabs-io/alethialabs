// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// helmRepoCredNamespace is the namespace the ArgoCD repository credential is seeded into. ArgoCD
// reads repository/repo-creds Secrets only from its own namespace ("argocd").
const helmRepoCredNamespace = "argocd"

// RepoCred is the ArgoCD repository credential a helm_registry provider maps its connection to: the
// chart-repo URL (oci://<host> for an OCI registry, https://… for an HTTPS chart repo), the
// username/password ArgoCD authenticates a chart pull with, and whether the repo is OCI. It is the
// return of a provider's repoCred behavior; HelmRepoCredSpecs adds the deterministic Secret name.
type RepoCred struct {
	URL       string
	Username  string
	Password  string
	EnableOCI bool
}

// HelmRepoCredSpec is a runner-seeded ArgoCD repository-credential Secret for one connected private
// Helm/OCI chart repo. The runner applies it post-apply via argocd.EnsureHelmRepoCredential; ArgoCD
// matches it to any add-on/BYO Application whose repoURL matches (exact for HTTPS, prefix for OCI),
// so the private chart pull authenticates. Name is deterministic in the URL so multiple repos never
// collide and a re-deploy refreshes rather than duplicates.
type HelmRepoCredSpec struct {
	Name string
	RepoCred
}

// HelmRepoCredSecretName derives a stable, RFC1123-safe Secret name from the chart-repo URL:
// "repo-helm-<12-hex of sha256(url)>". Keyed on the URL (not the slug) because a project may connect
// several repos of the same provider; the k8sNameRe validation in argocd.EnsureHelmRepoCredential is
// satisfied by construction (lowercase hex + hyphen).
func HelmRepoCredSecretName(url string) string {
	sum := sha256.Sum256([]byte(url))
	return "repo-helm-" + hex.EncodeToString(sum[:])[:12]
}

// HelmRepoCredSpecs builds the ArgoCD repository-credential Secrets the runner seeds post-apply for a
// project's connected private Helm/OCI chart repos (vc.HelmRegistries). Unlike container registries
// (one dominant provider per project → one imagePullSecret), a project may connect several distinct
// chart repos, so this returns one spec per pluggable entry. Credentials come from
// vc.ConnectorCredentialFor — decrypted, attached at claim, never on the config snapshot; they are
// used only to build the Secret payload, never logged.
//
// Fail-closed on a misconfigured entry: an entry that fails Validate is SKIPPED (never seeded as a
// half-built credential) and its error joined into the returned error so the caller can log it — but
// one bad repo must not sink the others or the cluster (the caller treats the error as non-fatal, a
// bad credential surfacing as an OutOfSync Application). A coming_soon keyless slug (no repoCred,
// IsHelmRegistry false) is skipped silently — the console never offers it, and its keyless resolution
// is a documented follow-up.
func HelmRepoCredSpecs(vc *types.ProjectConfig) ([]HelmRepoCredSpec, error) {
	var (
		specs []HelmRepoCredSpec
		errs  []error
		seen  = map[string]struct{}{}
	)
	for _, r := range vc.HelmRegistries {
		if !IsPluggable(r.Provider) {
			continue
		}
		if !IsHelmRegistry(r.Provider) {
			// A coming_soon / keyless helm_registry slug — no seedable static credential. The console
			// never offers it; skip defensively if one reaches the snapshot.
			continue
		}
		p, err := Get("helm_registry", r.Provider)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		ctx := ComponentContext{
			Project:        vc,
			Credentials:    vc.ConnectorCredentialFor("helm_registry", r.Provider),
			ProviderConfig: r.ProviderConfig,
		}
		if err := p.Validate(ctx); err != nil {
			errs = append(errs, fmt.Errorf("helm_registry/%s validation failed: %w", r.Provider, err))
			continue
		}
		cred, ok := p.RepoCred(ctx)
		if !ok {
			errs = append(errs, fmt.Errorf("helm_registry provider %q has no repo-credential mapping", r.Provider))
			continue
		}
		name := HelmRepoCredSecretName(cred.URL)
		if _, dup := seen[name]; dup {
			// Same repo URL connected twice — one Secret already covers it.
			continue
		}
		seen[name] = struct{}{}
		specs = append(specs, HelmRepoCredSpec{Name: name, RepoCred: cred})
	}
	return specs, errors.Join(errs...)
}
