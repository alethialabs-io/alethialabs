// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import (
	"io"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// secretsSaaSNamespace is where the SaaS store's auth-token Secret is seeded and where the
// ClusterSecretStore's auth.secretRef resolves it (a cluster-scoped store has no store namespace,
// so every secretRef must carry one). It is the operator's own namespace so the token Secret is
// co-located with the controller that reads it.
const secretsSaaSNamespace = "external-secrets-operator"

// SecretsSaaSStore describes a credential-based external secret store — HashiCorp Vault / OpenBao,
// Doppler, or a generic Vault-KV-API-compatible endpoint — the project selected via the `secrets`
// connector, that workloads read from IN-CLUSTER through the External Secrets Operator (ESO) with a
// STATIC API token. Unlike the cross-account cloud managers (KeylessSecretTarget, which ESO reads
// keylessly via the cluster's workload identity), a SaaS store has no cloud identity to federate: its
// auth token is seeded into an in-cluster Secret (CredSecret) out-of-band and referenced by the
// rendered store's auth.secretRef. This struct therefore carries only NON-SECRET connection config +
// the seed-Secret NAME — the token itself NEVER lives here (facts are rendered into ESO manifests
// committed to the cluster; a token on the facts would leak into a manifest). Built from the
// connector's provider_config + a credential-presence check.
//
// ESO 0.9.12 support (the pinned chart, infra/templates/argocd/external-secrets-operator.yaml):
// vault + generic (via spec.provider.vault) and doppler (spec.provider.doppler) get a first-class
// static-token store. Infisical (first-class only from ESO 0.9.20) and 1Password (Connect-only in
// 0.9.12) are DOCUMENTED runtime-read exclusions — their write/provision path still ships (#1204);
// they simply register no saasSecretStore and render no ClusterSecretStore. See
// infra/templates/project/CUSTOMIZABILITY-PARITY.md.
type SecretsSaaSStore struct {
	Slug      string // the selected secrets connector slug: vault | generic | doppler
	Kind      string // ESO provider kind: "vault" (vault/generic) | "doppler"
	StoreName string // ClusterSecretStore name: secretstore-<slug>

	// CredSecret is the in-cluster Secret (in Namespace) the seeder writes the auth token into, and
	// CredKey is the data key within it. The rendered store's auth.secretRef points at (CredSecret,
	// CredKey, Namespace).
	CredSecret string
	CredKey    string
	Namespace  string

	// ── vault / generic (spec.provider.vault) ──
	Server  string // the KV endpoint URL (vault_address)
	Path    string // the KV mount path (mount_path)
	Version string // "v1" | "v2"

	// ── doppler (spec.provider.doppler) — optional scoping ──
	Project string
	Config  string
}

// vaultSaaSStore builds the SecretsSaaSStore descriptor for a Vault / OpenBao / generic
// Vault-compatible endpoint from its connection credentials + provider_config. Shared by the `vault`
// and `generic` behaviors (a generic KV store is, by our documented scope, a Vault-KV-API-compatible
// endpoint). The token is read from ctx.Credentials only to name the seed-Secret key convention here;
// the actual seeding happens in the runner, never on these facts.
func vaultSaaSStore(ctx ComponentContext, slug string) SecretsSaaSStore {
	version := "v" + pcString(ctx.ProviderConfig, "kv_version", "2")
	return SecretsSaaSStore{
		Slug:       slug,
		Kind:       "vault",
		StoreName:  "secretstore-" + slug,
		CredSecret: "secretstore-" + slug + "-creds",
		CredKey:    "token",
		Namespace:  secretsSaaSNamespace,
		Server:     cred(ctx.Credentials, "address", ""),
		Path:       pcString(ctx.ProviderConfig, "mount_path", "secret"),
		Version:    version,
	}
}

// DominantSecretsSaaSStore returns the runtime-read SaaS secret store for the project's dominant
// secrets selection, or nil when that selection is native / none, a cross-account keyless manager, or
// a store with no first-class ESO read path on the pinned chart (infisical / 1Password). Parallels
// DominantKeylessSecretTarget, but a SaaS store REPLACES the native store as the secret source rather
// than layering on top. Fail-closed: a selected store whose credential/config is missing fails
// Validate and returns an error (Compose already rejects it pre-plan; this is defense-in-depth), so a
// half-configured store never renders a broken ClusterSecretStore pointing at an unseeded Secret.
func DominantSecretsSaaSStore(vc *types.ProjectConfig) (*SecretsSaaSStore, error) {
	slug, items := dominantProvider(secretItems(vc), io.Discard, "secrets")
	if !IsPluggable(slug) || !IsSaaSSecretStore(slug) {
		return nil, nil
	}
	p, err := Get("secrets", slug)
	if err != nil {
		return nil, err
	}
	ctx := ComponentContext{
		Project:        vc,
		Credentials:    vc.ConnectorCredentialFor("secrets", slug),
		ProviderConfig: secretsProviderConfig(vc, slug),
		Items:          items,
	}
	// Fail-closed: an absent token / required scope means no store (Validate mirrors the tofu-write
	// gate). Without this a store could render referencing a Secret the seeder will refuse to write.
	if err := p.Validate(ctx); err != nil {
		return nil, err
	}
	s, ok := p.SaaSSecretStore(ctx)
	if !ok {
		return nil, nil
	}
	return &s, nil
}
