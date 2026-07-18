// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// This file renders the KEYLESS half of a W3 service→database credential binding (#722): when the
// bound database has IAM/AAD auth enabled (db.IamAuth), the workload holds NO password. Instead it
// connects to a per-cloud auth-proxy SIDECAR over 127.0.0.1, and the sidecar authenticates upstream
// with the workload's own cloud identity (GCP Workload Identity → Cloud SQL IAM; Azure federated
// identity → Entra token). Both clouds converge on the same shape — a localhost proxy — so the app
// is cloud-agnostic and password-free.
//
// The decision to go keyless is DERIVED, not declared: it keys off the target database's existing
// `iam_auth` config (one source of truth, no new binding field). Everything here is pure +
// deterministic (golden-testable) like the rest of the package; the caller supplies the tofu outputs.
package manifests

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// Pinned sidecar images. Kept as constants (not user-configurable) so the keyless wiring is a fixed,
// reviewable part of the platform. NOTE: the elench verify gate (verify/k8s.go IMAGE-001) prefers
// digest-pinned images — these version tags are validated on the real-cloud e2e gate and may move to
// digests before GA.
const (
	// cloudSQLProxyImage is Google's Cloud SQL Auth Proxy v2 — with --auto-iam-authn it mints the
	// Cloud SQL IAM access token from the pod's Workload Identity and proxies 127.0.0.1 → the instance.
	cloudSQLProxyImage = "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.14.1"
	// pgBouncerImage fronts Azure Postgres on 127.0.0.1; the token-refresher sidecar keeps its
	// upstream credential (the Entra access token) fresh. Refined in Lane D (#722).
	pgBouncerImage = "bitnami/pgbouncer:1.23.1"
)

// KeylessDBTarget reports whether a binding target is a database that should use keyless IAM/AAD auth
// — kind "database", provider gcp or azure, and the matched db's IamAuth is true. A password-auth db,
// a non-database target, or any other provider (aws keeps the ExternalSecret path here) → false.
func KeylessDBTarget(provider string, t types.ServiceBindingTarget, dbs []types.ProjectDatabaseConfig) bool {
	if t.Kind != "database" {
		return false
	}
	switch provider {
	case string(types.CloudProviderGcp), string(types.CloudProviderAzure):
	default:
		return false
	}
	for _, db := range dbs {
		if db.Name == t.Name {
			return db.IamAuth != nil && *db.IamAuth
		}
	}
	return false
}

// credentialIdentityOutputKey maps a (provider, kind) to the tofu output holding the keyless DB
// LOGIN identity (the value a binding's `username` facet resolves to) — the app GSA's Cloud SQL IAM
// username on GCP, the app UAMI's Postgres AAD role on Azure. "" → no identity output for that pair,
// so the username facet is reported unresolvable (fail-closed). The keys are emitted by the per-cloud
// templates' keyless lanes (#722 Lane B/C).
func credentialIdentityOutputKey(provider, kind string) string {
	if kind != "database" {
		return ""
	}
	switch provider {
	case string(types.CloudProviderGcp):
		return "cloud_sql_iam_user"
	case string(types.CloudProviderAzure):
		return "azure_db_aad_user"
	}
	return ""
}

// keylessDBSidecar builds the auth-proxy sidecar(s) + shared volume(s) a keyless database binding
// needs. It fails CLOSED (returns an error the caller reports, omitting the whole binding) when a
// required tofu output is missing — never a half-wired pod pointed at a proxy that isn't there.
//
//   - GCP: the Cloud SQL Auth Proxy (--auto-iam-authn), listening on 127.0.0.1:5432, needs the
//     `cloud_sql_connection_name` output (project:region:instance) and the pod's Workload Identity.
//   - Azure: an `alethia db-token` refresher (reusing the runner's Entra workload-identity minting,
//     Lane D) writes the token to a shared emptyDir; a PgBouncer sidecar serves 127.0.0.1:5432 from
//     it. Needs `azure_db_fqdn` + the runner image (opts.RunnerImage).
func keylessDBSidecar(opts Options, t types.ServiceBindingTarget) (sidecars []Sidecar, volumes []Volume, err error) {
	switch opts.Provider {
	case string(types.CloudProviderGcp):
		conn := opts.Outputs["cloud_sql_connection_name"]
		if conn == "" {
			return nil, nil, fmt.Errorf("no cloud_sql_connection_name output for keyless Cloud SQL auth")
		}
		return []Sidecar{{
			Name:  "cloudsql-proxy",
			Image: cloudSQLProxyImage,
			Args: []string{
				"--private-ip",
				"--auto-iam-authn",
				"--port=5432",
				conn,
			},
			Ports: []int{5432},
		}}, nil, nil

	case string(types.CloudProviderAzure):
		fqdn := opts.Outputs["azure_db_fqdn"]
		if fqdn == "" {
			return nil, nil, fmt.Errorf("no azure_db_fqdn output for keyless Entra auth")
		}
		if opts.RunnerImage == "" {
			return nil, nil, fmt.Errorf("no runner image for the Azure db-token refresher sidecar")
		}
		const tokenDir = "/azure-db-token"
		vol := Volume{Name: "azure-db-token"}
		refresher := Sidecar{
			Name:   "azure-db-token",
			Image:  opts.RunnerImage,
			Args:   []string{"db-token", "--provider", "azure", "--out", tokenDir + "/token"},
			Ports:  nil,
			Mounts: []VolumeMount{{Name: vol.Name, MountPath: tokenDir}},
		}
		bouncer := Sidecar{
			Name:  "pgbouncer",
			Image: pgBouncerImage,
			Env: []types.ServiceEnvVar{
				{Name: "PGB_UPSTREAM_HOST", Value: fqdn},
				{Name: "PGB_TOKEN_FILE", Value: tokenDir + "/token"},
			},
			Ports:  []int{5432},
			Mounts: []VolumeMount{{Name: vol.Name, MountPath: tokenDir, ReadOnly: true}},
		}
		return []Sidecar{refresher, bouncer}, []Volume{vol}, nil
	}
	return nil, nil, fmt.Errorf("keyless DB auth is not supported for provider %q", opts.Provider)
}
