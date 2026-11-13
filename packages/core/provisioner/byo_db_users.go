// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// This file runs the BYO users Job (docs/adr/byo-binding-db-users.md §3, slices 4 and 5 of #6438) on
// each deploy with ALETHIA_BYO_DB_USERS_ENABLED, and decides from its result which per-binding database
// users a BYO chart may be bound to. The environment's database may be Postgres or MySQL; the Job and
// db-bootstrap speak its dialect.
//
// # One run, in order
//
//  1. Decide whether a run can happen at all. No environment ID, a credential-based secrets provider
//     (cloud.ByoDBUserSecretsUnavailableReason), no database, a database whose engine is named MySQL
//     with no engine family set (the Job and the binding resolver could then disagree about its
//     dialect), an Azure database in password mode (no administrator identity to sign in as), a
//     Postgres older than 15, or a MySQL older than 8.0.21 runs nothing. Each of those but the first
//     two gives every per-binding database credential facet a stated reason; none of them ever
//     falls back to the administrative credential.
//  2. Take the declared users from the refusal-aware binding set (declaredByoDBUsers), and decide
//     whether that set is complete. It is not when a declared user has no stored password, or when a
//     binding of the environment fails to render. An incomplete set runs with `--skip-revoke`, so a
//     binding that is still declared is never read as removed.
//  3. Refuse, touching nothing, while ByoDBUsersNamespace holds any object that is not a run's
//     (foreignByoDBUsersObjects): the namespace is reserved for the platform, and the run's
//     credential Secrets live there. Then sweep what an interrupted earlier run left
//     (sweepByoDBUsers): only ByoDBUsersNamespace, only ExternalSecrets, Secrets and
//     ServiceAccounts, only objects carrying BOTH the run label and this environment's owner label,
//     each re-checked and deleted pinned to its uid. While a Job of this environment is still active
//     the sweep stands down, and no second Job is started.
//  4. Apply the namespace, then — from the moment a credential object may exist — a deferred cleanup
//     that deletes every credential object of the run, uid-pinned with Foreground propagation, so
//     each owned Secret goes first. A render, apply, wait or read error cannot skip it. The Job
//     itself holds no credential and is left to its TTL, so a failed run's logs stay readable.
//  5. Wait for Complete or Failed, bounded by the Job's own deadline, and read the main container's
//     termination message through the API (never logs). The message opens with a header counting
//     its entries, so a result the kubelet truncated is detected, never read as a shorter list. A
//     user counts as provisioned only when the Job is Complete, the message names the user, and the
//     user is in the set this run declared. Anything else provisions nothing, and is a binding
//     failure, so the binding prune is skipped. A `revocation-pending:<user>`, `sessions-not-ended:<user>`
//     or `doubt:…` line is surfaced as a deploy warning and is NOT a failure. An absent message is a lost result and a failure: the
//     header is always written, so "nothing declared" arrives as `count=0`.
package provisioner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/catalog"
	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/selfimage"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// byoDBUsersFloorReason is the unsatisfied reason of every per-binding database credential facet on
// a Postgres older than 15 (ADR §3): there PUBLIC may create in schema public by default, so a
// per-binding user could create objects outside its own schema.
const byoDBUsersFloorReason = "per-binding database users need PostgreSQL 15 or newer"

// byoDBUsersMinPostgresMajor is that floor.
const byoDBUsersMinPostgresMajor = 15

// byoDBUsersMySQLFloorReason is the unsatisfied reason of every per-binding database credential facet
// on a MySQL older than 8.0.21 (apps/runner db_bootstrap_byo_mysql.go mysqlByoFloorReason): user
// ATTRIBUTE, which carries the environment tag revocation selects by, arrived in 8.0.21.
const byoDBUsersMySQLFloorReason = "per-binding database users need MySQL 8.0.21 or newer"

// byoDBUsersAzurePasswordReason is the unsatisfied reason of every per-binding database credential
// facet on an Azure database in password mode (iam_auth off). The Azure Job logs in as the dedicated
// Entra administrator through Workload Identity (manifests ByoDBUsersAzureServiceAccount), and the
// template creates that identity and its outputs only with Entra authentication on (app-db-identity.tf
// enable_app_db_identity), so a password-mode server has no administrator the Job can use. Refusing
// here states that, where rendering would fail on the missing azure_db_admin_* outputs and mark the run
// Failed on every deploy (#6504).
const byoDBUsersAzurePasswordReason = "per-binding database users on Azure need the database's Entra authentication (iam_auth); a password-mode server has no administrator identity the BYO users Job can sign in as"

// byoDBUsersEngineUnknownReason is the unsatisfied reason when the database's engine names MySQL but
// its engine family is unset: the binding resolver reads the family alone (manifests.dbEngineForName),
// so it would treat the database as Postgres while the Job would speak MySQL.
const byoDBUsersEngineUnknownReason = "the database's engine family is not set, so its per-binding users' dialect is unknown"

// byoDBUsersPendingPrefix starts a result line naming a revocation the Job could not finish
// (apps/runner db_bootstrap_byo.go byoPendingPrefix).
const byoDBUsersPendingPrefix = "revocation-pending:"

// byoDBUsersSessionsPrefix starts a result line naming a revoked user that may still have a session
// the Job did not end: the administrator lacks PROCESS (so no session can be ruled out) or
// CONNECTION_ADMIN, the user's session was past the run's kill bound, or its kill failed (apps/runner
// db_bootstrap_byo_mysql.go mysqlByoSessionsPrefix and mysqlByoUnkilledSQL; MySQL only).
const byoDBUsersSessionsPrefix = "sessions-not-ended:"

// byoDBUsersDoubtPrefix starts a result line saying the Job cannot vouch for part of its own report
// (apps/runner db_bootstrap_byo_mysql.go mysqlByoDoubtPrefix; MySQL only). byoDBUsersDoubtRe is
// every such line the parser accepts.
const byoDBUsersDoubtPrefix = "doubt:"

// byoDBUsersDoubtRe matches a doubt line: `doubt:sessions-unrecorded` (the record of the sessions the
// Job could not end was lost), or `doubt:<revocation-pending|sessions-not-ended> +<n> more` (that
// list was capped and n more were left out).
var byoDBUsersDoubtRe = regexp.MustCompile(`^` + byoDBUsersDoubtPrefix + `(?:(sessions-unrecorded)|(revocation-pending|sessions-not-ended) \+([1-9][0-9]{0,5}) more)$`)

