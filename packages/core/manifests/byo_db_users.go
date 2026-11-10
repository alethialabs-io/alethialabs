// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// This file renders the BYO users Job (docs/adr/byo-binding-db-users.md §3, slices 4 and 5 of #6438):
// the one-shot Job that connects to the environment's Postgres or MySQL database as its administrator
// and runs `alethia db-bootstrap --byo-users`, which creates, scopes, rotates and revokes the
// per-binding users.
//
// It sits next to RenderBootstrapJob and borrows that Job's admin connection per cloud, its deadline,
// its TTL and its security context. What differs, and why:
//
//   - The RUNNER applies it, with its own kubeconfig, into a namespace of its own
//     (ByoDBUsersNamespace) that holds no workload. It is not an ArgoCD hook, so it carries no hook
//     annotation, and nothing but the runner removes what it materialises
//     (provisioner/byo_db_users.go owns that cleanup).
//   - Every password reaches the pod through a Secret of its own: one ExternalSecret per declared user,
//     each materialising only that user's password, read by the render container through its own
//     secretKeyRef. No Secret holds two users' passwords, and the apply container holds none of them.
//   - The admin credential is materialised as for the bootstrap Job: an ExternalSecret on AWS and GCP,
//     a ServiceAccount federated to the dedicated admin identity on Azure.
//   - Every object carries ByoDBUsersLabel and the environment's owner label, so the runner's cleanup
//     and its pre-run sweep select only this environment's objects of this kind.
//
// Pure and deterministic: the caller supplies the tofu outputs and the declared users, and every
// required output that is missing fails the render closed.
package manifests

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"gopkg.in/yaml.v3"
)

const (
	// ByoDBUsersNamespace is where the BYO users Job and its credential objects live. The runner
	// creates it, and it is reserved for the platform by its exact name (the platformByoDBUsers
	// group of argocd/byo_reserved_namespaces.json, pinned by
	// TestByoDBUsers_NamespaceIsReservedForThePlatform), and the run refuses to start while it holds
	// any object that is not a run's (provisioner foreignByoDBUsersObjects).
	ByoDBUsersNamespace = "alethia-byo-db-users"
	// ByoDBUsersLabel marks every object of a BYO users run. The cleanup and the sweep select by it
	// AND by ByoDBUsersOwnerLabel, and re-check both on each object.
	ByoDBUsersLabel      = "alethia.io/byo-db-users"
	ByoDBUsersLabelValue = "true"
	// ByoDBUsersOwnerLabel is the environment's owner label (argocd.ByoBindingOwnerLabel, which this
	// package cannot import). Pinned equal by TestByoDBUsers_OwnerLabelMatchesArgocd.
	ByoDBUsersOwnerLabel = "alethia.io/environment-id"
	// ByoDBUsersMainContainer is the container whose termination message carries the run's result.
	ByoDBUsersMainContainer = "apply-sql"
	// ByoDBUsersResultPath is the main container's terminationMessagePath. psql's \o writes the
	// result there (on MySQL, the shell redirects the client's output to it), and the runner reads it
	// back as the container's termination message.
	ByoDBUsersResultPath = "/dev/termination-log"
	// byoDBUsersNamePrefix starts every object name of a run; ByoDBUsersJobNamePrefix exports it.
	byoDBUsersNamePrefix = "byo-db-users-"
	// ByoDBUsersJobNamePrefix starts every run's Job name (and every other object name of a run).
	ByoDBUsersJobNamePrefix = byoDBUsersNamePrefix
	// byoDBUsersEnvHashLen is how many hex characters of the environment hash a name carries.
	byoDBUsersEnvHashLen = 10
	// ByoDBUsersAzureServiceAccount is the ServiceAccount the Azure run's pod runs as. Its name is
	// FIXED, not per environment, because the Azure template federates the dedicated admin identity
	// to exactly system:serviceaccount:<ByoDBUsersNamespace>:<this> (app-db-identity.tf
	// azure_byo_db_users_ksa_name), and an Azure federated credential matches its subject exactly,
	// with no wildcard. One name per cluster is enough: the admin outputs and the credential exist
	// only where the environment provisions its own AKS cluster (provision_aks), and the credential's
	// issuer is that cluster's (module.aks[0].oidc_issuer_url). The credential trusts any pod running
	// as this ServiceAccount in ByoDBUsersNamespace on that cluster. What keeps other workloads out of
	// the namespace: BYO charts refuse it by exact name (argocd byo_reserved_namespaces.json), and
	// the runner refuses to start a run while it holds a foreign object (provisioner
	// foreignByoDBUsersObjects). A namespace-placed environment is not yet refused it (#6551).
	// TestByoDBUsers_AzureServiceAccountMatchesTheTemplate pins the two spellings equal.
	ByoDBUsersAzureServiceAccount = byoDBUsersNamePrefix + "admin"
)

