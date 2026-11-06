// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"gopkg.in/yaml.v3"
)

// usersCluster is an in-memory stand-in for the API server as the BYO users run uses it.
type usersCluster struct {
	mu sync.Mutex
	t  *testing.T
	// objects by "resource/name" in the run namespace: the decoded JSON of each object.
	objects map[string]map[string]any
	// seeded are listed by the sweep's label selector as the cluster returns them — the selector is
	// the API server's, so a seeded object that would not match is still returned, to prove the
	// re-check.
	seeded map[string][]map[string]any
	calls  []string
	// jobOutcome is the condition a created Job reaches: "Complete", "Failed" or "" (never).
	jobOutcome string
	// message is the main container's termination message; nil means no message field.
	message *string
	// jobGetErr makes every read of a Job fail.
	jobGetErr bool
	// foreign are the namespace's objects the pre-run check lists, beyond the run's own.
	foreign []map[string]any
	// applyApplied is every document applied.
	applied []map[string]any
	uid     int
}

// newUsersCluster installs the stand-in and fast timings for one test.
func newUsersCluster(t *testing.T) *usersCluster {
	t.Helper()
	c := &usersCluster{t: t, objects: map[string]map[string]any{}, seeded: map[string][]map[string]any{}, jobOutcome: "Complete"}
	origK, origSleep, origNow, origRun, origImg, origPoll, origGone := byoDBUsersKubectl, byoDBUsersSleep, byoDBUsersNow, byoDBUsersRunID, byoDBUsersRunnerImage, byoDBUsersPollInterval, byoDBUsersGoneWait
	t.Cleanup(func() {
		byoDBUsersKubectl, byoDBUsersSleep, byoDBUsersNow, byoDBUsersRunID, byoDBUsersRunnerImage, byoDBUsersPollInterval, byoDBUsersGoneWait = origK, origSleep, origNow, origRun, origImg, origPoll, origGone
	})
	clock := time.Unix(1_800_000_000, 0)
	byoDBUsersNow = func() time.Time { return clock }
	byoDBUsersSleep = func(_ context.Context, d time.Duration) error { clock = clock.Add(d); return nil }
	byoDBUsersRunID = func() string { return "r1" }
	byoDBUsersRunnerImage = func() string { return "ghcr.io/alethia/runner:1" }
	byoDBUsersKubectl = c.kubectl
	return c
}

// resourceOf maps a kind to the kubectl resource the run uses.
func resourceOf(kind string) string {
	return map[string]string{"ExternalSecret": "externalsecrets.external-secrets.io", "ServiceAccount": "serviceaccounts",
		"Job": "jobs.batch", "Namespace": "namespaces", "Secret": "secrets"}[kind]
}

// seed puts a leftover object in the cluster, returned by the sweep's list of resource.
func (c *usersCluster) seed(resource, name, owner string, runLabel bool) {
	labels := map[string]any{}
	if owner != "" {
		labels[manifests.ByoDBUsersOwnerLabel] = owner
	}
	if runLabel {
		labels[manifests.ByoDBUsersLabel] = "true"
	}
	c.uid++
	obj := map[string]any{"apiVersion": "external-secrets.io/v1beta1", "metadata": map[string]any{
		"name": name, "namespace": manifests.ByoDBUsersNamespace, "uid": fmt.Sprintf("00000000-0000-0000-0000-%012d", c.uid), "labels": labels}}
	if resource != "externalsecrets.external-secrets.io" {
		obj["apiVersion"] = "v1"
	}
	if resource == "jobs.batch" {
		obj["apiVersion"] = "batch/v1"
	}
	c.seeded[resource] = append(c.seeded[resource], obj)
	c.objects[resource+"/"+name] = obj
}

// kubectl answers one call.
func (c *usersCluster) kubectl(_ context.Context, stdin string, args ...string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	call := strings.Join(args, " ")
	if stdin != "" && args[0] == "delete" {
		call += " <" + stdin
	}
	c.calls = append(c.calls, call)
	switch {
	case args[0] == "apply":
		dec := yaml.NewDecoder(strings.NewReader(stdin))
		for {
			var doc map[string]any
			if err := dec.Decode(&doc); err != nil {
				if errors.Is(err, io.EOF) {
					break
				}
				return "", err
			}
			if doc == nil {
				continue
			}
			c.applied = append(c.applied, doc)
			kind, _ := doc["kind"].(string)
			meta, _ := doc["metadata"].(map[string]any)
			c.uid++
			meta["uid"] = fmt.Sprintf("10000000-0000-0000-0000-%012d", c.uid)
			if kind == "Job" && c.jobOutcome != "" {
				doc["status"] = map[string]any{"conditions": []any{map[string]any{"type": c.jobOutcome, "status": "True"}}}
			}
			name, _ := meta["name"].(string)
			c.objects[resourceOf(kind)+"/"+name] = doc
		}
		return "applied", nil
	case args[0] == "get" && args[1] == "pods":
		job := c.objects["jobs.batch/"+manifests.ByoDBUsersBaseName("env-1")+"-r1"]
		uid := ""
		if job != nil {
			uid, _ = job["metadata"].(map[string]any)["uid"].(string)
		}
		term := map[string]any{"exitCode": 0}
		// The API server omits an empty message (ContainerStateTerminated.Message is omitempty).
		if c.message != nil && *c.message != "" {
			term["message"] = *c.message
		}
		pod := map[string]any{
			"metadata": map[string]any{"name": "p", "ownerReferences": []any{map[string]any{"uid": uid}}},
			"status": map[string]any{"phase": "Succeeded", "containerStatuses": []any{
				map[string]any{"name": manifests.ByoDBUsersMainContainer, "state": map[string]any{"terminated": term}}}},
		}
		b, _ := json.Marshal(map[string]any{"items": []any{pod}})
		return string(b), nil
	case args[0] == "get" && strings.Contains(args[1], ","):
		b, _ := json.Marshal(map[string]any{"items": c.foreign})
		return string(b), nil
	case args[0] == "get" && len(args) > 3 && args[2] == "-n" && args[4] == "-l":
		b, _ := json.Marshal(map[string]any{"items": c.seeded[args[1]]})
		return string(b), nil
	case args[0] == "get":
		if args[1] == "jobs.batch" && c.jobGetErr {
			return "", errors.New("the server is unreachable")
		}
		obj := c.objects[args[1]+"/"+args[2]]
		if obj == nil {
			return "", nil
		}
		b, _ := json.Marshal(obj)
		return string(b), nil
	case args[0] == "delete":
		path := args[2]
		for key, obj := range c.objects {
			name := key[strings.Index(key, "/")+1:]
			if strings.HasSuffix(path, "/"+name) {
				uid, _ := obj["metadata"].(map[string]any)["uid"].(string)
				if !strings.Contains(stdin, uid) {
					return "", errors.New("precondition failed: uid")
				}
				delete(c.objects, key)
			}
		}
		for res, items := range c.seeded {
			var kept []map[string]any
			for _, o := range items {
				if !strings.HasSuffix(path, "/"+o["metadata"].(map[string]any)["name"].(string)) {
					kept = append(kept, o)
				}
			}
			c.seeded[res] = kept
		}
		return "", nil
	}
	return "", nil
}