// byoDBUsersUserRe is the shape of a per-binding user (manifests.ByoBindingDBUser). A result line is
// accepted only in this shape.
var byoDBUsersUserRe = regexp.MustCompile(`^` + manifests.ByoDBUserPrefix + `[0-9a-f]{12}$`)

// Timing of a run. Variables so tests run without waiting.
var (
	// byoDBUsersPollInterval is how often the Job's status is read.
	byoDBUsersPollInterval = 5 * time.Second
	// byoDBUsersWaitGrace is added to the Job's activeDeadlineSeconds: the Job controller marks a
	// Job Failed shortly after its deadline, and the wait must outlast that, not race it.
	byoDBUsersWaitGrace = 2 * time.Minute
	// byoDBUsersRefreshEvery re-mints the cluster credential during a long wait.
	byoDBUsersRefreshEvery = 5 * time.Minute
	// byoDBUsersGoneWait bounds the wait for swept objects to disappear before a new run applies the
	// same names (Foreground deletion keeps an object until its dependents are gone).
	byoDBUsersGoneWait = 90 * time.Second
	// byoDBUsersNow is the clock.
	byoDBUsersNow = time.Now
	// byoDBUsersSleep waits d, or returns the context's error.
	byoDBUsersSleep = func(ctx context.Context, d time.Duration) error {
		t := time.NewTimer(d)
		defer t.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			return nil
		}
	}
	// byoDBUsersRunID names one run's Job.
	byoDBUsersRunID = func() string { return strconv.FormatInt(time.Now().Unix(), 36) }
	// byoDBUsersRunnerImage is the image db-bootstrap runs from.
	byoDBUsersRunnerImage = selfimage.Ref
)

// byoBindingRenderFailuresFn is byoBindingRenderFailures, a variable so a test can make a binding
// fail to render without also making its user unresolvable.
var byoBindingRenderFailuresFn = byoBindingRenderFailures

// byoDBUsersKubectl runs one kubectl call with optional stdin. A variable so tests can stand in for
// a cluster; it is the reaper's bounded call by default.
var byoDBUsersKubectl = func(ctx context.Context, stdin string, args ...string) (string, error) {
	return bootstrapReapKubectl(ctx, stdin, args...)
}

// byoDBUsersOutcome is what one deploy's BYO users run decided, for the binding lane.
type byoDBUsersOutcome struct {
	// Provisioned are the users the Job reported and this run declared (see the file comment).
	Provisioned map[string]bool
	// Refusal, when set, is the reason every per-binding database credential facet that is not
	// provisioned is reported with, instead of the resolver's generic one.
	Refusal string
	// Failed is set when a run was due and did not produce a trustworthy result. It is a binding
	// failure: the binding prune is skipped on this deploy.
	Failed bool
	// SkipRevoke records that the run was asked to revoke nothing (an incomplete declared set).
	SkipRevoke bool
	// Warnings are the Deploy-tab warnings of the run: a failure, and each pending revocation.
	Warnings []string
}

// byoDBUsersInput is what a run reads.
type byoDBUsersInput struct {
	VC       *types.ProjectConfig
	Outputs  map[string]interface{}
	Provider string
	// Refused are the BYO charts this deploy refused; their bindings are not declared.
	Refused []byoRefusal
	// Refresh re-mints the cluster credential before a long wait; nil skips it.
	Refresh func(ctx context.Context, step string) error
}

// byoDeclaredDBUser is one declared per-binding user and its `custom_secrets` key.
type byoDeclaredDBUser struct {
	User string
	Key  string
}

// byoDBUsersFailedWarning is the Deploy-tab warning for a run that produced no trustworthy result.
func byoDBUsersFailedWarning(reason string) string {
	return "The per-binding database users of this environment's bring-your-own charts were not provisioned on this deploy (" +
		reason + "), so their database bindings were not applied, and no binding secret was withdrawn. The next deploy runs it again."
}

// byoDBUsersSessionsWarning is the Deploy-tab warning for one revoked user whose open sessions the
// Job could not end. It is a warning, not a failure: the user is locked and dropped regardless. The
// Job names a user only when it saw a session of it, or when it could not see sessions at all (no
// PROCESS), so the text claims no session exists: it says any it had was not terminated. Nor does it
// claim one cause: a missing privilege is the usual one, but the Job's measurement also names a user
// whose session was past the run's kill bound or whose kill failed, with every privilege held.
func byoDBUsersSessionsWarning(user string) string {
	return fmt.Sprintf("Database user %s belongs to a bring-your-own binding that was removed. Any session it had open was not terminated: "+
		byoDBUsersSessionsCause+" Such a session keeps running until it disconnects. The user cannot log in again.", user)
}

// byoDBUsersSessionsCause names every reason the Job reports a session it did not end
// (mysqlByoUnkilledSQL in apps/runner), shared by the per-user warning and the "+n more" doubt.
const byoDBUsersSessionsCause = "the database administrator lacks the PROCESS or CONNECTION_ADMIN privilege, or a session could " +
	"not be ended on this deploy (more were open than one deploy ends, or ending one failed)."

// byoDBUsersDoubtWarning is the Deploy-tab warning for one doubt line (byoDBUsersDoubtRe), which the
// parser has already accepted.
func byoDBUsersDoubtWarning(line string) string {
	m := byoDBUsersDoubtRe.FindStringSubmatch(line)
	switch {
	case m == nil:
		return "The BYO users Job reported a doubt this deploy cannot read: " + line
	case m[1] != "":
		return "The BYO users Job lost its record of which removed bring-your-own bindings' database users still had sessions it could not " +
			"terminate (a statement failed or its client reconnected), so this deploy cannot say whether any such session is still open. " +
			"A revoked user cannot log in again; a session it opened before the revocation keeps running until it disconnects."
	case m[2] == "revocation-pending":
		return fmt.Sprintf("%s more database users of removed bring-your-own bindings could not be dropped on this deploy and are not listed "+
			"one by one. They can no longer log in, but they still exist. The next deploy tries the drop again.", m[3])
	default:
		return fmt.Sprintf("%s more database users of removed bring-your-own bindings may have sessions open that were not terminated, and "+
			"are not listed one by one: "+byoDBUsersSessionsCause+" Such a session keeps running until it disconnects. "+
			"These users cannot log in again.", m[3])
	}
}

// byoDBUsersPendingWarning is the Deploy-tab warning for one revocation the Job could not finish.
func byoDBUsersPendingWarning(user string) string {
	return fmt.Sprintf("Database user %s belongs to a bring-your-own binding that was removed, and could not be dropped on this deploy. "+
		"It can no longer log in, but it still exists and still owns its objects. The next deploy tries the drop again.", user)
}

