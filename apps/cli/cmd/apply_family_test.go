// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/manifest"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The manifest family — `plan`, `apply`, `export` and the `config` verbs — held to the contract
// every command family has: the result on stdout in the format that was asked for, everything said
// about it on stderr, and every failure a classified error with the exit code its class owns.

// errorEnvelope is the alethia.error/v1 object a failure writes on stderr under --output json.
type errorEnvelope struct {
	Error struct {
		Code      string     `json:"code"`
		Class     string     `json:"class"`
		ExitCode  int        `json:"exit_code"`
		Message   string     `json:"message"`
		Hint      string     `json:"hint"`
		Operation *clierr.Op `json:"operation"`
	} `json:"error"`
	Schema string `json:"schema"`
}

// lastErrorEnvelope decodes the last line of stderr as the error object.
func lastErrorEnvelope(t *testing.T, stderr string) errorEnvelope {
	t.Helper()
	lines := strings.Split(strings.TrimSpace(stderr), "\n")
	var env errorEnvelope
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &env); err != nil {
		t.Fatalf("the last line of stderr is not the error object: %v\n%s", err, stderr)
	}
	if env.Schema != clierr.Schema {
		t.Fatalf("the error object does not name its schema: %q", env.Schema)
	}
	return env
}

// ── apply ─────────────────────────────────────────────────────────────────────────────────

// `apply --output json` is the one result shape every mutating command returns, with every key
// present, and a waited deploy carries the warnings it recorded.
func TestApplyFamily_JSONIsTheSharedResultShape(t *testing.T) {
	s := &projServer{envs: applyDemoEnvs(), jobMeta: map[string]any{
		"gitops_status": map[string]any{"manifest_warnings": []any{"external-dns did not sync"}},
	}}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, applyDemoManifest)

	code, stdout, stderr := projExitCode(t, h, "apply", "--file", path, "--yes", "--runner", "primary", "--no-input", "--output", "json")
	if code != 0 {
		t.Fatalf("apply exited %d\n%s", code, stderr)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(stdout), &raw); err != nil {
		t.Fatalf("stdout is not one JSON document: %v\n%s", err, stdout)
	}
	for _, key := range []string{"id", "kind", "action", "job", "dry_run", "object"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("the result has no %q key:\n%s", key, stdout)
		}
	}
	var got applyMutation
	if err := json.Unmarshal([]byte(stdout), &got); err != nil {
		t.Fatal(err)
	}
	if got.ID != "p1" || got.Kind != "project" || got.Action != ResultCreated || got.DryRun {
		t.Errorf("the result is not a created project: %+v", got)
	}
	if got.Job == nil || got.Job.Type != "DEPLOY" || got.Job.ID != got.Object.Jobs[len(got.Object.Jobs)-1].ID {
		t.Errorf("`job` is not the last deploy queued: %+v", got.Job)
	}
	if len(got.Object.Jobs) != 2 {
		t.Fatalf("jobs: %+v", got.Object.Jobs)
	}
	for i, env := range []string{"prod", "dev-1"} {
		j := got.Object.Jobs[i]
		if j.Environment != env || j.Type != "DEPLOY" || j.Status != jobStatusSuccess || j.AwaitingApproval {
			t.Errorf("job %d is not %s's finished deploy: %+v", i, env, j)
		}
		if len(j.Warnings) != 1 || j.Warnings[0] != "external-dns did not sync" {
			t.Errorf("job %d does not carry the deploy's warnings: %+v", i, j.Warnings)
		}
	}
	// Everything said about the run is on stderr, and none of it is in the document.
	for _, said := range []string{"created project boutique", "Deploying prod", "The deploy finished with 1 warning"} {
		if !strings.Contains(stderr, said) || strings.Contains(stdout, said) {
			t.Errorf("%q belongs on stderr and only there\nstdout:\n%s\nstderr:\n%s", said, stdout, stderr)
		}
	}
}

// A run that does not wait names every job it queued, in both forms, and polls nothing.
// `--wait=false` is `--no-wait` under the name every long-running command uses.
func TestApplyFamily_NotWaitingNamesEveryJob(t *testing.T) {
	for _, flag := range []string{"--no-wait", "--wait=false"} {
		t.Run(flag, func(t *testing.T) {
			s := &projServer{envs: applyDemoEnvs()}
			h := applyEnv(t, s)
			path := applyWriteManifest(t, applyDemoManifest)

			code, stdout, stderr := projExitCode(t, h, "apply", "--file", path, "--yes", "--runner", "primary", "--no-input", flag)
			if code != 0 {
				t.Fatalf("apply exited %d\n%s", code, stderr)
			}
			for _, want := range []string{"DEPLOY job j1 (prod) queued", "DEPLOY job j1 (dev-1) queued"} {
				if !strings.Contains(stdout, want) {
					t.Errorf("stdout does not say %q:\n%s", want, stdout)
				}
			}
			if strings.Contains(stdout, "is up.") {
				t.Errorf("a run that did not wait claimed the project is up:\n%s", stdout)
			}
			// The previews are waited for (a deploy applies a reviewed plan); the deploys are not.
			if polls := s.hits("/api/cli/jobs/"); polls != 2 {
				t.Errorf("a run that does not wait polled %d times, want once per preview (2)", polls)
			}

			code, stdout, _ = projExitCode(t, h, "apply", "--file", path, "--yes", "--runner", "primary", "--no-input", flag, "--output", "json")
			got := applyResultOf(t, stdout)
			if code != 0 || len(got.Jobs) != 2 || got.Jobs[0].Status == jobStatusSuccess || len(got.Jobs[0].Warnings) != 0 {
				t.Errorf("exit %d, jobs %+v", code, got.Jobs)
			}
			if got.Jobs[0].Warnings == nil {
				t.Error("warnings is not an array for a job that was not waited for")
			}
		})
	}
}

// The action says what the run did to the project: created it, wrote into it, only deployed it.
func TestApplyResult_ActionAndTheSentence(t *testing.T) {
	job := projectJobEntry{ID: "j1", Type: "DEPLOY", Status: "QUEUED", Environment: "prod"}
	for name, tc := range map[string]struct {
		result ApplyResult
		action ResultAction
		job    bool
		says   string
	}{
		"created":   {ApplyResult{ProjectID: "p1", createdProject: true, Created: []string{"project web"}, Jobs: []projectJobEntry{job}}, ResultCreated, true, "DEPLOY job j1 (prod) queued"},
		"updated":   {ApplyResult{ProjectID: "p1", Created: []string{"prod cluster"}, Jobs: []projectJobEntry{job}}, ResultUpdated, true, "queued"},
		"queued":    {ApplyResult{ProjectID: "p1", Jobs: []projectJobEntry{job}}, ResultQueued, true, "queued"},
		"unchanged": {ApplyResult{ProjectID: "p1"}, ResultUnchanged, false, "No environment was deployed."},
		"finished": {ApplyResult{ProjectID: "p1", Jobs: []projectJobEntry{
			{ID: "j1", Type: "DEPLOY", Status: jobStatusSuccess, Environment: "prod"},
		}}, ResultQueued, true, "web is up."},
	} {
		t.Run(name, func(t *testing.T) {
			m := tc.result.mutation()
			if m.Action != tc.action || (m.Job != nil) != tc.job || m.ID != "p1" || m.Kind != "project" {
				t.Errorf("mutation: %+v", m)
			}
			var buf bytes.Buffer
			renderApplyResult(&buf, "web", &tc.result)
			if !strings.Contains(buf.String(), tc.says) {
				t.Errorf("the sentence does not say %q:\n%s", tc.says, buf.String())
			}
		})
	}
}

