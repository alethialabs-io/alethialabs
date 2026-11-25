// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/manifest"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// The contract every command of the project family holds, driven through the real cobra tree
// against the fake control plane (cov_project_test.go):
//
//   - a result is ONE document on stdout, and under `-o json` it parses;
//   - a command that changes something returns the mutation result, and with --dry-run sends
//     nothing;
//   - a refusal exits with the code its class owns, writes nothing on stdout, and says what to
//     do next on stderr.

// famResult is the mutation result as a program reads it.
type famResult struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Action string `json:"action"`
	Job    *struct {
		ID   string `json:"id"`
		Type string `json:"type"`
	} `json:"job"`
	DryRun bool            `json:"dry_run"`
	Object json.RawMessage `json:"object"`
}

// famJobObject is the `object` of a job command's result.
type famJobObject struct {
	ProjectID     string         `json:"project_id"`
	EnvironmentID string         `json:"environment_id"`
	Request       map[string]any `json:"request"`
	DestroyTree   []struct {
		Name string `json:"name"`
	} `json:"destroy_tree"`
	Jobs []struct {
		ID               string   `json:"id"`
		Type             string   `json:"type"`
		Status           string   `json:"status"`
		Environment      string   `json:"environment"`
		AwaitingApproval bool     `json:"awaiting_approval"`
		ApprovalURL      string   `json:"approval_url"`
		Warnings         []string `json:"warnings"`
	} `json:"jobs"`
}

// famDesignDoc writes a design document and returns its path.
func famDesignDoc(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "design.json")
	if err := os.WriteFile(path, []byte(`{"components":[]}`), 0o600); err != nil {
		t.Fatalf("write design document: %v", err)
	}
	return path
}

// famRunJSON runs one invocation with `--output json`, requires it to succeed, and decodes stdout
// as one mutation result. It returns the result and what was written on stderr.
func famRunJSON(t *testing.T, h projHarness, args ...string) (famResult, string) {
	t.Helper()
	code, stdout, stderr := projExitCode(t, h, append(args, "--output", "json")...)
	if code != 0 {
		t.Fatalf("%v exited %d:\n%s", args, code, stderr)
	}
	var r famResult
	dec := json.NewDecoder(strings.NewReader(stdout))
	if err := dec.Decode(&r); err != nil {
		t.Fatalf("%v: stdout is not one json document: %v\n%s", args, err, stdout)
	}
	if dec.More() {
		t.Fatalf("%v: stdout carries more than the result:\n%s", args, stdout)
	}
	return r, stderr
}

// famJobs decodes a job command's object.
func famJobs(t *testing.T, r famResult) famJobObject {
	t.Helper()
	var obj famJobObject
	if err := json.Unmarshal(r.Object, &obj); err != nil {
		t.Fatalf("the result's object is not a job object: %v\n%s", err, r.Object)
	}
	return obj
}

// famMutations is every mutating command of the family, said entirely in flags.
func famMutations(t *testing.T) []struct {
	name, kind, action string
	args               []string
	queuesJob          bool
} {
	t.Helper()
	return []struct {
		name, kind, action string
		args               []string
		queuesJob          bool
	}{
		{"create", "project", "created",
			[]string{"project", "create", "api", "--region", "eu-west-1", "--cloud-account", "prod-account", "--no-manifest"}, false},
		{"env add", "environment", "created",
			[]string{"project", "env", "add", "staging", "--project", "web", "--stage", "staging", "--placement-mode", "namespace"}, false},
		{"component add", "component", "created",
			[]string{"project", "component", "add", "--project", "web", "--kind", "databases", "--name", "main", "--set", "engine=postgres"}, false},
		{"component remove", "component", "deleted",
			[]string{"project", "component", "remove", "--project", "web", "--kind", "databases", "--name", "main", "--yes"}, false},
		{"preview", "project", "queued",
			[]string{"project", "preview", "--project", "web", "--runner", "primary", "--env", "production"}, true},
		{"deploy", "project", "queued",
			[]string{"project", "deploy", "--project", "web", "--runner", "primary", "--env", "production", "--yes"}, true},
		{"destroy", "project", "queued",
			[]string{"project", "destroy", "--project", "web", "--runner", "primary", "--env", "production", "--yes"}, true},
	}
}

// TestProjFamily_EveryMutationReturnsOneResult is the JSON shape of each mutating command: one
// result on stdout, naming its subject, what happened to it, and the job when one was queued.
func TestProjFamily_EveryMutationReturnsOneResult(t *testing.T) {
	for _, tc := range famMutations(t) {
		t.Run(tc.name, func(t *testing.T) {
			s := &projServer{envs: projSampleEnvs()}
			h := projEnv(t, s)
			r, _ := famRunJSON(t, h, append(tc.args, "--no-input")...)
			if r.Kind != tc.kind || r.Action != tc.action || r.DryRun || r.ID == "" {
				t.Errorf("result = %+v, want kind %q action %q with an id and dry_run false", r, tc.kind, tc.action)
			}
			if len(r.Object) == 0 || string(r.Object) == "null" {
				t.Errorf("the result carries no object: %+v", r)
			}
			if !tc.queuesJob {
				if r.Job != nil {
					t.Errorf("a command that queues nothing reported a job: %+v", r.Job)
				}
				return
			}
			if r.Job == nil || r.Job.ID != "j1" {
				t.Fatalf("a job command must name the job it queued, got %+v", r.Job)
			}
			obj := famJobs(t, r)
			if obj.ProjectID != "p1" || obj.EnvironmentID != "e1" || len(obj.Jobs) != 1 {
				t.Errorf("job object = %+v, want project p1, environment e1 and one job", obj)
			}
			if obj.Jobs[0].Type != r.Job.Type || obj.Jobs[0].Status != "QUEUED" || obj.Jobs[0].AwaitingApproval {
				t.Errorf("job entry = %+v, want the queued job of type %s", obj.Jobs[0], r.Job.Type)
			}
			if post, ok := s.lastPost(); !ok || post.Body["assigned_runner_id"] != "r1" {
				t.Errorf("--runner primary did not reach the queued job as r1: %+v", post.Body)
			}
		})
	}
}

// TestProjFamily_DesignApplyReturnsOneResult is the same for the design document, whose result
// says which mode ran and lists the changes.
func TestProjFamily_DesignApplyReturnsOneResult(t *testing.T) {
	doc := famDesignDoc(t)
	cases := []struct {
		name    string
		changes []map[string]any
		extra   []string
		action  string
		dryRun  bool
		mode    string
	}{
		{"applied", []map[string]any{{"kind": "databases", "name": "orders", "action": "UPDATE"}}, nil, "updated", false, "applied"},
		{"nothing to change", []map[string]any{}, nil, "unchanged", false, "applied"},
		{"dry run", []map[string]any{{"kind": "databases", "name": "orders", "action": "CREATE"}}, []string{"--dry-run"}, "updated", true, "dry-run"},
		{"staged", []map[string]any{{"kind": "databases", "name": "orders", "action": "CREATE"}}, []string{"--stage"}, "queued", false, "staged"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := projEnv(t, &projServer{designChanges: tc.changes})
			args := append([]string{"project", "design", "apply", "--project", "web", "--file", doc, "--no-input"}, tc.extra...)
			r, _ := famRunJSON(t, h, args...)
			if r.ID != "web" || r.Kind != "design" || r.Action != tc.action || r.DryRun != tc.dryRun {
				t.Errorf("result = %+v, want design web, action %q, dry_run %v", r, tc.action, tc.dryRun)
			}
			var obj struct {
				Mode    string           `json:"mode"`
				Changes []map[string]any `json:"changes"`
			}
			if err := json.Unmarshal(r.Object, &obj); err != nil {
				t.Fatalf("design object: %v\n%s", err, r.Object)
			}
			if obj.Mode != tc.mode || len(obj.Changes) != len(tc.changes) {
				t.Errorf("design object = %+v, want mode %q and %d change(s)", obj, tc.mode, len(tc.changes))
			}
		})
	}
}