// byoPrimaryDatabase is the name of the environment's primary database (byoEnvDatabase). A project
// may list more than one database, but every cloud's tofu composition provisions only the first
// (aws/gcp/azure/alibaba_provider.go read config.Databases[0]), and the admin connection outputs
// name that one server. A per-binding user is therefore created only for a binding to the primary
// database; a binding to any other target is refused with byoNonPrimaryReason, never created on the
// primary under another target's name.
func byoPrimaryDatabase(vc *types.ProjectConfig) (string, bool) {
	db, ok := byoEnvDatabase(vc)
	return db.Name, ok
}

// byoNonPrimaryReason is the unsatisfied reason of a per-binding database credential facet bound to
// a target other than the primary database.
func byoNonPrimaryReason(primary string) string {
	return fmt.Sprintf("per-binding database users are created only on the environment's primary database %q; a BYO binding is never given the administrative credential", primary)
}

// byoEnvDatabase is the environment's database: the first configured one, which is the one every
// cloud template provisions and the admin connection outputs name.
func byoEnvDatabase(vc *types.ProjectConfig) (types.ProjectDatabaseConfig, bool) {
	if vc == nil || len(vc.Databases) == 0 {
		return types.ProjectDatabaseConfig{}, false
	}
	return vc.Databases[0], true
}

// byoDatabaseIsMySQL reports whether a database config resolves to the MySQL family.
func byoDatabaseIsMySQL(db types.ProjectDatabaseConfig) bool {
	if db.EngineFamily != "" {
		return db.EngineFamily == "mysql"
	}
	return strings.Contains(strings.ToLower(db.Engine), "mysql")
}

// byoTargetIsMySQL mirrors the binding resolver's engine rule (manifests.dbEngineForName): a target
// is MySQL only when a configured database of that name has the MySQL engine family.
func byoTargetIsMySQL(dbs []types.ProjectDatabaseConfig, name string) bool {
	for _, db := range dbs {
		if db.Name == name {
			return db.EngineFamily == "mysql"
		}
	}
	return false
}

// byoMajorVersionRe takes the first run of digits of an engine version ("16.8", "15", "POSTGRES_14").
var byoMajorVersionRe = regexp.MustCompile(`[0-9]+`)

// byoMySQLVersionRe reads a MySQL version: major and minor, and the patch only when the version is
// a plain x.y.z ("8.0.mysql_aurora.3.04.0" names Aurora's own release, not MySQL's patch).
var byoMySQLVersionRe = regexp.MustCompile(`^(?:MYSQL_)?([0-9]+)[._]([0-9]+)(?:\.([0-9]+)$)?`)