// A refusal the CLI decides exits with the code of its class, writes nothing on stdout under json,
// and says what to do next on stderr.
func TestApplyFamily_RefusalsAreClassified(t *testing.T) {
	path := applyWriteManifest(t, applyDemoManifest)
	for name, tc := range map[string]struct {
		args []string
		exit int
		code string
		says string
	}{
		"nobody can confirm":       {[]string{"apply", "--file", path}, clierr.ExitInputRequired, clierr.CodeConfirmationRequired, "pass --yes"},
		"an unknown --env":         {[]string{"apply", "--file", path, "--yes", "--env", "nope"}, clierr.ExitUsage, clierr.CodeInvalidFlag, "nope"},
		"a --timeout that is not":  {[]string{"apply", "--file", path, "--yes", "--timeout", "soon"}, clierr.ExitUsage, clierr.CodeInvalidFlag, "--timeout"},
		"a negative --timeout":     {[]string{"apply", "--file", path, "--yes", "--timeout", "-5m"}, clierr.ExitUsage, clierr.CodeInvalidFlag, "--timeout"},
		"--timeout with --no-wait": {[]string{"apply", "--file", path, "--yes", "--timeout", "5m", "--no-wait"}, clierr.ExitUsage, clierr.CodeInvalidUsage, "--no-wait"},
		"an unknown runner":        {[]string{"apply", "--file", path, "--yes", "--runner", "nope"}, clierr.ExitNotFound, clierr.CodeNotFound, "primary"},
		"no file":                  {[]string{"apply", "--file", filepath.Join(t.TempDir(), "none.yaml"), "--yes"}, clierr.ExitUnclassified, codeManifestNotFound, "alethia init"},
		"plan with no file":        {[]string{"plan", "--file", filepath.Join(t.TempDir(), "none.yaml")}, clierr.ExitUnclassified, codeManifestNotFound, "alethia init"},
		"plan of a file that is not valid": {[]string{"plan", "--file", applyWriteManifest(t, "project: boutique\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: qa\n")},
			clierr.ExitUnclassified, codeManifestInvalid, "stage"},
	} {
		t.Run(name, func(t *testing.T) {
			s := &projServer{envs: applyDemoEnvs()}
			h := applyEnv(t, s)
			code, stdout, stderr := projExitCode(t, h, append(tc.args, "--no-input", "--output", "json")...)
			if code != tc.exit {
				t.Errorf("exit %d, want %d\n%s", code, tc.exit, stderr)
			}
			if stdout != "" {
				t.Errorf("a refusal wrote on stdout:\n%s", stdout)
			}
			env := lastErrorEnvelope(t, stderr)
			if env.Error.Code != tc.code || env.Error.ExitCode != tc.exit || !strings.Contains(env.Error.Message+env.Error.Hint, tc.says) {
				t.Errorf("error = %+v, want code %s saying %q", env.Error, tc.code, tc.says)
			}
			if len(s.posts) != 0 {
				t.Errorf("a refused run wrote to the control plane: %+v", s.posts)
			}
		})
	}
}

// A zero or empty --timeout is no deadline, and a duration is read as one.
func TestApplyTimeout(t *testing.T) {
	for raw, want := range map[string]time.Duration{"": 0, "0": 0, "0s": 0, "90s": 90 * time.Second, "1h30m": 90 * time.Minute} {
		if got, err := applyTimeout(raw, false); err != nil || got != want {
			t.Errorf("applyTimeout(%q) = %v, %v; want %v", raw, got, err, want)
		}
	}
	// A zero deadline says nothing about waiting, so --no-wait does not contradict it.
	if _, err := applyTimeout("0", true); err != nil {
		t.Errorf("--timeout 0 --no-wait was refused: %v", err)
	}
}

// The deadline is over the whole run. When it passes the deploy keeps running: the command exits
// 12, the error names the job and the environments that were never queued, and the partial result
// on stdout still names the job.
func TestApplyFamily_ATimeoutExitsTwelveAndNamesWhatIsLeft(t *testing.T) {
	s := &projServer{envs: applyDemoEnvs(), jobStatuses: []string{"RUNNING"}}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, applyDemoManifest)

	code, stdout, stderr := projExitCode(t, h, "apply", "--file", path, "--yes", "--runner", "primary", "--no-input", "--timeout", "40ms", "--output", "json")
	if code != clierr.ExitWaitTimeout {
		t.Fatalf("exit %d, want %d\n%s", code, clierr.ExitWaitTimeout, stderr)
	}
	got := applyResultOf(t, stdout)
	if len(got.Jobs) != 1 || got.Jobs[0].Environment != "prod" || got.Jobs[0].ID != "j1" {
		t.Errorf("the partial result does not name the one deploy that was queued: %+v", got.Jobs)
	}
	env := lastErrorEnvelope(t, stderr)
	if env.Error.Code != clierr.CodeWaitTimeout || env.Error.Operation == nil || env.Error.Operation.ID != "j1" {
		t.Errorf("error = %+v", env.Error)
	}
	for _, want := range []string{"timed out after 40ms", "the deploy of prod", "still running", "Not deployed", "dev-1"} {
		if !strings.Contains(env.Error.Message, want) {
			t.Errorf("the message does not say %q: %s", want, env.Error.Message)
		}
	}
	if !strings.Contains(env.Error.Hint, "alethia jobs logs j1") {
		t.Errorf("the hint does not name the command that follows the job: %q", env.Error.Hint)
	}
	if deploys := len(s.jobPostsOfType("DEPLOY")); deploys != 1 {
		t.Errorf("%d deploys were queued; the second environment must wait for the first", deploys)
	}
}

// A deploy that finishes failed exits 13 through the one fatal path, with the job in the error.
func TestApplyFamily_AFailedDeployExitsThirteen(t *testing.T) {
	s := &projServer{envs: applyDemoEnvs(), jobStatuses: []string{"RUNNING", "FAILED"}, jobErrMsg: "quota exceeded"}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, applyDemoManifest)

	code, _, stderr := projExitCode(t, h, "apply", "--file", path, "--yes", "--runner", "primary", "--no-input", "--output", "json")
	env := lastErrorEnvelope(t, stderr)
	if code != clierr.ExitOperationFailed || env.Error.Code != clierr.CodeOperationFailed {
		t.Fatalf("exit %d, error %+v", code, env.Error)
	}
	if !strings.Contains(env.Error.Message, "deploy prod") || !strings.Contains(env.Error.Message, "quota exceeded") ||
		env.Error.Operation == nil || !strings.Contains(env.Error.Hint, "alethia jobs logs") {
		t.Errorf("the error does not name the environment, the reason and the job: %+v", env.Error)
	}
}