// deletes are the delete calls made.
func (c *usersCluster) deletes() []string {
	var out []string
	for _, call := range c.calls {
		if strings.HasPrefix(call, "delete") {
			out = append(out, call)
		}
	}
	return out
}

// appliedJob is the applied Job document, or nil.
func (c *usersCluster) appliedJob() map[string]any {
	for _, d := range c.applied {
		if d["kind"] == "Job" {
			return d
		}
	}
	return nil
}

// jobArgs is the applied Job's render-sql arguments, joined.
func (c *usersCluster) jobArgs() string {
	j := c.appliedJob()
	if j == nil {
		return ""
	}
	spec := j["spec"].(map[string]any)["template"].(map[string]any)["spec"].(map[string]any)
	for _, ic := range spec["initContainers"].([]any) {
		m := ic.(map[string]any)
		if m["name"] == "render-sql" {
			var out []string
			for _, a := range m["args"].([]any) {
				out = append(out, a.(string))
			}
			return strings.Join(out, " ")
		}
	}
	return ""
}

// usersConfig is one environment on AWS Postgres 16 with two BYO charts bound to the database.
func usersConfig() *types.ProjectConfig {
	bind := types.ServiceBinding{
		Target: types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"},
		Inject: []types.ServiceBindingInjection{{Env: "DB_PASSWORD", From: "password"}},
	}
	w := func(name string) types.ChartWorkloadBinding {
		return types.ChartWorkloadBinding{Name: name, Bindings: []types.ServiceBinding{bind},
			ValuePaths: map[string]string{"bind:database:primary:password": name + ".existingSecret"}}
	}
	return &types.ProjectConfig{
		ID: "proj-1", ProjectName: "shop", EnvironmentID: "env-1",
		Databases: []types.ProjectDatabaseConfig{{Name: "primary", EngineFamily: "postgres", EngineVersion: "16.8"}},
		AddOns: []types.AddOnInstall{
			{ID: "acme-api", Byo: true, Namespace: "byo-acme-api", Workloads: []types.ChartWorkloadBinding{w("api")}},
			{ID: "beta", Byo: true, Namespace: "byo-beta", Workloads: []types.ChartWorkloadBinding{w("worker")}},
		},
	}
}

// usersFor are the two users usersConfig declares, in order.
func usersFor() (api, worker string) {
	t := types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"}
	return manifests.ByoBindingDBUser("env-1", "byo-acme-api", "api", t), manifests.ByoBindingDBUser("env-1", "byo-beta", "worker", t)
}

// usersOutputs carry the admin connection and every declared user's stored password.
func usersOutputs(vc *types.ProjectConfig) map[string]interface{} {
	names := map[string]interface{}{}
	for _, d := range declaredByoDBUsers(vc, false, nil) {
		names[d.Key] = "store/" + d.Key
	}
	return map[string]interface{}{
		"rds_cluster_endpoint": "db.internal", "rds_database_name": "app",
		"rds_master_credentials_secret_name": bindingOutputsSecret,
		"custom_secret_names":                names,
	}
}

// resultOf is a termination message as db-bootstrap writes it: the header counting the entries,
// then the entries.
func resultOf(lines ...string) *string {
	s := byoDBUsersResultHeader + fmt.Sprint(len(lines)) + "\n"
	for _, l := range lines {
		s += l + "\n"
	}
	return &s
}

// rawResult is a termination message exactly as given, for malformed cases.
func rawResult(lines ...string) *string {
	s := strings.Join(lines, "\n") + "\n"
	return &s
}

// runUsers runs the BYO users run for vc on AWS.
func runUsers(vc *types.ProjectConfig, outputs map[string]interface{}, refused []byoRefusal) (byoDBUsersOutcome, string) {
	var log strings.Builder
	out := runByoDBUsers(context.Background(), byoDBUsersInput{VC: vc, Outputs: outputs, Provider: "aws", Refused: refused}, &log, &log)
	return out, log.String()
}

// assertCleanedUp checks every credential object of the run was deleted, uid-pinned and Foreground,
// and the Job was not.
func assertCleanedUp(t *testing.T, c *usersCluster) {
	t.Helper()
	for key := range c.objects {
		if strings.HasPrefix(key, "externalsecrets") || strings.HasPrefix(key, "serviceaccounts") {
			t.Errorf("credential object %s was left behind", key)
		}
	}
	dels := c.deletes()
	if len(dels) == 0 {
		t.Fatalf("nothing was deleted:\n%s", strings.Join(c.calls, "\n"))
	}
	for _, d := range dels {
		if !strings.Contains(d, `"propagationPolicy":"Foreground"`) || !strings.Contains(d, `"preconditions":{"uid":"`) {
			t.Errorf("delete is not uid-pinned with Foreground propagation: %s", d)
		}
		if strings.Contains(d, "/jobs/") {
			t.Errorf("the Job was deleted; it holds no credential and is left to its TTL: %s", d)
		}
	}
}

