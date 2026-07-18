// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// This file renders the KEYLESS half of a W3 service→database credential binding (#722): when the
// bound database has IAM/AAD auth enabled (db.IamAuth), the workload holds NO password. Instead it
// connects to a local auth proxy over 127.0.0.1, and the proxy authenticates upstream with the
// workload's own cloud identity. The app is cloud-agnostic and password-free.
//
// Two mechanisms, four clouds (parity):
//   - NATIVE PROXY — GCP Cloud SQL Auth Proxy (--auto-iam-authn) mints the Cloud SQL IAM token itself.
//   - TOKEN REFRESHER — AWS (RDS IAM) and Azure (Entra) have no native proxy, so an `alethia db-token`
//     sidecar mints a short-lived DB token from the pod's Workload Identity and keeps it fresh on a
//     shared file that a local PgBouncer uses as its upstream credential.
//   - EXCLUDED (documented) — Alibaba ApsaraDB RDS has no token-based DB login (RAM is control-plane
//     only), and Hetzner data services are ArgoCD add-ons with no cloud IAM. Both stay on the password
//     path; the exclusion is explicit here so parity is enforced, not silently dropped.
//
// The decision to go keyless is DERIVED, not declared: it keys off the target database's existing
// `iam_auth` config (one source of truth, no new binding field). Everything here is pure +
// deterministic (golden-testable); the caller supplies the tofu outputs.
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
	// pgBouncerImage fronts AWS/Azure Postgres on 127.0.0.1; the token-refresher sidecar keeps its
	// upstream credential (the DB access token) fresh. The pgbouncer config that consumes the token
	// file is validated on the real-cloud e2e gate (#722 Lane D).
	pgBouncerImage = "bitnami/pgbouncer:1.23.1"

	// keylessKSAName / keylessKSANamespace name the Workload-Identity ServiceAccount a keyless app
	// pod runs as. These MUST match the per-cloud templates' WIF/federated-identity subject binding
	// (GCP app-db-identity.tf app_ksa_name/namespace; Azure/AWS the federated-identity subject).
	keylessKSAName      = "alethia-app"
	keylessKSANamespace = "default"

	// keylessDBUser is the least-privilege Postgres role the bootstrap Job creates for the app on the
	// token-as-password clouds (AWS RDS IAM / Azure Entra), mapped to the app's cloud identity. GCP
	// instead uses its tofu-created IAM service-account user (the cloud_sql_iam_user output).
	keylessDBUser = "alethia_app"

	// keylessTokenDir is the shared emptyDir the refresher writes the token into and pgbouncer reads.
	keylessTokenDir = "/db-token"
)

// keylessWiring is everything a keyless database binding adds to the workload's pod: the auth-proxy
// sidecar(s), any shared volume(s), and the Workload-Identity ServiceAccount the pod must run as
// (annotated/labelled so the cloud federates the pod's identity).
type keylessWiring struct {
	sidecars      []Sidecar
	volumes       []Volume
	saName        string
	saAnnotations map[string]string
	saLabels      map[string]string
}

// KeylessDBTarget reports whether a binding target is a database that should use keyless IAM/AAD auth
// — kind "database", a provider that supports it (AWS RDS IAM / GCP Cloud SQL IAM / Azure Entra), and
// the matched db's IamAuth is true. Alibaba (ApsaraDB RDS: no token DB login) and Hetzner (add-on DBs:
// no cloud IAM) are EXPLICIT exclusions → they keep the password/ExternalSecret path. A password-auth
// db or a non-database target → false.
func KeylessDBTarget(provider string, t types.ServiceBindingTarget, dbs []types.ProjectDatabaseConfig) bool {
	if t.Kind != "database" {
		return false
	}
	switch provider {
	case string(types.CloudProviderAws), string(types.CloudProviderGcp), string(types.CloudProviderAzure):
		// supported
	default:
		// Alibaba / Hetzner (and anything unknown): documented exclusion — password path.
		return false
	}
	for _, db := range dbs {
		if db.Name == t.Name {
			return db.IamAuth != nil && *db.IamAuth
		}
	}
	return false
}

// keylessDBUsername resolves the login the app's `username` facet gets: GCP's tofu-created IAM SA
// user (the cloud_sql_iam_user output), or the fixed bootstrap-created least-priv role on AWS/Azure.
// Returns an error (→ fail-closed) when GCP's identity output is missing.
func keylessDBUsername(provider string, outputs map[string]string) (string, error) {
	switch provider {
	case string(types.CloudProviderGcp):
		if u := outputs["cloud_sql_iam_user"]; u != "" {
			return u, nil
		}
		return "", fmt.Errorf("no cloud_sql_iam_user output for the keyless login")
	case string(types.CloudProviderAws), string(types.CloudProviderAzure):
		return keylessDBUser, nil
	}
	return "", fmt.Errorf("keyless DB auth is not supported for provider %q", provider)
}