// waitingClient is an applyClient for the deploy half alone: it queues a job and reports it running.
type waitingClient struct {
	applyClient
	queued int
}

// QueueJobWithParams queues the next job. A preview is not counted: it is the plan a deploy applies.
func (c *waitingClient) QueueJobWithParams(p api.QueueJobParams) (*api.ProvisionJob, error) {
	if p.JobType == string(types.JobTypePlan) {
		return &api.ProvisionJob{ID: "plan-1", Status: string(types.JobStatusQueued)}, nil
	}
	c.queued++
	return &api.ProvisionJob{ID: "j1", Status: string(types.JobStatusQueued)}, nil
}

// GetJob reports a preview as succeeded and the deploy as running.
func (c *waitingClient) GetJob(id string) (*api.ProvisionJob, error) {
	if id == "plan-1" {
		return &api.ProvisionJob{ID: id, Status: string(types.JobStatusSuccess)}, nil
	}
	return &api.ProvisionJob{ID: "j1", Status: "RUNNING"}, nil
}

// An interrupt ends the wait as an interrupt: exit 130, the job named, nothing more queued.
func TestExecuteApply_AnInterruptEndsTheWait(t *testing.T) {
	prev := jobPollInterval
	jobPollInterval = time.Millisecond
	t.Cleanup(func() { jobPollInterval = prev })

	plan := &ApplyPlan{
		Manifest:  &manifest.Manifest{Project: "web"},
		ProjectID: "p1",
		Environments: []EnvPlan{
			{Name: "prod", ID: "e1", Action: ActionUnchanged, Deploy: true},
			{Name: "dev", ID: "e2", Action: ActionUnchanged, Deploy: true},
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	c := &waitingClient{}
	var out bytes.Buffer
	p := &Printer{Out: &out, Err: &out, Format: ui.FormatTable}
	result, err := executeApply(ctx, c, p, plan, "", waitFlags{Wait: true})
	e := clierr.From(err)
	if e == nil || e.Exit != clierr.ExitInterrupted || e.Operation == nil || e.Operation.ID != "j1" {
		t.Fatalf("an interrupted wait must exit 130 and name the job: %+v", e)
	}
	if !strings.Contains(e.Message, "deploy prod") || !strings.Contains(e.Message, "Not deployed") || !strings.Contains(e.Message, "dev") {
		t.Errorf("the message does not say what was left: %s", e.Message)
	}
	if c.queued != 1 || result == nil || len(result.Jobs) != 1 {
		t.Errorf("queued %d jobs, result %+v", c.queued, result)
	}
}

// deployWaitError keeps the class of the wait's own ending, and adds what it leaves undone only
// when something is left.
func TestDeployWaitError(t *testing.T) {
	failed := clierr.New(clierr.CodeOperationFailed, "job failed: quota")
	failed.Operation = &clierr.Op{ID: "j9", Type: "DEPLOY"}
	last := clierr.From(deployWaitError(failed, "dev", 0, nil))
	if last.Exit != clierr.ExitOperationFailed || last.Message != "deploy dev: job failed: quota" {
		t.Errorf("the last environment's failure gained a tail: %+v", last)
	}
	plain := clierr.From(deployWaitError(errors.New("failed to poll job status: boom"), "dev", time.Minute, []string{"qa"}))
	if plain.Exit != clierr.ExitUnclassified || !strings.Contains(plain.Message, "Not deployed, because the deploys run in order: qa") {
		t.Errorf("a failed poll: %+v", plain)
	}
}

// A deploy held for an approval is said to wait on a person, with the console page to approve it
// at — on stderr for a person, and as two fields of the job for a program.
func TestApplyFamily_ADeployWaitingForApprovalSaysSo(t *testing.T) {
	s := &projServer{envs: applyDemoEnvs(), queuedStatus: jobStatusAwaitingApproval}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, applyDemoManifest)

	code, stdout, stderr := projExitCode(t, h, "apply", "--file", path, "--yes", "--runner", "primary", "--no-input", "--no-wait", "--output", "json")
	if code != 0 {
		t.Fatalf("apply exited %d\n%s", code, stderr)
	}
	got := applyResultOf(t, stdout)
	for _, j := range got.Jobs {
		if !j.AwaitingApproval || !strings.HasSuffix(j.ApprovalURL, "/acme/~/jobs/"+j.ID) {
			t.Errorf("the job does not say it waits for approval, or where: %+v", j)
		}
	}
	if !strings.Contains(stderr, "is waiting for a person to approve it") || !strings.Contains(stderr, "/acme/~/jobs/j1") {
		t.Errorf("stderr does not say the deploy waits on a person, with the page:\n%s", stderr)
	}
	if strings.Contains(stderr, "Deploying prod") {
		t.Errorf("a job that is held was announced as deploying:\n%s", stderr)
	}

	// For a person, the result line says the same thing instead of "queued".
	_, stdout, _ = projExitCode(t, h, "apply", "--file", path, "--yes", "--runner", "primary", "--no-input", "--no-wait")
	if !strings.Contains(stdout, "is waiting for a person to approve it") || strings.Contains(stdout, "j1 (prod) queued") {
		t.Errorf("the result reads as queued:\n%s", stdout)
	}
}

// While it waits, an apply says once that the job is held, and carries on by itself when the job
// is approved and runs.
func TestApplyFamily_TheWaitGoesThroughAnApproval(t *testing.T) {
	s := &projServer{envs: applyDemoEnvs(), jobStatuses: []string{
		jobStatusAwaitingApproval, jobStatusAwaitingApproval, "SUCCESS",
	}}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, applyDemoManifest)

	code, stdout, stderr := projExitCode(t, h, "apply", "--file", path, "--yes", "--runner", "primary", "--no-input", "--env", "prod", "--output", "json")
	if code != 0 {
		t.Fatalf("apply exited %d\n%s", code, stderr)
	}
	if n := strings.Count(stderr, "is waiting for approval"); n != 1 {
		t.Errorf("the held state was said %d times, want once:\n%s", n, stderr)
	}
	if got := applyResultOf(t, stdout); len(got.Jobs) != 1 || got.Jobs[0].Status != jobStatusSuccess || got.Jobs[0].AwaitingApproval {
		t.Errorf("jobs: %+v", got.Jobs)
	}
}

