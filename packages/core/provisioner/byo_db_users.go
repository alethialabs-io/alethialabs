// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// This file runs the BYO users Job (docs/adr/byo-binding-db-users.md §3, slice 4 of #6438) on each
// deploy with ALETHIA_BYO_DB_USERS_ENABLED, and decides from its result which per-binding database
// users a BYO chart may be bound to.
//
// # One run, in order
//
//  1. Decide whether a run can happen at all. No environment ID, a credential-based secrets provider
//     (cloud.ByoDBUserSecretsUnavailableReason), no database, a MySQL database, or a Postgres older
//     than 15 runs nothing. The last two of those, and the secrets provider, give every per-binding
//     database credential facet a stated reason; none of them ever falls back to the administrative
//     credential.
//  2. Take the declared users from the refusal-aware binding set (declaredByoDBUsers), and decide
//     whether that set is complete. It is not when a declared user has no stored password, or when a
//     binding of the environment fails to render. An incomplete set runs with `--skip-revoke`, so a
//     binding that is still declared is never read as removed.
//  3. Sweep what an interrupted earlier run left (sweepByoDBUsers): only ByoDBUsersNamespace, only
//     ExternalSecrets, Secrets and ServiceAccounts, only objects carrying BOTH the run label and this
//     environment's owner label, each re-checked and deleted pinned to its uid. While a Job of this
//     environment is still active the sweep stands down, and no second Job is started.
//  4. Apply the namespace, then — from the moment a credential object may exist — a deferred cleanup
//     that deletes every credential object of the run, uid-pinned with Foreground propagation, so
//     each owned Secret goes first. A render, apply, wait or read error cannot skip it. The Job
//     itself holds no credential and is left to its TTL, so a failed run's logs stay readable.
//  5. Wait for Complete or Failed, bounded by the Job's own deadline, and read the main container's
//     termination message through the API (never logs). A user counts as provisioned only when the
//     Job is Complete, the message names the user, and the user is in the set this run declared.
//     Anything else provisions nothing, and is a binding failure, so the binding prune is skipped.
//     A `revocation-pending:<user>` line is surfaced as a deploy warning and is NOT a failure.
package provisioner

import (
	"context"
	"encoding/json"
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

// byoDBUsersPendingPrefix starts a result line naming a revocation the Job could not finish
// (apps/runner db_bootstrap_byo.go byoPendingPrefix).
const byoDBUsersPendingPrefix = "revocation-pending:"

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

// byoDBUsersPendingWarning is the Deploy-tab warning for one revocation the Job could not finish.
func byoDBUsersPendingWarning(user string) string {
	return fmt.Sprintf("Database user %s belongs to a bring-your-own binding that was removed, and could not be dropped on this deploy. "+
		"It can no longer log in, but it still exists and still owns its objects. The next deploy tries the drop again.", user)
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
// target excluded while the keyless flag is on, and a MySQL target excluded (that dialect is a later
// slice, and the resolver refuses it). It is the refusal-aware counterpart of cloud.ByoDBUserSecrets,
// read from the configuration alone, so a binding that fails later on this run is still declared.
// Namespaces are read as configureByoCharts left them (a moved chart is already in its own).
func declaredByoDBUsers(vc *types.ProjectConfig, keylessOn bool, refused []byoRefusal) []byoDeclaredDBUser {
	env := byoBindingOwner(vc)
	if env == "" {
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
				if byoTargetIsMySQL(vc.Databases, b.Target.Name) {
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
	if !ok || byoDatabaseIsMySQL(db) {
		return out // no Postgres database: nothing this Job can provision (MySQL is a later slice)
	}
	if major, ok := byoPostgresMajor(in.Provider, db); !ok || major < byoDBUsersMinPostgresMajor {
		fmt.Fprintf(stdout, "BYO users Job: not run: %s (database %q, version %q)\n", byoDBUsersFloorReason, db.Name, db.EngineVersion)
		out.Refusal = byoDBUsersFloorReason
		return out
	}

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
		cleanupByoDBUsers(cctx, owner, job.Credentials, stdout, stderr)
	}()

	docs := make([]string, 0, len(job.Credentials))
	for _, c := range job.Credentials {
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
	msg, err := readByoDBUsersResult(ctx, job.JobName, jobUID)
	if err != nil {
		return fail(fmt.Sprintf("could not read Job %s's result: %v", job.JobName, err))
	}
	listed, pending, err := parseByoDBUsersResult(msg)
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
	fmt.Fprintf(stdout, "BYO users Job %s: %d of %d user(s) provisioned\n", job.JobName, len(out.Provisioned), len(users))
	return out
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

// byoDBUsersCredentialKinds are the kinds a run's credentials take, and the sweep's only kinds.
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
// terminated state, a non-zero exit or no message field is an error, never an empty result.
func readByoDBUsersResult(ctx context.Context, jobName, jobUID string) (string, error) {
	raw, err := byoDBUsersKubectl(ctx, "", "get", "pods", "-n", manifests.ByoDBUsersNamespace, "-l", "job-name="+jobName, "-o", "json")
	if err != nil {
		return "", fmt.Errorf("list the Job's pods: %w", err)
	}
	var list struct {
		Items []byoDBUsersObject `json:"items"`
	}
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return "", fmt.Errorf("parse the Job's pods: %w", err)
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
		return "", fmt.Errorf("%d succeeded pod(s) of the Job, want exactly 1", len(succeeded))
	}
	for _, cs := range succeeded[0].Status.ContainerStatuses {
		if cs.Name != manifests.ByoDBUsersMainContainer {
			continue
		}
		t := cs.State.Terminated
		if t == nil || t.ExitCode != 0 || t.Message == nil {
			return "", fmt.Errorf("container %s has no successful termination message", cs.Name)
		}
		return *t.Message, nil
	}
	return "", fmt.Errorf("the Job's pod has no %s container status", manifests.ByoDBUsersMainContainer)
}

// parseByoDBUsersResult parses a termination message strictly: one line per entry, each either a
// per-binding user (provisioned) or `revocation-pending:<user>`, with one trailing newline allowed.
// Any other line, an empty line, a carriage return or a repeated entry makes the whole message
// malformed, so nothing in it is trusted.
func parseByoDBUsersResult(msg string) (users, pending []string, err error) {
	if msg == "" {
		return nil, nil, nil
	}
	body := strings.TrimSuffix(msg, "\n")
	seen := map[string]bool{}
	for i, line := range strings.Split(body, "\n") {
		if seen[line] {
			return nil, nil, fmt.Errorf("line %d repeats an entry", i+1)
		}
		seen[line] = true
		switch {
		case byoDBUsersUserRe.MatchString(line):
			users = append(users, line)
		case strings.HasPrefix(line, byoDBUsersPendingPrefix) && byoDBUsersUserRe.MatchString(strings.TrimPrefix(line, byoDBUsersPendingPrefix)):
			pending = append(pending, strings.TrimPrefix(line, byoDBUsersPendingPrefix))
		default:
			return nil, nil, fmt.Errorf("line %d is neither a user nor a pending revocation", i+1)
		}
	}
	return users, pending, nil
}