// TestByoDBUsers_SuccessProvisionsTheDeclaredUsers: the Job is Complete and lists both users, so both
// are provisioned; each user's Secret is its own; the Job is told the environment and the declared
// users; and every credential object is deleted after the run.
func TestByoDBUsers_SuccessProvisionsTheDeclaredUsers(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newUsersCluster(t)
	api, worker := usersFor()
	c.message = resultOf(api, worker)
	vc := usersConfig()
	out, log := runUsers(vc, usersOutputs(vc), nil)
	if out.Failed || !out.Provisioned[api] || !out.Provisioned[worker] || len(out.Provisioned) != 2 {
		t.Fatalf("outcome %+v\n%s", out, log)
	}
	args := c.jobArgs()
	users := []string{api, worker}
	sort.Strings(users)
	for _, want := range []string{"--env-id env-1", "--users=" + strings.Join(users, ","), "--result-path /dev/termination-log"} {
		if !strings.Contains(args, want) {
			t.Errorf("Job args %q lack %q", args, want)
		}
	}
	if strings.Contains(args, "--skip-revoke") {
		t.Errorf("--skip-revoke with a complete declared set: %q", args)
	}
	assertCleanedUp(t, c)
}

// TestByoDBUsers_FailureProvisionsNothing: a Failed Job provisions nothing and is a failure (the
// prune is skipped), and its credential objects are still removed.
func TestByoDBUsers_FailureProvisionsNothing(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newUsersCluster(t)
	api, worker := usersFor()
	c.jobOutcome = "Failed"
	c.message = resultOf(api, worker) // a message on a failed Job is never read
	vc := usersConfig()
	out, _ := runUsers(vc, usersOutputs(vc), nil)
	if !out.Failed || len(out.Provisioned) != 0 || len(out.Warnings) != 1 {
		t.Fatalf("outcome %+v", out)
	}
	assertCleanedUp(t, c)
}

// TestByoDBUsers_UntrustworthyResultProvisionsNothing: a malformed message, a missing message field,
// or a wait that cannot read the Job provisions nothing, is a failure, and still cleans up.
func TestByoDBUsers_UntrustworthyResultProvisionsNothing(t *testing.T) {
	api, _ := usersFor()
	for name, setup := range map[string]func(c *usersCluster){
		"unknown line":                         func(c *usersCluster) { c.message = resultOf(api, "NOTICE: done") },
		"empty middle line":                    func(c *usersCluster) { c.message = resultOf(api, "", api[:len(api)-1]+"0") },
		"repeated entry":                       func(c *usersCluster) { c.message = resultOf(api, api) },
		"bad pending line":                     func(c *usersCluster) { c.message = resultOf(api, "revocation-pending:alethia_app") },
		"no header":                            func(c *usersCluster) { c.message = rawResult(api) },
		"count too high":                       func(c *usersCluster) { c.message = rawResult(byoDBUsersResultHeader+"3", api) },
		"count too low":                        func(c *usersCluster) { c.message = rawResult(byoDBUsersResultHeader+"0", api) },
		"no message field with users declared": func(c *usersCluster) { c.message = nil },
		"wait error":                           func(c *usersCluster) { c.message = resultOf(api); c.jobGetErr = true },
		"never finishes":                       func(c *usersCluster) { c.message = resultOf(api); c.jobOutcome = "" },
		"carriage return":                      func(c *usersCluster) { c.message = resultOf(api + "\r") },
		"carriage return in the header":        func(c *usersCluster) { c.message = rawResult(byoDBUsersResultHeader+"1\r", api) },
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
			c := newUsersCluster(t)
			setup(c)
			vc := usersConfig()
			out, log := runUsers(vc, usersOutputs(vc), nil)
			if !out.Failed || len(out.Provisioned) != 0 {
				t.Fatalf("outcome %+v\n%s", out, log)
			}
			assertCleanedUp(t, c)
		})
	}
}

// TestByoDBUsers_IgnoresAUserOutsideTheDeclaredSet: a listed user this deploy did not declare is not
// provisioned; the declared one is.
func TestByoDBUsers_IgnoresAUserOutsideTheDeclaredSet(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newUsersCluster(t)
	api, _ := usersFor()
	stranger := "alethia_byo_0123456789ab"
	c.message = resultOf(api, stranger)
	vc := usersConfig()
	out, _ := runUsers(vc, usersOutputs(vc), nil)
	if out.Failed || !out.Provisioned[api] || out.Provisioned[stranger] {
		t.Fatalf("outcome %+v", out)
	}
}

// TestByoDBUsers_PendingRevocationIsAWarningNotAFailure: a `revocation-pending:` line is surfaced as a
// Deploy-tab warning naming the user, and the declared users are still provisioned.
func TestByoDBUsers_PendingRevocationIsAWarningNotAFailure(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newUsersCluster(t)
	api, worker := usersFor()
	gone := "alethia_byo_0123456789ab"
	c.message = resultOf(api, worker, "revocation-pending:"+gone)
	vc := usersConfig()
	out, _ := runUsers(vc, usersOutputs(vc), nil)
	if out.Failed || len(out.Provisioned) != 2 || out.Provisioned[gone] {
		t.Fatalf("outcome %+v", out)
	}
	if len(out.Warnings) != 1 || !strings.Contains(out.Warnings[0], gone) || !strings.Contains(out.Warnings[0], "can no longer log in") {
		t.Errorf("warnings %q", out.Warnings)
	}
}