// A runner that does not take the project's cloud is never assigned: named, it is refused before
// anything is written; unnamed, the only online runner is passed over and the job is left for the
// server to place.
func TestApplyFamily_TheRunnerMustTakeTheProjectsCloud(t *testing.T) {
	gcpOnly := []map[string]any{
		{"id": "r1", "name": "gcp-box", "operator": "self", "status": "ONLINE", "supported_providers": []string{"gcp"}},
	}
	path := applyWriteManifest(t, applyDemoManifest)

	s := &projServer{envs: applyDemoEnvs(), runners: gcpOnly}
	h := applyEnv(t, s)
	code, stdout, stderr := projExitCode(t, h, "apply", "--file", path, "--yes", "--runner", "gcp-box", "--no-input", "--output", "json")
	env := lastErrorEnvelope(t, stderr)
	if code != clierr.ExitConflict || stdout != "" || env.Error.Code != clierr.CodeConflict {
		t.Fatalf("exit %d, stdout %q, error %+v", code, stdout, env.Error)
	}
	if !strings.Contains(env.Error.Message, `runner "gcp-box" does not take aws jobs (it takes gcp)`) || !strings.Contains(env.Error.Hint, "alethia runner list") {
		t.Errorf("the refusal does not name the runner, the cloud and the next step: %+v", env.Error)
	}
	if len(s.posts) != 0 {
		t.Errorf("a refused runner still let the apply write: %+v", s.posts)
	}

	s = &projServer{envs: applyDemoEnvs(), runners: gcpOnly}
	h = applyEnv(t, s)
	if code, _, stderr := projExitCode(t, h, "apply", "--file", path, "--yes", "--no-input", "--no-wait"); code != 0 {
		t.Fatalf("apply exited %d\n%s", code, stderr)
	}
	for _, p := range s.posts {
		if p.Path == "/api/jobs" && p.Body["assigned_runner_id"] != nil {
			t.Errorf("the deploy was assigned to a runner that does not take aws jobs: %+v", p.Body)
		}
	}
}

// The runner rule, on the three lists that decide it.
func TestApplyRunner_ByCloud(t *testing.T) {
	hygCliConfirmSetNoInput(t, true)
	mixed := applyRunnerFake{runners: []api.Runner{
		{ID: "r1", Name: "aws-box", Status: runnerStatusOnline, SupportedProviders: []string{"aws"}},
		{ID: "r2", Name: "gcp-box", Status: runnerStatusOnline, SupportedProviders: []string{"gcp"}},
		{ID: "r3", Name: "any-box", Status: "OFFLINE"},
	}}
	// Two are online and one of them takes aws jobs: that one, without a question.
	if id, err := applyRunner(mixed, "tok", "", "aws"); err != nil || id != "r1" {
		t.Errorf("aws: got %q, %v", id, err)
	}
	// None takes azure jobs: unassigned.
	if id, err := applyRunner(mixed, "tok", "", "azure"); err != nil || id != "" {
		t.Errorf("azure: got %q, %v", id, err)
	}
	// A runner that lists no cloud takes every one, and a named runner may be offline: the job
	// waits for it.
	if id, err := applyRunner(mixed, "tok", "any-box", "azure"); err != nil || id != "r3" {
		t.Errorf("a runner with no cloud list: got %q, %v", id, err)
	}
	// Named by id, the same refusal as by name.
	if _, err := applyRunner(mixed, "tok", "r2", "aws"); clierr.From(err).Exit != clierr.ExitConflict {
		t.Errorf("a named runner on another cloud must be a conflict: %v", err)
	}
	// An unknown cloud (a file that names no account) rules no runner out.
	if err := runnerTakesCloud(mixed.runners, "r2", ""); err != nil {
		t.Errorf("an unknown cloud ruled a runner out: %v", err)
	}
	if err := runnerTakesCloud(mixed.runners, "", "aws"); err != nil {
		t.Errorf("\"any available\" was refused: %v", err)
	}
}

// When the server refuses a change, the command leaves with the class of that refusal — a conflict
// stays a conflict — and the sentence lists every refused change.
func TestApplyFamily_ARefusedChangeKeepsItsClass(t *testing.T) {
	s := &projServer{
		envs: []map[string]any{
			{"id": "e1", "name": "production", "stage": "production", "placement_mode": "dedicated", "status": "ACTIVE", "is_default": true},
		},
		comps: []map[string]any{
			{"id": "c1", "kind": "databases", "name": "orders", "status": "ACTIVE", "config": map[string]any{"engine": "postgres", "engine_version": "15"}},
		},
		failOnPost: []string{"/components/databases/orders"},
	}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: production\n    stage: production\n    components:\n      databases:\n        - name: orders\n          engine_version: \"16\"\n")

	code, stdout, stderr := projExitCode(t, h, "apply", "--file", path, "--yes", "--runner", "primary", "--no-wait", "--no-input", "--output", "json")
	env := lastErrorEnvelope(t, stderr)
	if code != clierr.ExitUnavailable || env.Error.ExitCode != code {
		t.Fatalf("exit %d, error %+v: a 500 from the server is the unavailable class", code, env.Error)
	}
	if !strings.Contains(env.Error.Message, "1 component not updated") || !strings.Contains(env.Error.Message, "production databases/orders") || env.Error.Hint == "" {
		t.Errorf("the error does not list the refused change and a next step: %+v", env.Error)
	}
	if got := applyResultOf(t, stdout); len(got.Errors) != 1 || len(got.Jobs) != 0 {
		t.Errorf("the partial result: %+v", got)
	}
}

// ── plan ──────────────────────────────────────────────────────────────────────────────────

// A plan that apply would refuse prints the whole plan on stdout, the refusal on stderr as the
// error object with the code plan_refused, and keeps its own exit code.
func TestPlanFamily_ARefusalIsOnStderrInEveryFormat(t *testing.T) {
	s := &projServer{envs: []map[string]any{
		{"id": "e1", "name": "production", "stage": "production", "placement_mode": "dedicated", "status": "ACTIVE", "is_default": true},
	}}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: production\n    stage: staging\n")

	code, stdout, stderr := projExitCode(t, h, "plan", "--file", path, "--no-input", "--output", "json")
	var plan ApplyPlan
	if err := json.Unmarshal([]byte(stdout), &plan); err != nil || len(plan.Environments) != 1 || len(plan.Environments[0].Problems) != 1 {
		t.Fatalf("stdout is not the whole plan: %v\n%s", err, stdout)
	}
	env := lastErrorEnvelope(t, stderr)
	if code != exitPlanRefused || env.Error.Code != codePlanRefused || env.Error.ExitCode != exitPlanRefused || env.Error.Hint == "" {
		t.Errorf("exit %d, error %+v", code, env.Error)
	}

	code, _, stderr = projExitCode(t, h, "plan", "--file", path, "--no-input", "--output", "json", "--detailed-exitcode")
	if env := lastErrorEnvelope(t, stderr); code != exitPlanProblems || env.Error.ExitCode != exitPlanProblems {
		t.Errorf("--detailed-exitcode: exit %d, error says %d", code, env.Error.ExitCode)
	}

	code, stdout, stderr = projExitCode(t, h, "plan", "--file", path, "--no-input")
	if code != exitPlanRefused || !strings.Contains(stdout, "Reading alethia.yaml") || strings.Contains(stdout, "cannot be applied as written") {
		t.Errorf("exit %d; the plan belongs on stdout and the refusal does not:\n%s", code, stdout)
	}
	if !strings.Contains(stderr, "cannot be applied as written") || !strings.Contains(stderr, "hint") {
		t.Errorf("stderr does not carry the refusal and a next step:\n%s", stderr)
	}
}

