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
//     only), and Hetzner data services are ArgoCD add-ons with no cloud IAM. Both are cells in
//     keylessCells carrying the reason a user reads, so a database marked `iam_auth` there fails
//     CLOSED with that reason. It does NOT fall back to a password: silently handing a password to
//     someone who asked for keyless is the failure this file exists to prevent (#1510).
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
	"errors"
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

	// KeylessDBUser is the least-privilege login the bootstrap Job creates for the app on the
	// token-as-password clouds (AWS RDS IAM / Azure Entra), mapped to the app's cloud identity. It is
	// the same name on every one of those cells: AWS Postgres `CREATE ROLE alethia_app` + rds_iam,
	// Azure Postgres `CREATE ROLE` + a pgaadauth SECURITY LABEL, Azure MySQL
	// `CREATE AADUSER 'alethia_app' IDENTIFIED BY '<uami-client-id>'`. GCP instead uses its
	// tofu-created IAM service-account user (the cloud_sql_iam_user output).
	//
	// EXPORTED because three places must agree on it and only two of them can share a symbol:
	// this package, the runner's db_bootstrap.go (which creates the login), and the AWS IAM policy
	// ARN in infra/templates/project/aws/irsa.tf (`dbuser:<resource-id>/alethia_app`, #1509). The
	// runner now imports this constant; the template cannot, so TestKeylessDBUserMatchesIRSAPolicy
	// asserts the ARN's username segment against it. RDS IAM usernames are CASE-SENSITIVE and a
	// mismatch does not fail the apply — it grants connect for a user that does not exist, so every
	// connect is denied at runtime with nothing pointing back at the drift.
	KeylessDBUser = "alethia_app"

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
	providerAWS     = string(types.CloudProviderAws)
	providerGCP     = string(types.CloudProviderGcp)
	providerAzure   = string(types.CloudProviderAzure)
	providerAlibaba = string(types.CloudProviderAlibaba)
	providerHetzner = string(types.CloudProviderHetzner)
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

// cellState is what we CLAIM about one cloud × engine keyless cell. The three states are not
// interchangeable: "we have not built it yet" and "this cloud can never do it" are different facts
// with different consequences — the first is debt that a lane retires, the second is a permanent
// product boundary the canvas must render and the offer-parity matrix must record as an exclusion.
// Collapsing them into one boolean is how alibaba/hetzner came to be "excluded" by simply being
// ABSENT from this table, which is the cloud-parity rule obeyed by omission.
type cellState string

const (
	// cellLive — every leg is built; the binding renders.
	cellLive cellState = "live"
	// cellPending — a leg is missing; reason names the lane that will deliver it.
	cellPending cellState = "pending"
	// cellExcluded — the cloud can never honor it; reason is the product-voice why.
	cellExcluded cellState = "excluded"
)

// keylessCell records whether one cloud × engine keyless cell is implemented END TO END — the tofu
// flag that turns IAM auth on, the bootstrap Job that creates the app's login, AND the runtime proxy.
type keylessCell struct {
	state cellState
	// reason is empty ONLY when state is cellLive. It is surfaced three ways — the fail-closed error
	// an operator reads, the canvas's disabled-toggle prose (via lib/cloud-providers/generated/
	// keyless-cells.ts, generated from this table), and the offer-parity matrix — so it is written in
	// the product's voice, not as an internal note. TestKeylessCellsTotal enforces non-emptiness.
	reason string
}