// TestByoDBUsers_IncompleteSetSkipsRevocation: one binding cannot resolve (its user has no stored
// password), so the declared set is incomplete. The Job runs with --skip-revoke, provisions the rest,
// and does not list the unresolved user — which, with --skip-revoke, db-bootstrap does not lock out.
func TestByoDBUsers_IncompleteSetSkipsRevocation(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newUsersCluster(t)
	api, worker := usersFor()
	c.message = resultOf(worker)
	vc := usersConfig()
	outputs := usersOutputs(vc)
	t0 := types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"}
	delete(outputs["custom_secret_names"].(map[string]interface{}), manifests.ByoBindingDBSecretKey("env-1", "byo-acme-api", "api", t0))
	out, _ := runUsers(vc, outputs, nil)
	if out.Failed || !out.SkipRevoke || !out.Provisioned[worker] || out.Provisioned[api] {
		t.Fatalf("outcome %+v", out)
	}
	args := c.jobArgs()
	if !strings.Contains(args, "--skip-revoke") || !strings.Contains(args, "--users="+worker+" ") || strings.Contains(args, api) {
		t.Errorf("Job args %q: want --skip-revoke and only %s", args, worker)
	}
}

// TestByoDBUsers_RenderFailureSkipsRevocation: a binding of the environment that fails to render
// makes the declared set incomplete, so the Job runs with --skip-revoke while every user still
// resolves and is provisioned.
func TestByoDBUsers_RenderFailureSkipsRevocation(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newUsersCluster(t)
	api, worker := usersFor()
	c.message = resultOf(api, worker)
	orig := byoBindingRenderFailuresFn
	t.Cleanup(func() { byoBindingRenderFailuresFn = orig })
	byoBindingRenderFailuresFn = func(*types.ProjectConfig, map[string]interface{}, string, []byoRefusal, map[string]bool) int {
		return 1
	}
	vc := usersConfig()
	out, _ := runUsers(vc, usersOutputs(vc), nil)
	if out.Failed || !out.SkipRevoke || len(out.Provisioned) != 2 || !strings.Contains(c.jobArgs(), "--skip-revoke") {
		t.Fatalf("outcome %+v, args %q", out, c.jobArgs())
	}
}

// TestByoBindingRenderFailures counts a binding that cannot render — a stored name the renderer
// refuses — as if its user were provisioned, without applying or writing anything.
func TestByoBindingRenderFailures(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newBindingCluster(t, `{"items":[]}`, 0)
	vc := usersConfig()
	outputs := usersOutputs(vc)
	api, worker := usersFor()
	assumed := map[string]bool{api: true, worker: true}
	if n := byoBindingRenderFailures(vc, outputs, "aws", nil, assumed); n != 0 {
		t.Fatalf("%d failures with usable keys", n)
	}
	t0 := types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"}
	outputs["custom_secret_names"].(map[string]interface{})[manifests.ByoBindingDBSecretKey("env-1", "byo-acme-api", "api", t0)] = "a\nb"
	if n := byoBindingRenderFailures(vc, outputs, "aws", nil, assumed); n != 1 {
		t.Errorf("%d failures, want 1", n)
	}
	if strings.Contains(c.calls(), "apply") || vc.AddOns[0].Values != nil {
		t.Errorf("the count applied or wrote something: %s %v", c.calls(), vc.AddOns[0].Values)
	}
}

// TestByoDBUsers_DeclaredSetLeavesOutRefusedCharts: the Job's user list is the refusal-aware set — a
// refused chart's binding is not declared, so its user is neither provisioned nor counted missing.
func TestByoDBUsers_DeclaredSetLeavesOutRefusedCharts(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newUsersCluster(t)
	api, worker := usersFor()
	c.message = resultOf(worker)
	vc := usersConfig()
	out, _ := runUsers(vc, usersOutputs(vc), []byoRefusal{{ID: "acme-api", Namespace: "byo-acme-api"}})
	if out.Failed || out.SkipRevoke || !out.Provisioned[worker] {
		t.Fatalf("outcome %+v", out)
	}
	if args := c.jobArgs(); strings.Contains(args, api) {
		t.Errorf("the refused chart's user reached the Job: %q", args)
	}
}

// TestByoDBUsers_SweepDeletesOnlyObjectsCarryingBothLabels: before the run, a leftover carrying the
// run label and this environment's owner label is deleted uid-pinned; one missing either label, or
// carrying another environment's owner, is not — even when the API returns it.
func TestByoDBUsers_SweepDeletesOnlyObjectsCarryingBothLabels(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newUsersCluster(t)
	api, worker := usersFor()
	c.message = resultOf(api, worker)
	c.seed("secrets", "leftover-ours", "env-1", true)
	c.seed("secrets", "no-run-label", "env-1", false)
	c.seed("serviceaccounts", "no-owner", "", true)
	c.seed("externalsecrets.external-secrets.io", "other-env", "env-2", true)
	vc := usersConfig()
	if out, log := runUsers(vc, usersOutputs(vc), nil); out.Failed {
		t.Fatalf("outcome %+v\n%s", out, log)
	}
	for _, kept := range []string{"secrets/no-run-label", "serviceaccounts/no-owner", "externalsecrets.external-secrets.io/other-env"} {
		if c.objects[kept] == nil {
			t.Errorf("%s was deleted though it lacks one of the two labels", kept)
		}
	}
	if c.objects["secrets/leftover-ours"] != nil {
		t.Errorf("the leftover carrying both labels was not swept")
	}
	swept := false
	for _, d := range c.deletes() {
		if strings.Contains(d, "/secrets/leftover-ours") {
			swept = strings.Contains(d, `"uid":"00000000-0000-0000-0000-000000000001"`)
		}
	}
	if !swept {
		t.Errorf("the sweep's delete was not pinned to the listed uid:\n%s", strings.Join(c.deletes(), "\n"))
	}
}