// What the file leaves out is unmanaged and never a removal, and the plan says the rule once, only
// when it listed something.
func TestRenderPlan_SaysTheUnmanagedRuleOnce(t *testing.T) {
	m, err := manifest.Parse([]byte("project: p\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n"))
	if err != nil {
		t.Fatal(err)
	}
	m.Normalize()
	render := func(p *ApplyPlan) string {
		var buf bytes.Buffer
		renderPlan(&buf, p)
		return buf.String()
	}
	env := EnvPlan{Name: "prod", Placement: "dedicated", Action: ActionUnchanged, Deploy: true}

	nothing := render(&ApplyPlan{Manifest: m, ProjectID: "p1", Environments: []EnvPlan{env}})
	if strings.Contains(nothing, "unmanaged") {
		t.Errorf("a plan with nothing left out talks about unmanaged things:\n%s", nothing)
	}

	withAddon := env
	withAddon.UnmanagedAddons = []string{"loki"}
	for name, plan := range map[string]*ApplyPlan{
		"an environment": {Manifest: m, ProjectID: "p1", Unmanaged: []string{"staging", "qa"}, Environments: []EnvPlan{env}},
		"an add-on":      {Manifest: m, ProjectID: "p1", Environments: []EnvPlan{withAddon}},
	} {
		out := render(plan)
		if strings.Count(out, unmanagedRule) != 1 {
			t.Errorf("%s: the rule must be said exactly once:\n%s", name, out)
		}
		if !strings.Contains(out, "left alone (unmanaged)") {
			t.Errorf("%s: what was left out is not listed as unmanaged:\n%s", name, out)
		}
		for _, verb := range []string{"- ", "remove", "delete", "destroy"} {
			for _, line := range strings.Split(out, "\n") {
				if line == "  "+unmanagedRule {
					continue
				}
				if strings.HasPrefix(strings.TrimSpace(line), verb) || (verb != "- " && strings.Contains(strings.ToLower(line), verb)) {
					t.Errorf("%s: a plan line reads as a removal: %q", name, line)
				}
			}
		}
	}
}

// ── export and config ─────────────────────────────────────────────────────────────────────

// familyCLI runs the real command tree against a control plane that is one handler, with an
// isolated home, and returns each run's exit code and what it wrote on each stream.
func familyCLI(t *testing.T, handler http.HandlerFunc) func(args ...string) (code int, stdout, stderr string) {
	t.Helper()
	credsPath := isolatedHome(t)
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: makeToken(t, time.Now().Add(time.Hour)), RefreshToken: "r"}); err != nil {
		t.Fatal(err)
	}
	if err := types.SaveCliConfig(types.CliConfig{ActiveOrgID: "o1", ActiveOrgName: "Acme", ActiveOrgSlug: "acme"}); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
	resetFlagsAroundTest(t)
	prevExit := exitFunc
	exitFunc = func(code int) { panic(projExit{code}) }
	t.Cleanup(func() { exitFunc = prevExit })

	return func(args ...string) (code int, stdout, stderr string) {
		stdout, stderr = captureStreams(t, func() {
			defer func() {
				if r := recover(); r != nil {
					pe, ok := r.(projExit)
					if !ok {
						panic(r)
					}
					code = pe.code
				}
			}()
			resetAllFlags()
			execRootArgs(args)
			if err := rootCmd.Execute(); err != nil {
				t.Errorf("execute %v: %v", args, err)
			}
		})
		return code, stdout, stderr
	}
}

// consoleDocument is the design document the fake control plane exports.
const consoleDocument = `{"project":"web","environment":"staging"}`

// consoleExportPlane serves the one route `export --format console-json` reads, and records the
// environment each request asked for.
func consoleExportPlane(asked *[]string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/export") {
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "Project \"nope\" not found"})
			return
		}
		if strings.Contains(r.URL.Path, "/nope/") {
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "Project \"nope\" not found"})
			return
		}
		*asked = append(*asked, r.URL.Query().Get("env"))
		_ = json.NewEncoder(w).Encode(map[string]string{"content": consoleDocument, "filename": "web.json", "format": "json"})
	}
}

// `config export` is the old name of `export --format console-json`: hidden, one line on stderr,
// and the same bytes on stdout in every form.
func TestExportFamily_ConfigExportIsTheOldNameOfConsoleJSON(t *testing.T) {
	var asked []string
	run := familyCLI(t, consoleExportPlane(&asked))

	if !configExportCmd.Hidden {
		t.Error("config export is listed")
	}
	for _, form := range [][]string{
		{"--no-input"},
		{"--no-input", "--output", "json"},
		{"--no-input", "--env", "staging"},
	} {
		newCode, newOut, newErr := run(append([]string{"export", "web", "--format", "console-json"}, form...)...)
		oldCode, oldOut, oldErr := run(append([]string{"config", "export", "web"}, form...)...)
		if newCode != 0 || oldCode != 0 {
			t.Fatalf("%v: exits %d and %d\n%s\n%s", form, newCode, oldCode, newErr, oldErr)
		}
		if newOut != oldOut || newOut == "" {
			t.Errorf("%v: the two names wrote different documents:\n%q\n%q", form, newOut, oldOut)
		}
		if newErr != "" {
			t.Errorf("%v: the current name wrote on stderr: %q", form, newErr)
		}
		if len(strings.Fields(strings.ReplaceAll(strings.TrimSpace(oldErr), " ", "_"))) != 1 ||
			!strings.Contains(oldErr, "`alethia config export` is now `alethia export --format console-json`") {
			t.Errorf("%v: the old name must say so in exactly one stderr line: %q", form, oldErr)
		}
	}
	if got := strings.Join(asked, ","); got != ",,,,staging,staging" {
		t.Errorf("the environments asked for: %q", got)
	}

	_, raw, _ := run("export", "web", "--format", "console-json", "--no-input")
	if raw != consoleDocument+"\n" {
		t.Errorf("stdout is not the document and nothing else: %q", raw)
	}
	_, wrapped, _ := run("export", "web", "--format", "console-json", "--no-input", "--output", "json")
	var envelope api.ConfigurationExport
	if err := json.Unmarshal([]byte(wrapped), &envelope); err != nil || envelope.Content != consoleDocument || envelope.Format != "json" {
		t.Errorf("--output json is not the export object: %v\n%s", err, wrapped)
	}
}