// byoDBUsersRunIDRe bounds the run id folded into the Job's name: a Job name is also a pod label
// value (job-name), so the whole name stays within 63 characters.
var byoDBUsersRunIDRe = regexp.MustCompile(`^[a-z0-9]{1,16}$`)

// ByoDBUsersUser is one declared per-binding user the Job provisions: its name and the name of its
// password secret in the environment's store (the tofu output `custom_secret_names`).
type ByoDBUsersUser struct {
	User      string
	RemoteKey string
}

// ByoDBUsersJobParams is everything one BYO users run is rendered from.
type ByoDBUsersJobParams struct {
	// Provider is the cloud ("aws" | "gcp" | "azure"); the admin connection is per cloud.
	Provider string
	// Engine is the database's engine family: "postgres" (or "") or "mysql". It picks the client
	// container and db-bootstrap's dialect.
	Engine string
	// RunnerImage runs db-bootstrap (and, on Azure, db-token).
	RunnerImage string
	// Environment is the environment's ID: the owner label value, and `--env-id`.
	Environment string
	// Users is the declared set this run provisions. Empty is valid: the run then revokes every user
	// of this environment (unless SkipRevoke).
	Users []ByoDBUsersUser
	// SkipRevoke renders `--skip-revoke`: the caller's declared set is incomplete, so nothing may be
	// revoked on this run.
	SkipRevoke bool
	// RunID makes this run's Job name unique, so a finished Job kept for its TTL never blocks the next.
	RunID string
	// Outputs are the provision's string tofu outputs (the admin connection).
	Outputs map[string]string
	// NamespaceLabels are extra labels for the namespace (the runner's secret-store stamp).
	NamespaceLabels map[string]string
}

// ByoDBUsersObject is one credential-bearing object of a run, as the runner must find it again to
// delete it: its kubectl resource, name and rendered document.
type ByoDBUsersObject struct {
	// Resource is the kubectl resource name ("externalsecrets.external-secrets.io" | "serviceaccounts").
	Resource string
	// Name is the object's name in ByoDBUsersNamespace.
	Name string
	// YAML is the rendered document.
	YAML string
}

// ByoDBUsersJob is a rendered BYO users run.
type ByoDBUsersJob struct {
	// NamespaceYAML creates ByoDBUsersNamespace.
	NamespaceYAML string
	// Credentials are the run's credential-bearing objects, admin first, then one per user, sorted by
	// user. The runner applies them before the Job and deletes every one of them after it.
	Credentials []ByoDBUsersObject
	// CAConfigMap is the ConfigMap holding the CA set the main container verifies the database server
	// against (db_tls.go). It holds no secret; the runner applies it before the Job and deletes it
	// after it, with the credentials.
	CAConfigMap ByoDBUsersObject
	// JobName is the Job's name.
	JobName string
	// JobYAML is the batch/v1 Job. It holds no credential: only secretKeyRefs and, on Azure, a token
	// minted inside its own pod.
	JobYAML string
}

// ByoDBUsersBaseName is the stem of every object name an environment's runs use.
func ByoDBUsersBaseName(environment string) string {
	sum := sha256.Sum256([]byte(environment))
	return byoDBUsersNamePrefix + hex.EncodeToString(sum[:])[:byoDBUsersEnvHashLen]
}