// TestByoDBUsers_SweepStandsDownWhileAJobIsActive: while a Job of this environment is still active,
// nothing is swept and no second Job is started; the run is a failure, so nothing is pruned.
func TestByoDBUsers_SweepStandsDownWhileAJobIsActive(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newUsersCluster(t)
	c.seed("jobs.batch", "byo-db-users-earlier", "env-1", true) // no terminal condition: active
	c.seed("secrets", "leftover-ours", "env-1", true)
	vc := usersConfig()
	out, _ := runUsers(vc, usersOutputs(vc), nil)
	if !out.Failed {
		t.Fatalf("outcome %+v", out)
	}
	if len(c.deletes()) != 0 || c.appliedJob() != nil {
		t.Errorf("an active Job did not stand the run down:\n%s", strings.Join(c.calls, "\n"))
	}
}

// TestByoDBUsers_BelowPostgres15RunsNoJob: a Postgres 14 database runs no Job, touches nothing, and
// reports the floor reason; the binding lane carries it on the facet, never binding the admin.
func TestByoDBUsers_BelowPostgres15RunsNoJob(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newUsersCluster(t)
	vc := usersConfig()
	vc.Databases[0].EngineVersion = "14.9"
	out, _ := runUsers(vc, usersOutputs(vc), nil)
	if out.Refusal != byoDBUsersFloorReason || out.Failed || len(c.calls) != 0 {
		t.Fatalf("outcome %+v, calls %v", out, c.calls)
	}
	assertFacetReason(t, vc, out, byoDBUsersFloorReason)
}

// TestByoDBUsers_SecretsUnavailableReportsTheCause: with a credential-based secrets provider no
// password exists, so no Job runs and the facet names that cause.
func TestByoDBUsers_SecretsUnavailableReportsTheCause(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newUsersCluster(t)
	vc := usersConfig()
	vc.Secrets = []types.ProjectSecretConfig{{Name: "app", Provider: "vault"}}
	want := cloud.ByoDBUserSecretsUnavailableReason(vc)
	if want == "" {
		t.Fatal("fixture: vault is expected to switch the native store off")
	}
	out, _ := runUsers(vc, usersOutputs(vc), nil)
	if out.Refusal != want || len(c.calls) != 0 {
		t.Fatalf("outcome %+v, calls %v", out, c.calls)
	}
	assertFacetReason(t, vc, out, want)
}

// assertFacetReason runs the binding lane with outcome and checks the facet is unsatisfied with
// reason and nothing is applied.
func assertFacetReason(t *testing.T, vc *types.ProjectConfig, out byoDBUsersOutcome, reason string) {
	t.Helper()
	bc := newBindingCluster(t, `{"items":[]}`, 0)
	var log strings.Builder
	applyByoChartBindingsExcept(vc, usersOutputs(vc), "aws", nil, out, &log, io.Discard)
	if !strings.Contains(log.String(), "unsatisfied ("+reason+")") {
		t.Errorf("the facet does not carry %q:\n%s", reason, log.String())
	}
	if strings.Contains(bc.calls(), "apply") {
		t.Errorf("a binding was applied:\n%s", bc.calls())
	}
}

// TestByoDBUsers_FlagOffRunsNothing: with the flag off there is no run and no cluster call.
func TestByoDBUsers_FlagOffRunsNothing(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "")
	c := newUsersCluster(t)
	vc := usersConfig()
	if out, _ := runUsers(vc, usersOutputs(vc), nil); out.Failed || out.Provisioned != nil || len(c.calls) != 0 {
		t.Fatalf("outcome %+v, calls %v", out, c.calls)
	}
}

// TestByoDBUsers_FailedRunSkipsTheBindingPrune: a failed run is a binding failure: nothing is bound
// and the prune does not run, so a per-binding ExternalSecret an earlier deploy applied is kept.
func TestByoDBUsers_FailedRunSkipsTheBindingPrune(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	bc := newBindingCluster(t, liveBinding(`{"alethia.io/byo-binding":"true","alethia.io/environment-id":"env-1"}`), 0)
	vc := byoBindingConfig("env-1", true)
	var stderr strings.Builder
	st := applyByoChartBindingsExcept(vc, dbUserOutputs(), "aws", nil, byoDBUsersOutcome{Failed: true}, io.Discard, io.Discard)
	pruneByoChartBindings(st, io.Discard, &stderr)
	if !st.DBUsersFailed || strings.Contains(bc.calls(), "delete") || strings.Contains(bc.calls(), "apply") {
		t.Fatalf("state %+v, calls:\n%s", st, bc.calls())
	}
	if !strings.Contains(stderr.String(), "BYO users Job") {
		t.Errorf("the skip was not reported: %s", stderr.String())
	}
	// The control: a pending revocation is not a failure, so the prune runs.
	st = applyByoChartBindingsExcept(vc, dbUserOutputs(), "aws", nil, byoDBUsersOutcome{Warnings: []string{"pending"}}, io.Discard, io.Discard)
	if st.DBUsersFailed {
		t.Errorf("a run with only a pending revocation skipped the prune")
	}
}

// TestByoDBUsers_AdminKeyNeverReachesABinding: with the flag on, whatever the run's outcome, no BYO
// binding ExternalSecret and no user Secret of the Job references the administrative secret; only
// the Job's own admin credential object does.
func TestByoDBUsers_AdminKeyNeverReachesABinding(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	api, worker := usersFor()
	for name, msg := range map[string]*string{"provisioned": resultOf(api, worker), "nothing provisioned": resultOf()} {
		t.Run(name, func(t *testing.T) {
			c := newUsersCluster(t)
			c.message = msg
			vc := usersConfig()
			outputs := usersOutputs(vc)
			out, _ := runUsers(vc, outputs, nil)
			bc := newBindingCluster(t, `{"items":[]}`, 0)
			st := applyByoChartBindingsExcept(vc, outputs, "aws", nil, out, io.Discard, io.Discard)
			body, _ := os.ReadFile(bc.applied)
			if strings.Contains(string(body), bindingOutputsSecret) {
				t.Fatalf("a BYO binding references the administrative secret:\n%s", body)
			}
			if want := len(out.Provisioned); len(st.Rendered) != want {
				t.Errorf("%d binding(s) rendered, want one per provisioned user (%d)", len(st.Rendered), want)
			}
			for _, d := range c.applied {
				name, _ := d["metadata"].(map[string]any)["name"].(string)
				b, _ := yaml.Marshal(d)
				if strings.Contains(string(b), bindingOutputsSecret) && !strings.HasSuffix(name, "-admin") {
					t.Errorf("%s %s references the administrative secret", d["kind"], name)
				}
			}
		})
	}
}

