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

	// keylessKSAName / keylessKSANamespace name the Workload-Identity ServiceAccount a keyless app
	// pod runs as. These MUST match the per-cloud templates' WIF/federated-identity subject binding
	// (GCP app-db-identity.tf app_ksa_name/namespace; Azure the federated credential subject).
	keylessKSAName      = "alethia-app"
	keylessKSANamespace = "default"
)

// keylessWiring is everything a keyless database binding adds to the workload's pod: the auth-proxy
// sidecar(s), any shared volume(s), and the Workload-Identity ServiceAccount the pod must run as
// (annotated/labelled so the cloud federates the pod's identity — GCP GSA impersonation, Azure UAMI).
type keylessWiring struct {
	sidecars      []Sidecar
	volumes       []Volume
	saName        string
	saAnnotations map[string]string
	saLabels      map[string]string
}

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
func keylessDBSidecar(opts Options, t types.ServiceBindingTarget) (keylessWiring, error) {
	// The templates pin the WIF/federated-identity subject to keylessKSANamespace/keylessKSAName; if
	// the app deploys into a different namespace the pod's identity won't federate, so fail closed
	// rather than render a pod that can never authenticate. ("" defaults to keylessKSANamespace.)
	if opts.Namespace != "" && opts.Namespace != keylessKSANamespace {
		return keylessWiring{}, fmt.Errorf("keyless DB auth requires namespace %q (the Workload-Identity subject), got %q", keylessKSANamespace, opts.Namespace)
	}
	switch opts.Provider {
	case string(types.CloudProviderGcp):
		conn := opts.Outputs["cloud_sql_connection_name"]
		if conn == "" {
			return keylessWiring{}, fmt.Errorf("no cloud_sql_connection_name output for keyless Cloud SQL auth")
		}
		gsa := opts.Outputs["cloud_sql_app_gsa_email"]
		if gsa == "" {
			return keylessWiring{}, fmt.Errorf("no cloud_sql_app_gsa_email output for the keyless app Workload Identity")
		}
		return keylessWiring{
			sidecars: []Sidecar{{
				Name:  "cloudsql-proxy",
				Image: cloudSQLProxyImage,
				Args: []string{
					"--private-ip",
					"--auto-iam-authn",
					"--port=5432",
					conn,
				},
				Ports: []int{5432},
			}},
			saName:        keylessKSAName,
			saAnnotations: map[string]string{"iam.gke.io/gcp-service-account": gsa},
		}, nil

	case string(types.CloudProviderAzure):
		fqdn := opts.Outputs["azure_db_fqdn"]
		if fqdn == "" {
			return keylessWiring{}, fmt.Errorf("no azure_db_fqdn output for keyless Entra auth")
		}
		clientID := opts.Outputs["azure_db_client_id"]
		if clientID == "" {
			return keylessWiring{}, fmt.Errorf("no azure_db_client_id output for the keyless app federated identity")
		}
		if opts.RunnerImage == "" {
			return keylessWiring{}, fmt.Errorf("no runner image for the Azure db-token refresher sidecar")
		}
		const tokenDir = "/azure-db-token"
		vol := Volume{Name: "azure-db-token"}
		return keylessWiring{
			sidecars: []Sidecar{
				{
					Name:   "azure-db-token",
					Image:  opts.RunnerImage,
					Args:   []string{"db-token", "--provider", "azure", "--out", tokenDir + "/token"},
					Mounts: []VolumeMount{{Name: vol.Name, MountPath: tokenDir}},
				},
				{
					Name:  "pgbouncer",
					Image: pgBouncerImage,
					Env: []types.ServiceEnvVar{
						{Name: "PGB_UPSTREAM_HOST", Value: fqdn},
						{Name: "PGB_TOKEN_FILE", Value: tokenDir + "/token"},
					},
					Ports:  []int{5432},
					Mounts: []VolumeMount{{Name: vol.Name, MountPath: tokenDir, ReadOnly: true}},
				},
			},
			volumes: []Volume{vol},
			saName:  keylessKSAName,
			// Azure Workload Identity: the KSA is labelled use=true and annotated with the UAMI client id.
			saLabels:      map[string]string{"azure.workload.identity/use": "true"},
			saAnnotations: map[string]string{"azure.workload.identity/client-id": clientID},
		}, nil
	}
	return keylessWiring{}, fmt.Errorf("keyless DB auth is not supported for provider %q", opts.Provider)
}
