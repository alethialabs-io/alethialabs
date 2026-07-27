// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// This file renders the KEYLESS half of a W3 service→database credential binding (#722): when the
// bound database has IAM/AAD auth enabled (db.IamAuth), the workload holds NO password. Instead it
// connects to a local auth proxy over 127.0.0.1, and the proxy authenticates upstream with the
// workload's own cloud identity. The app is cloud-agnostic, engine-agnostic and password-free.
//
// Two mechanisms, four clouds (parity):
//   - NATIVE PROXY — GCP Cloud SQL Auth Proxy (--auto-iam-authn) mints the Cloud SQL IAM token itself,
//     for both engines.
//   - IN-PROCESS PROXY — AWS (RDS IAM) and Azure (Entra) have no native proxy, so the runner image's
//     `alethia db-authproxy` sidecar (#1501) serves 127.0.0.1, mints a fresh token per upstream
//     connection from the pod's Workload Identity, dials the cloud over TLS and splices the wire.
//     It holds NO token at rest — no token file, no rotation store, no shared volume.
//   - EXCLUDED (documented) — Alibaba ApsaraDB RDS has no token-based DB login (RAM is control-plane
//     only), and Hetzner data services are ArgoCD add-ons with no cloud IAM. Both stay on the password
//     path; the exclusion is explicit here so parity is enforced, not silently dropped.
//
// This replaces the original AWS/Azure wiring — an `alethia db-token` file refresher plus a stock
// `bitnami/pgbouncer` configured through PGB_UPSTREAM_HOST / PGB_UPSTREAM_USER / PGB_TOKEN_FILE.
// That image has never read those variables and nothing in the repo supplied an entrypoint that
// would, so keyless had never authenticated to a real database on either cloud (#1500).
//
// The decision to go keyless is DERIVED, not declared: it keys off the target database's existing
// `iam_auth` config (one source of truth, no new binding field). Everything here is pure +
// deterministic (golden-testable); the caller supplies the tofu outputs.
package manifests

import (
	"fmt"
	"net"
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
	// One image serves both engines; only the port differs.
	cloudSQLProxyImage = "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.14.1"

	// keylessKSAName / keylessKSANamespace name the Workload-Identity ServiceAccount a keyless app
	// pod runs as. These MUST match the per-cloud templates' WIF/federated-identity subject binding
	// (GCP app-db-identity.tf app_ksa_name/namespace; Azure/AWS the federated-identity subject).
	keylessKSAName      = "alethia-app"
	keylessKSANamespace = "default"

	// keylessDBUser is the least-privilege login the bootstrap Job creates for the app on the
	// token-as-password clouds (AWS RDS IAM / Azure Entra), mapped to the app's cloud identity. It is
	// the same name on every one of those cells: AWS Postgres `CREATE ROLE alethia_app` + rds_iam,
	// Azure Postgres `CREATE ROLE` + a pgaadauth SECURITY LABEL, Azure MySQL
	// `CREATE AADUSER 'alethia_app' IDENTIFIED BY '<uami-client-id>'` — see the runner's
	// db_bootstrap.go (keylessBootstrapRole). GCP instead uses its tofu-created IAM service-account
	// user (the cloud_sql_iam_user output).
	keylessDBUser = "alethia_app"

	// authProxyListenHost is the loopback address the in-process proxy serves on. `db-authproxy`
	// REJECTS a non-loopback --listen at startup (it would expose a credential-substituting proxy to
	// the pod network), so this is a literal, not a knob.
	authProxyListenHost = "127.0.0.1"

	// azureWorkloadIdentityLabel is the label the azure-workload-identity webhook keys on. It must be
	// on the POD (not only the ServiceAccount) for the federated token to be injected.
	azureWorkloadIdentityLabel = "azure.workload.identity/use"
)

// Provider slugs, as the strings this package compares and passes to `db-authproxy --provider`.
const (
	providerAWS   = string(types.CloudProviderAws)
	providerGCP   = string(types.CloudProviderGcp)
	providerAzure = string(types.CloudProviderAzure)
)