// --out writes the document to a file and says so on stderr, leaving stdout empty. The current
// name does not replace a file without --force; the old name always did.
func TestExportFamily_ConsoleJSONToAFile(t *testing.T) {
	var asked []string
	run := familyCLI(t, consoleExportPlane(&asked))
	path := filepath.Join(t.TempDir(), "web.json")

	code, stdout, stderr := run("export", "web", "--format", "console-json", "--out", path, "--no-input")
	if code != 0 || stdout != "" || !strings.Contains(stderr, "Wrote "+path) {
		t.Fatalf("exit %d, stdout %q, stderr %q", code, stdout, stderr)
	}
	if got, err := os.ReadFile(path); err != nil || string(got) != consoleDocument {
		t.Errorf("the file is not the document: %q, %v", got, err)
	}

	code, stdout, stderr = run("export", "web", "--format", "console-json", "--out", path, "--no-input")
	if code != clierr.ExitConflict || stdout != "" || !strings.Contains(stderr, "already exists") || !strings.Contains(stderr, "--force") {
		t.Errorf("an existing file: exit %d, stdout %q, stderr %q", code, stdout, stderr)
	}
	if code, _, _ := run("export", "web", "--format", "console-json", "--out", path, "--force", "--no-input"); code != 0 {
		t.Errorf("--force did not replace the file: exit %d", code)
	}
	if code, _, _ := run("config", "export", "web", "--out", path, "--no-input"); code != 0 {
		t.Errorf("the old name stopped replacing an existing file: exit %d", code)
	}
}