// byoMySQLVersionOK reports whether the environment's MySQL may get per-binding users: the configured
// version, or the catalogue's default for the provider, is 8.0.21 or newer as far as it says. A version
// without a patch ("8.0") passes here, and the Job's own floor, which reads the server's real version,
// refuses a server below 8.0.21. No readable version fails closed.
func byoMySQLVersionOK(provider string, db types.ProjectDatabaseConfig) bool {
	v := strings.TrimSpace(db.EngineVersion)
	if v == "" {
		if e, ok := catalog.MustLoad().DBEngine(provider, "mysql"); ok {
			v = e.DefaultVersion
		}
	}
	m := byoMySQLVersionRe.FindStringSubmatch(strings.ToUpper(v))
	if m == nil {
		return false
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	switch {
	case major != 8:
		return major > 8
	case minor > 0:
		return true
	case m[3] == "":
		return true
	}
	patch, _ := strconv.Atoi(m[3])
	return patch >= 21
}

// byoPostgresMajor is the Postgres major version the environment's database is created with: the
// configured version, or the catalogue's default for the provider when none is set (the template
// receives the same default), or on AWS cloud.DefaultAuroraPostgresVersion. ok=false when no version
// can be read, which the caller treats as below the floor.
func byoPostgresMajor(provider string, db types.ProjectDatabaseConfig) (int, bool) {
	v := strings.TrimSpace(db.EngineVersion)
	if v == "" {
		if e, ok := catalog.MustLoad().DBEngine(provider, "postgres"); ok {
			v = e.DefaultVersion
		}
	}
	if v == "" && provider == string(types.CloudProviderAws) {
		v = cloud.DefaultAuroraPostgresVersion
	}
	m := byoMajorVersionRe.FindString(v)
	if m == "" {
		return 0, false
	}
	n, err := strconv.Atoi(m)
	return n, err == nil
}

// declaredByoDBUsers is the set of per-binding users this deploy declares, sorted by user: every
// database binding with a credential facet in an add-on that is not a refused BYO chart, a keyless
// target excluded while the keyless flag is on, and a target other than the environment's primary
// database excluded (byoPrimaryDatabase says why). Postgres and MySQL targets are declared alike. It is the refusal-aware counterpart of cloud.ByoDBUserSecrets,
// read from the configuration alone, so a binding that fails later on this run is still declared.
// Namespaces are read as configureByoCharts left them (a moved chart is already in its own).
func declaredByoDBUsers(vc *types.ProjectConfig, keylessOn bool, refused []byoRefusal) []byoDeclaredDBUser {
	env := byoBindingOwner(vc)
	if env == "" {
		return nil
	}
	primary, ok := byoPrimaryDatabase(vc)
	if !ok {
		return nil
	}
	skip := byoRefusedIDs(refused)
	seen := map[string]bool{}
	var out []byoDeclaredDBUser
	for _, a := range vc.AddOns {
		if a.IsByo() && skip[a.ID] {
			continue
		}
		for _, w := range a.Workloads {
			for _, b := range w.Bindings {
				if b.Target.Kind != types.ServiceBindingKindDatabase || len(manifests.CredentialFacetNames(b)) == 0 {
					continue
				}
				if keylessOn && manifests.KeylessDBTarget(b.Target, vc.Databases) {
					continue
				}
				if b.Target.Name != primary {
					continue
				}
				user := manifests.ByoBindingDBUser(env, a.Namespace, w.Name, b.Target)
				if seen[user] {
					continue
				}
				seen[user] = true
				out = append(out, byoDeclaredDBUser{User: user, Key: manifests.ByoBindingDBSecretKey(env, a.Namespace, w.Name, b.Target)})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].User < out[j].User })
	return out
}

// stringOutputs keeps the string-valued tofu outputs.
func stringOutputs(outputs map[string]interface{}) map[string]string {
	out := make(map[string]string, len(outputs))
	for k, v := range outputs {
		if s, ok := v.(string); ok {
			out[k] = s
		}
	}
	return out
}

// runByoDBUsers runs this deploy's BYO users Job, when one is due, and returns what the binding lane
// may bind (see the file comment). It never returns an error: every failure is logged, provisions
// nothing, and, where a run was due, marks the outcome Failed.
func runByoDBUsers(ctx context.Context, in byoDBUsersInput, stdout, stderr io.Writer) (out byoDBUsersOutcome) {
	vc := in.VC
	if !byoDBUsersEnabled() || vc == nil {
		return out
	}
	owner := byoBindingOwner(vc)
	if owner == "" {
		return out // the resolver reports the facets: no environment ID, no user can be named
	}
	if reason := cloud.ByoDBUserSecretsUnavailableReason(vc); reason != "" {
		fmt.Fprintf(stdout, "BYO users Job: not run: %s\n", reason)
		out.Refusal = reason
		return out
	}
	db, ok := byoEnvDatabase(vc)
	if !ok {
		return out // no database: nothing this Job can provision
	}
	if in.Provider == string(types.CloudProviderAzure) && (db.IamAuth == nil || !*db.IamAuth) {
		fmt.Fprintf(stdout, "BYO users Job: not run: %s (database %q)\n", byoDBUsersAzurePasswordReason, db.Name)
		out.Refusal = byoDBUsersAzurePasswordReason
		return out
	}
	// The engine is read as the binding resolver reads it (the engine family), so the Job's dialect
	// and the resolver's — which decides what a `database` facet names — are one decision.
	engine := "postgres"
	switch mysql := byoTargetIsMySQL(vc.Databases, db.Name); {
	case !mysql && byoDatabaseIsMySQL(db):
		fmt.Fprintf(stdout, "BYO users Job: not run: %s (database %q, engine %q)\n", byoDBUsersEngineUnknownReason, db.Name, db.Engine)
		out.Refusal = byoDBUsersEngineUnknownReason
		return out
	case mysql:
		engine = "mysql"
		if !byoMySQLVersionOK(in.Provider, db) {
			fmt.Fprintf(stdout, "BYO users Job: not run: %s (database %q, version %q)\n", byoDBUsersMySQLFloorReason, db.Name, db.EngineVersion)
			out.Refusal = byoDBUsersMySQLFloorReason
			return out
		}
	default:
		if major, ok := byoPostgresMajor(in.Provider, db); !ok || major < byoDBUsersMinPostgresMajor {
			fmt.Fprintf(stdout, "BYO users Job: not run: %s (database %q, version %q)\n", byoDBUsersFloorReason, db.Name, db.EngineVersion)
			out.Refusal = byoDBUsersFloorReason
			return out
		}
	}

	// fail marks the run Failed. That provisions nothing, so on this deploy every BYO chart's
	// database credential facets are unsatisfied and its Values render WITHOUT the existingSecret
	// patch: a transient Job failure costs existing charts their database credential reference until
	// the next successful deploy (an availability cost, not only a binding not made). The binding
	// prune is skipped, so no live binding Secret is withdrawn; a chart that reads its Secret by a
	// name it already knows keeps working.
	fail := func(reason string) byoDBUsersOutcome {
		fmt.Fprintf(stderr, "Warning: BYO users Job: %s\n", reason)
		out.Failed = true
		out.Provisioned = nil
		out.Warnings = append(out.Warnings, byoDBUsersFailedWarning(reason))
		return out
	}

	// The declared set, and whether it is complete.
	keylessOn := keylessDBAuthEnabled()
	declared := declaredByoDBUsers(vc, keylessOn, in.Refused)
	names := customSecretNames(in.Outputs)
	var users []manifests.ByoDBUsersUser
	jobUsers := map[string]bool{}
	for _, d := range declared {
		if key := names[d.Key]; strings.TrimSpace(key) == "" || strings.ContainsAny(key, "\r\n") {
			fmt.Fprintf(stdout, "BYO users Job: user %s has no usable stored password; revocation is skipped on this deploy\n", d.User)
			out.SkipRevoke = true
			continue
		}
		users = append(users, manifests.ByoDBUsersUser{User: d.User, RemoteKey: names[d.Key]})
		jobUsers[d.User] = true
	}
	assumed := map[string]bool{}
	for _, d := range declared {
		assumed[d.User] = true
	}
	if n := byoBindingRenderFailuresFn(vc, in.Outputs, in.Provider, in.Refused, assumed); n > 0 {
		fmt.Fprintf(stdout, "BYO users Job: %d binding(s) failed to render; revocation is skipped on this deploy\n", n)
		out.SkipRevoke = true
	}

	job, err := manifests.RenderByoDBUsersJob(manifests.ByoDBUsersJobParams{
		Provider:        in.Provider,
		Engine:          engine,
		RunnerImage:     byoDBUsersRunnerImage(),
		Environment:     owner,
		Users:           users,
		SkipRevoke:      out.SkipRevoke,
		RunID:           byoDBUsersRunID(),
		Outputs:         stringOutputs(in.Outputs),
		NamespaceLabels: map[string]string{argocd.SecretStoreAccessLabel: argocd.SecretStoreAccessValue},
	})
	if err != nil {
		return fail(fmt.Sprintf("render failed: %v", err))
	}

	// The namespace is reserved for the platform (the platformByoDBUsers group of byo_reserved_namespaces.json),
	// and holds nothing but the runs' own objects. An object that is not one of them means that no
	// longer holds, so the run refuses before it touches anything.
	if foreign, err := foreignByoDBUsersObjects(ctx); err != nil {
		return fail(fmt.Sprintf("could not check namespace %s for objects that are not BYO users runs': %v", manifests.ByoDBUsersNamespace, err))
	} else if len(foreign) > 0 {
		return fail(fmt.Sprintf("namespace %s holds objects that are not BYO users runs' (%s), so the Job was not started and nothing there was changed",
			manifests.ByoDBUsersNamespace, strings.Join(foreign, ", ")))
	}

	active, err := sweepByoDBUsers(ctx, owner, stdout, stderr)
	if err != nil {
		return fail(fmt.Sprintf("the sweep of an earlier run's objects failed: %v", err))
	}
	if active != "" {
		return fail(fmt.Sprintf("an earlier BYO users Job of this environment (%s) is still running", active))
	}

	if _, err := byoDBUsersKubectl(ctx, job.NamespaceYAML, "apply", "-f", "-"); err != nil {
		return fail(fmt.Sprintf("could not create namespace %s: %v", manifests.ByoDBUsersNamespace, err))
	}
	// From here a credential object may exist, so the cleanup is deferred before the first apply
	// that creates one. It runs on every return below, whatever the outcome.
	defer func() {
		cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Minute)
		defer cancel()
		if in.Refresh != nil {
			if err := in.Refresh(cctx, "the BYO users cleanup"); err != nil {
				fmt.Fprintf(stderr, "Warning: BYO users Job: credential re-mint before cleanup failed: %v\n", err)
			}
		}
		cleanupByoDBUsers(cctx, owner, byoDBUsersRunObjects(job), stdout, stderr)
	}()

	// The CA ConfigMap goes with the credentials: the Job mounts it, and the cleanup removes it.
	objs := byoDBUsersRunObjects(job)
	docs := make([]string, 0, len(objs))
	for _, c := range objs {
		docs = append(docs, c.YAML)
	}
	if len(docs) > 0 {
		if _, err := byoDBUsersKubectl(ctx, strings.Join(docs, "---\n"), "apply", "-f", "-"); err != nil {
			return fail(fmt.Sprintf("could not apply its credential objects: %v", err))
		}
	}
	if _, err := byoDBUsersKubectl(ctx, job.JobYAML, "apply", "-f", "-"); err != nil {
		return fail(fmt.Sprintf("could not apply Job %s: %v", job.JobName, err))
	}
	fmt.Fprintf(stdout, "BYO users Job %s/%s: provisioning %d user(s)%s\n", manifests.ByoDBUsersNamespace, job.JobName, len(users),
		map[bool]string{true: ", revocation skipped (incomplete declared set)", false: ""}[out.SkipRevoke])

	jobUID, complete, err := waitByoDBUsersJob(ctx, job.JobName, in.Refresh, stdout)
	if err != nil {
		return fail(err.Error())
	}
	if !complete {
		return fail(fmt.Sprintf("Job %s failed (its pod log names the cause)", job.JobName))
	}
	msg, present, err := readByoDBUsersResult(ctx, job.JobName, jobUID)
	if err != nil {
		return fail(fmt.Sprintf("could not read Job %s's result: %v", job.JobName, err))
	}
	listed, pending, unended, doubts, err := parseByoDBUsersResultLines(msg, present)
	if err != nil {
		return fail(fmt.Sprintf("Job %s's result is malformed: %v", job.JobName, err))
	}
	out.Provisioned = map[string]bool{}
	for _, u := range listed {
		if !jobUsers[u] {
			fmt.Fprintf(stderr, "Warning: BYO users Job reported user %s, which this deploy did not declare; ignored\n", u)
			continue
		}
		out.Provisioned[u] = true
	}
	for _, u := range pending {
		fmt.Fprintf(stderr, "Warning: BYO users Job: revocation of %s is pending (locked out, not yet dropped)\n", u)
		out.Warnings = append(out.Warnings, byoDBUsersPendingWarning(u))
	}
	for _, u := range unended {
		fmt.Fprintf(stderr, "Warning: BYO users Job: any open session of revoked user %s was not terminated\n", u)
		out.Warnings = append(out.Warnings, byoDBUsersSessionsWarning(u))
	}
	for _, d := range doubts {
		fmt.Fprintf(stderr, "Warning: BYO users Job: %s\n", d)
		out.Warnings = append(out.Warnings, byoDBUsersDoubtWarning(d))
	}
	fmt.Fprintf(stdout, "BYO users Job %s: %d of %d user(s) provisioned\n", job.JobName, len(out.Provisioned), len(users))
	return out
}