// Default wire ports per engine family. `db-authproxy` has no default for --listen or --upstream
// (both are required host:port flags), so the renderer is the single place these are decided.
const (
	postgresPort = 5432
	mysqlPort    = 3306
)

// keylessWiring is everything a keyless database binding adds to the workload's pod: the auth-proxy
// sidecar(s), any shared volume(s), the Workload-Identity ServiceAccount the pod must run as
// (annotated/labelled so the cloud federates the pod's identity), and any labels the POD ITSELF must
// carry for an identity webhook to act on it.
type keylessWiring struct {
	sidecars      []Sidecar
	volumes       []Volume
	saName        string
	saAnnotations map[string]string
	saLabels      map[string]string
	podLabels     map[string]string
}

// keylessCell records whether one cloud × engine keyless cell is implemented END TO END — the tofu
// flag that turns IAM auth on, the bootstrap Job that creates the app's login, AND the runtime proxy.
type keylessCell struct {
	ok bool
	// why names the lane that will deliver the cell; empty when ok. It is surfaced in the fail-closed
	// error so an operator reads "not built yet, tracked in #N" rather than a bare refusal.
	why string
}

// keylessCells is the single source of truth for which keyless cells may render.
//
// A cell that is NOT implemented end to end renders NOTHING — the binding fails closed — because the
// alternative is the exact failure this table exists to prevent: a pod that passes every render-time
// check and then cannot authenticate at runtime. Rendering a proxy for a database whose IAM auth tofu
// never enabled, or whose login the bootstrap Job cannot create, is a lie told at deploy time and
// discovered in production.
//
// MySQL is Azure-only today: the runner's db_bootstrap.go errors for aws/gcp because AWS Aurora-MySQL
// needs `CREATE USER … IDENTIFIED WITH AWSAuthenticationPlugin` and GCP creates its Cloud SQL IAM
// users in tofu. Both are separate, unshipped lanes — so those cells stay off until they land, at
// which point each is a one-line flip here.
var keylessCells = map[string]map[string]keylessCell{
	providerAWS: {
		enginePostgres: {ok: true},
		engineMySQL:    {why: "the Aurora-MySQL template lands in #1504 and its AWSAuthenticationPlugin bootstrap SQL in #1506"},
	},
	providerGCP: {
		enginePostgres: {ok: true},
		engineMySQL:    {why: "the Cloud SQL MySQL IAM-auth flag lands in #1505"},
	},
	providerAzure: {
		enginePostgres: {ok: true},
		engineMySQL:    {ok: true},
	},
}

// keylessCellSupported reports whether a cloud × engine keyless cell may render, or an error naming
// the lane that will deliver it. Fail-closed: an unknown provider or engine is refused, never
// defaulted into a neighbouring cell's wiring.
func keylessCellSupported(provider, engine string) error {
	engines, ok := keylessCells[provider]
	if !ok {
		return fmt.Errorf("keyless DB auth is not supported for provider %q", provider)
	}
	cell, ok := engines[engine]
	if !ok {
		return fmt.Errorf("keyless DB auth is not supported for engine %q on %s", engine, provider)
	}
	if !cell.ok {
		return fmt.Errorf("keyless %s on %s is not implemented yet (%s)", engine, provider, cell.why)
	}
	return nil
}

// enginePort returns the conventional wire port for an engine family, as a string and an int — the
// renderer needs both (a flag value and a containerPort).
func enginePort(engine string) (string, int) {
	if engine == engineMySQL {
		return strconv.Itoa(mysqlPort), mysqlPort
	}
	return strconv.Itoa(postgresPort), postgresPort
}