// The refusals of `export`, each with the exit code of its class, nothing on stdout, and the
// error object on stderr.
func TestExportFamily_RefusalsAreClassified(t *testing.T) {
	var asked []string
	run := familyCLI(t, consoleExportPlane(&asked))
	existing := filepath.Join(t.TempDir(), manifest.FileName)
	if err := os.WriteFile(existing, []byte("project: kept\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "link.yaml")
	if err := os.Symlink(existing, link); err != nil {
		t.Fatal(err)
	}
	for name, tc := range map[string]struct {
		args []string
		exit int
		code string
		says string
	}{
		"--env with --all":          {[]string{"export", "web", "--env", "prod", "--all"}, clierr.ExitUsage, clierr.CodeInvalidUsage, "not both"},
		"a format that is not one":  {[]string{"export", "web", "--format", "toml"}, clierr.ExitUsage, clierr.CodeInvalidFlag, "yaml or console-json"},
		"--all with console-json":   {[]string{"export", "web", "--all", "--format", "console-json"}, clierr.ExitUsage, clierr.CodeInvalidUsage, "--env, not --all"},
		"a file that exists":        {[]string{"export", "web", "--all", "--out", existing}, clierr.ExitConflict, clierr.CodeAlreadyExists, "--force"},
		"a symbolic link":           {[]string{"export", "web", "--all", "--out", link, "--force"}, clierr.ExitConflict, clierr.CodeConflict, "symbolic link"},
		"no project and no one":     {[]string{"export"}, clierr.ExitInputRequired, clierr.CodeInputRequired, "alethia export NAME"},
		"the old name, no project":  {[]string{"config", "export"}, clierr.ExitInputRequired, clierr.CodeInputRequired, "alethia export NAME"},
		"a project that is not one": {[]string{"export", "nope", "--format", "console-json"}, clierr.ExitNotFound, clierr.CodeNotFound, "alethia project list"},
	} {
		t.Run(name, func(t *testing.T) {
			code, stdout, stderr := run(append(tc.args, "--no-input", "--output", "json")...)
			env := lastErrorEnvelope(t, stderr)
			if code != tc.exit || stdout != "" || env.Error.Code != tc.code || !strings.Contains(env.Error.Message+env.Error.Hint, tc.says) {
				t.Errorf("exit %d (want %d), stdout %q, error %+v", code, tc.exit, stdout, env.Error)
			}
		})
	}
	if got, _ := os.ReadFile(existing); string(got) != "project: kept\n" {
		t.Errorf("a refused export changed the file: %q", got)
	}
}

// Through the command: the file's first line names its schema, a project or an environment that is
// not there is the not-found class with the list of what is, and several environments with nobody
// to ask is the input-required class naming both flags.
func TestExportFamily_TheManifestThroughTheCommand(t *testing.T) {
	run := exportCLI(t)
	out, exited := run("export", "web", "--env", "prod", "--no-input")
	if exited || !strings.HasPrefix(out, manifestSchemaComment+"\n") {
		t.Fatalf("line 1 is not the schema comment:\n%s", out)
	}
	if !strings.HasSuffix(manifestSchemaComment, manifestSchemaURL) || !strings.HasPrefix(manifestSchemaComment, "# yaml-language-server: $schema=https://") {
		t.Errorf("the schema comment is not the one a YAML language server reads: %q", manifestSchemaComment)
	}
	// The line is a comment to the file's own reader.
	if _, err := manifest.Parse([]byte(out)); err != nil {
		t.Errorf("the exported file does not read back: %v", err)
	}

	f := exportServer(t)
	for name, tc := range map[string]struct {
		o    exportOptions
		exit int
		says string
	}{
		"a project that is not there":      {exportOptions{project: "nope", all: true}, clierr.ExitNotFound, `project "nope" not found`},
		"an environment that is not there": {exportOptions{project: "web", env: "nope"}, clierr.ExitNotFound, `environment "nope" not found`},
		"several environments, nobody":     {exportOptions{project: "web"}, clierr.ExitInputRequired, "--env <name>"},
	} {
		hygCliConfirmSetNoInput(t, true)
		err := runExport(f, &bytes.Buffer{}, &bytes.Buffer{}, tc.o, promptExportEnvironment)
		e := clierr.From(err)
		if e == nil || e.Exit != tc.exit || !strings.Contains(e.Message, tc.says) || e.Hint == "" {
			t.Errorf("%s: %+v", name, e)
		}
	}
	// A read that fails is not a "not found": it keeps what it was.
	if err := exportNotFound(errBoom); err != errBoom {
		t.Errorf("an unrelated error was reclassified: %v", err)
	}
}

// A file `init` authors opens with the same line an exported one does, and `plan` reads it.
func TestInitFamily_TheAuthoredFileNamesItsSchema(t *testing.T) {
	s := &projServer{}
	h := upEnv(t, s)
	dir := chdirTo(t)
	if h.run("init", "--web-origin", WebOrigin(), "--project", "boutique",
		"--region", "eu-west-1", "--cloud-account", "prod-account", "--no-input") {
		t.Fatal("init exited fatally")
	}
	path := filepath.Join(dir, manifest.FileName)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(raw), manifestSchemaComment+"\nproject: boutique\n") {
		t.Errorf("line 1 of the authored file is not the schema comment:\n%s", raw)
	}
	if manifest.SchemaComment != manifestSchemaComment {
		t.Errorf("init and export name different schemas: %q and %q", manifest.SchemaComment, manifestSchemaComment)
	}
	if code, _, stderr := projExitCode(t, h, "plan", "--file", path, "--no-input"); code != 0 {
		t.Errorf("plan refuses the file init wrote: exit %d\n%s", code, stderr)
	}
}

// A document written to a stream that fails is reported, not swallowed.
func TestRunConsoleExport_AFailedWriteIsReported(t *testing.T) {
	var asked []string
	srv := httptest.NewServer(consoleExportPlane(&asked))
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	p := &Printer{Out: failWriter{}, Err: &bytes.Buffer{}, Format: ui.FormatTable}
	if err := runConsoleExport(api.NewClient("tok"), p, consoleExport{project: "web", contentFormat: "json"}); err == nil {
		t.Error("a failed write of the document was not reported")
	}
	dir := t.TempDir()
	if err := runConsoleExport(api.NewClient("tok"), p, consoleExport{project: "web", out: filepath.Join(dir, "no", "such", "x.json")}); err == nil || !strings.Contains(err.Error(), "write ") {
		t.Errorf("a file that cannot be written: %v", err)
	}
}

// The config verbs: each prints one JSON document under --output json, and the two that write
// print the shared result shape and say when nothing changed.
func TestConfigFamily_JSONShapes(t *testing.T) {
	run := familyCLI(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) })

	code, stdout, stderr := run("config", "--output", "json")
	var view configView
	if err := json.Unmarshal([]byte(stdout), &view); code != 0 || err != nil || view.ActiveOrgName != "Acme" || view.WebOriginSource != string(types.WebOriginFromEnv) || stderr != "" {
		t.Errorf("config: exit %d, %v, %+v, stderr %q", code, err, view, stderr)
	}

	code, stdout, _ = run("config", "get", "--output", "json")
	var all map[string]string
	if err := json.Unmarshal([]byte(stdout), &all); code != 0 || err != nil || all["active-org"] != "Acme" || all["web-origin"] == "" {
		t.Errorf("config get: exit %d, %v, %v", code, err, all)
	}
	if code, stdout, _ := run("config", "get", "active-org"); code != 0 || stdout != "Acme\n" {
		t.Errorf("config get KEY must print the bare value: exit %d, %q", code, stdout)
	}

	type setResult struct {
		ID     string       `json:"id"`
		Kind   string       `json:"kind"`
		Action ResultAction `json:"action"`
		Job    *JobRef      `json:"job"`
		DryRun bool         `json:"dry_run"`
		Object configChange `json:"object"`
	}
	decode := func(doc string) setResult {
		t.Helper()
		var r setResult
		if err := json.Unmarshal([]byte(doc), &r); err != nil {
			t.Fatalf("not the result shape: %v\n%s", err, doc)
		}
		return r
	}
	code, stdout, stderr = run("config", "set", "web-origin", "https://alethia.example.com/", "--output", "json")
	first := decode(stdout)
	if code != 0 || first.ID != "web-origin" || first.Kind != "config" || first.Action != ResultUpdated || first.Job != nil ||
		first.Object.Value != "https://alethia.example.com" || first.Object.Previous != "" {
		t.Errorf("config set: exit %d, %+v", code, first)
	}
	// The environment outranks the file here, and the write says so: on stderr and in the result.
	if first.Object.Shadowed == "" || !strings.Contains(stderr, "$ALETHIA_WEB_ORIGIN") || strings.Contains(stdout, "⚠") {
		t.Errorf("the shadowing was not reported on both: %+v\n%s", first.Object, stderr)
	}
	_, stdout, _ = run("config", "set", "web-origin", "https://alethia.example.com", "--output", "json")
	if again := decode(stdout); again.Action != ResultUnchanged || again.Object.Previous != again.Object.Value {
		t.Errorf("setting the same value again must be unchanged: %+v", again)
	}
	if _, stdout, _ := run("config", "set", "web-origin", "https://alethia.example.com"); !strings.Contains(stdout, "Nothing changed") {
		t.Errorf("a person is not told nothing changed: %q", stdout)
	}
	if _, stdout, _ := run("config", "set", "web-origin", "https://other.example.com"); !strings.Contains(stdout, "web-origin set to https://other.example.com") {
		t.Errorf("a person is not told what was set: %q", stdout)
	}

	type clearResult struct {
		ID     string         `json:"id"`
		Kind   string         `json:"kind"`
		Action ResultAction   `json:"action"`
		Object clearedContext `json:"object"`
	}
	var cleared clearResult
	code, stdout, _ = run("config", "clear-context", "--output", "json")
	if err := json.Unmarshal([]byte(stdout), &cleared); code != 0 || err != nil || cleared.Action != ResultUpdated ||
		cleared.Kind != "config" || cleared.ID != "active-org" || cleared.Object.ActiveOrgName != "Acme" || cleared.Object.ActiveOrgID != "o1" {
		t.Errorf("clear-context: exit %d, %v, %+v", code, err, cleared)
	}
	if cfg := types.LoadCliConfig(); cfg.ActiveOrgID != "" || cfg.ActiveOrgSlug != "" || cfg.WebOrigin != "https://other.example.com" {
		t.Errorf("clear-context must clear the organization and nothing else: %+v", cfg)
	}
	_, stdout, _ = run("config", "clear-context", "--output", "json")
	if err := json.Unmarshal([]byte(stdout), &cleared); err != nil || cleared.Action != ResultUnchanged {
		t.Errorf("clearing a clear context must be unchanged: %v, %+v", err, cleared)
	}
	if _, stdout, _ := run("config", "clear-context"); !strings.Contains(stdout, "Nothing changed") {
		t.Errorf("a person is not told nothing changed: %q", stdout)
	}
}

// The refusals of the config verbs: a usage error is 8, a value nobody can be asked for is 9, and
// neither writes on stdout or to the config file.
func TestConfigFamily_RefusalsAreClassified(t *testing.T) {
	run := familyCLI(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) })
	before := types.LoadCliConfig()
	for name, tc := range map[string]struct {
		args []string
		exit int
		code string
		says string
	}{
		"get a key that is not one": {[]string{"config", "get", "colour"}, clierr.ExitUsage, clierr.CodeInvalidUsage, "web-origin, active-org"},
		"set a key that is not one": {[]string{"config", "set", "colour", "blue"}, clierr.ExitUsage, clierr.CodeInvalidUsage, "alethia config get"},
		"set a read-only key":       {[]string{"config", "set", "active-org", "acme"}, clierr.ExitUsage, clierr.CodeInvalidUsage, "alethia org switch"},
		"set a value that is not":   {[]string{"config", "set", "web-origin", "ftp://nope"}, clierr.ExitUsage, clierr.CodeValidationFailed, "invalid web-origin"},
		"set with nothing to set":   {[]string{"config", "set"}, clierr.ExitInputRequired, clierr.CodeInputRequired, "alethia config set"},
		"set with no value":         {[]string{"config", "set", "web-origin"}, clierr.ExitInputRequired, clierr.CodeInputRequired, "<value>"},
	} {
		t.Run(name, func(t *testing.T) {
			code, stdout, stderr := run(append(tc.args, "--no-input", "--output", "json")...)
			env := lastErrorEnvelope(t, stderr)
			if code != tc.exit || stdout != "" || env.Error.Code != tc.code || !strings.Contains(env.Error.Message+env.Error.Hint, tc.says) {
				t.Errorf("exit %d (want %d), stdout %q, error %+v", code, tc.exit, stdout, env.Error)
			}
		})
	}
	if after := types.LoadCliConfig(); after != before {
		t.Errorf("a refused command changed the config: %+v, was %+v", after, before)
	}
}