// byoDBUsersUserSecretName is the ExternalSecret (and Secret) holding one user's password.
func byoDBUsersUserSecretName(environment, user string) string {
	return ByoDBUsersBaseName(environment) + "-u-" + strings.TrimPrefix(user, ByoDBUserPrefix)
}

// byoDBUsersAdminName is the admin ExternalSecret's name (AWS/GCP). The Azure ServiceAccount is
// ByoDBUsersAzureServiceAccount instead.
func byoDBUsersAdminName(environment string) string {
	return ByoDBUsersBaseName(environment) + "-admin"
}

// ByoDBUsersPasswordEnv names the render container's environment variable for one user's password:
// db-bootstrap's prefix, then the user's 12-hex suffix (apps/runner db_bootstrap_byo.go
// byoPasswordEnv). TestByoDBUsersJob_PasswordEnvMatchesTheRunner pins the two spellings together.
func ByoDBUsersPasswordEnv(user string) string {
	return "ALETHIA_BYO_DB_PASSWORD_" + strings.TrimPrefix(user, ByoDBUserPrefix)
}

// byoDBUsersLabels are the labels every object of a run carries.
func byoDBUsersLabels(environment string) map[string]string {
	return map[string]string{
		ByoDBUsersLabel:                ByoDBUsersLabelValue,
		ByoDBUsersOwnerLabel:           environment,
		"app.kubernetes.io/managed-by": "alethia",
	}
}

