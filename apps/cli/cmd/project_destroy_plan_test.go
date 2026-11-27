// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// Destroy plans (#7455, #7795). A destroy from the CLI is approved against a destroy-mode PLAN job,
// never against the plan the environment was deployed from, and a deploy never applies one. Every
// test below has a wrong answer available: an apply plan where a destroy plan belongs, a destroy
// plan where an apply plan belongs, another environment's plan, or an approval of no plan at all.

// destroyPlanJob is a PLAN job as GET /api/jobs lists it.
func destroyPlanJob(id, env, status string, destroy bool) map[string]any {
	return map[string]any{
		"id": id, "job_type": "PLAN", "status": status, "project_id": "p1", "destroy_plan": destroy,
		"created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
		"config_snapshot": map[string]any{"environment_id": env},
	}
}

// jobShape renders the POST /api/jobs bodies as one line: the job type, `+destroy_plan` on a destroy
// plan and `+approval` on a job sent with the approval.
func jobShape(s *projServer) string {
	var shape []string
	for _, j := range s.jobPosts() {
		mark, _ := j["job_type"].(string)
		if j["destroy_plan"] == true {
			mark += "+destroy_plan"
		}
		if j["approval_id"] == testApprovalID {
			mark += "+approval"
		}
		shape = append(shape, mark)
	}
	return strings.Join(shape, " ")
}

func TestProjDestroy_PlansTheTeardownThenIsApprovedAgainstIt(t *testing.T) {
	fastApprovalPolls(t)
	s := &projServer{envs: projSampleEnvs(), approval: &projApproval{}}
	h := projEnv(t, s)

	code, _, stderr := projExitCode(t, h, "project", "destroy", "--project", "web", "--env", "production", "--yes", "--no-input")
	if code != 0 {
		t.Fatalf("exit %d:\n%s", code, stderr)
	}
	if got := jobShape(s); got != "DESTROY PLAN+destroy_plan DESTROY+approval" {
		t.Errorf("want the destroy refused, a destroy plan made, then the destroy sent with the approval: %s", got)
	}
	plan := s.jobPostsOfType("PLAN")[0]
	if plan["environment_id"] != "e1" || plan["cascade"] != nil {
		t.Errorf("the destroy plan must be of the destroy's own environment, and never a cascade: %+v", plan)
	}
	if len(s.approval.requests) != 1 || s.approval.requests[0]["plan_job_id"] != "j1" || s.approval.requests[0]["operation"] != "destroy" {
		t.Errorf("the destroy must be approved against the destroy plan it just made: %+v", s.approval.requests)
	}
	if !strings.Contains(stderr, "plans the teardown first") {
		t.Errorf("stderr does not say why a plan is queued before a destroy:\n%s", stderr)
	}
}

func TestProjDestroy_LatestPlanTakesThisEnvironmentsDestroyPlan(t *testing.T) {
	fastApprovalPolls(t)
	s := &projServer{envs: projSampleEnvs(), approval: &projApproval{deploys: []map[string]any{
		destroyPlanJob("apply-newest", "e1", "SUCCESS", false),    // an apply plan: never approved for a destroy
		destroyPlanJob("dp-other-env", "e2", "SUCCESS", true),     // another environment's teardown
		destroyPlanJob("dp-processing", "e2", "PROCESSING", true), // ...still running, and still not ours
		destroyPlanJob("dp-e1", "e1", "SUCCESS", true),
	}}}
	h := projEnv(t, s)

	code, _, stderr := projExitCode(t, h, "project", "destroy", "--project", "web", "--latest-plan", "--yes", "--no-input")
	if code != 0 {
		t.Fatalf("exit %d:\n%s", code, stderr)
	}
	if len(s.approval.requests) != 1 || s.approval.requests[0]["plan_job_id"] != "dp-e1" {
		t.Errorf("--latest-plan must take the default environment's destroy plan dp-e1: %+v", s.approval.requests)
	}
	if got := jobShape(s); got != "DESTROY DESTROY+approval" {
		t.Errorf("a named destroy plan is not planned again: %s", got)
	}
	if !strings.Contains(stderr, "approving against") {
		t.Errorf("a destroy plan the CLI chose must be announced:\n%s", stderr)
	}
}

