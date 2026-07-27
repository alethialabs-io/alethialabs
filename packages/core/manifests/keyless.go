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
//     shared file that a local wire proxy uses as its upstream credential.
//   - EXCLUDED (documented) — Alibaba ApsaraDB RDS has no token-based DB login (RAM is control-plane
//     only), and Hetzner data services are ArgoCD add-ons with no cloud IAM. Both stay on the password
//     path; the exclusion is explicit here so parity is enforced, not silently dropped.
//
// ENGINE (#1441). The local proxy is wire-protocol specific, so it is chosen by the target database's
// engine family: PgBouncer for postgres, ProxySQL for mysql. Keyless MySQL is AZURE-ONLY — the
// bootstrap Job binds an Entra login with `CREATE AADUSER` (see runner db_bootstrap.go), a mechanism
// AWS Aurora-MySQL and GCP Cloud SQL MySQL do not share and for which no template ships yet. That
// exclusion is enforced in keylessDBSidecar as an explicit error rather than left to render a
// Postgres-wire proxy against a MySQL server, which would fail only at runtime.
//
// The decision to go keyless is DERIVED, not declared: it keys off the target database's existing
// `iam_auth` config (one source of truth, no new binding field). Everything here is pure +
// deterministic (golden-testable); the caller supplies the tofu outputs.
package manifests