// RenderByoDBUsersJob renders one BYO users run for a Postgres or MySQL database. It fails closed on an
// unknown engine, a provider with no admin connection here, a missing admin output, a malformed
// environment, run id, user or remote key, or a user declared twice — so a run that cannot connect, or
// would hand db-bootstrap a name it refuses, is never applied.
func RenderByoDBUsersJob(p ByoDBUsersJobParams) (ByoDBUsersJob, error) {
	if p.RunnerImage == "" {
		return ByoDBUsersJob{}, fmt.Errorf("no runner image for the BYO users Job (db-bootstrap)")
	}
	if !byoDBEnvironmentRe.MatchString(p.Environment) {
		return ByoDBUsersJob{}, fmt.Errorf("the BYO users Job needs an environment ID")
	}
	if !byoDBUsersRunIDRe.MatchString(p.RunID) {
		return ByoDBUsersJob{}, fmt.Errorf("BYO users Job: run id %q is not a short lowercase alphanumeric", p.RunID)
	}
	switch p.Engine {
	case "", enginePostgres, engineMySQL:
	default:
		return ByoDBUsersJob{}, fmt.Errorf("BYO users Job: engine %q is not supported (want postgres|mysql)", p.Engine)
	}
	store := StoreNameFor(p.Provider)
	if store == "" {
		return ByoDBUsersJob{}, fmt.Errorf("no ClusterSecretStore for provider %q — the BYO users Job cannot read the passwords", p.Provider)
	}
	users := append([]ByoDBUsersUser(nil), p.Users...)
	sort.Slice(users, func(i, j int) bool { return users[i].User < users[j].User })
	seen := map[string]bool{}
	for _, u := range users {
		if !byoDBUserRe.MatchString(u.User) {
			return ByoDBUsersJob{}, fmt.Errorf("BYO users Job: %q is not a per-binding database user", u.User)
		}
		if seen[u.User] {
			return ByoDBUsersJob{}, fmt.Errorf("BYO users Job: user %s is declared twice", u.User)
		}
		seen[u.User] = true
		if strings.TrimSpace(u.RemoteKey) == "" || strings.ContainsAny(u.RemoteKey, "\r\n") {
			return ByoDBUsersJob{}, fmt.Errorf("BYO users Job: no usable secret name for user %s", u.User)
		}
	}

	var out ByoDBUsersJob
	env := p.Environment
	labels := byoDBUsersLabels(env)
	conn, err := byoDBUsersAdminConnection(p, store)
	if err != nil {
		return ByoDBUsersJob{}, err
	}
	caName := dbCAConfigMapName(ByoDBUsersBaseName(env))
	out.CAConfigMap = ByoDBUsersObject{
		Resource: "configmaps",
		Name:     caName,
		YAML:     renderDBCAConfigMap(caName, ByoDBUsersNamespace, labels, nil, conn.tls),
	}
	conn.volumes = append(conn.volumes, map[string]any{"name": dbCAVolume, "configMap": map[string]any{"name": caName}})
	conn.main["volumeMounts"] = append(conn.main["volumeMounts"].([]any),
		map[string]any{"name": dbCAVolume, "mountPath": dbCADir, "readOnly": true})

	nsLabels := map[string]string{ByoDBUsersLabel: ByoDBUsersLabelValue, "app.kubernetes.io/managed-by": "alethia"}
	for k, v := range p.NamespaceLabels {
		nsLabels[k] = v
	}
	out.NamespaceYAML = marshalByoDBUsersDoc(map[string]any{
		"apiVersion": "v1",
		"kind":       "Namespace",
		"metadata":   map[string]any{"name": ByoDBUsersNamespace, "labels": nsLabels},
	})
	if conn.admin.YAML != "" {
		out.Credentials = append(out.Credentials, conn.admin)
	}

	// One ExternalSecret per user, each materialising that user's password alone.
	userArgs := make([]string, 0, len(users))
	renderEnv := make([]any, 0, len(users))
	for _, u := range users {
		name := byoDBUsersUserSecretName(env, u.User)
		doc := byoDBUsersExternalSecret(name, store, labels, []map[string]any{
			{"secretKey": "password", "remoteRef": map[string]any{"key": u.RemoteKey}},
		})
		out.Credentials = append(out.Credentials, ByoDBUsersObject{Resource: byoDBUsersESResource, Name: name, YAML: doc})
		userArgs = append(userArgs, u.User)
		renderEnv = append(renderEnv, secretEnv(ByoDBUsersPasswordEnv(u.User), name, "password"))
	}

	args := []string{
		"db-bootstrap", "--byo-users",
		"--provider", p.Provider,
		"--env-id", env,
		"--db", conn.dbName,
		// One argument, so an empty declared set is still an explicit `--users=` (omitting it is refused).
		"--users=" + strings.Join(userArgs, ","),
	}
	if p.Engine == engineMySQL {
		// Two scripts: the sweep is applied with --force, so it is a file of its own, and only when
		// revocation runs. The client's output, not a path, carries the result.
		args = append(args, "--engine", engineMySQL, "--out", bootstrapSQLFile)
		if !p.SkipRevoke {
			args = append(args, "--sweep-out", byoDBUsersSweepFile)
		}
	} else {
		args = append(args, "--result-path", ByoDBUsersResultPath, "--out", bootstrapSQLFile)
	}
	if p.SkipRevoke {
		args = append(args, "--skip-revoke")
	}
	render := map[string]any{
		"name":         "render-sql",
		"image":        p.RunnerImage,
		"args":         args,
		"volumeMounts": []any{map[string]any{"name": "sql", "mountPath": bootstrapSQLDir}},
	}
	if len(renderEnv) > 0 {
		render["env"] = renderEnv
	}
	inits := append(conn.inits, render)
	for _, c := range inits {
		byoDBUsersHarden(c)
	}
	main := conn.main
	main["terminationMessagePath"] = ByoDBUsersResultPath
	main["terminationMessagePolicy"] = "File"
	byoDBUsersHarden(main)

	podSpec := map[string]any{
		"restartPolicy":   "Never",
		"securityContext": byoDBUsersPodSecurityContext(),
		"initContainers":  inits,
		"containers":      []any{main},
		"volumes":         conn.volumes,
	}
	if conn.serviceAccount != "" {
		podSpec["serviceAccountName"] = conn.serviceAccount
	}
	podLabels := map[string]string{}
	for k, v := range labels {
		podLabels[k] = v
	}
	for k, v := range conn.podLabels {
		podLabels[k] = v
	}
	out.JobName = ByoDBUsersBaseName(env) + "-" + p.RunID
	out.JobYAML = marshalByoDBUsersDoc(map[string]any{
		"apiVersion": "batch/v1",
		"kind":       "Job",
		"metadata":   map[string]any{"name": out.JobName, "namespace": ByoDBUsersNamespace, "labels": labels},
		"spec": map[string]any{
			"backoffLimit":            2,
			"activeDeadlineSeconds":   bootstrapJobDeadlineSeconds,
			"ttlSecondsAfterFinished": bootstrapJobTTLSeconds,
			"template": map[string]any{
				"metadata": map[string]any{"labels": podLabels},
				"spec":     podSpec,
			},
		},
	})
	return out, nil
}