func TestProjDestroy_LatestPlanRefusesARunningOneAndAnAbsentOne(t *testing.T) {
	cases := []struct {
		name string
		jobs []map[string]any
		want string
	}{
		{"running", []map[string]any{destroyPlanJob("dp-e1", "e1", "PROCESSING", true)}, "dp-e1"},
		{"only apply plans", []map[string]any{destroyPlanJob("apply-e1", "e1", "SUCCESS", false)}, "alethia project preview --destroy"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := &projServer{envs: projSampleEnvs(), approval: &projApproval{deploys: tc.jobs}}
			h := projEnv(t, s)
			code, _, stderr := projExitCode(t, h, "project", "destroy", "--project", "web", "--env", "production",
				"--latest-plan", "--yes", "--no-input", "--output", "json")
			if code == 0 {
				t.Fatalf("want a refusal:\n%s", stderr)
			}
			env := lastErrorEnvelope(t, stderr)
			if !strings.Contains(env.Error.Message+" "+env.Error.Hint, tc.want) {
				t.Errorf("error = %+v, want it to name %q", env.Error, tc.want)
			}
			if posts := s.jobPosts(); len(posts) != 0 {
				t.Errorf("a destroy plan that cannot be used must be refused before anything is queued: %+v", posts)
			}
		})
	}
}

func TestProjDestroy_NoWaitNamesTheCommandThatDestroysThatPlan(t *testing.T) {
	s := &projServer{envs: projSampleEnvs(), approval: &projApproval{}}
	h := projEnv(t, s)

	code, _, stderr := projExitCode(t, h, "project", "destroy", "--project", "web", "--env", "production",
		"--plan-job-id", "dp1", "--yes", "--no-input", "--no-wait", "--output", "json")
	if code != clierr.ExitInputRequired {
		t.Fatalf("exit %d, want 9:\n%s", code, stderr)
	}
	env := lastErrorEnvelope(t, stderr)
	if env.Error.Code != clierr.CodeApprovalRequired ||
		!strings.Contains(env.Error.Hint, "alethia project destroy --project web --env production --plan-job-id dp1 --yes") {
		t.Errorf("error = %+v", env.Error)
	}
	if len(s.approval.requests) != 1 || s.approval.requests[0]["plan_job_id"] != "dp1" || s.approval.polls != 0 {
		t.Errorf("want the approval of dp1 asked for and not waited on: %+v, %d polls", s.approval.requests, s.approval.polls)
	}
}

func TestProjDestroy_ADestroyPlanThatFailsDestroysNothing(t *testing.T) {
	fastApprovalPolls(t)
	s := &projServer{envs: projSampleEnvs(), approval: &projApproval{}, jobStatuses: []string{"FAILED"}, jobErrMsg: "provider error"}
	h := projEnv(t, s)

	code, _, stderr := projExitCode(t, h, "project", "destroy", "--project", "web", "--env", "production",
		"--yes", "--no-input", "--output", "json")
	if code != clierr.ExitOperationFailed {
		t.Fatalf("exit %d, want 13:\n%s", code, stderr)
	}
	if env := lastErrorEnvelope(t, stderr); !strings.Contains(env.Error.Message, "destroy plan") ||
		!strings.Contains(env.Error.Message, "nothing was destroyed") {
		t.Errorf("error = %+v", env.Error)
	}
	if len(s.approval.requests) != 0 {
		t.Errorf("a destroy plan that failed must not be put to a person: %+v", s.approval.requests)
	}
	if got := jobShape(s); got != "DESTROY PLAN+destroy_plan" {
		t.Errorf("a failed destroy plan must queue nothing more: %s", got)
	}
}

func TestProjDestroy_RefusesAPlanWithACascadeOrBothForms(t *testing.T) {
	for _, args := range [][]string{
		{"--cascade", "--latest-plan"},
		{"--cascade", "--plan-job-id", "dp1"},
		{"--latest-plan", "--plan-job-id", "dp1"},
	} {
		s := &projServer{envs: projSampleEnvs(), approval: &projApproval{}}
		h := projEnv(t, s)
		argv := append([]string{"project", "destroy", "--project", "web", "--yes", "--no-input"}, args...)
		if code, _, stderr := projExitCode(t, h, argv...); code != clierr.ExitUsage {
			t.Errorf("%v: exit %d, want 8:\n%s", args, code, stderr)
		}
		if posts := s.jobPosts(); len(posts) != 0 {
			t.Errorf("%v queued %+v", args, posts)
		}
	}
}