// keylessCells is the single source of truth for which keyless cells may render.
//
// A cell that is NOT implemented end to end renders NOTHING — the binding fails closed — because the
// alternative is the exact failure this table exists to prevent: a pod that passes every render-time
// check and then cannot authenticate at runtime. Rendering a proxy for a database whose IAM auth tofu
// never enabled, or whose login the bootstrap Job cannot create, is a lie told at deploy time and
// discovered in production.
//
// Every managed cell is live. MySQL was Azure-only while its aws/gcp legs were unshipped; they landed
// in #1504 (Aurora-MySQL template + `iam_database_authentication_enabled`), #1505 (Cloud SQL's
// underscored `cloudsql_iam_authentication` flag + the truncated MySQL login form), #1506 (the
// AWSAuthenticationPlugin / GRANT-only bootstrap dialects) and #1507 (the mysql-client apply
// container), so this table opens them.
//
// The table is TOTAL over every cloud the console can place a database on × both engine families. A
// cell you did not think about must not compile into a hole: absence used to mean "excluded", so
// alibaba and hetzner were excluded by not being written down, and the canvas — which had no way to
// read this table at all — went on offering the toggle for them anyway (#1510). Totality is the
// cloud-parity rule made structural, and TestKeylessCellsTotal is what enforces it.
//
// Keeping a cell off is a claim that one of its four legs is missing — the tofu flag, the bootstrap
// Job renderer, the bootstrap SQL dialect, or the runtime proxy. check-keyless-cells.mjs (CI guards)
// verifies that claim against those sources, because a cell left off after its legs ship is dead code
// that fails closed citing work already merged — which is how aws/gcp MySQL sat switched off across
// three lanes.
var keylessCells = map[string]map[string]keylessCell{
	providerAWS: {
		enginePostgres: {state: cellLive},
		engineMySQL:    {state: cellLive},
	},
	providerGCP: {
		enginePostgres: {state: cellLive},
		engineMySQL:    {state: cellLive},
	},
	providerAzure: {
		enginePostgres: {state: cellLive},
		engineMySQL:    {state: cellLive},
	},
	providerAlibaba: {
		enginePostgres: {state: cellExcluded, reason: alibabaKeylessExclusion},
		engineMySQL:    {state: cellExcluded, reason: alibabaKeylessExclusion},
	},
	providerHetzner: {
		enginePostgres: {state: cellExcluded, reason: hetznerKeylessExclusion},
		// Unreachable in the canvas — the catalog floor gives Hetzner only Postgres, so the engine
		// picker never offers MySQL. Present because the table is total: a cell that cannot be
		// reached today must still say what it would mean, or the next cloud added here inherits
		// "absent means excluded" all over again.
		engineMySQL: {state: cellExcluded, reason: hetznerMySQLExclusion},
	},
}

// The exclusion prose. Extracted as constants because each string is used twice or more and is
// PRODUCT COPY: it is what a user reads on the disabled canvas toggle, what an operator reads in the
// fail-closed deploy error, and — mirrored into infra/offer-exclusions.yaml, coupled by
// check-offer-parity.mjs — what the parity matrix prints. Reword it here and the guard reds until
// the yaml agrees.
const (
	alibabaKeylessExclusion = "Unavailable on Alibaba Cloud. RAM governs ApsaraDB's control plane only — there is no data-plane token login for a keyless connection to authenticate with. This database keeps a generated password."
	hetznerKeylessExclusion = "Unavailable on Hetzner. Postgres runs in-cluster via CloudNativePG — there is no managed instance and no cloud identity plane to mint database tokens against. This database keeps a generated password."
	hetznerMySQLExclusion   = "MySQL is not offered on Hetzner — the in-cluster CloudNativePG operator is PostgreSQL only."
)

// keylessCellSupported reports whether a cloud × engine keyless cell may render, or an error carrying
// the cell's reason. Fail-closed: an unknown provider or engine is refused, never defaulted into a
// neighbouring cell's wiring.
func keylessCellSupported(provider, engine string) error {
	engines, ok := keylessCells[provider]
	if !ok {
		return fmt.Errorf("keyless DB auth is not supported for provider %q", provider)
	}
	cell, ok := engines[engine]
	if !ok {
		return fmt.Errorf("keyless DB auth is not supported for engine %q on %s", engine, provider)
	}
	switch cell.state {
	case cellLive:
		return nil
	case cellPending:
		return fmt.Errorf("keyless %s on %s is not implemented yet (%s)", engine, provider, cell.reason)
	default:
		// The reason is the whole message: it is written for the person reading it, and prefixing it
		// with our own framing would bury the sentence that actually answers "why not".
		return errors.New(cell.reason)
	}
}

// enginePort returns the conventional wire port for an engine family, as a string and an int — the
// renderer needs both (a flag value and a containerPort).
func enginePort(engine string) (string, int) {
	if engine == engineMySQL {
		return strconv.Itoa(mysqlPort), mysqlPort
	}
	return strconv.Itoa(postgresPort), postgresPort
}

// KeylessDBTarget reports whether a binding target is a database the operator asked to authenticate
// keylessly — kind "database" and the matched db's IamAuth is true. A password-auth db or a
// non-database target → false.
//
// It is deliberately both engine-BLIND and provider-BLIND. It answers "did the operator ask for
// this?", never "can we do it?" — that second question is keylessCells', asked in keylessDBSidecar,
// which fails closed with the cell's reason. Answering both here is what made the doc comment false:
// this function used to return false for alibaba/hetzner, which routed a database explicitly marked
// `iam_auth: true` onto the password/ExternalSecret path with no error anywhere. A database the
// operator marked `iam_auth: true` must never quietly acquire a password (#1510), so the excluded
// cells now produce a reasoned refusal instead of a silent downgrade — and the key set of
// keylessCells is the only place that says which clouds honor keyless.
func KeylessDBTarget(t types.ServiceBindingTarget, dbs []types.ProjectDatabaseConfig) bool {
	if t.Kind != "database" {
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
		return KeylessDBUser, nil
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
		"--user", KeylessDBUser,
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