// KeylessDBTarget reports whether a binding target is a database that should use keyless IAM/AAD auth
// — kind "database", a provider that supports it (AWS RDS IAM / GCP Cloud SQL IAM / Azure Entra), and
// the matched db's IamAuth is true. Alibaba (ApsaraDB RDS: no token DB login) and Hetzner (add-on DBs:
// no cloud IAM) are EXPLICIT exclusions → they keep the password/ExternalSecret path. A password-auth
// db or a non-database target → false.
//
// This is deliberately engine-BLIND: an unimplemented cloud × engine cell must fail closed with a
// reason (keylessCellSupported, applied in keylessDBSidecar), not silently fall back to the password
// path — a database the operator marked `iam_auth: true` must never quietly acquire a password.
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
// keyless database binding needs, for the target database's ENGINE. It fails CLOSED (returns an error
// the caller reports, omitting the whole binding) when the cloud × engine cell is not implemented or a
// required tofu output is missing — never a half-wired pod pointed at a proxy that isn't there, and
// never a Postgres proxy in front of a MySQL server.
func keylessDBSidecar(opts Options, t types.ServiceBindingTarget) (keylessWiring, error) {
	// The templates pin the WIF/federated-identity subject to keylessKSANamespace/keylessKSAName; if
	// the app deploys into a different namespace the pod's identity won't federate, so fail closed
	// rather than render a pod that can never authenticate. ("" defaults to keylessKSANamespace.)
	if opts.Namespace != "" && opts.Namespace != keylessKSANamespace {
		return keylessWiring{}, fmt.Errorf("keyless DB auth requires namespace %q (the Workload-Identity subject), got %q", keylessKSANamespace, opts.Namespace)
	}
	// The engine comes from the bound database itself (matched by name — the same match
	// KeylessDBTarget already made to read IamAuth, so the db is guaranteed present here).
	engine := dbEngineForTarget(opts, t)
	if err := keylessCellSupported(opts.Provider, engine); err != nil {
		return keylessWiring{}, err
	}
	switch opts.Provider {
	case providerGCP:
		return gcpProxyWiring(opts, engine)
	case providerAWS:
		return awsAuthProxyWiring(opts, engine)
	case providerAzure:
		return azureAuthProxyWiring(opts, engine)
	}
	// Unreachable — keylessCellSupported already rejected any provider absent from keylessCells.
	return keylessWiring{}, fmt.Errorf("keyless DB auth is not supported for provider %q", opts.Provider)
}

// upstreamAddr joins a database host with the engine's port for `db-authproxy --upstream`.
//
// The platform endpoint outputs are host-only (Aurora's `endpoint`, Azure's `server_fqdn`), which is
// the case worth optimising for — but blindly joining a host that ALREADY carries a port yields
// `[host:5432]:5432`, which the proxy parses as a hostname containing a colon and then presents as the
// TLS ServerName, failing certificate verification with a message that points nowhere near the cause.
// If the host already parses as host:port it is authoritative and passed through untouched.
func upstreamAddr(host, port string) string {
	if _, _, err := net.SplitHostPort(host); err == nil {
		return host
	}
	return net.JoinHostPort(host, port)
}

// authProxySidecar builds the `alethia db-authproxy` sidecar shared by the token-as-password clouds
// (AWS RDS IAM / Azure Entra). One builder for both, so their invocations cannot drift apart.
//
// The proxy is self-contained: it mints a fresh token per upstream connection from the pod's own
// Workload Identity and holds it only in memory, so there is no volume, no mount and nothing written
// to disk — which is also why it satisfies the readOnlyRootFilesystem the sidecar renderer imposes.
// `region` is required by `db-authproxy` on AWS (the RDS token is region-signed) and is empty
// elsewhere. The runner image's entrypoint is the runner binary, so the subcommand is the first Arg.
func authProxySidecar(provider, engine, upstreamHost, region, runnerImage string) Sidecar {
	portStr, portInt := enginePort(engine)
	args := []string{
		"db-authproxy",
		"--provider", provider,
		"--engine", engine,
		// Both flags carry a full host:port — `db-authproxy` splits them and has no port defaults.
		"--upstream", upstreamAddr(upstreamHost, portStr),
		"--listen", net.JoinHostPort(authProxyListenHost, portStr),
		"--user", keylessDBUser,
	}
	if region != "" {
		args = append(args, "--region", region)
	}
	return Sidecar{
		Name:  "db-authproxy",
		Image: runnerImage,
		Args:  args,
		Ports: []int{portInt},
	}
}