func TestQueueWithApproval_AnApprovalOfNoPlanIsNeverAskedFor(t *testing.T) {
	approvals := &scriptedApprovals{initial: api.ApprovalStatusApproved}
	p, _ := approvalTestPrinter(Mode{})
	sends := 0
	_, err := queueWithApproval(context.Background(), p, approvals, api.ApprovalOperationDestroy,
		func() (string, error) { return " ", nil }, approvalWait{},
		func(approvalID string) (string, error) {
			sends++
			return "", &api.APIError{StatusCode: 403, Code: clierr.CodeApprovalRequired, Message: "needs approval"}
		})
	if e := clierr.From(err); e == nil || e.Code != clierr.CodeApprovalRequired || !strings.Contains(e.Message, "no plan") {
		t.Errorf("got %v", err)
	}
	if len(approvals.requested) != 0 || sends != 1 {
		t.Errorf("an approval of no plan was asked for (%v), or the job was sent again (%d sends)", approvals.requested, sends)
	}
}

func TestPlanJobToApply_SkipsADestroyPlan(t *testing.T) {
	base := time.Date(2026, 3, 9, 12, 0, 0, 0, time.UTC)
	jobs := append([]api.ProvisionJob{
		// The project's newest PLAN is a destroy plan, still running. A deploy neither applies it
		// nor is refused because of it.
		{ID: "destroy-plan-newest", JobType: string(types.JobTypePlan), Status: string(types.JobStatusProcessing),
			ProjectID: "p-web-0001", ProjectName: "web", DestroyPlan: true, CreatedAt: base.Add(time.Minute)},
	}, planRefJobs()...)
	got, err := planJobToApply(&jobsSelectLister{jobs: jobs}, "p-web-0001", "", true)
	if err != nil {
		t.Fatalf("planJobToApply: %v", err)
	}
	if got.ID != "plan-latest" {
		t.Errorf("resolved %q, want the most recent apply plan plan-latest", got.ID)
	}
}

func TestProjPreview_DestroySendsADestroyPlan(t *testing.T) {
	s := &projServer{envs: projSampleEnvs()}
	h := projEnv(t, s)
	if code, _, stderr := projExitCode(t, h, "project", "plan", "--project", "web", "--env", "production", "--destroy"); code != 0 {
		t.Fatalf("exit %d:\n%s", code, stderr)
	}
	if code, _, stderr := projExitCode(t, h, "project", "preview", "--project", "web", "--env", "production"); code != 0 {
		t.Fatalf("exit %d:\n%s", code, stderr)
	}
	if got := jobShape(s); got != "PLAN+destroy_plan PLAN" {
		t.Errorf("--destroy must send destroy_plan, and only with --destroy: %s", got)
	}

	code, stdout, stderr := projExitCode(t, h, "project", "preview", "--project", "web", "--destroy", "--dry-run", "--output", "json")
	if code != 0 || !strings.Contains(stdout, `"destroy_plan": true`) {
		t.Errorf("a dry run must show the destroy plan it would request: exit %d\n%s\n%s", code, stdout, stderr)
	}
}

func TestQueueJobFull_SendsDestroyPlanOnlyWhenTrue(t *testing.T) {
	s := &projServer{envs: projSampleEnvs()}
	projEnv(t, s)
	c := api.NewClient("t")
	for _, destroy := range []bool{true, false} {
		if _, err := c.QueueJobFull(api.QueueJobParams{JobType: "PLAN", ConfigurationID: "p1", DestroyPlan: destroy}); err != nil {
			t.Fatalf("QueueJobFull: %v", err)
		}
	}
	posts := s.jobPosts()
	if len(posts) != 2 || posts[0]["destroy_plan"] != true {
		t.Fatalf("posts = %+v", posts)
	}
	if _, sent := posts[1]["destroy_plan"]; sent {
		t.Errorf("destroy_plan is sent only when true: %+v", posts[1])
	}
}

// TestProjSampleEnvs_TheDefaultIsE1 keeps the fixture assumption the default-environment test
// above relies on (no --env resolves to e1) stated where it would break.
func TestProjSampleEnvs_TheDefaultIsE1(t *testing.T) {
	if id := projDefaultEnvID(t); id != "e1" {
		t.Fatalf("the default environment is %q; the destroy-plan tests assume e1", id)
	}
}