// byoDBUsersRunObjects are the objects a run applies before its Job and deletes after it: its
// credentials and, when rendered, the CA ConfigMap the Job verifies the database server against.
func byoDBUsersRunObjects(job manifests.ByoDBUsersJob) []manifests.ByoDBUsersObject {
	objs := append([]manifests.ByoDBUsersObject(nil), job.Credentials...)
	if job.CAConfigMap.YAML != "" {
		objs = append(objs, job.CAConfigMap)
	}
	return objs
}

// byoDBUsersSelector selects the run objects of one environment.
func byoDBUsersSelector(owner string) string {
	return manifests.ByoDBUsersLabel + "=" + manifests.ByoDBUsersLabelValue + "," + manifests.ByoDBUsersOwnerLabel + "=" + owner
}

// byoDBUsersOwnerRe is the shape an owner label value must have before it reaches a selector.
var byoDBUsersOwnerRe = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$`)

// byoDBUsersObject is the part of a listed object a run reads.
type byoDBUsersObject struct {
	APIVersion string `json:"apiVersion"`
	Metadata   struct {
		Name            string            `json:"name"`
		Namespace       string            `json:"namespace"`
		UID             string            `json:"uid"`
		Labels          map[string]string `json:"labels"`
		OwnerReferences []struct {
			UID string `json:"uid"`
		} `json:"ownerReferences"`
	} `json:"metadata"`
	Status struct {
		Active     int    `json:"active"`
		Phase      string `json:"phase"`
		Conditions []struct {
			Type   string `json:"type"`
			Status string `json:"status"`
		} `json:"conditions"`
		ContainerStatuses []struct {
			Name  string `json:"name"`
			State struct {
				Terminated *struct {
					ExitCode int     `json:"exitCode"`
					Message  *string `json:"message"`
				} `json:"terminated"`
			} `json:"state"`
		} `json:"containerStatuses"`
	} `json:"status"`
}

// ownedByRun reports whether a listed object is one of this environment's run objects in the run
// namespace: both labels re-checked on the object itself, never trusted from the selector alone,
// and a name and uid of the shape a path may carry.
func (o byoDBUsersObject) ownedByRun(owner string) bool {
	m := o.Metadata
	return owner != "" &&
		m.Namespace == manifests.ByoDBUsersNamespace &&
		m.Labels[manifests.ByoDBUsersLabel] == manifests.ByoDBUsersLabelValue &&
		m.Labels[manifests.ByoDBUsersOwnerLabel] == owner &&
		reapNameRE.MatchString(m.Name) && reapUIDRE.MatchString(m.UID)
}

// jobFinished reports a Job's terminal condition: complete or failed. done=false while it runs.
func (o byoDBUsersObject) jobFinished() (done, complete bool) {
	for _, c := range o.Status.Conditions {
		if c.Status != "True" {
			continue
		}
		switch c.Type {
		case "Complete":
			return true, true
		case "Failed":
			return true, false
		}
	}
	return false, false
}

// byoDBUsersCredentialKinds are the kinds a run's credentials take, plus its CA ConfigMap: the
// sweep's only kinds.
var byoDBUsersCredentialKinds = []struct {
	resource string
	path     func(apiVersion, name string) string
}{
	{"externalsecrets.external-secrets.io", func(apiVersion, name string) string {
		return "/apis/" + apiVersion + "/namespaces/" + manifests.ByoDBUsersNamespace + "/externalsecrets/" + name
	}},
	{"secrets", func(_, name string) string {
		return "/api/v1/namespaces/" + manifests.ByoDBUsersNamespace + "/secrets/" + name
	}},
	{"serviceaccounts", func(_, name string) string {
		return "/api/v1/namespaces/" + manifests.ByoDBUsersNamespace + "/serviceaccounts/" + name
	}},
	// Not a credential: the CA set the Job verifies the database server against. Listed so the
	// sweep removes one an interrupted run left, as it removes that run's credentials.
	{"configmaps", func(_, name string) string {
		return "/api/v1/namespaces/" + manifests.ByoDBUsersNamespace + "/configmaps/" + name
	}},
}

// byoDBUsersPath is the delete path of a run object of resource.
func byoDBUsersPath(resource, apiVersion, name string) string {
	for _, k := range byoDBUsersCredentialKinds {
		if k.resource == resource {
			return k.path(apiVersion, name)
		}
	}
	return ""
}

// byoDBUsersESAPIVersionRe bounds the apiVersion a listed ExternalSecret's delete path is built from.
var byoDBUsersESAPIVersionRe = regexp.MustCompile(`^external-secrets\.io/v[0-9a-z]+$`)

// listByoDBUsers lists one resource of this environment's run objects.
func listByoDBUsers(ctx context.Context, resource, owner string) ([]byoDBUsersObject, error) {
	raw, err := byoDBUsersKubectl(ctx, "", "get", resource, "-n", manifests.ByoDBUsersNamespace, "-l", byoDBUsersSelector(owner), "-o", "json")
	if err != nil {
		return nil, fmt.Errorf("list %s: %w", resource, err)
	}
	var list struct {
		Items []byoDBUsersObject `json:"items"`
	}
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return nil, fmt.Errorf("parse the %s list: %w", resource, err)
	}
	return list.Items, nil
}

// deleteByoDBUsersObject requests deletion of one run object, pinned to its uid, with Foreground
// propagation, so an ExternalSecret's owned Secret is removed before it.
func deleteByoDBUsersObject(ctx context.Context, resource string, obj byoDBUsersObject) error {
	apiVersion := obj.APIVersion
	if resource == byoDBUsersCredentialKinds[0].resource && !byoDBUsersESAPIVersionRe.MatchString(apiVersion) {
		return fmt.Errorf("%s %s: unexpected apiVersion %q", resource, obj.Metadata.Name, apiVersion)
	}
	opts := fmt.Sprintf(`{"kind":"DeleteOptions","apiVersion":"v1","propagationPolicy":"Foreground","preconditions":{"uid":%q}}`, obj.Metadata.UID)
	_, err := byoDBUsersKubectl(ctx, opts, "delete", "--raw", byoDBUsersPath(resource, apiVersion, obj.Metadata.Name), "-f", "-")
	return err
}

// getByoDBUsersObject reads one object of resource by name; ok=false when it does not exist.
func getByoDBUsersObject(ctx context.Context, resource, name string) (byoDBUsersObject, bool, error) {
	raw, err := byoDBUsersKubectl(ctx, "", "get", resource, name, "-n", manifests.ByoDBUsersNamespace, "--ignore-not-found", "-o", "json")
	if err != nil {
		return byoDBUsersObject{}, false, err
	}
	if strings.TrimSpace(raw) == "" {
		return byoDBUsersObject{}, false, nil
	}
	var obj byoDBUsersObject
	if err := json.Unmarshal([]byte(raw), &obj); err != nil {
		return byoDBUsersObject{}, false, fmt.Errorf("parse %s %s: %w", resource, name, err)
	}
	return obj, true, nil
}

// sweepByoDBUsers removes what an interrupted earlier run of this environment left behind, before a
// new run applies anything. It returns the name of a still-active Job of this environment, in which
// case it deleted nothing; an error means the run must not start. Every read precedes every delete.
func sweepByoDBUsers(ctx context.Context, owner string, stdout, stderr io.Writer) (string, error) {
	if !byoDBUsersOwnerRe.MatchString(owner) {
		return "", fmt.Errorf("owner %q is not a label value", owner)
	}
	jobs, err := listByoDBUsers(ctx, "jobs.batch", owner)
	if err != nil {
		return "", err
	}
	for _, j := range jobs {
		if !j.ownedByRun(owner) {
			continue
		}
		if done, _ := j.jobFinished(); !done || j.Status.Active > 0 {
			return j.Metadata.Name, nil
		}
	}
	type candidate struct {
		resource string
		obj      byoDBUsersObject
	}
	var found []candidate
	for _, k := range byoDBUsersCredentialKinds {
		items, err := listByoDBUsers(ctx, k.resource, owner)
		if err != nil {
			return "", err
		}
		for _, obj := range items {
			if !obj.ownedByRun(owner) {
				fmt.Fprintf(stderr, "Warning: BYO users sweep: %s %q skipped: it does not carry both labels of this environment's runs\n", k.resource, obj.Metadata.Name)
				continue
			}
			found = append(found, candidate{k.resource, obj})
		}
	}
	for _, c := range found {
		if err := deleteByoDBUsersObject(ctx, c.resource, c.obj); err != nil {
			return "", fmt.Errorf("delete %s %s: %w", c.resource, c.obj.Metadata.Name, err)
		}
		fmt.Fprintf(stdout, "BYO users sweep: deletion requested for %s %s/%s, left by an interrupted run\n", c.resource, manifests.ByoDBUsersNamespace, c.obj.Metadata.Name)
	}
	// Foreground deletion keeps an object until its dependents are gone; the new run reuses the
	// names, so it waits until each swept object is gone (or replaced by another uid).
	deadline := byoDBUsersNow().Add(byoDBUsersGoneWait)
	for _, c := range found {
		for {
			obj, exists, err := getByoDBUsersObject(ctx, c.resource, c.obj.Metadata.Name)
			if err != nil {
				return "", err
			}
			if !exists || obj.Metadata.UID != c.obj.Metadata.UID {
				break
			}
			if byoDBUsersNow().After(deadline) {
				return "", fmt.Errorf("%s %s is still being deleted", c.resource, c.obj.Metadata.Name)
			}
			if err := byoDBUsersSleep(ctx, byoDBUsersPollInterval); err != nil {
				return "", err
			}
		}
	}
	return "", nil
}

// cleanupByoDBUsers deletes every credential object of a run that still exists: each is read back
// by name, held to both labels, and deleted pinned to the uid it was read with, Foreground. It is
// best-effort per object — one failure is logged and the rest are still deleted — and whatever it
// cannot delete is the next run's sweep's.
func cleanupByoDBUsers(ctx context.Context, owner string, creds []manifests.ByoDBUsersObject, stdout, stderr io.Writer) {
	for _, c := range creds {
		obj, exists, err := getByoDBUsersObject(ctx, c.Resource, c.Name)
		if err != nil {
			fmt.Fprintf(stderr, "Warning: BYO users cleanup: could not read %s %s (the next deploy's sweep removes it): %v\n", c.Resource, c.Name, err)
			continue
		}
		if !exists {
			continue
		}
		if !obj.ownedByRun(owner) {
			fmt.Fprintf(stderr, "Warning: BYO users cleanup: %s %s skipped: it does not carry both labels of this environment's runs\n", c.Resource, c.Name)
			continue
		}
		if err := deleteByoDBUsersObject(ctx, c.Resource, obj); err != nil {
			fmt.Fprintf(stderr, "Warning: BYO users cleanup: could not delete %s %s (the next deploy's sweep removes it): %v\n", c.Resource, c.Name, err)
			continue
		}
		fmt.Fprintf(stdout, "BYO users cleanup: deletion requested for %s %s/%s\n", c.Resource, manifests.ByoDBUsersNamespace, c.Name)
	}
}

// waitByoDBUsersJob waits for the Job to finish, bounded by its deadline plus a grace, and returns
// its uid and whether it completed. An error means the outcome is unknown.
func waitByoDBUsersJob(ctx context.Context, name string, refresh func(context.Context, string) error, stdout io.Writer) (string, bool, error) {
	start := byoDBUsersNow()
	deadline := start.Add(time.Duration(manifests.ByoDBUsersDeadlineSeconds)*time.Second + byoDBUsersWaitGrace)
	lastRefresh := start
	var lastErr error
	for {
		if refresh != nil && byoDBUsersNow().Sub(lastRefresh) >= byoDBUsersRefreshEvery {
			if err := refresh(ctx, "the BYO users Job wait"); err != nil {
				return "", false, fmt.Errorf("credential re-mint during the wait failed: %w", err)
			}
			lastRefresh = byoDBUsersNow()
		}
		job, exists, err := getByoDBUsersObject(ctx, "jobs.batch", name)
		switch {
		case err != nil:
			lastErr = err
		case !exists:
			return "", false, fmt.Errorf("Job %s disappeared before it finished", name)
		default:
			if done, complete := job.jobFinished(); done {
				return job.Metadata.UID, complete, nil
			}
		}
		if byoDBUsersNow().After(deadline) {
			if lastErr != nil {
				return "", false, fmt.Errorf("Job %s did not finish within its deadline (last read error: %v)", name, lastErr)
			}
			return "", false, fmt.Errorf("Job %s did not finish within its deadline", name)
		}
		if err := byoDBUsersSleep(ctx, byoDBUsersPollInterval); err != nil {
			return "", false, fmt.Errorf("the wait for Job %s was interrupted: %w", name, err)
		}
	}
}

// readByoDBUsersResult reads the result of a Complete Job: the termination message of the main
// container of its one Succeeded pod, through the API. A pod is the Job's only when its owner
// reference names the Job's uid. No succeeded pod, two of them, or a main container with no
// terminated state or a non-zero exit is an error. present=false when the message field is absent:
// the API server omits an empty message (ContainerStateTerminated.Message is omitempty, and the
// kubelet reports a zero-length termination file as no message), so absence is a value, not an error,
// and parseByoDBUsersResult decides what it means.
func readByoDBUsersResult(ctx context.Context, jobName, jobUID string) (string, bool, error) {
	raw, err := byoDBUsersKubectl(ctx, "", "get", "pods", "-n", manifests.ByoDBUsersNamespace, "-l", "job-name="+jobName, "-o", "json")
	if err != nil {
		return "", false, fmt.Errorf("list the Job's pods: %w", err)
	}
	var list struct {
		Items []byoDBUsersObject `json:"items"`
	}
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return "", false, fmt.Errorf("parse the Job's pods: %w", err)
	}
	var succeeded []byoDBUsersObject
	for _, p := range list.Items {
		owned := false
		for _, ref := range p.Metadata.OwnerReferences {
			if jobUID != "" && ref.UID == jobUID {
				owned = true
			}
		}
		if owned && p.Status.Phase == "Succeeded" {
			succeeded = append(succeeded, p)
		}
	}
	if len(succeeded) != 1 {
		return "", false, fmt.Errorf("%d succeeded pod(s) of the Job, want exactly 1", len(succeeded))
	}
	for _, cs := range succeeded[0].Status.ContainerStatuses {
		if cs.Name != manifests.ByoDBUsersMainContainer {
			continue
		}
		t := cs.State.Terminated
		if t == nil || t.ExitCode != 0 {
			return "", false, fmt.Errorf("container %s did not terminate successfully", cs.Name)
		}
		if t.Message == nil {
			return "", false, nil
		}
		return *t.Message, true, nil
	}
	return "", false, fmt.Errorf("the Job's pod has no %s container status", manifests.ByoDBUsersMainContainer)
}

// byoDBUsersResultHeader starts the first line of every result db-bootstrap writes
// (apps/runner db_bootstrap_byo.go byoResultHeaderPrefix): `alethia-byo-users v1 count=<n>`, then
// exactly n entries.
const byoDBUsersResultHeader = "alethia-byo-users v1 count="

// byoDBUsersHeaderRe is the header line with its count.
var byoDBUsersHeaderRe = regexp.MustCompile(`^` + regexp.QuoteMeta(byoDBUsersResultHeader) + `(0|[1-9][0-9]{0,5})$`)

// errByoDBUsersResultLost is the named reason for a Complete Job with no termination message. The
// header is written on every run, even with nothing declared and with --skip-revoke, so an absent
// message means the result was lost, never "nothing listed".
var errByoDBUsersResultLost = errors.New("result lost: the Job completed but left no termination message")

// errByoDBUsersTruncated is the named reason for a result without its header. The kubelet keeps the
// LAST 4096 bytes of a termination file, so a result too long for it loses its header line first.
var errByoDBUsersTruncated = errors.New("result truncated: too many users for one Job (its header line is missing)")

// parseByoDBUsersResult parses a termination message strictly. The first line is the header, and
// exactly the counted number of entries follow, each a per-binding user (provisioned),
// `revocation-pending:<user>`, `sessions-not-ended:<user>` or a doubt (byoDBUsersDoubtRe), with one
// trailing newline allowed. A missing header (truncation), a
// count that does not match, any other line, an empty line, a carriage return or a repeated entry
// makes the whole message malformed, so nothing in it is trusted.
//
// An ABSENT message (present=false, or empty) is never "nothing listed": db-bootstrap writes the
// header on every run, so "nothing declared" arrives as `count=0`, and an absent message means the
// result was lost (errByoDBUsersResultLost), whatever was declared.
func parseByoDBUsersResult(msg string, present bool) (users, pending []string, err error) {
	users, pending, _, _, err = parseByoDBUsersResultLines(msg, present)
	return users, pending, err
}

// parseByoDBUsersResultLines is parseByoDBUsersResult that also returns the revoked users whose
// sessions were not ended (unended) and the doubt lines, verbatim (doubts).
func parseByoDBUsersResultLines(msg string, present bool) (users, pending, unended, doubts []string, err error) {
	if !present || msg == "" {
		return nil, nil, nil, nil, errByoDBUsersResultLost
	}
	lines := strings.Split(strings.TrimSuffix(msg, "\n"), "\n")
	m := byoDBUsersHeaderRe.FindStringSubmatch(lines[0])
	if m == nil {
		return nil, nil, nil, nil, errByoDBUsersTruncated
	}
	count, _ := strconv.Atoi(m[1])
	entries := lines[1:]
	if len(entries) != count {
		return nil, nil, nil, nil, fmt.Errorf("the header counts %d entries, the result carries %d", count, len(entries))
	}
	seen := map[string]bool{}
	for i, line := range entries {
		if seen[line] {
			return nil, nil, nil, nil, fmt.Errorf("line %d repeats an entry", i+2)
		}
		seen[line] = true
		switch {
		case byoDBUsersUserRe.MatchString(line):
			users = append(users, line)
		case strings.HasPrefix(line, byoDBUsersPendingPrefix) && byoDBUsersUserRe.MatchString(strings.TrimPrefix(line, byoDBUsersPendingPrefix)):
			pending = append(pending, strings.TrimPrefix(line, byoDBUsersPendingPrefix))
		case strings.HasPrefix(line, byoDBUsersSessionsPrefix) && byoDBUsersUserRe.MatchString(strings.TrimPrefix(line, byoDBUsersSessionsPrefix)):
			unended = append(unended, strings.TrimPrefix(line, byoDBUsersSessionsPrefix))
		case byoDBUsersDoubtRe.MatchString(line):
			doubts = append(doubts, line)
		default:
			return nil, nil, nil, nil, fmt.Errorf("line %d is neither a user, a pending revocation, a session report nor a doubt", i+2)
		}
	}
	return users, pending, unended, doubts, nil
}

// byoDBUsersForeignKinds are the kinds the namespace check lists: every workload kind, plus the kinds
// a run's objects take and the two the API server creates in every namespace.
const byoDBUsersForeignKinds = "pods,deployments.apps,statefulsets.apps,daemonsets.apps,replicasets.apps,jobs.batch,cronjobs.batch," +
	"services,configmaps,secrets,serviceaccounts,externalsecrets.external-secrets.io"

// byoDBUsersForeignObject is the part of a listed object the namespace check reads.
type byoDBUsersForeignObject struct {
	Kind     string `json:"kind"`
	Metadata struct {
		Name            string            `json:"name"`
		Labels          map[string]string `json:"labels"`
		UID             string            `json:"uid"`
		OwnerReferences []struct {
			Kind string `json:"kind"`
			UID  string `json:"uid"`
		} `json:"ownerReferences"`
	} `json:"metadata"`
}

// labelled reports whether the object carries the run label and an owner label of the right shape.
func (o byoDBUsersForeignObject) labelled() bool {
	m := o.Metadata
	return m.Labels[manifests.ByoDBUsersLabel] == manifests.ByoDBUsersLabelValue && byoDBUsersOwnerRe.MatchString(m.Labels[manifests.ByoDBUsersOwnerLabel])
}

// isRunObject reports whether one listed object is a BYO users run's — of any environment the
// cluster hosts, since the namespace is shared — or one the API server creates in every namespace.
// A run object is a Job, ExternalSecret, Secret, ServiceAccount or ConfigMap carrying the run label and an
// owner label, or a Pod carrying both whose owner reference is the uid of a run Job listed in the
// same namespace (runJobs) — a name or kind alone proves nothing. Nothing else belongs there.
func (o byoDBUsersForeignObject) isRunObject(runJobs map[string]bool) bool {
	m := o.Metadata
	switch {
	case o.Kind == "ServiceAccount" && m.Name == "default", o.Kind == "ConfigMap" && m.Name == "kube-root-ca.crt":
		return true
	}
	switch o.Kind {
	case "Job", "ExternalSecret", "Secret", "ServiceAccount", "ConfigMap":
		return o.labelled()
	case "Pod":
		for _, ref := range m.OwnerReferences {
			if ref.Kind == "Job" && ref.UID != "" && runJobs[ref.UID] {
				return o.labelled()
			}
		}
	}
	return false
}

// foreignByoDBUsersObjects lists the objects in the BYO users namespace that are not a run's, as
// "Kind/name". Read-only; an absent namespace lists nothing.
func foreignByoDBUsersObjects(ctx context.Context) ([]string, error) {
	raw, err := byoDBUsersKubectl(ctx, "", "get", byoDBUsersForeignKinds, "-n", manifests.ByoDBUsersNamespace, "-o", "json")
	if err != nil {
		return nil, err
	}
	var list struct {
		Items []byoDBUsersForeignObject `json:"items"`
	}
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return nil, fmt.Errorf("parse the namespace's objects: %w", err)
	}
	runJobs := map[string]bool{}
	for _, o := range list.Items {
		if o.Kind == "Job" && o.labelled() && o.Metadata.UID != "" {
			runJobs[o.Metadata.UID] = true
		}
	}
	var out []string
	for _, o := range list.Items {
		if !o.isRunObject(runJobs) {
			out = append(out, o.Kind+"/"+o.Metadata.Name)
		}
	}
	sort.Strings(out)
	return out, nil
}