// TestByoDBUsers_OwnerLabelMatchesArgocd: the run's owner label is the binding lane's.
func TestByoDBUsers_OwnerLabelMatchesArgocd(t *testing.T) {
	if manifests.ByoDBUsersOwnerLabel != argocd.ByoBindingOwnerLabel {
		t.Fatalf("manifests.ByoDBUsersOwnerLabel %q != argocd.ByoBindingOwnerLabel %q", manifests.ByoDBUsersOwnerLabel, argocd.ByoBindingOwnerLabel)
	}
}

// TestByoPostgresMajor reads the configured version, and the provider's default when none is set.
func TestByoPostgresMajor(t *testing.T) {
	for _, tc := range []struct {
		provider, version string
		want              int
		ok                bool
	}{
		{"aws", "16.8", 16, true}, {"gcp", "15", 15, true}, {"azure", "14", 14, true},
		{"gcp", "POSTGRES_13", 13, true}, {"aws", "latest", 0, false},
	} {
		got, ok := byoPostgresMajor(tc.provider, types.ProjectDatabaseConfig{EngineVersion: tc.version})
		if got != tc.want || ok != tc.ok {
			t.Errorf("%s %q: got %d,%v want %d,%v", tc.provider, tc.version, got, ok, tc.want, tc.ok)
		}
	}
	for _, p := range []string{"aws", "gcp", "azure"} {
		if got, ok := byoPostgresMajor(p, types.ProjectDatabaseConfig{}); !ok || got < byoDBUsersMinPostgresMajor {
			t.Errorf("%s default version: %d,%v — the default would refuse every binding", p, got, ok)
		}
	}
}

// TestByoBindingState_RenderedIsWhatWasApplied: the documents the sweep holds live bindings to are
// exactly the ones the binding apply applied.
func TestByoBindingState_RenderedIsWhatWasApplied(t *testing.T) {
	c := newBindingCluster(t, `{"items":[]}`, 0)
	vc := byoBindingConfig("env-1", true)
	worker := vc.AddOns[0].Workloads[0]
	worker.Name = "worker"
	vc.AddOns[0].Workloads = append(vc.AddOns[0].Workloads, worker)
	st := applyByoChartBindings(vc, map[string]interface{}{"rds_master_credentials_secret_name": bindingOutputsSecret}, "aws", io.Discard, io.Discard)
	raw, _ := os.ReadFile(c.applied)
	if len(st.Rendered) != 2 {
		t.Fatalf("rendered %d, want 2", len(st.Rendered))
	}
	total := 0
	for ref, doc := range st.Rendered {
		if ref.Namespace != "apps" || !strings.Contains(string(raw), doc) {
			t.Errorf("%v is not what was applied", ref)
		}
		total += len(doc)
	}
	if total != len(raw) {
		t.Errorf("applied %d bytes, rendered %d", len(raw), total)
	}
}

// TestConfigureByoCharts_StampsTheSecretStoreLabel: the namespaces the runner creates for BYO charts
// carry the runner's secret-store stamp, without which the platform's stores no longer serve a
// namespace marked as a BYO chart's.
func TestConfigureByoCharts_StampsTheSecretStoreLabel(t *testing.T) {
	c := newBindingCluster(t, `{"items":[]}`, 0)
	vc := usersConfig()
	configureByoCharts(vc, "", nil, map[string]string{argocd.ByoBindingOwnerLabel: "env-1"}, io.Discard, io.Discard)
	raw, _ := os.ReadFile(c.applied)
	// The stub appends each applied file as is, so documents of two files are not separated: count
	// the namespaces and the stamps rather than decoding the stream.
	namespaces := strings.Count(string(raw), "kind: Namespace\n")
	stamped := strings.Count(string(raw), argocd.SecretStoreAccessLabel+": "+argocd.SecretStoreAccessValue+"\n")
	if namespaces != 2 || stamped != 2 {
		t.Fatalf("%d namespaces applied, %d stamped, want 2 and 2:\n%s", namespaces, stamped, raw)
	}
}

// TestByoDBUsers_TruncatedResultIsNamed: a result that lost its header — what the kubelet's
// keep-the-last-4096-bytes does to a result too long for it — fails the run with a named warning.
func TestByoDBUsers_TruncatedResultIsNamed(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newUsersCluster(t)
	api, worker := usersFor()
	c.message = rawResult(api, worker) // the header and anything before these lines were cut
	vc := usersConfig()
	out, _ := runUsers(vc, usersOutputs(vc), nil)
	if !out.Failed || len(out.Provisioned) != 0 {
		t.Fatalf("outcome %+v", out)
	}
	if len(out.Warnings) != 1 || !strings.Contains(out.Warnings[0], "result truncated: too many users for one Job") {
		t.Errorf("warnings %q", out.Warnings)
	}
}