// TestProjFamily_ReadsEmitOneDocument is the JSON shape of each read: a document that parses,
// with nothing else on stdout.
func TestProjFamily_ReadsEmitOneDocument(t *testing.T) {
	cases := [][]string{
		{"project", "list"},
		{"project", "get", "web"},
		{"project", "get", "--project", "web"},
		{"project", "env", "list", "--project", "web"},
		{"project", "component", "kinds"},
		{"project", "component", "list", "--project", "web"},
	}
	for _, args := range cases {
		t.Run(strings.Join(args[1:], "_"), func(t *testing.T) {
			h := projEnv(t, &projServer{config: projSampleConfig(), envs: projSampleEnvs(), comps: projSampleComponents()})
			code, stdout, stderr := projExitCode(t, h, append(args, "--output", "json", "--no-input")...)
			if code != 0 {
				t.Fatalf("exited %d:\n%s", code, stderr)
			}
			if !json.Valid([]byte(stdout)) {
				t.Errorf("stdout is not one json document:\n%s", stdout)
			}
		})
	}
}

// TestProjFamily_DryRunSendsNothing pins --dry-run on every command that declares the client
// level: the result says dry_run and carries the request, and no mutating request is made — not
// even with no --yes, because there is nothing to confirm.
func TestProjFamily_DryRunSendsNothing(t *testing.T) {
	cases := []struct {
		name string
		args []string
	}{
		{"create", []string{"project", "create", "api", "--region", "eu-west-1", "--cloud-account", "prod-account", "--no-manifest"}},
		{"env add", []string{"project", "env", "add", "staging", "--project", "web", "--stage", "staging"}},
		{"component add", []string{"project", "component", "add", "--project", "web", "--kind", "databases", "--name", "main", "--env", "production"}},
		{"component remove", []string{"project", "component", "remove", "--project", "web", "--kind", "databases", "--name", "main"}},
		{"preview", []string{"project", "preview", "--project", "web"}},
		{"deploy", []string{"project", "deploy", "--project", "web", "--plan-job-id", "j0"}},
		{"destroy", []string{"project", "destroy", "--project", "web", "--env", "production"}},
		{"destroy cascade", []string{"project", "destroy", "--project", "web", "--env", "production", "--cascade"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := &projServer{envs: projSampleEnvs()}
			h := projEnv(t, s)
			r, _ := famRunJSON(t, h, append(tc.args, "--dry-run", "--no-input")...)
			if !r.DryRun || r.Job != nil {
				t.Errorf("a dry run must say so and name no job, got %+v", r)
			}
			var obj struct {
				Request map[string]any `json:"request"`
			}
			if err := json.Unmarshal(r.Object, &obj); err != nil || len(obj.Request) == 0 {
				t.Errorf("a dry run must carry the request it would send: %s (%v)", r.Object, err)
			}
			if post, ok := s.lastPost(); ok {
				t.Errorf("a dry run sent %s %s", post.Method, post.Path)
			}

			// The same run for a person: one sentence saying nothing was sent.
			code, stdout, stderr := projExitCode(t, h, append(tc.args, "--dry-run", "--no-input", "--output", "table")...)
			if code != 0 || !strings.Contains(stdout, "Nothing was sent") {
				t.Errorf("the table form of a dry run: exit %d, stdout %q, stderr %q", code, stdout, stderr)
			}
			if _, ok := s.lastPost(); ok {
				t.Error("the table form of a dry run sent a request")
			}
		})
	}
}

// TestProjFamily_ADryRunOfACascadeShowsTheTree pins what a cascade's dry run is for: the whole
// set of environments it would destroy, in the result, with nothing queued.
func TestProjFamily_ADryRunOfACascadeShowsTheTree(t *testing.T) {
	s := &projServer{envs: projSampleEnvs(), destroyTree: boutiqueTree()}
	h := projEnv(t, s)
	r, stderr := famRunJSON(t, h, "project", "destroy", "--project", "web", "--env", "production", "--cascade", "--dry-run", "--no-input")
	obj := famJobs(t, r)
	if len(obj.DestroyTree) != 3 || obj.DestroyTree[2].Name != "production" {
		t.Errorf("the dry run must carry the destroy tree, owner last: %+v", obj.DestroyTree)
	}
	if obj.Request["cascade"] != true || obj.Request["job_type"] != "DESTROY" {
		t.Errorf("the request must be a cascading DESTROY: %+v", obj.Request)
	}
	if !strings.Contains(stderr, "Will destroy, in order: dev-1") {
		t.Errorf("the tree is also said on stderr:\n%s", stderr)
	}
}

// famRefusal is one invocation that must be refused.
type famRefusal struct {
	name string
	args []string
	exit int
	want []string
}

// famRefusals is one refusal per command of the family, and one per kind of refusal a command
// has. None of them may reach a mutating request.
func famRefusals(doc, badDoc string) []famRefusal {
	return []famRefusal{
		{"get: unknown project", []string{"project", "get", "nope"}, clierr.ExitNotFound, []string{`no project named "nope"`, "alethia project list"}},
		{"get: named twice", []string{"project", "get", "web", "--project", "api"}, clierr.ExitUsage, []string{"named twice"}},
		{"get: no name and nobody to ask", []string{"project", "get"}, clierr.ExitInputRequired, []string{"--project", "alethia project list"}},
		{"preview: unknown project", []string{"project", "preview", "--project", "nope"}, clierr.ExitNotFound, []string{`project "nope" not found`, "alethia project list"}},
		{"preview: two project flags", []string{"project", "preview", "--project", "web", "--project-id", "p1"}, clierr.ExitUsage, []string{"both name the project"}},
		{"preview: no project and nobody to ask", []string{"project", "preview"}, clierr.ExitInputRequired, []string{"--project is required"}},
		{"preview: unknown environment", []string{"project", "preview", "--project", "web", "--env", "nope"}, clierr.ExitNotFound, []string{`environment "nope" not found`, "alethia project env list"}},
		{"deploy: unconfirmed", []string{"project", "deploy", "--project", "web"}, clierr.ExitInputRequired, []string{"pass --yes to deploy", "alethia project preview"}},
		{"deploy: two plan references", []string{"project", "deploy", "--project", "web", "--plan-job-id", "j0", "--latest-plan", "--yes"}, clierr.ExitUsage, []string{"both name the plan"}},
		{"deploy: no plan to take", []string{"project", "deploy", "--project", "web", "--latest-plan", "--yes"}, clierr.ExitNotFound, []string{"no PLAN job", "alethia project preview --wait"}},
		{"destroy: unconfirmed", []string{"project", "destroy", "--project", "web"}, clierr.ExitInputRequired, []string{"pass --yes"}},
		{"env list: no project", []string{"project", "env", "list"}, clierr.ExitInputRequired, []string{"--project is required"}},
		{"env add: no name", []string{"project", "env", "add", "--project", "web"}, clierr.ExitInputRequired, []string{"an environment name is required"}},
		{"env add: a stage that does not exist", []string{"project", "env", "add", "x", "--project", "web", "--stage", "nope"}, clierr.ExitUsage, []string{`invalid stage "nope"`}},
		{"component list: no project", []string{"project", "component", "list"}, clierr.ExitInputRequired, []string{"--project is required"}},
		{"component add: no kind", []string{"project", "component", "add", "--project", "web"}, clierr.ExitInputRequired, []string{"--kind is required", "alethia project component kinds"}},
		{"component add: a malformed --set", []string{"project", "component", "add", "--project", "web", "--kind", "databases", "--name", "main", "--set", "engine"}, clierr.ExitUsage, []string{`invalid --set "engine"`}},
		{"component remove: unconfirmed", []string{"project", "component", "remove", "--project", "web", "--kind", "cluster"}, clierr.ExitInputRequired, []string{"pass --yes"}},
		{"component remove: a multi kind with no name", []string{"project", "component", "remove", "--project", "web", "--kind", "databases", "--yes"}, clierr.ExitInputRequired, []string{"needs a name", "alethia project component list --kind databases"}},
		{"design apply: no document", []string{"project", "design", "apply", "--project", "web"}, clierr.ExitInputRequired, []string{"-f is required"}},
		{"design apply: two modes", []string{"project", "design", "apply", "--project", "web", "--file", doc, "--dry-run", "--stage"}, clierr.ExitUsage, []string{"mutually exclusive"}},
		{"design apply: not json", []string{"project", "design", "apply", "--project", "web", "--file", badDoc}, clierr.ExitUsage, []string{"is not valid JSON"}},
		{"design apply: no such file", []string{"project", "design", "apply", "--project", "web", "--file", doc + ".missing"}, clierr.ExitUsage, []string{"read the design document"}},
		{"design apply: a removal nobody confirmed", []string{"project", "design", "apply", "--project", "web", "--file", doc}, clierr.ExitInputRequired, []string{"would DELETE 1 component", "pass --yes"}},
		{"create: no region", []string{"project", "create", "api", "--no-manifest"}, clierr.ExitInputRequired, []string{"--region"}},
		{"create: two manifest instructions", []string{"project", "create", "api", "--file", doc, "--no-manifest"}, clierr.ExitUsage, []string{"--no-manifest"}},
		{"create: a machine type with no cloud", []string{"project", "create", "api", "--region", "eu-west-1", "--instance-type", "t3.large", "--no-manifest"}, clierr.ExitUsage, []string{"--instance-type", "--cloud-account"}},
		{"create: an unknown cloud account", []string{"project", "create", "api", "--region", "eu-west-1", "--cloud-account", "nope", "--no-manifest"}, clierr.ExitNotFound, []string{`cloud account "nope" not found`, "alethia connector list"}},
	}
}