// A config file that cannot be saved fails the two commands that write it, with the reason.
func TestConfigFamily_AFailedSaveIsReported(t *testing.T) {
	isolatedHome(t)
	path, err := types.CliConfigPath()
	if err != nil {
		t.Fatal(err)
	}
	// A directory where the file should be: the save cannot replace it.
	if err := os.MkdirAll(filepath.Join(path, "in-the-way"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := setConfigValue("web-origin", "https://alethia.example.com"); err == nil || !strings.Contains(err.Error(), "failed to save config") {
		t.Errorf("config set: %v", err)
	}
	if _, err := clearActiveOrg(); err == nil || !strings.Contains(err.Error(), "failed to clear context") {
		t.Errorf("config clear-context: %v", err)
	}
}

// ── the node shape ────────────────────────────────────────────────────────────────────────

// A node shape that cannot be read is a usage error with an example of one that can.
func TestNodeShape_ABadFlagIsAUsageError(t *testing.T) {
	for _, bad := range [][2]string{{"", "big"}, {"", "0x16"}, {"", "4x9000"}, {"", "axb"}, {"t3.large", "4x16"}} {
		_, err := nodeShapeFrom(bad[0], bad[1])
		e := clierr.From(err)
		if e == nil || e.Exit != clierr.ExitUsage || e.Code != clierr.CodeInvalidFlag || !strings.Contains(e.Hint, "--node-size 4x16") {
			t.Errorf("nodeShapeFrom(%q, %q): %+v", bad[0], bad[1], e)
		}
	}
}

// ── the registry ──────────────────────────────────────────────────────────────────────────

// The facts the registry records about the family are the ones the commands have, every command
// has help and an example, and every example is an invocation the tree accepts.
func TestMetaManifest_TheFactsMatchTheCommands(t *testing.T) {
	applyCommandMeta()
	checked := 0
	for _, m := range metaManifest {
		tokens := strings.Fields(m.Path)[1:]
		cmd, _, err := rootCmd.Find(tokens)
		if err != nil || cmd.CommandPath() != m.Path {
			t.Errorf("%s does not resolve to its own command (err %v)", m.Path, err)
			continue
		}
		checked++
		has := func(flag string) bool { return cmd.Flags().Lookup(flag) != nil }
		if m.LongRunning != (has("wait") && has("timeout")) {
			t.Errorf("%s: long-running is %v, but --wait/--timeout present is %v", m.Path, m.LongRunning, has("wait") && has("timeout"))
		}
		if m.Destructive {
			t.Errorf("%s is recorded as destructive; nothing in this family removes anything", m.Path)
		}
		if (m.DryRun == cmdmeta.DryRunClient || m.DryRun == cmdmeta.DryRunServer) != has(cmdmeta.DryRunFlag) {
			t.Errorf("%s: dry-run level %q does not match whether --dry-run exists", m.Path, m.DryRun)
		}
		if cmd.Hidden != m.Hidden {
			t.Errorf("%s: hidden is %v in the tree and %v in the registry", m.Path, cmd.Hidden, m.Hidden)
		}
		if strings.TrimSpace(cmd.Short) == "" || len(strings.TrimSpace(cmd.Long)) < 80 {
			t.Errorf("%s has no short description, or a long one that says nothing", m.Path)
		}
		if strings.Contains(strings.ToLower(cmd.Long+cmd.Short), "alibaba") {
			t.Errorf("%s: the help names a cloud that is not offered", m.Path)
		}
		if len(m.Examples) == 0 {
			t.Errorf("%s has no example", m.Path)
		}
		for _, ex := range m.Examples {
			checkManifestExample(t, m.Path, ex.Cmd)
		}
		if got := cmd.Example; got == "" {
			t.Errorf("%s: the examples were not written onto the command", m.Path)
		}
	}
	if checked != 8 {
		t.Fatalf("%d commands were checked; the family has eight", checked)
	}
	// What each command writes is its own fact: the documents are documents.
	for path, want := range map[string]cmdmeta.Output{
		"alethia export": cmdmeta.OutputDocument, "alethia config export": cmdmeta.OutputDocument,
		"alethia plan": cmdmeta.OutputTable, "alethia apply": cmdmeta.OutputTable,
	} {
		for _, m := range metaManifest {
			if m.Path == path && m.Output != want {
				t.Errorf("%s writes a %s, recorded as %s", path, want, m.Output)
			}
		}
	}
}

// checkManifestExample resolves one example against the real tree: it must be a runnable command,
// every flag it passes must exist on that command, its arguments must be ones the command accepts,
// and it must carry no placeholder.
func checkManifestExample(t *testing.T, path, example string) {
	t.Helper()
	if strings.ContainsAny(example, "<>") {
		t.Errorf("%s: example %q carries a placeholder", path, example)
		return
	}
	tokens := strings.Fields(example)
	if len(tokens) < 2 || tokens[0] != "alethia" {
		t.Errorf("%s: example %q is not an alethia invocation", path, example)
		return
	}
	cmd, rest, err := rootCmd.Find(tokens[1:])
	if err != nil || !cmd.Runnable() || cmd.Hidden {
		t.Errorf("%s: example %q does not resolve to a listed, runnable command (err %v)", path, example, err)
		return
	}
	var args []string
	for i := 0; i < len(rest); i++ {
		tok := rest[i]
		if !strings.HasPrefix(tok, "--") {
			args = append(args, tok)
			continue
		}
		name, _, hasValue := strings.Cut(strings.TrimPrefix(tok, "--"), "=")
		flag := cmd.Flags().Lookup(name)
		if flag == nil {
			flag = cmd.InheritedFlags().Lookup(name)
		}
		if flag == nil {
			t.Errorf("%s: example %q passes --%s, which %s does not have", path, example, name, cmd.CommandPath())
			continue
		}
		if !hasValue && flag.Value.Type() != "bool" {
			i++ // the next token is this flag's value
		}
	}
	if cmd.Args != nil {
		if err := cmd.Args(cmd, args); err != nil {
			t.Errorf("%s: example %q passes arguments the command refuses: %v", path, example, err)
		}
	}
}