import (
	"fmt"
	"strconv"

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
	// proxySQLImage fronts Azure MySQL on 127.0.0.1 — the MySQL-wire counterpart to pgBouncerImage,
	// consuming the same refreshed token file as its upstream credential. Debian variant for /bin/sh
	// (the entrypoint reads the token file), matching the rationale mysqlClientImage documents in
	// bootstrap_job.go. Validated on the real-cloud e2e gate (#1450).
	proxySQLImage = "proxysql/proxysql:3.0.9-debian"

	// keylessKSAName / keylessKSANamespace name the Workload-Identity ServiceAccount a keyless app
	// pod runs as. These MUST match the per-cloud templates' WIF/federated-identity subject binding
	// (GCP app-db-identity.tf app_ksa_name/namespace; Azure/AWS the federated-identity subject).
	keylessKSAName      = "alethia-app"
	keylessKSANamespace = "default"

	// keylessDBUser is the least-privilege login the bootstrap Job creates for the app on the
	// token-as-password clouds (AWS RDS IAM / Azure Entra), mapped to the app's cloud identity — a
	// Postgres ROLE, or on Azure MySQL an Entra AADUSER (db_bootstrap.go keylessBootstrapRole is the
	// same name). It is the upstream user BOTH local proxies authenticate as. GCP instead uses its
	// tofu-created IAM service-account user (the cloud_sql_iam_user output).
	keylessDBUser = "alethia_app"

	// keylessTokenDir is the shared emptyDir the refresher writes the token into and the local proxy
	// (pgbouncer / proxysql) reads.
	keylessTokenDir = "/db-token"

	// The local proxy's listen port, per engine wire protocol. The workload connects here on
	// 127.0.0.1, so this is also the value the `port` binding facet injects (keylessProxyPort).
	keylessPortPostgres = 5432
	keylessPortMySQL    = 3306
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
	// ENGINE GATE (#1441) — one place, all clouds. Keyless MySQL exists only on Azure: the bootstrap
	// Job's `CREATE AADUSER` Entra binding has no AWS Aurora-MySQL / GCP Cloud SQL MySQL equivalent and
	// no template ships one (db_bootstrap.go makes --engine mysql an explicit error there too). Without
	// this gate an AWS/GCP MySQL with iam_auth would render a POSTGRES-wire proxy against a MySQL
	// server and fail only at runtime — the silent-misconfiguration shape the fail-closed rule exists
	// to prevent.
	engine := dbEngineForTarget(opts, t)
	if engine == engineMySQL && opts.Provider != string(types.CloudProviderAzure) {
		return keylessWiring{}, fmt.Errorf(
			"keyless MySQL auth is supported on Azure only (AWS Aurora-MySQL and GCP Cloud SQL MySQL bind their DB login differently and ship no template yet), got provider %q",
			opts.Provider)
	}
	switch opts.Provider {
	case string(types.CloudProviderGcp):
		return gcpProxyWiring(opts)
	case string(types.CloudProviderAws):
		return awsRefresherWiring(opts)
	case string(types.CloudProviderAzure):
		return azureRefresherWiring(opts, engine)
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
			Args:  []string{"--private-ip", "--auto-iam-authn", "--port=" + strconv.Itoa(keylessPortPostgres), conn},
			Ports: []int{keylessPortPostgres},
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
			"--host", endpoint, "--port", strconv.Itoa(keylessPortPostgres), "--region", region, "--user", keylessDBUser,
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
// Entra token from the pod's federated identity) + a local wire proxy. The KSA carries the Azure
// Workload-Identity label + client-id annotation.
//
// The REFRESHER is engine-agnostic and unchanged for MySQL: the ossrdbms-aad Entra scope it mints for
// is shared by Azure Database for PostgreSQL, MySQL and MariaDB (see the runner's db_token.go), and
// both engines take the token as the password. Only the local proxy differs — PgBouncer speaks the
// Postgres wire, ProxySQL the MySQL wire.
func azureRefresherWiring(opts Options, engine string) (keylessWiring, error) {
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
	proxy := pgbouncerSidecar(fqdn)
	if engine == engineMySQL {
		proxy = proxysqlSidecar(fqdn)
	}
	return keylessWiring{
		sidecars:      []Sidecar{refresher, proxy},
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
		Ports:  []int{keylessPortPostgres},
		Mounts: []VolumeMount{{Name: "db-token", MountPath: keylessTokenDir, ReadOnly: true}},
	}
}

// proxysqlSidecar — the local MySQL proxy for Azure Database for MySQL, the MySQL-wire counterpart to
// pgbouncerSidecar. It serves 127.0.0.1:3306 and connects upstream to `upstreamHost` as keylessDBUser
// (the Entra AADUSER the bootstrap Job created) using the refreshed token file as the credential; the
// app connects to localhost with no token awareness.
//
// Like pgbouncer's, the entrypoint that consumes PROXYSQL_TOKEN_FILE is finalized on the real-cloud
// e2e gate (#1450). It is NOT the same shape as pgbouncer's file read: ProxySQL holds backend
// credentials in its admin DB, so the refresh applies via its admin interface (UPDATE mysql_servers /
// LOAD MYSQL SERVERS TO RUNTIME) rather than by re-reading a file — a rotating Entra token has to be
// pushed in, not picked up. That is the one substantive difference between the two proxies and the
// reason #1450 gates this cell.
//
// TWO CONSTRAINTS that entrypoint MUST satisfy (from the #1441 security review):
//
//  1. Bind the admin interface to a UNIX SOCKET outside any app-visible mount, and never ship the
//     default admin credentials. ProxySQL keeps backend credentials in its admin DB, and its default
//     admin user is "localhost-only" — but a pod shares ONE network namespace, so 127.0.0.1 is
//     reachable from the customer's own app container. Left at the default, the workload could read
//     the rotating Entra token out of mysql_servers, turning a pod-confined proxy-mediated credential
//     into a bearer token it can exfiltrate — the exact invariant this file exists to hold.
//  2. Give it a writable emptyDir for ProxySQL's datadir (/var/lib/proxysql, the admin SQLite DB).
//     The sidecar inherits readOnlyRootFilesystem, so it cannot start without one. Add the volume —
//     do NOT relax readOnlyRootFilesystem, which is the shortcut that would undo the hardening.
func proxysqlSidecar(upstreamHost string) Sidecar {
	return Sidecar{
		Name:  "proxysql",
		Image: proxySQLImage,
		Env: []types.ServiceEnvVar{
			{Name: "PROXYSQL_UPSTREAM_HOST", Value: upstreamHost},
			{Name: "PROXYSQL_UPSTREAM_USER", Value: keylessDBUser},
			{Name: "PROXYSQL_TOKEN_FILE", Value: keylessTokenDir + "/token"},
		},
		Ports:  []int{keylessPortMySQL},
		Mounts: []VolumeMount{{Name: "db-token", MountPath: keylessTokenDir, ReadOnly: true}},
	}
}

// keylessProxyPort is the local port the keyless auth proxy listens on, as a string for the `port`
// binding facet. Under keyless auth the workload connects to the SIDECAR, not the server, so this —
// not defaultPort — is the port it must be handed; a MySQL app pointed at pgbouncer's 5432 would
// dial a listener that isn't there.
func keylessProxyPort(opts Options, t types.ServiceBindingTarget) string {
	if dbEngineForTarget(opts, t) == engineMySQL {
		return strconv.Itoa(keylessPortMySQL)
	}
	return strconv.Itoa(keylessPortPostgres)
}