// TestProjFamily_RefusalsExitWithTheirClassOnStderr drives every refusal: the exit code is the
// class, stdout is empty, the sentence and its next step are on stderr, and nothing was changed.
func TestProjFamily_RefusalsExitWithTheirClassOnStderr(t *testing.T) {
	doc := famDesignDoc(t)
	badDoc := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(badDoc, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range famRefusals(doc, badDoc) {
		t.Run(tc.name, func(t *testing.T) {
			s := &projServer{envs: projSampleEnvs()}
			h := projEnv(t, s)
			code, stdout, stderr := projExitCode(t, h, append(tc.args, "--no-input")...)
			if code != tc.exit {
				t.Errorf("exit code = %d, want %d\n%s", code, tc.exit, stderr)
			}
			if stdout != "" {
				t.Errorf("a refusal wrote on stdout: %q", stdout)
			}
			for _, want := range tc.want {
				if !strings.Contains(stderr, want) {
					t.Errorf("stderr is missing %q:\n%s", want, stderr)
				}
			}
			s.mu.Lock()
			defer s.mu.Unlock()
			for _, post := range s.posts {
				if !post.DryRun {
					t.Errorf("a refused command still sent %s %s", post.Method, post.Path)
				}
			}
		})
	}
}

// TestProjFamily_ARefusalUnderJSONIsOneEnvelopeOnStderr pins the machine form of a refusal: one
// alethia.error/v1 object on stderr carrying the code, the exit and the hint, and an empty stdout.
func TestProjFamily_ARefusalUnderJSONIsOneEnvelopeOnStderr(t *testing.T) {
	h := projEnv(t, &projServer{})
	code, stdout, stderr := projExitCode(t, h, "project", "deploy", "--project", "web", "--output", "json", "--no-input")
	if code != clierr.ExitInputRequired || stdout != "" {
		t.Fatalf("exit %d, stdout %q", code, stdout)
	}
	var env struct {
		Schema string `json:"schema"`
		Error  struct {
			Code     string `json:"code"`
			ExitCode int    `json:"exit_code"`
			Hint     string `json:"hint"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(stderr)), &env); err != nil {
		t.Fatalf("stderr is not one error envelope: %v\n%s", err, stderr)
	}
	if env.Schema != "alethia.error/v1" || env.Error.Code != clierr.CodeConfirmationRequired ||
		env.Error.ExitCode != clierr.ExitInputRequired || env.Error.Hint == "" {
		t.Errorf("envelope = %+v", env)
	}
}

// --- project deploy and project preview ---

// TestProjDeploy_AsksBeforeItQueues pins the confirmation on a terminal: a no queues nothing and
// is not an error, and a yes queues the DEPLOY. The question names the project, the environment
// and the plan.
func TestProjDeploy_AsksBeforeItQueues(t *testing.T) {
	s := &projServer{envs: projSampleEnvs()}
	h := projEnv(t, s)
	projTTY(t)

	var asked []string
	prev := confirm
	answer := false
	confirm = func(title, description string) bool {
		asked = append(asked, title+"\n"+description)
		return answer
	}
	t.Cleanup(func() { confirm = prev })

	args := []string{"project", "deploy", "--project", "web", "--runner-id", "r1", "--env", "production", "--plan-job-id", "j0"}
	if code, _, stderr := projExitCode(t, h, args...); code != 0 {
		t.Fatalf("a declined deploy is not an error, exited %d:\n%s", code, stderr)
	}
	if _, ok := s.lastPost(); ok {
		t.Fatal("a declined deploy queued a job")
	}
	if len(asked) != 1 {
		t.Fatalf("the deploy asked %d time(s), want once", len(asked))
	}
	for _, want := range []string{"Deploy this project environment?", "environment production", "project web", "plan job j0"} {
		if !strings.Contains(asked[0], want) {
			t.Errorf("the question does not name %q:\n%s", want, asked[0])
		}
	}

	answer = true
	if code, _, stderr := projExitCode(t, h, args...); code != 0 {
		t.Fatalf("a confirmed deploy exited %d:\n%s", code, stderr)
	}
	post, ok := s.lastPost()
	if !ok || post.Body["job_type"] != "DEPLOY" || post.Body["plan_job_id"] != "j0" || post.Body["environment_id"] != "e1" {
		t.Errorf("a confirmed deploy must queue the DEPLOY it described, sent %+v", post.Body)
	}
}

// TestProjDeploy_WithoutAPlanPreviewsFirst pins plain `project deploy`: a deploy applies a reviewed
// plan, so with no --plan-job-id or --latest-plan it queues a PLAN for the same project,
// environment and runner, waits for it, prints what it would change, asks, and then queues the
// DEPLOY of exactly that plan.
func TestProjDeploy_WithoutAPlanPreviewsFirst(t *testing.T) {
	s := &projServer{envs: projSampleEnvs(), jobMeta: map[string]any{
		"plan_result": map[string]any{"resource_changes": []any{
			map[string]any{"change": map[string]any{"actions": []any{"create"}}},
			map[string]any{"change": map[string]any{"actions": []any{"create"}}},
			map[string]any{"change": map[string]any{"actions": []any{"update"}}},
			map[string]any{"change": map[string]any{"actions": []any{"delete", "create"}}},
			map[string]any{"change": map[string]any{"actions": []any{"no-op"}}},
		}},
	}}
	h := projEnv(t, s)
	projTTY(t)

	var asked []string
	prev := confirm
	confirm = func(title, description string) bool {
		asked = append(asked, description)
		return true
	}
	t.Cleanup(func() { confirm = prev })

	code, _, stderr := projExitCode(t, h, "project", "deploy", "--project", "web", "--runner-id", "r1", "--env", "production")
	if code != 0 {
		t.Fatalf("a confirmed deploy exited %d:\n%s", code, stderr)
	}
	var jobs []projPost
	for _, post := range s.posts {
		if post.Path == "/api/jobs" {
			jobs = append(jobs, post)
		}
	}
	if len(jobs) != 2 {
		t.Fatalf("want a PLAN then a DEPLOY, sent %+v", jobs)
	}
	plan, deploy := jobs[0].Body, jobs[1].Body
	if plan["job_type"] != "PLAN" || plan["environment_id"] != "e1" || plan["assigned_runner_id"] != "r1" || plan["plan_job_id"] != nil {
		t.Errorf("the preview must be a PLAN of the same environment on the same runner, sent %+v", plan)
	}
	if deploy["job_type"] != "DEPLOY" || deploy["plan_job_id"] != "j1" || deploy["environment_id"] != "e1" {
		t.Errorf("the deploy must apply the plan it just made, sent %+v", deploy)
	}
	if !strings.Contains(stderr, "Plan: 2 to create, 1 to update, 1 to replace, 0 to delete.") {
		t.Errorf("the plan's changes must be shown before the question, stderr:\n%s", stderr)
	}
	if len(asked) != 1 || !strings.Contains(asked[0], "plan job j1") {
		t.Errorf("the question must name the plan it deploys, asked %q", asked)
	}
}

// TestProjDeploy_AFailedPreviewDeploysNothing pins the failure: a preview that does not succeed
// exits with the operation-failed code, says why and which job, and queues no DEPLOY.
func TestProjDeploy_AFailedPreviewDeploysNothing(t *testing.T) {
	s := &projServer{envs: projSampleEnvs(), jobStatuses: []string{"FAILED"}, jobErrMsg: "tofu plan: provider error"}
	h := projEnv(t, s)

	code, stdout, stderr := projExitCode(t, h, "project", "deploy", "--project", "web", "--runner-id", "r1", "--env", "production", "--yes")
	if code != clierr.ExitOperationFailed {
		t.Fatalf("a failed preview must exit %d, exited %d:\n%s", clierr.ExitOperationFailed, code, stderr)
	}
	if stdout != "" {
		t.Errorf("a refusal writes nothing on stdout, wrote:\n%s", stdout)
	}
	if !strings.Contains(stderr, "PLAN job j1") || !strings.Contains(stderr, "nothing was deployed") {
		t.Errorf("the error must name the preview and say nothing was deployed, stderr:\n%s", stderr)
	}
	for _, post := range s.posts {
		if post.Path == "/api/jobs" && post.Body["job_type"] == "DEPLOY" {
			t.Fatalf("a failed preview queued a DEPLOY: %+v", post.Body)
		}
	}
}

// TestProjDeploy_UnconfirmableQueuesNoPreview pins the order: a deploy nobody can confirm is
// refused before the preview is queued, so no plan is spent on it.
func TestProjDeploy_UnconfirmableQueuesNoPreview(t *testing.T) {
	s := &projServer{envs: projSampleEnvs()}
	h := projEnv(t, s)

	code, _, _ := projExitCode(t, h, "project", "deploy", "--project", "web", "--env", "production", "--no-input")
	if code != clierr.ExitInputRequired {
		t.Fatalf("want exit %d, got %d", clierr.ExitInputRequired, code)
	}
	if _, ok := s.lastPost(); ok {
		t.Fatal("an unconfirmable deploy queued a preview")
	}
}

// TestProjDeploy_WithoutAPlanEdges covers the other ways a plain `project deploy` ends: a dry run
// sends nothing and says a real run previews first; under json the plan summary stays off stderr
// and stdout is the one result; a preview the control plane refuses, or accepts without naming a
// job, deploys nothing.
func TestProjDeploy_WithoutAPlanEdges(t *testing.T) {
	base := []string{"project", "deploy", "--project", "web", "--runner-id", "r1", "--env", "production", "--yes"}

	t.Run("dry run", func(t *testing.T) {
		s := &projServer{envs: projSampleEnvs()}
		h := projEnv(t, s)
		code, _, stderr := projExitCode(t, h, append(base, "--dry-run")...)
		if code != 0 {
			t.Fatalf("a dry run exited %d:\n%s", code, stderr)
		}
		if _, ok := s.lastPost(); ok {
			t.Fatal("a dry run queued a job")
		}
		if !strings.Contains(stderr, "first queues a preview") {
			t.Errorf("the dry run must say a real run previews first, stderr:\n%s", stderr)
		}
	})

	t.Run("json", func(t *testing.T) {
		s := &projServer{envs: projSampleEnvs()}
		h := projEnv(t, s)
		r, stderr := famRunJSON(t, h, base...)
		if r.Job == nil || r.Job.Type != "DEPLOY" {
			t.Errorf("the result must be the DEPLOY, got %+v", r.Job)
		}
		if strings.Contains(stderr, "Plan:") || strings.Contains(stderr, "Job j1") {
			t.Errorf("under json the plan summary is not printed, stderr:\n%s", stderr)
		}
	})

	t.Run("preview refused", func(t *testing.T) {
		s := &projServer{envs: projSampleEnvs(), failOn: []string{"/api/jobs"}}
		h := projEnv(t, s)
		if code, _, _ := projExitCode(t, h, base...); code == 0 {
			t.Fatal("a refused preview must not exit 0")
		}
	})

	t.Run("preview names no job", func(t *testing.T) {
		s := &projServer{envs: projSampleEnvs(), noJob: true}
		h := projEnv(t, s)
		code, _, stderr := projExitCode(t, h, base...)
		if code == 0 || !strings.Contains(stderr, "no plan to deploy") {
			t.Fatalf("a preview with no job must stop the deploy, exited %d:\n%s", code, stderr)
		}
	})
}

// TestPlanChangeSummary counts tofu's resource changes the way the console's plan review does,
// and says nothing for a job that recorded no plan result.
func TestPlanChangeSummary(t *testing.T) {
	meta := func(v map[string]interface{}) *map[string]interface{} { return &v }
	for name, tc := range map[string]struct {
		meta *map[string]interface{}
		want string
	}{
		"no metadata":         {nil, ""},
		"no plan result":      {meta(map[string]interface{}{}), ""},
		"no resource changes": {meta(map[string]interface{}{"plan_result": map[string]interface{}{}}), ""},
		"every action": {meta(map[string]interface{}{"plan_result": map[string]interface{}{"resource_changes": []interface{}{
			map[string]interface{}{"change": map[string]interface{}{"actions": []interface{}{"delete"}}},
			map[string]interface{}{"change": map[string]interface{}{"actions": []interface{}{"create", "delete"}}},
			map[string]interface{}{"change": map[string]interface{}{"actions": []interface{}{"read"}}},
			"not an object",
		}}}), "Plan: 0 to create, 0 to update, 1 to replace, 1 to delete."},
	} {
		t.Run(name, func(t *testing.T) {
			if got := planChangeSummary(tc.meta); got != tc.want {
				t.Errorf("planChangeSummary = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestDeployDescription_SaysWhatHasNoName covers the two defaults of the question: a project that
// was picked rather than named is shown by its id, and a deploy with no plan says it previews first.
func TestDeployDescription_SaysWhatHasNoName(t *testing.T) {
	got := deployDescription(api.QueueJobParams{ConfigurationID: "p1"}, "", "")
	for _, want := range []string{"the default environment", "project p1", "previews the environment first"} {
		if !strings.Contains(got, want) {
			t.Errorf("description is missing %q: %s", want, got)
		}
	}
}

// TestProjFamily_TheOldNamesAreHiddenAndSaySo pins the rename: `project plan` and `project apply`
// still run, are not listed, print one line on stderr naming the current command, and queue what
// they always queued. `project apply` keeps the contract scripts were written against — it does
// not ask — while `project deploy` does.
func TestProjFamily_TheOldNamesAreHiddenAndSaySo(t *testing.T) {
	cases := []struct {
		old, current, jobType string
	}{
		{"plan", "preview", "PLAN"},
		{"apply", "deploy", "DEPLOY"},
	}
	for _, tc := range cases {
		t.Run(tc.old, func(t *testing.T) {
			s := &projServer{}
			h := projEnv(t, s)
			r, stderr := famRunJSON(t, h, "project", tc.old, "--project", "web", "--no-input")
			if r.Job == nil || r.Job.Type != tc.jobType {
				t.Errorf("`project %s` must still queue a %s job, got %+v", tc.old, tc.jobType, r.Job)
			}
			notice := fmt.Sprintf("`alethia project %s` is now `alethia project %s`", tc.old, tc.current)
			if n := strings.Count(stderr, notice); n != 1 {
				t.Errorf("the deprecation line must appear once on stderr, appeared %d time(s):\n%s", n, stderr)
			}

			applyCommandMeta()
			oldCmd, _, err := rootCmd.Find([]string{"project", tc.old})
			if err != nil || !oldCmd.Hidden {
				t.Errorf("`project %s` must resolve and be hidden (err %v)", tc.old, err)
			}
			currentCmd, _, err := rootCmd.Find([]string{"project", tc.current})
			if err != nil || currentCmd.Hidden || currentCmd.Name() != tc.current {
				t.Errorf("`project %s` must resolve and be listed (err %v)", tc.current, err)
			}
			// The current name says nothing about a rename.
			_, stderr = famRunJSON(t, h, "project", tc.current, "--project", "web", "--dry-run", "--no-input")
			if strings.Contains(stderr, "is now") {
				t.Errorf("`project %s` printed a deprecation line:\n%s", tc.current, stderr)
			}
		})
	}

	help := projectCmd.UsageString()
	for _, name := range []string{"\n  plan ", "\n  apply "} {
		if strings.Contains(help, name) {
			t.Errorf("the project help lists a deprecated name:\n%s", help)
		}
	}
	for _, name := range []string{"\n  preview ", "\n  deploy "} {
		if !strings.Contains(help, name) {
			t.Errorf("the project help does not list %q:\n%s", strings.TrimSpace(name), help)
		}
	}
}

// --- a job that waits on a person ---

// TestProjFamily_AJobAwaitingApprovalReadsAsWaitingOnAPerson pins the approval state. A job the
// control plane holds for approval is not "queued and about to run": the command says a person
// has to approve it and gives the console page to do that on, on stderr for a person and as
// fields for a program.
func TestProjFamily_AJobAwaitingApprovalReadsAsWaitingOnAPerson(t *testing.T) {
	for _, sub := range []string{"deploy", "destroy"} {
		t.Run(sub, func(t *testing.T) {
			s := &projServer{queuedStatus: "AWAITING_APPROVAL"}
			h := projEnv(t, s)
			r, stderr := famRunJSON(t, h, "project", sub, "--project", "web", "--yes", "--no-input")
			obj := famJobs(t, r)
			if len(obj.Jobs) != 1 || !obj.Jobs[0].AwaitingApproval || obj.Jobs[0].Status != "AWAITING_APPROVAL" {
				t.Fatalf("the job must be reported as awaiting approval: %+v", obj.Jobs)
			}
			wantURL := os.Getenv("ALETHIA_WEB_ORIGIN") + "/acme/~/jobs/j1"
			if obj.Jobs[0].ApprovalURL != wantURL {
				t.Errorf("approval_url = %q, want the job's console page %q", obj.Jobs[0].ApprovalURL, wantURL)
			}
			for _, want := range []string{"waiting for a person to approve it", wantURL} {
				if !strings.Contains(stderr, want) {
					t.Errorf("stderr is missing %q:\n%s", want, stderr)
				}
			}
			if strings.Contains(stderr, "Queued") {
				t.Errorf("a job that waits for approval must not read as queued:\n%s", stderr)
			}

			// For a person the same sentence is the result.
			code, stdout, _ := projExitCode(t, h, "project", sub, "--project", "web", "--yes", "--no-input", "--output", "table")
			if code != 0 || !strings.Contains(stdout, "waiting for a person to approve it") {
				t.Errorf("table form: exit %d, stdout %q", code, stdout)
			}
		})
	}
}

// TestProjFamily_AnApprovalWithNoBuildableLinkStillSaysWhereToGo covers the organization that
// cannot be named: the sentence still says the job waits on a person, and points at the console.
func TestProjFamily_AnApprovalWithNoBuildableLinkStillSaysWhereToGo(t *testing.T) {
	p, _, errOut := splitPrinter("table")
	e := projectJobEntry{ID: "j9", Type: "DEPLOY", Status: "pending_approval"}
	announceQueuedJob(p, fakeJobs{}, &e)
	if !e.AwaitingApproval || e.ApprovalURL != "" {
		t.Errorf("entry = %+v, want awaiting approval with no link", e)
	}
	if !strings.Contains(errOut.String(), "approves it in the console") {
		t.Errorf("the notice must still say where to approve:\n%s", errOut.String())
	}
	for status, want := range map[string]bool{
		"AWAITING_APPROVAL": true, "PENDING_APPROVAL": true, "QUEUED": false, "PROCESSING": false, "": false,
	} {
		if got := awaitsApproval(status); got != want {
			t.Errorf("awaitsApproval(%q) = %v, want %v", status, got, want)
		}
	}
}

// TestJobConsoleURL_RefusesAJobWithNoID covers the link that cannot be built from the route: an
// empty id has no page, and the answer is no link rather than a wrong one.
func TestJobConsoleURL_RefusesAJobWithNoID(t *testing.T) {
	projEnv(t, &projServer{})
	if got := jobConsoleURL(fakeJobs{}, ""); got != "" {
		t.Errorf("a job with no id has no page, got %q", got)
	}
}

// --- --wait and --timeout ---

// TestProjFamily_WaitEndsWithTheJobsVerdict pins the three ways a wait ends, on each of the three
// job commands: a job that succeeds is the result, a job that fails exits 13, and a deadline that
// passes exits 12 with the job still running. Each failure names the job.
func TestProjFamily_WaitEndsWithTheJobsVerdict(t *testing.T) {
	for _, sub := range []string{"preview", "deploy", "destroy"} {
		args := []string{"project", sub, "--project", "web", "--wait", "--no-input"}
		if sub != "preview" {
			args = append(args, "--yes")
		}
		t.Run(sub+" succeeds", func(t *testing.T) {
			h := projEnv(t, &projServer{jobStatuses: []string{"PROCESSING", "SUCCESS"}})
			r, _ := famRunJSON(t, h, args...)
			if obj := famJobs(t, r); len(obj.Jobs) != 1 || obj.Jobs[0].Status != "SUCCESS" {
				t.Errorf("a waited job must report its final status: %+v", obj.Jobs)
			}
			code, stdout, _ := projExitCode(t, h, append(args, "--output", "table")...)
			if code != 0 || !strings.Contains(stdout, "job j1 finished") {
				t.Errorf("table form: exit %d, stdout %q", code, stdout)
			}
		})
		t.Run(sub+" fails", func(t *testing.T) {
			h := projEnv(t, &projServer{jobStatuses: []string{"FAILED"}, jobErrMsg: "tofu exploded"})
			code, stdout, stderr := projExitCode(t, h, args...)
			if code != clierr.ExitOperationFailed || stdout != "" {
				t.Errorf("exit %d (want %d), stdout %q", code, clierr.ExitOperationFailed, stdout)
			}
			for _, want := range []string{"tofu exploded", "alethia jobs logs j1"} {
				if !strings.Contains(stderr, want) {
					t.Errorf("stderr is missing %q:\n%s", want, stderr)
				}
			}
		})
		t.Run(sub+" times out", func(t *testing.T) {
			h := projEnv(t, &projServer{jobStatuses: []string{"PROCESSING"}})
			code, stdout, stderr := projExitCode(t, h, append(args, "--timeout", "20ms")...)
			if code != clierr.ExitWaitTimeout || stdout != "" {
				t.Errorf("exit %d (want %d), stdout %q", code, clierr.ExitWaitTimeout, stdout)
			}
			for _, want := range []string{"still running", "alethia jobs logs j1 --follow"} {
				if !strings.Contains(stderr, want) {
					t.Errorf("stderr is missing %q:\n%s", want, stderr)
				}
			}
		})
	}
}

// TestProjFamily_AWaitedJobCarriesItsWarnings pins the `warnings` array of a job entry: a waited
// deploy or preview reports what the job recorded, on stderr for a person and in the result for a
// program; a job that was not waited for, or recorded none, carries an empty array and never null.
func TestProjFamily_AWaitedJobCarriesItsWarnings(t *testing.T) {
	meta := map[string]any{"gitops_status": map[string]any{"manifest_warnings": []any{"add-on loki did not sync"}}}
	for _, sub := range []string{"deploy", "preview"} {
		t.Run(sub, func(t *testing.T) {
			args := []string{"project", sub, "--project", "web", "--no-input"}
			if sub == "deploy" {
				args = append(args, "--yes")
			}
			h := projEnv(t, &projServer{jobStatuses: []string{"SUCCESS"}, jobMeta: meta})
			r, stderr := famRunJSON(t, h, append(args, "--wait")...)
			obj := famJobs(t, r)
			if len(obj.Jobs) != 1 || len(obj.Jobs[0].Warnings) != 1 || obj.Jobs[0].Warnings[0] != "add-on loki did not sync" {
				t.Errorf("a waited %s must carry the job's warnings: %+v", sub, obj.Jobs)
			}
			if !strings.Contains(stderr, "add-on loki did not sync") {
				t.Errorf("the warning is also said on stderr:\n%s", stderr)
			}

			// Not waited for: the array is there and empty.
			r, _ = famRunJSON(t, h, args...)
			if !strings.Contains(string(r.Object), `"warnings": []`) && !strings.Contains(string(r.Object), `"warnings":[]`) {
				t.Errorf("a job that was not waited for must carry an empty warnings array: %s", r.Object)
			}
		})
	}
}

// TestProjFamily_AQueueThatNamesNoJobIsRefused is the same refusal through the command: the
// control plane answered 200 and named no job, so there is nothing to report as queued.
func TestProjFamily_AQueueThatNamesNoJobIsRefused(t *testing.T) {
	h := projEnv(t, &projServer{noJob: true})
	code, stdout, stderr := projExitCode(t, h, "project", "preview", "--project", "web", "--no-input")
	if code != clierr.ExitUnclassified || stdout != "" || !strings.Contains(stderr, "named no job") {
		t.Errorf("exit %d, stdout %q, stderr %q", code, stdout, stderr)
	}
}

// TestProjFamily_AResultThatCannotBeWrittenIsAnError covers the write: a result that could not
// be put on stdout is a failed command, not a success with no output.
func TestProjFamily_AResultThatCannotBeWrittenIsAnError(t *testing.T) {
	cases := [][]string{
		{"project", "preview", "--project", "web"},
		{"project", "create", "api", "--region", "eu-west-1", "--no-manifest"},
		{"project", "env", "add", "staging", "--project", "web"},
		{"project", "component", "add", "--project", "web", "--kind", "databases", "--name", "main"},
		{"project", "component", "remove", "--project", "web", "--kind", "cluster", "--yes"},
	}
	for _, args := range cases {
		t.Run(strings.Join(args[1:3], "_"), func(t *testing.T) {
			h := projEnv(t, &projServer{})
			projClosedStdout(t)
			if !h.run(append(args, "--output", "json", "--no-input")...) {
				t.Errorf("%v should exit when the result cannot be written", args)
			}
		})
	}
}

// --- project destroy ---

// famTypedAnswer makes askLine answer with one fixed line and records what it was asked.
func famTypedAnswer(t *testing.T, answer string, err error) *[]string {
	t.Helper()
	var asked []string
	prev := askLine
	askLine = func(title, description string) (string, error) {
		asked = append(asked, title+"\n"+description)
		return answer, err
	}
	t.Cleanup(func() { askLine = prev })
	return &asked
}

// TestProjDestroy_IsConfirmedByTypingTheProjectsName pins the confirmation of the one thing in
// this group that cannot be undone. The person types the project's NAME; anything else — another
// word, a dismissed prompt — destroys nothing and is not an error.
func TestProjDestroy_IsConfirmedByTypingTheProjectsName(t *testing.T) {
	args := []string{"project", "destroy", "--project-id", "p1", "--runner-id", "r1", "--env", "production"}

	t.Run("the name queues the destroy", func(t *testing.T) {
		s := &projServer{envs: projSampleEnvs()}
		h := projEnv(t, s)
		projTTY(t)
		asked := famTypedAnswer(t, "web", nil)
		if code, _, stderr := projExitCode(t, h, args...); code != 0 {
			t.Fatalf("exited %d:\n%s", code, stderr)
		}
		post, ok := s.lastPost()
		if !ok || post.Body["job_type"] != "DESTROY" {
			t.Fatalf("typing the name must queue the DESTROY, sent %+v", post.Body)
		}
		// The project was given by id, and the person is still asked for its name.
		if len(*asked) != 1 || !strings.Contains((*asked)[0], "Type web to confirm") {
			t.Errorf("the prompt must ask for the project's name: %v", *asked)
		}
	})

	for name, typed := range map[string]string{"another word": "yes", "nothing": "", "the id": "p1"} {
		t.Run(name+" queues nothing", func(t *testing.T) {
			s := &projServer{envs: projSampleEnvs()}
			h := projEnv(t, s)
			projTTY(t)
			famTypedAnswer(t, typed, nil)
			code, stdout, stderr := projExitCode(t, h, args...)
			if code != 0 || stdout != "" {
				t.Errorf("a declined destroy is a quiet no-op: exit %d, stdout %q", code, stdout)
			}
			if !strings.Contains(stderr, "nothing was destroyed") {
				t.Errorf("the decline must be said on stderr:\n%s", stderr)
			}
			if _, ok := s.lastPost(); ok {
				t.Error("a destroy that was not confirmed queued a job")
			}
		})
	}

	t.Run("a dismissed prompt queues nothing", func(t *testing.T) {
		s := &projServer{envs: projSampleEnvs()}
		h := projEnv(t, s)
		projTTY(t)
		famTypedAnswer(t, "web", errors.New("dismissed"))
		if code, _, _ := projExitCode(t, h, args...); code != 0 {
			t.Errorf("a dismissed confirmation is a quiet no-op, exited %d", code)
		}
		if _, ok := s.lastPost(); ok {
			t.Error("a dismissed confirmation queued a job")
		}
	})

	t.Run("a cascade is confirmed the same way", func(t *testing.T) {
		s := &projServer{envs: projSampleEnvs(), destroyTree: boutiqueTree(), cascadeJobs: boutiqueCascadeJobs()}
		h := projEnv(t, s)
		projTTY(t)
		asked := famTypedAnswer(t, "web", nil)
		r, _ := famRunJSON(t, h, append(args, "--cascade")...)
		obj := famJobs(t, r)
		if len(obj.Jobs) != 3 || obj.Jobs[2].ID != "j-owner" || r.Job == nil || r.Job.ID != "j-owner" {
			t.Errorf("a cascade reports every job, the owner last and as the result's job: %+v / %+v", obj.Jobs, r.Job)
		}
		if len(*asked) != 1 || !strings.Contains((*asked)[0], "Will destroy, in order: dev-1") {
			t.Errorf("the cascade's question must show what it destroys: %v", *asked)
		}
	})
}

// TestProjectConfirmName_FallsBackToTheID covers a project the list cannot name: the id is what
// the person types, so the confirmation is never an empty string.
func TestProjectConfirmName_FallsBackToTheID(t *testing.T) {
	lister := projFakeLister{configs: []types.ConfigurationSummary{{ID: "p1", ProjectName: "web"}, {ID: "p2"}}}
	for id, want := range map[string]string{"p1": "web", "p2": "p2", "p9": "p9"} {
		if got := projectConfirmName(lister, id); got != want {
			t.Errorf("projectConfirmName(%q) = %q, want %q", id, got, want)
		}
	}
	if got := projectConfirmName(projFakeLister{err: errBoom}, "p1"); got != "p1" {
		t.Errorf("a failed list must fall back to the id, got %q", got)
	}
}

// --- project create ---

// TestProjCreate_ACloudThatIsNotOfferedIsRefusedInTheServersSentence pins the refusal of a
// project on a cloud this release does not offer. The control plane's sentence is shown as it was
// written — with no wrapper and no status — whichever status carried it, the exit is the usage
// one, and the hint names the clouds that are offered.
func TestProjCreate_ACloudThatIsNotOfferedIsRefusedInTheServersSentence(t *testing.T) {
	const sentence = "Alibaba Cloud is not available in this release."
	for _, status := range []int{500, 400, 409} {
		t.Run(fmt.Sprintf("status %d", status), func(t *testing.T) {
			h := projEnv(t, &projServer{createStatus: status, createMessage: sentence})
			code, stdout, stderr := projExitCode(t, h,
				"project", "create", "api", "--region", "cn-hangzhou", "--cloud-account", "prod-account", "--no-manifest", "--no-input")
			if code != clierr.ExitUsage || stdout != "" {
				t.Errorf("exit %d (want %d), stdout %q", code, clierr.ExitUsage, stdout)
			}
			if !strings.Contains(stderr, sentence) {
				t.Errorf("the server's sentence is not shown:\n%s", stderr)
			}
			for _, unwanted := range []string{"failed to create project", fmt.Sprintf("status %d", status)} {
				if strings.Contains(stderr, unwanted) {
					t.Errorf("the sentence is wrapped in %q:\n%s", unwanted, stderr)
				}
			}
			if !strings.Contains(stderr, enabledCloudList()) {
				t.Errorf("the hint must name the offered clouds (%s):\n%s", enabledCloudList(), stderr)
			}
		})
	}

	// Any other failure of the create keeps the class of the control plane's answer.
	h := projEnv(t, &projServer{createStatus: 409, createMessage: "A project named api already exists"})
	code, _, stderr := projExitCode(t, h,
		"project", "create", "api", "--region", "eu-west-1", "--cloud-account", "prod-account", "--no-manifest", "--no-input")
	if code != clierr.ExitConflict || !strings.Contains(stderr, "failed to create project: A project named api already exists") {
		t.Errorf("exit %d, stderr %q", code, stderr)
	}
}

// TestProjCreate_ADiscoveredManifestIsAnnouncedOnStderrUnderJSON pins where the discovery line
// goes when stdout is a document: stderr. It used to be dropped, which left a scripted run with
// no sign that a file had shaped the project.
func TestProjCreate_ADiscoveredManifestIsAnnouncedOnStderrUnderJSON(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, manifest.FileName), []byte(
		"project: api\ncloud:\n  account: prod-account\n  region: eu-west-1\nenvironments:\n  - name: prod\n    stage: production\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := projEnv(t, &projServer{})
	t.Chdir(dir)
	_, stderr := famRunJSON(t, h, "project", "create", "--no-input")
	if !strings.Contains(stderr, manifest.FileName) || !strings.Contains(stderr, "--no-manifest") {
		t.Errorf("the discovered manifest was not announced on stderr:\n%s", stderr)
	}
}

// TestProjCreate_ABrokenDiscoveredManifestIsAUsageRefusal covers the file nobody named and nobody
// can use: the refusal says it was read from this directory, and exits as a refusal of the input.
func TestProjCreate_ABrokenDiscoveredManifestIsAUsageRefusal(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, manifest.FileName), []byte(
		"project: api\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: prod\n    stage: nope\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := projEnv(t, &projServer{})
	t.Chdir(dir)
	code, stdout, stderr := projExitCode(t, h, "project", "create", "--no-input")
	if code != clierr.ExitUsage || stdout != "" || !strings.Contains(stderr, "was read because no --file was given") {
		t.Errorf("exit %d, stdout %q, stderr %q", code, stdout, stderr)
	}
	// A broken file that WAS named is refused the same way, without the remark.
	code, _, stderr = projExitCode(t, h, "project", "create", "--file", manifest.FileName, "--no-input")
	if code != clierr.ExitUsage || strings.Contains(stderr, "was read because") {
		t.Errorf("a named broken manifest: exit %d, stderr %q", code, stderr)
	}
	code, _, _ = projExitCode(t, h, "project", "create", "--file", "missing.yaml", "--no-input")
	if code != clierr.ExitUsage {
		t.Errorf("a manifest that does not exist: exit %d, want %d", code, clierr.ExitUsage)
	}
}

// --- project design apply ---

// TestProjDesign_ADeclinedRemovalIsAQuietNoOp covers the person who is asked and says no: nothing
// is written and the command does not fail.
func TestProjDesign_ADeclinedRemovalIsAQuietNoOp(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)
	projConfirm(t, false)
	code, stdout, stderr := projExitCode(t, h, "project", "design", "apply", "--project", "web", "--file", famDesignDoc(t))
	if code != 0 || stdout != "" {
		t.Errorf("exit %d, stdout %q", code, stdout)
	}
	if !strings.Contains(stderr, "would DELETE 1 component") {
		t.Errorf("the plan's removals are said on stderr before the question:\n%s", stderr)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, post := range s.posts {
		if !post.DryRun {
			t.Errorf("a declined apply wrote: %s %s", post.Method, post.Path)
		}
	}
}

// TestProjDesign_AFailedApplyKeepsItsClass covers the apply that the control plane refuses after
// the gate let it through: the exit is the class of the answer, not a flattened 1.
func TestProjDesign_AFailedApplyKeepsItsClass(t *testing.T) {
	h := projEnv(t, &projServer{failOnPost: []string{"/design"}})
	code, stdout, stderr := projExitCode(t, h,
		"project", "design", "apply", "--project", "web", "--file", famDesignDoc(t), "--yes", "--no-input")
	if code != clierr.ExitUnavailable || stdout != "" || !strings.Contains(stderr, "failed to apply the design") {
		t.Errorf("exit %d, stdout %q, stderr %q", code, stdout, stderr)
	}
}

// TestErrDesignPreflightUnreadable_NamesAMissingPlan covers a preflight that returned neither a
// plan nor an error: the refusal still has a cause to name.
func TestErrDesignPreflightUnreadable_NamesAMissingPlan(t *testing.T) {
	if got := errDesignPreflightUnreadable(nil).Error(); !strings.Contains(got, "the server returned no plan") {
		t.Errorf("a missing plan must be named: %s", got)
	}
}

// --- project component ---

// famVocabulary is a component registry whose kinds publish their fields, the way the control
// plane's does.
func famVocabulary() componentVocabulary {
	return componentVocabulary{doc: &api.ComponentSchemaDocument{Version: "v-test", Kinds: []api.ComponentSchemaKind{
		{Kind: "cluster", Singleton: true, Fields: []string{"cluster_version", "instance_types"}},
		{Kind: "databases", Fields: []string{"engine", "engine_version"}},
	}}}
}

// TestFieldNameQuestion_OffersTheKindsOwnFields pins the schema-driven half of the component
// form: a kind the registry describes is asked about with a PICKER over its published fields,
// starting on the first, and a kind it does not describe falls back to a text box.
func TestFieldNameQuestion_OffersTheKindsOwnFields(t *testing.T) {
	v := famVocabulary()
	fields := v.fields("cluster")
	if len(fields) != 2 {
		t.Fatalf("the test registry lists %d field(s) for cluster, want two, so this test would assert nothing", len(fields))
	}
	var key string
	if _, ok := fieldNameQuestion(fields, &key).(*huh.Select[string]); !ok {
		t.Error("a kind with published fields must be asked about with a picker")
	}
	if key != fields[0] {
		t.Errorf("the picker must start on the first published field %q, started on %q", fields[0], key)
	}

	key = ""
	if _, ok := fieldNameQuestion(v.fields("not-a-kind"), &key).(*huh.Input); !ok {
		t.Error("a kind the registry does not describe must fall back to a text box")
	}
	if key != "" {
		t.Errorf("the text box must start empty, started on %q", key)
	}
	if got := (componentVocabulary{}).fields("cluster"); len(got) != 0 {
		t.Errorf("an unresolved registry lists no fields, got %v", got)
	}
}

// TestPromptComponentAdd_PassesTheKindsFieldsToTheQuestion pins the wiring: the fields the form
// offers are the ones the registry publishes for the kind that was chosen.
func TestPromptComponentAdd_PassesTheKindsFieldsToTheQuestion(t *testing.T) {
	projTTY(t)
	projForm(t)
	var offered []string
	prevYesNo, prevKV := askYesNo, askKeyValue
	calls := 0
	askYesNo = func(string, string) (bool, error) { calls++; return calls == 1, nil }
	askKeyValue = func(fields []string) (string, string, error) {
		offered = fields
		return "engine", "postgres", nil
	}
	t.Cleanup(func() { askYesNo, askKeyValue = prevYesNo, prevKV })

	v := famVocabulary()
	got, err := promptComponentAdd(&fakeClient{}, v, "web", componentAddSpec{Kind: "databases", Name: "main"})
	if err != nil {
		t.Fatalf("promptComponentAdd: %v", err)
	}
	if strings.Join(offered, ",") != strings.Join(v.fields("databases"), ",") || len(offered) == 0 {
		t.Errorf("the form offered %v, want the registry's fields for databases %v", offered, v.fields("databases"))
	}
	if len(got.Sets) != 1 || got.Sets[0] != "engine=postgres" {
		t.Errorf("the answer was not kept: %v", got.Sets)
	}
}

// --- the selectors ---

// TestFlagRequired_OnlyRenamesAPromptThatCouldNotOpen pins the one translation the family makes
// of a selector's error: "nothing can ask" becomes the input-required refusal naming the flag, and
// every other error is passed through untouched.
func TestFlagRequired_OnlyRenamesAPromptThatCouldNotOpen(t *testing.T) {
	if got := flagRequired(nil, "--project", "x"); got != nil {
		t.Errorf("no error must stay no error, got %v", got)
	}
	if got := flagRequired(errBoom, "--project", "x"); !errors.Is(got, errBoom) || clierr.From(got).Class != clierr.ClassUnclassified {
		t.Errorf("an unrelated error must be passed through, got %v", got)
	}
	for _, cause := range []error{errNoInput, errNoTTY} {
		e := clierr.From(flagRequired(cause, "--project", "alethia project list"))
		if e.Exit != clierr.ExitInputRequired || !strings.Contains(e.Message, "--project is required") ||
			e.Hint != "alethia project list" || !errors.Is(e, cause) {
			t.Errorf("flagRequired(%v) = %+v", cause, e)
		}
	}
}

// TestSelectors_AnEmptyOrganizationNamesTheCommandThatFillsIt pins the two empty states a picker
// can meet: no projects names `alethia up`, and no cloud accounts names the connector command of
// each offered cloud.
func TestSelectors_AnEmptyOrganizationNamesTheCommandThatFillsIt(t *testing.T) {
	h := projEnv(t, &projServer{configs: []map[string]any{}, noIdentities: true})
	projTTY(t)
	projForm(t)

	_, err := selectProject(readTestToken(t, h))
	if e := clierr.From(err); e == nil || e.Exit != clierr.ExitNotFound || !strings.Contains(e.Message, "alethia up") {
		t.Errorf("an organization with no projects: %+v", e)
	}
	_, err = selectCloudIdentity(readTestToken(t, h))
	e := clierr.From(err)
	if e == nil || e.Exit != clierr.ExitNotFound {
		t.Fatalf("an organization with no cloud accounts: %+v", e)
	}
	for _, cloud := range EnabledCloudProviders() {
		if !strings.Contains(e.Message, string(cloud)) {
			t.Errorf("the refusal must name `alethia connector %s`: %s", cloud, e.Message)
		}
	}
	if strings.Contains(e.Message, "alibaba") {
		t.Errorf("the refusal names a cloud that is not offered: %s", e.Message)
	}
}

// readTestToken returns the access token the harness stored, for a test that calls a selector
// directly rather than through the command tree.
func readTestToken(t *testing.T, h projHarness) string {
	t.Helper()
	raw, err := os.ReadFile(h.creds)
	if err != nil {
		t.Fatalf("read credentials: %v", err)
	}
	var creds types.ExchangeResponse
	if err := json.Unmarshal(raw, &creds); err != nil {
		t.Fatalf("decode credentials: %v", err)
	}
	return creds.AccessToken
}

// --- the result renderers ---

// TestProjectJobLine_SaysWhereEachJobStands covers the sentence for each state a job is reported
// in, and that a cascade's job is named with its environment.
func TestProjectJobLine_SaysWhereEachJobStands(t *testing.T) {
	cases := []struct {
		entry projectJobEntry
		want  string
	}{
		{projectJobEntry{ID: "j1", Type: "DEPLOY", Status: "QUEUED"}, "DEPLOY job j1 queued"},
		{projectJobEntry{ID: "j1", Type: "DEPLOY", Status: "SUCCESS"}, "DEPLOY job j1 finished"},
		{projectJobEntry{ID: "j2", Type: "DESTROY", Status: "QUEUED", Environment: "dev-1"}, "DESTROY job j2 (dev-1) queued"},
		{projectJobEntry{ID: "j3", Type: "DEPLOY", Status: "AWAITING_APPROVAL", AwaitingApproval: true, ApprovalURL: "https://c/x"},
			"waiting for a person to approve it. It does not start until someone approves it at https://c/x."},
	}
	for _, tc := range cases {
		if got := projectJobLine(tc.entry); !strings.Contains(got, tc.want) {
			t.Errorf("projectJobLine(%+v) = %q, want it to contain %q", tc.entry, got, tc.want)
		}
	}
}

// TestRunProjectJob_ADryRunNeverReachesTheControlPlane is the dry run below the command: the
// client is one that fails every call, and the result still arrives with the request in it.
func TestRunProjectJob_ADryRunNeverReachesTheControlPlane(t *testing.T) {
	r, err := runProjectJob(context.Background(), testPrinter(io.Discard, "json"), failingJobs{}, projectJobRun{
		Params: api.QueueJobParams{JobType: "DEPLOY", ConfigurationID: "p1", EnvironmentID: "e1", AssignedRunnerID: "r1", PlanJobID: "j0"},
		DryRun: true,
	})
	if err != nil {
		t.Fatalf("a dry run reached the control plane: %v", err)
	}
	obj, ok := r.Object.(projectJobObject)
	if !ok || obj.Request == nil || obj.Request.PlanJobID != "j0" || obj.Request.AssignedRunnerID != "r1" || len(obj.Jobs) != 0 {
		t.Errorf("dry-run object = %+v", r.Object)
	}
	// A real run through the same client surfaces the refusal, and names no job.
	r, err = runProjectJob(context.Background(), testPrinter(io.Discard, "json"), failingJobs{}, projectJobRun{
		Params: api.QueueJobParams{JobType: "DEPLOY", ConfigurationID: "p1"},
	})
	if !errors.Is(err, errBoom) || r.Job != nil {
		t.Errorf("a refused queue call: err %v, job %+v", err, r.Job)
	}
}

// failingJobs is a projectJobClient whose every call fails.
type failingJobs struct{}

func (failingJobs) GetJob(string) (*api.ProvisionJob, error) { return nil, errBoom }
func (failingJobs) Whoami() (*api.WhoAmI, error)             { return nil, errBoom }
func (failingJobs) QueueJobFull(api.QueueJobParams) (*api.QueueJobResponse, error) {
	return nil, errBoom
}

// --- the registry ---

// TestMetaProject_TheFactsMatchTheCommands holds the registry's entries for this family to what
// can be read off the command tree, so a fact that stops being true fails here rather than being
// published in the description of the CLI:
//
//   - a destructive command offers --yes;
//   - a long-running command offers --wait and --timeout;
//   - a command that declares a dry run has the --dry-run flag;
//   - a hidden entry is a hidden command, and nothing else is hidden;
//   - every runnable command has an example, every example is a real invocation of a command of
//     this family with flags that exist, and none carries a placeholder to copy from elsewhere.
func TestMetaProject_TheFactsMatchTheCommands(t *testing.T) {
	applyCommandMeta()
	checked := 0
	for _, m := range metaProject {
		cmd, _, err := rootCmd.Find(strings.Fields(m.Path)[1:])
		if err != nil || cmd.CommandPath() != m.Path {
			t.Errorf("%s does not resolve to its own command (err %v)", m.Path, err)
			continue
		}
		if !cmd.Runnable() {
			continue
		}
		checked++
		has := func(flag string) bool { return cmd.Flags().Lookup(flag) != nil }
		if m.Destructive && !has("yes") {
			t.Errorf("%s is destructive and has no --yes", m.Path)
		}
		if m.LongRunning != (has("wait") && has("timeout")) {
			t.Errorf("%s: long-running is %v, but --wait/--timeout present is %v", m.Path, m.LongRunning, has("wait") && has("timeout"))
		}
		if (m.DryRun == cmdmeta.DryRunClient || m.DryRun == cmdmeta.DryRunServer) != has(cmdmeta.DryRunFlag) {
			t.Errorf("%s: dry-run level %q does not match whether --dry-run exists (%v)", m.Path, m.DryRun, has(cmdmeta.DryRunFlag))
		}
		if cmd.Hidden != m.Hidden {
			t.Errorf("%s: hidden is %v in the tree and %v in the registry", m.Path, cmd.Hidden, m.Hidden)
		}
		if strings.TrimSpace(cmd.Short) == "" || strings.TrimSpace(cmd.Long) == "" {
			t.Errorf("%s has no short or no long description", m.Path)
		}
		if len(m.Examples) == 0 {
			t.Errorf("%s has no example", m.Path)
		}
		for _, ex := range m.Examples {
			checkMetaExample(t, m.Path, ex.Cmd)
		}
	}
	if checked < 14 {
		t.Fatalf("only %d runnable project commands were checked; the family has at least fourteen, so this walk is not seeing the registry", checked)
	}
}

// checkMetaExample resolves one example against the real tree: it must be a runnable command of
// the project family, every flag it passes must exist on that command, its arguments must be ones
// the command accepts, and it must carry no `<placeholder>`.
func checkMetaExample(t *testing.T, path, example string) {
	t.Helper()
	if strings.ContainsAny(example, "<>") {
		t.Errorf("%s: example %q carries a placeholder", path, example)
		return
	}
	tokens := strings.Fields(example)
	if len(tokens) < 3 || tokens[0] != "alethia" || tokens[1] != "project" {
		t.Errorf("%s: example %q is not an `alethia project …` invocation", path, example)
		return
	}
	cmd, rest, err := rootCmd.Find(tokens[1:])
	if err != nil || !cmd.Runnable() {
		t.Errorf("%s: example %q does not resolve to a runnable command (err %v)", path, example, err)
		return
	}
	var args []string
	for i := 0; i < len(rest); i++ {
		tok := rest[i]
		if !strings.HasPrefix(tok, "-") {
			args = append(args, tok)
			continue
		}
		name := strings.TrimLeft(strings.SplitN(tok, "=", 2)[0], "-")
		flag := lookupExampleFlag(cmd, name)
		if flag == nil {
			t.Errorf("%s: example %q passes %s, which `%s` does not take", path, example, tok, cmd.CommandPath())
			return
		}
		// A flag that takes a value consumes the next token.
		if flag.Value.Type() != "bool" && !strings.Contains(tok, "=") {
			i++
		}
	}
	if err := cmd.ValidateArgs(args); err != nil {
		t.Errorf("%s: example %q passes arguments %v that `%s` does not accept: %v", path, example, args, cmd.CommandPath(), err)
	}
}

// lookupExampleFlag finds a flag an example names, by its long name or its shorthand, among the
// command's own flags and the ones it inherits.
func lookupExampleFlag(cmd *cobra.Command, name string) *pflag.Flag {
	for _, set := range []*pflag.FlagSet{cmd.Flags(), cmd.InheritedFlags()} {
		if f := set.Lookup(name); f != nil {
			return f
		}
		if len(name) == 1 {
			if f := set.ShorthandLookup(name); f != nil {
				return f
			}
		}
	}
	return nil
}
