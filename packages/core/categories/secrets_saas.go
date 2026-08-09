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
// Doppler, Infisical, or a generic Vault-KV-API-compatible endpoint — the project selected via the
// `secrets` connector, that workloads read from IN-CLUSTER through the External Secrets Operator (ESO)
// with STATIC credentials. Unlike the cross-account cloud managers (KeylessSecretTarget, which ESO
// reads keylessly via the cluster's workload identity), a SaaS store has no cloud identity to
// federate: its credentials are seeded into an in-cluster Secret (CredSecret) out-of-band and
// referenced by the rendered store's auth.secretRef. This struct therefore carries only NON-SECRET
// connection config + the seed-Secret NAME — the credentials themselves NEVER live here (facts are
// rendered into ESO manifests committed to the cluster; a token on the facts would leak into a
// manifest). Built from the connector's provider_config + a credential-presence check.
//
// ESO 0.9.20 support (the pinned chart, infra/templates/argocd/external-secrets-operator.yaml):
// vault + generic (via spec.provider.vault), doppler (spec.provider.doppler) and infisical
// (spec.provider.infisical — first-class only from 0.9.20, which is why the chart is pinned there)
// get a first-class static-credential store. 1Password remains a DOCUMENTED runtime-read exclusion —
// ESO's onepassword provider is Connect-server-only, which a bare Service-Account token cannot
// satisfy — so it registers no saasSecretStore and renders no ClusterSecretStore; its write/provision
// path still ships (#1204). See infra/templates/project/CUSTOMIZABILITY-PARITY.md.
type SecretsSaaSStore struct {
	Slug      string // the selected secrets connector slug: vault | generic | doppler | infisical
	Kind      string // ESO provider kind: "vault" (vault/generic) | "doppler" | "infisical"
	StoreName string // ClusterSecretStore name: secretstore-<slug>

	// CredSecret is the in-cluster Secret (in Namespace) the seeder writes the store's auth material
	// into; the rendered store's auth.secretRef points at (CredSecret, <key>, Namespace). Creds lists
	// every key that Secret carries. It is a LIST, not one key, because auth arity is per-provider:
	// vault / generic / doppler authenticate with a single API token, while infisical's Universal Auth
	// needs TWO independent SecretKeySelectors (clientId + clientSecret).
	CredSecret string
	Creds      []SecretsSaaSCredRef
	Namespace  string

	// ── vault / generic (spec.provider.vault) ──
	Server  string // the KV endpoint URL (vault_address)
	Path    string // the KV mount path (mount_path)
	Version string // "v1" | "v2"

	// ── doppler (spec.provider.doppler) — optional scoping ──
	Project string
	Config  string

	// ── infisical (spec.provider.infisical) ──
	// HostAPI is the Infisical API endpoint (self-hosted override). ProjectSlug is the project SLUG —
	// NOT the workspace id the tofu write path uses (infisical_workspace_id): ESO's secretsScope wants
	// the slug you copy from Infisical's project settings, and feeding it an id renders a store that
	// never resolves. They are separate provider_config fields for exactly that reason.
	HostAPI         string
	ProjectSlug     string
	EnvironmentSlug string
	SecretsPath     string
}

// SecretsSaaSCredRole names what one key inside the seeded credential Secret carries. Finite and
// known — the ESO provider's auth shape decides the set — so it is a typed union, not a bare string.
type SecretsSaaSCredRole string

const (
	// SaaSCredToken is the single API token vault / generic / doppler authenticate with.
	SaaSCredToken SecretsSaaSCredRole = "token"
	// SaaSCredClientID is the infisical Universal Auth machine-identity client id.
	SaaSCredClientID SecretsSaaSCredRole = "clientId"
	// SaaSCredClientSecret is the infisical Universal Auth machine-identity client secret.
	SaaSCredClientSecret SecretsSaaSCredRole = "clientSecret"
)

// SecretsSaaSCredRef is one key inside the seeded credential Secret: what it carries (Role), the data
// key the rendered store's auth.secretRef names (Key), and the connector credential field the seeder
// reads the value from (CredentialField). The VALUE never lives here — these facts are rendered into
// manifests, and a token on the facts would leak into one.
type SecretsSaaSCredRef struct {
	Role            SecretsSaaSCredRole
	Key             string
	CredentialField string
}

// CredKey returns the credential-Secret data key carrying the given role, or "" when this store has
// no such element. Takes a plain string so the ClusterSecretStore template can call it directly
// ({{ .SecretsSaaS.CredKey "clientId" }}) without a typed-constant conversion; looking the key up by
// role keeps the template independent of the order Creds happens to be built in.
func (s SecretsSaaSStore) CredKey(role string) string {
	for _, c := range s.Creds {
		if c.Role == SecretsSaaSCredRole(role) {
			return c.Key
		}
	}
	return ""
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
		Creds: []SecretsSaaSCredRef{
			{Role: SaaSCredToken, Key: "token", CredentialField: "token"},
		},
		Namespace: secretsSaaSNamespace,
		Server:    cred(ctx.Credentials, "address", ""),
		Path:      pcString(ctx.ProviderConfig, "mount_path", "secret"),
		Version:   version,
	}
}

// saaSStoreSlugs is every slug whose behavior can produce a SecretsSaaSStore that
// externalSecretsStoreTemplate actually RENDERS — the set a cleanup must be able to reap from.
//
// `generic` is here and is not redundant: it is a second vault-Kind store with its own StoreName
// ("secretstore-generic"), so enumerating Kinds instead of slugs would miss it.
//
// 1Password is deliberately ABSENT. It is a documented runtime-read exclusion — ESO's onepassword
// provider is Connect-server-only, which a bare Service-Account token cannot satisfy — so no branch
// renders for it and there is never a store of that name to reap. A test proves this list against
// the template's own branches, so if that exclusion is ever lifted the test fails rather than the
// cleanup silently going stale.
var saaSStoreSlugs = []string{"vault", "generic", "doppler", "infisical"}

// SaaSStoreName is the ClusterSecretStore name for a pluggable SaaS secrets slug.
func SaaSStoreName(slug string) string { return "secretstore-" + slug }

// AllSaaSStoreNames returns every pluggable-SaaS ClusterSecretStore name the template can render.
//
// The sibling of AllXacctStoreNames, and it exists for the same reason: the cleanup in
// argocd.CleanupSkippedInfraServices re-listed these names by hand and was missing
// secretstore-infisical, so switching away from Infisical orphaned its store in a
// permanently-broken state (#2038). The template never spells these names literally — it renders
// `{{ .SecretsSaaS.StoreName }}` — which is exactly why a hand-written copy drifts unnoticed.
func AllSaaSStoreNames() []string {
	out := make([]string, 0, len(saaSStoreSlugs))
	for _, slug := range saaSStoreSlugs {
		out = append(out, SaaSStoreName(slug))
	}
	return out
}

// DominantSecretsSaaSStore returns the runtime-read SaaS secret store for the project's dominant
// secrets selection, or nil when that selection is native / none, a cross-account keyless manager, or
// a store with no first-class ESO read path on the pinned chart (1Password). Parallels
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