// keylessDBSidecar builds the auth-proxy sidecar(s) + shared volume(s) + Workload-Identity KSA a
// keyless database binding needs. It fails CLOSED (returns an error the caller reports, omitting the
// whole binding) when a required tofu output is missing — never a half-wired pod pointed at a proxy
// that isn't there.
func keylessDBSidecar(opts Options, t types.ServiceBindingTarget) (keylessWiring, error) {
	// The templates pin the WIF/federated-identity subject to keylessKSANamespace/keylessKSAName; if
	// the app deploys into a different namespace the pod's identity won't federate, so fail closed
	// rather than render a pod that can never authenticate. ("" defaults to keylessKSANamespace.)
	if opts.Namespace != "" && opts.Namespace != keylessKSANamespace {
		return keylessWiring{}, fmt.Errorf("keyless DB auth requires namespace %q (the Workload-Identity subject), got %q", keylessKSANamespace, opts.Namespace)
	}
	switch opts.Provider {
	case string(types.CloudProviderGcp):
		return gcpProxyWiring(opts)
	case string(types.CloudProviderAws):
		return awsRefresherWiring(opts)
	case string(types.CloudProviderAzure):
		return azureRefresherWiring(opts)
	}
	return keylessWiring{}, fmt.Errorf("keyless DB auth is not supported for provider %q", opts.Provider)
}

// gcpProxyWiring — the native Cloud SQL Auth Proxy sidecar (no token refresher needed).
func gcpProxyWiring(opts Options) (keylessWiring, error) {
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
			Args:  []string{"--private-ip", "--auto-iam-authn", "--port=5432", conn},
			Ports: []int{5432},
		}},
		saName:        keylessKSAName,
		saAnnotations: map[string]string{"iam.gke.io/gcp-service-account": gsa},
	}, nil
}

// awsRefresherWiring — RDS IAM auth: an `alethia db-token --provider aws` refresher (mints the RDS
// auth token from the pod's IRSA role) + a local PgBouncer. The KSA is IRSA-annotated with the RDS
// IAM role ARN.
func awsRefresherWiring(opts Options) (keylessWiring, error) {
	endpoint := opts.Outputs[endpointOutputKey(string(types.CloudProviderAws), "database")]
	if endpoint == "" {
		return keylessWiring{}, fmt.Errorf("no rds_cluster_endpoint output for keyless RDS IAM auth")
	}
	region := opts.Outputs["aws_region"]
	if region == "" {
		return keylessWiring{}, fmt.Errorf("no aws_region output for the RDS auth-token refresher")
	}
	roleARN := opts.Outputs["rds_iam_auth_irsa_arn"]
	if roleARN == "" {
		return keylessWiring{}, fmt.Errorf("no rds_iam_auth_irsa_arn output for the keyless app IRSA identity")
	}
	if opts.RunnerImage == "" {
		return keylessWiring{}, fmt.Errorf("no runner image for the AWS db-token refresher sidecar")
	}
	refresher := Sidecar{
		Name:  "db-token",
		Image: opts.RunnerImage,
		Args: []string{
			"db-token", "--provider", "aws", "--out", keylessTokenDir + "/token",
			"--host", endpoint, "--port", "5432", "--region", region, "--user", keylessDBUser,
		},
		Mounts: []VolumeMount{{Name: "db-token", MountPath: keylessTokenDir}},
	}
	return keylessWiring{
		sidecars:      []Sidecar{refresher, pgbouncerSidecar(endpoint)},
		volumes:       []Volume{{Name: "db-token"}},
		saName:        keylessKSAName,
		saAnnotations: map[string]string{"eks.amazonaws.com/role-arn": roleARN},
	}, nil
}

// azureRefresherWiring — Entra auth: an `alethia db-token --provider azure` refresher (mints the
// Entra token from the pod's federated identity) + a local PgBouncer. The KSA carries the Azure
// Workload-Identity label + client-id annotation.
func azureRefresherWiring(opts Options) (keylessWiring, error) {
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
	refresher := Sidecar{
		Name:   "db-token",
		Image:  opts.RunnerImage,
		Args:   []string{"db-token", "--provider", "azure", "--out", keylessTokenDir + "/token", "--user", keylessDBUser},
		Mounts: []VolumeMount{{Name: "db-token", MountPath: keylessTokenDir}},
	}
	return keylessWiring{
		sidecars:      []Sidecar{refresher, pgbouncerSidecar(fqdn)},
		volumes:       []Volume{{Name: "db-token"}},
		saName:        keylessKSAName,
		saLabels:      map[string]string{"azure.workload.identity/use": "true"},
		saAnnotations: map[string]string{"azure.workload.identity/client-id": clientID},
	}, nil
}

// pgbouncerSidecar — the shared local Postgres proxy for the token-as-password clouds (AWS/Azure). It
// serves 127.0.0.1:5432 and connects upstream to `upstreamHost` using the refreshed token file as the
// credential; the app connects to localhost with no token awareness. (The pgbouncer entrypoint that
// consumes PGB_TOKEN_FILE is finalized on the real-cloud e2e gate — see Lane D.)
func pgbouncerSidecar(upstreamHost string) Sidecar {
	return Sidecar{
		Name:  "pgbouncer",
		Image: pgBouncerImage,
		Env: []types.ServiceEnvVar{
			{Name: "PGB_UPSTREAM_HOST", Value: upstreamHost},
			{Name: "PGB_UPSTREAM_USER", Value: keylessDBUser},
			{Name: "PGB_TOKEN_FILE", Value: keylessTokenDir + "/token"},
		},
		Ports:  []int{5432},
		Mounts: []VolumeMount{{Name: "db-token", MountPath: keylessTokenDir, ReadOnly: true}},
	}
}