// ByoDBUsersDeadlineSeconds is the Job's activeDeadlineSeconds, the bootstrap Job's: the runner's
// wait is bounded by it.
const ByoDBUsersDeadlineSeconds = bootstrapJobDeadlineSeconds

// byoDBEnvironmentRe bounds the environment ID: it is a label value and db-bootstrap's --env-id,
// which refuses anything outside this shape (byoEnvIDPattern).
var byoDBEnvironmentRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$`)

// byoDBUsersESResource is the kubectl resource of an ExternalSecret.
const byoDBUsersESResource = "externalsecrets.external-secrets.io"

// byoDBUsersConn is the per-cloud admin connection of a run.
type byoDBUsersConn struct {
	dbName         string
	tls            dbTLS
	admin          ByoDBUsersObject
	serviceAccount string
	podLabels      map[string]string
	inits          []map[string]any
	main           map[string]any
	volumes        []any
}

// byoDBUsersAdminConnection resolves the per-cloud admin connection from the outputs — the same
// outputs, users, clients and TLS verification the bootstrap Job connects with (awsBootstrapSpec,
// gcpBootstrapSpec, azureBootstrapSpec, dbTLSFor) — and renders the admin credential object.
func byoDBUsersAdminConnection(p ByoDBUsersJobParams, store string) (byoDBUsersConn, error) {
	env := p.Environment
	labels := byoDBUsersLabels(env)
	need := func(key, what string) (string, error) {
		if v := p.Outputs[key]; v != "" {
			return v, nil
		}
		return "", fmt.Errorf("no %s output for the BYO users Job %s", key, what)
	}
	var c byoDBUsersConn
	switch p.Provider {
	case string(types.CloudProviderAws), string(types.CloudProviderGcp), string(types.CloudProviderAzure):
		tls, err := dbTLSFor(p.Provider, p.Outputs)
		if err != nil {
			return c, fmt.Errorf("BYO users Job: %w", err)
		}
		c.tls = tls
	default:
		return c, fmt.Errorf("the BYO users Job is not supported for provider %q", p.Provider)
	}
	pgEnv := func(host, db string) []any {
		return []any{
			plainEnv("PGHOST", host),
			plainEnv("PGPORT", "5432"),
			plainEnv("PGDATABASE", db),
			plainEnv("PGSSLMODE", c.tls.PGSSLMode()),
			plainEnv("PGSSLROOTCERT", dbCAFile),
			plainEnv("PGCONNECT_TIMEOUT", "30"),
			plainEnv(dbTLSReasonEnv, c.tls.dbTLSFailureReason()),
		}
	}
	sqlRO := map[string]any{"name": "sql", "mountPath": bootstrapSQLDir, "readOnly": true}
	switch p.Provider {
	case string(types.CloudProviderAws), string(types.CloudProviderGcp):
		hostKey, dbKey, secretKey := "rds_cluster_endpoint", "rds_database_name", "rds_master_credentials_secret_name"
		if p.Provider == string(types.CloudProviderGcp) {
			hostKey, dbKey, secretKey = "cloud_sql_ip", "cloud_sql_database", "cloud_sql_credentials_secret"
		}
		host, err := need(hostKey, "connection")
		if err != nil {
			return c, err
		}
		if c.dbName, err = need(dbKey, "connection"); err != nil {
			return c, err
		}
		remote, err := need(secretKey, "admin credentials")
		if err != nil {
			return c, err
		}
		name := byoDBUsersAdminName(env)
		doc := byoDBUsersExternalSecret(name, store, labels, []map[string]any{
			{"secretKey": "username", "remoteRef": map[string]any{"key": remote, "property": "username"}},
			{"secretKey": "password", "remoteRef": map[string]any{"key": remote, "property": "password"}},
		})
		c.admin = ByoDBUsersObject{Resource: byoDBUsersESResource, Name: name, YAML: doc}
		if p.Engine == engineMySQL {
			c.main, c.volumes = byoDBUsersMySQLMain(host, c.dbName, p.SkipRevoke,
				[]any{secretEnv("BYO_DB_ADMIN_USER", name, "username"), secretEnv("MYSQL_PWD", name, "password")}, false, c.tls)
			break
		}
		envs := append(pgEnv(host, c.dbName), secretEnv("PGUSER", name, "username"), secretEnv("PGPASSWORD", name, "password"))
		c.main = map[string]any{
			"name":         ByoDBUsersMainContainer,
			"image":        postgresClientImage,
			"command":      []string{"/bin/sh", "-c", byoDBUsersPGScript(false)},
			"env":          envs,
			"volumeMounts": []any{sqlRO},
		}
		c.volumes = []any{map[string]any{"name": "sql", "emptyDir": map[string]any{}}}
	case string(types.CloudProviderAzure):
		host, err := need("azure_db_fqdn", "connection")
		if err != nil {
			return c, err
		}
		if c.dbName, err = need("azure_db_name", "connection"); err != nil {
			return c, err
		}
		adminUser, err := need("azure_db_admin_user", "admin login")
		if err != nil {
			return c, err
		}
		clientID, err := need("azure_db_admin_client_id", "Workload Identity")
		if err != nil {
			return c, err
		}
		name := ByoDBUsersAzureServiceAccount
		saLabels := map[string]string{"azure.workload.identity/use": "true"}
		for k, v := range labels {
			saLabels[k] = v
		}
		doc := marshalByoDBUsersDoc(map[string]any{
			"apiVersion": "v1",
			"kind":       "ServiceAccount",
			"metadata": map[string]any{
				"name":        name,
				"namespace":   ByoDBUsersNamespace,
				"labels":      saLabels,
				"annotations": map[string]string{"azure.workload.identity/client-id": clientID},
			},
		})
		c.admin = ByoDBUsersObject{Resource: "serviceaccounts", Name: name, YAML: doc}
		c.serviceAccount = name
		c.podLabels = map[string]string{"azure.workload.identity/use": "true"}
		c.inits = []map[string]any{{
			"name":         "mint-admin-token",
			"image":        p.RunnerImage,
			"args":         []string{"db-token", "--provider", "azure", "--once", "--out", bootstrapTokenFile},
			"volumeMounts": []any{map[string]any{"name": "admin-token", "mountPath": bootstrapTokenDir}},
		}}
		if p.Engine == engineMySQL {
			// The ossrdbms-aad token is the same for both engines; MySQL's Entra login sends it as the
			// password through the cleartext plugin, over TLS (bootstrap_job.go mysqlContainer).
			c.main, c.volumes = byoDBUsersMySQLMain(host, c.dbName, p.SkipRevoke, []any{plainEnv("BYO_DB_ADMIN_USER", adminUser)}, true, c.tls)
			break
		}
		c.main = map[string]any{
			"name":    ByoDBUsersMainContainer,
			"image":   postgresClientImage,
			"command": []string{"/bin/sh", "-c", byoDBUsersPGScript(true)},
			"env":     append(pgEnv(host, c.dbName), plainEnv("PGUSER", adminUser)),
			"volumeMounts": []any{sqlRO,
				map[string]any{"name": "admin-token", "mountPath": bootstrapTokenDir, "readOnly": true}},
		}
		c.volumes = []any{
			map[string]any{"name": "sql", "emptyDir": map[string]any{}},
			map[string]any{"name": "admin-token", "emptyDir": map[string]any{"medium": "Memory"}},
		}
	}
	return c, nil
}

// byoDBUsersPGScript is the Postgres main container's shell script: psql applies the provision
// script, which itself writes the result to the termination message (`--result-path`), under
// run_db_client, which names a TLS failure and keeps the client's exit code. With fromToken the
// admin password is the minted Entra token, read from its file.
func byoDBUsersPGScript(fromToken bool) string {
	script := dbTLSShellPrelude + "exec 3>&1\n"
	if fromToken {
		script += `PGPASSWORD="$(cat ` + bootstrapTokenFile + `)"` + "\nexport PGPASSWORD\n"
	}
	return script + "run_db_client psql -X -v ON_ERROR_STOP=1 -f " + bootstrapSQLFile + "\n"
}

// byoDBUsersSweepFile is the MySQL sweep script, next to the provision script (bootstrapSQLFile).
const byoDBUsersSweepFile = bootstrapSQLDir + "/sweep.sql"

// byoDBUsersMySQLResultDir holds the sweep's output until it is known to be a whole result.
const byoDBUsersMySQLResultDir = "/byo-result"

// byoDBUsersMySQLScript is the MySQL main container's shell script. It applies the provision script
// WITHOUT --force, so the first error stops the run, and sends the client's output — the result, the
// only rows that script selects — to the termination message; set -e then fails the container on any
// error before the result. Unless revocation is skipped, it applies the sweep WITH --force, so a
// candidate that cannot be dropped does not stop the others (the client reports each error), into a
// file of its own; that file replaces the termination message only when it starts with the result
// header, and anything else fails the container. The admin password is MYSQL_PWD, which the client
// reads natively, so it is never in argv. Every client runs under run_db_client (dbTLSShellPrelude)
// with mysqlFlags (the TLS verification), so a certificate that does not verify fails the container
// with a named reason before any result is written: the run is Failed, never read as zero users.
func byoDBUsersMySQLScript(skipRevoke, fromToken bool, mysqlFlags string) string {
	client := `run_db_client mysql --user="$BYO_DB_ADMIN_USER" ` + mysqlFlags
	if fromToken {
		client += " --enable-cleartext-plugin"
	}
	client += " -N -B"
	lines := []string{strings.TrimSuffix(dbTLSShellPrelude, "\n")}
	if fromToken {
		lines = append(lines, `MYSQL_PWD="$(cat `+bootstrapTokenFile+`)"`, "export MYSQL_PWD")
	}
	lines = append(lines, "exec 3> "+ByoDBUsersResultPath, client+` "$BYO_DB_NAME" < `+bootstrapSQLFile)
	if !skipRevoke {
		result := byoDBUsersMySQLResultDir + "/result"
		lines = append(lines,
			"exec 3> "+result,
			`if ! `+client+` --force "$BYO_DB_NAME" < `+byoDBUsersSweepFile+`; then`,
			`  echo "alethia byo-users: the sweep reported errors above; a user it could not drop stays locked and is listed as revocation-pending" >&2`,
			`fi`,
			"exec 3>&-",
			`first=""`,
			`IFS= read -r first < `+result+` || true`,
			`case "$first" in`,
			`  "alethia-byo-users v1 count="*) ;;`,
			`  *) echo "alethia byo-users: the sweep wrote no result" >&2; exit 1 ;;`,
			`esac`,
			`cat `+result+` > `+ByoDBUsersResultPath,
		)
	}
	return strings.Join(lines, "\n") + "\n"
}

// byoDBUsersMySQLMain is the MySQL main container and the run's volumes: the mysql client image, the
// connection as env values, TLS always verified (tls), and the admin credential in adminEnv (and, with
// fromToken, the Entra token's volume).
func byoDBUsersMySQLMain(host, db string, skipRevoke bool, adminEnv []any, fromToken bool, tls dbTLS) (map[string]any, []any) {
	env := append([]any{
		plainEnv("MYSQL_HOST", host),
		plainEnv("MYSQL_TCP_PORT", "3306"),
		plainEnv("BYO_DB_NAME", db),
		plainEnv(dbTLSReasonEnv, tls.dbTLSFailureReason()),
	}, adminEnv...)
	mounts := []any{
		map[string]any{"name": "sql", "mountPath": bootstrapSQLDir, "readOnly": true},
		map[string]any{"name": "byo-result", "mountPath": byoDBUsersMySQLResultDir},
	}
	volumes := []any{
		map[string]any{"name": "sql", "emptyDir": map[string]any{}},
		map[string]any{"name": "byo-result", "emptyDir": map[string]any{"medium": "Memory"}},
	}
	if fromToken {
		mounts = append(mounts, map[string]any{"name": "admin-token", "mountPath": bootstrapTokenDir, "readOnly": true})
		volumes = append(volumes, map[string]any{"name": "admin-token", "emptyDir": map[string]any{"medium": "Memory"}})
	}
	return map[string]any{
		"name":         ByoDBUsersMainContainer,
		"image":        mysqlClientImage,
		"command":      []string{"/bin/sh", "-c", byoDBUsersMySQLScript(skipRevoke, fromToken, tls.MySQLFlags())},
		"env":          env,
		"volumeMounts": mounts,
	}, volumes
}

// byoDBUsersExternalSecret renders one credential ExternalSecret of a run. The Secret it materialises
// carries the same labels (target.template.metadata), so the sweep can select a Secret whose
// ExternalSecret is already gone. With no template data, ESO writes the fetched data unchanged.
func byoDBUsersExternalSecret(name, store string, labels map[string]string, data []map[string]any) string {
	return marshalByoDBUsersDoc(map[string]any{
		"apiVersion": "external-secrets.io/v1beta1",
		"kind":       "ExternalSecret",
		"metadata":   map[string]any{"name": name, "namespace": ByoDBUsersNamespace, "labels": labels},
		"spec": map[string]any{
			"refreshInterval": "1h",
			"secretStoreRef":  map[string]any{"name": store, "kind": "ClusterSecretStore"},
			"target": map[string]any{
				"name":           name,
				"creationPolicy": "Owner",
				"template":       map[string]any{"metadata": map[string]any{"labels": labels}},
			},
			"data": data,
		},
	})
}

// plainEnv is a container env var with a literal value.
func plainEnv(name, value string) map[string]any {
	return map[string]any{"name": name, "value": value}
}

// secretEnv is a container env var read from one key of one Secret.
func secretEnv(name, secret, key string) map[string]any {
	return map[string]any{"name": name, "valueFrom": map[string]any{"secretKeyRef": map[string]any{"name": secret, "key": key}}}
}

// byoDBUsersHarden gives a container the bootstrap Job's resources and container security context.
func byoDBUsersHarden(c map[string]any) {
	c["resources"] = map[string]any{
		"requests": map[string]any{"cpu": "10m", "memory": "32Mi"},
		"limits":   map[string]any{"cpu": "200m", "memory": "128Mi"},
	}
	c["securityContext"] = map[string]any{
		"allowPrivilegeEscalation": false,
		"readOnlyRootFilesystem":   true,
		"capabilities":             map[string]any{"drop": []string{"ALL"}},
	}
}

// byoDBUsersPodSecurityContext is the bootstrap Job's pod security context.
// TestByoDBUsersJob_SecurityContextMatchesTheBootstrapJob pins the two equal.
func byoDBUsersPodSecurityContext() map[string]any {
	return map[string]any{
		"runAsNonRoot":   true,
		"runAsUser":      1000,
		"runAsGroup":     1000,
		"fsGroup":        1000,
		"seccompProfile": map[string]any{"type": "RuntimeDefault"},
	}
}

// marshalByoDBUsersDoc encodes one document. Marshalling, not templating: every value is quoted as
// YAML needs, so no input can become a second document or a field it was not given as.
//
// There is no error to handle. yaml.v3 returns one only from a value's own MarshalYAML, and every
// document here is built from strings, ints, bools, maps and slices, none of which has one; a value
// of a kind YAML cannot carry makes Marshal panic instead, which is a defect in this file and fails
// loudly (TestByoDBUsersJob_MarshalDefectPanics).
func marshalByoDBUsersDoc(doc map[string]any) string {
	b, _ := yaml.Marshal(doc)
	return string(b)
}