// TestByoDBUsers_AbsentMessageIsALostResult: db-bootstrap writes its header on every run, so a
// Complete Job whose termination message is absent (the API server omits an empty one) lost its
// result. That fails the run with a named warning, whatever was declared — even nothing. The
// success case for "nothing declared" is the header's count=0.
func TestByoDBUsers_AbsentMessageIsALostResult(t *testing.T) {
	for name, msg := range map[string]*string{"no message field": nil, "empty message": new(string)} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
			c := newUsersCluster(t)
			c.message = msg
			vc := usersConfig()
			vc.AddOns = nil
			out, log := runUsers(vc, usersOutputs(vc), nil)
			if !out.Failed || len(out.Warnings) != 1 || !strings.Contains(out.Warnings[0], "result lost") {
				t.Fatalf("outcome %+v\n%s", out, log)
			}
		})
	}
	t.Run("count=0 with nothing declared", func(t *testing.T) {
		t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
		c := newUsersCluster(t)
		c.message = resultOf()
		vc := usersConfig()
		vc.AddOns = nil
		out, log := runUsers(vc, usersOutputs(vc), nil)
		if out.Failed || len(out.Warnings) != 0 || len(out.Provisioned) != 0 {
			t.Fatalf("outcome %+v\n%s", out, log)
		}
		if !strings.Contains(c.jobArgs(), "--users= ") {
			t.Errorf("the Job did not run with an explicit empty set: %q", c.jobArgs())
		}
	})
}

// TestByoDBUsers_RefusesANamespaceHoldingForeignObjects: the run refuses, as a failed run with a
// named reason, while its namespace holds an object that is not a run's, and touches nothing.
func TestByoDBUsers_RefusesANamespaceHoldingForeignObjects(t *testing.T) {
	runLabels := func(owner string) map[string]any {
		return map[string]any{manifests.ByoDBUsersLabel: "true", manifests.ByoDBUsersOwnerLabel: owner}
	}
	jobUID := "20000000-0000-0000-0000-000000000001"
	ownedBy := func(uid string) []any {
		return []any{map[string]any{"kind": "Job", "name": manifests.ByoDBUsersJobNamePrefix + "abc-r1", "uid": uid}}
	}
	allowed := []map[string]any{
		{"kind": "ServiceAccount", "metadata": map[string]any{"name": "default"}},
		{"kind": "ConfigMap", "metadata": map[string]any{"name": "kube-root-ca.crt"}},
		{"kind": "Job", "metadata": map[string]any{"name": manifests.ByoDBUsersJobNamePrefix + "abc-r1", "uid": jobUID, "labels": runLabels("env-2")}},
		{"kind": "Pod", "metadata": map[string]any{"name": "run-pod", "labels": runLabels("env-2"), "ownerReferences": ownedBy(jobUID)}},
		{"kind": "Secret", "metadata": map[string]any{"name": "s", "labels": runLabels("env-2")}},
	}
	for name, foreign := range map[string]map[string]any{
		"a Deployment":                   {"kind": "Deployment", "metadata": map[string]any{"name": "web", "labels": runLabels("env-1")}},
		"a Pod not owned by a run's Job": {"kind": "Pod", "metadata": map[string]any{"name": "loose", "labels": runLabels("env-1")}},
		"a Pod owned by a Job not listed here": {"kind": "Pod", "metadata": map[string]any{"name": "elsewhere", "labels": runLabels("env-1"),
			"ownerReferences": ownedBy("20000000-0000-0000-0000-000000000099")}},
		"a ServiceAccount without both labels": {"kind": "ServiceAccount", "metadata": map[string]any{"name": "lookalike", "labels": map[string]any{manifests.ByoDBUsersLabel: "true"}}},
		"a ConfigMap":                          {"kind": "ConfigMap", "metadata": map[string]any{"name": "settings"}},
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
			c := newUsersCluster(t)
			api, worker := usersFor()
			c.message = resultOf(api, worker)
			c.foreign = append(append([]map[string]any{}, allowed...), foreign)
			vc := usersConfig()
			out, _ := runUsers(vc, usersOutputs(vc), nil)
			fname := foreign["kind"].(string) + "/" + foreign["metadata"].(map[string]any)["name"].(string)
			if !out.Failed || len(out.Warnings) != 1 || !strings.Contains(out.Warnings[0], fname) {
				t.Fatalf("outcome %+v, want a failed run naming %s", out, fname)
			}
			for _, call := range c.calls {
				if !strings.HasPrefix(call, "get ") {
					t.Errorf("the run touched the cluster after refusing: %s", call)
				}
			}
		})
	}
	// The control: only the run's own objects and the API server's defaults — the run proceeds.
	t.Run("only run objects", func(t *testing.T) {
		t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
		c := newUsersCluster(t)
		api, worker := usersFor()
		c.message = resultOf(api, worker)
		c.foreign = allowed
		vc := usersConfig()
		if out, log := runUsers(vc, usersOutputs(vc), nil); out.Failed {
			t.Fatalf("outcome %+v\n%s", out, log)
		}
	})
}

// TestByoDBUsers_NamespaceIsReservedForThePlatform: no BYO chart may target the BYO users namespace,
// and a chart that asks for it is refused at deploy; no other alethia- name is reserved.
func TestByoDBUsers_NamespaceIsReservedForThePlatform(t *testing.T) {
	if err := argocd.ValidateByoNamespace(manifests.ByoDBUsersNamespace); err == nil || !strings.Contains(err.Error(), "reserved") {
		t.Fatalf("ValidateByoNamespace(%q) = %v, want a reserved-namespace refusal", manifests.ByoDBUsersNamespace, err)
	}
	// Only the exact name: a reserved alethia- prefix would refuse a chart already attached in a
	// namespace such as alethia-foo on its next deploy, and the binding prune would then withdraw its
	// binding secrets from its running pods.
	if err := argocd.ValidateByoNamespace("alethia-anything"); err != nil {
		t.Errorf("alethia-anything is refused (%v); only the BYO users namespace itself is reserved", err)
	}
	// The JSON group that reserves it names exactly this namespace.
	raw, err := os.ReadFile("../argocd/byo_reserved_namespaces.json")
	if err != nil {
		t.Fatal(err)
	}
	var list struct {
		Groups []struct {
			ID         string   `json:"id"`
			Namespaces []string `json:"namespaces"`
		} `json:"groups"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, g := range list.Groups {
		if g.ID == "platformByoDBUsers" {
			found = len(g.Namespaces) == 1 && g.Namespaces[0] == manifests.ByoDBUsersNamespace
		}
	}
	if !found {
		t.Errorf("byo_reserved_namespaces.json has no platformByoDBUsers group naming exactly %q", manifests.ByoDBUsersNamespace)
	}
	newBindingCluster(t, `{"items":[]}`, 0)
	vc := usersConfig()
	vc.AddOns[0].Namespace = manifests.ByoDBUsersNamespace
	byo := configureByoCharts(vc, "", nil, nil, io.Discard, io.Discard)
	if len(byo.Refused) != 1 || byo.Refused[0].ID != "acme-api" {
		t.Fatalf("refused %+v, want acme-api refused for its namespace", byo.Refused)
	}
}

// TestByoDBUsers_OnlyThePrimaryDatabaseGetsUsers: a binding to a second configured Postgres database
// is not declared (no user is created on the primary under its name), and its facet says why.
func TestByoDBUsers_OnlyThePrimaryDatabaseGetsUsers(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	vc := usersConfig()
	vc.Databases = append(vc.Databases, types.ProjectDatabaseConfig{Name: "analytics", EngineFamily: "postgres", EngineVersion: "16"})
	vc.AddOns[1].Workloads[0].Bindings[0].Target = types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "analytics"}
	vc.AddOns[1].Workloads[0].ValuePaths = map[string]string{"bind:database:analytics:password": "worker.existingSecret"}
	api, _ := usersFor()
	declared := declaredByoDBUsers(vc, false, nil)
	if len(declared) != 1 || declared[0].User != api {
		t.Fatalf("declared %+v, want only the primary-database binding's user %s", declared, api)
	}
	newBindingCluster(t, `{"items":[]}`, 0)
	var log strings.Builder
	applyByoChartBindingsExcept(vc, usersOutputs(vc), "aws", nil, provisionedDBUsers(api), &log, io.Discard)
	if !strings.Contains(log.String(), "binding bind:database:analytics:password unsatisfied ("+byoNonPrimaryReason("primary")+")") {
		t.Errorf("the second database's facet does not state the rule:\n%s", log.String())
	}
}

// TestParseByoDBUsersResult_Header pins the header contract directly.
func TestParseByoDBUsersResult_Header(t *testing.T) {
	api, worker := usersFor()
	users, pending, err := parseByoDBUsersResult(*resultOf(api, "revocation-pending:"+worker), true)
	if err != nil || len(users) != 1 || len(pending) != 1 {
		t.Fatalf("got %v %v %v", users, pending, err)
	}
	if u, p, err := parseByoDBUsersResult(*resultOf(), true); err != nil || len(u)+len(p) != 0 {
		t.Errorf("count=0: %v %v %v", u, p, err)
	}
	for _, absent := range []struct {
		msg     string
		present bool
	}{{"", false}, {"", true}} {
		if _, _, err := parseByoDBUsersResult(absent.msg, absent.present); !errors.Is(err, errByoDBUsersResultLost) {
			t.Errorf("an absent message (present=%v): %v, want a lost result", absent.present, err)
		}
	}
	if _, _, err := parseByoDBUsersResult(*rawResult(api), true); !errors.Is(err, errByoDBUsersTruncated) {
		t.Errorf("a headerless message: %v", err)
	}
	if _, _, err := parseByoDBUsersResult(*rawResult(byoDBUsersResultHeader+"01", api), true); err == nil {
		t.Errorf("a zero-padded count was accepted")
	}
}

// TestParseByoDBUsersResult_ContractWithTheRunner pins the result spellings this parser shares with
// `alethia db-bootstrap --byo-users` (apps/runner, a separate module): the header and the pending
// prefix.
func TestParseByoDBUsersResult_ContractWithTheRunner(t *testing.T) {
	src, err := os.ReadFile("../../../apps/runner/internal/agent/db_bootstrap_byo.go")
	if err != nil {
		t.Fatalf("read the runner source: %v", err)
	}
	for _, want := range []string{
		`const byoResultHeaderPrefix = "` + byoDBUsersResultHeader + `"`,
		`const byoPendingPrefix = "` + byoDBUsersPendingPrefix + `"`,
	} {
		if !strings.Contains(string(src), want) {
			t.Errorf("the runner does not declare %s", want)
		}
	}
}

// TestByoDBUsers_APodOfAnUnlabelledJobIsForeign: a Pod is a run's only when its owner Job is one
// listed in the namespace with both run labels, so a Pod owned by an unlabelled Job is named as
// foreign in its own right, not only through its Job.
func TestByoDBUsers_APodOfAnUnlabelledJobIsForeign(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newUsersCluster(t)
	labels := map[string]any{manifests.ByoDBUsersLabel: "true", manifests.ByoDBUsersOwnerLabel: "env-1"}
	uid := "30000000-0000-0000-0000-000000000001"
	c.foreign = []map[string]any{
		{"kind": "Job", "metadata": map[string]any{"name": manifests.ByoDBUsersJobNamePrefix + "x", "uid": uid}},
		{"kind": "Pod", "metadata": map[string]any{"name": "child", "labels": labels,
			"ownerReferences": []any{map[string]any{"kind": "Job", "name": manifests.ByoDBUsersJobNamePrefix + "x", "uid": uid}}}},
	}
	vc := usersConfig()
	out, _ := runUsers(vc, usersOutputs(vc), nil)
	if !out.Failed || len(out.Warnings) != 1 || !strings.Contains(out.Warnings[0], "Pod/child") {
		t.Fatalf("outcome %+v, want the Pod named as foreign", out)
	}
}
