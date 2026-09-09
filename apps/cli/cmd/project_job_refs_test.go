// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The two references `project plan` and `project apply` used to demand as opaque ids: the runner
// (whose sibling `alethia apply --runner` already took a name) and the plan job (which had no
// name, no --latest and no picker, so applying a reviewed plan meant pasting a uuid between two
// commands).
//
// The runner half is resolution the group already owned — runnerIDFrom, tested in
// cov_runners_test.go — so what is pinned here is that these two commands are WIRED to it and
// refuse the same way. The plan half is new, and every one of its refusals is a decision:
//
//   - the narrowing is by job TYPE, because the project's most recent job is as likely to be the
//     DEPLOY that followed the plan as the plan itself;
//   - the narrowing is NOT by status, because skipping a plan that is still running would reach
//     past the plan the caller just queued and apply an older one;
//   - a resolved job is ANNOUNCED, because a CLI that chose for you and did not say which is the
//     silent pass-through resolveProjectName exists to prevent.

// planRefJobs is a page of jobs as the server orders it — newest first — arranged so that every
// one of those decisions has a wrong answer available to be caught by.
//
// For project p-web-0001 the newest job is a DEPLOY, so a resolver that ignored --type PLAN would
// return `deploy-newest`. Behind it is a PLAN that SUCCEEDED. Another project's PLAN sits at the
// very top, so a resolver that ignored the project would return that one.
func planRefJobs() []api.ProvisionJob {
	base := time.Date(2026, 3, 9, 12, 0, 0, 0, time.UTC)
	return []api.ProvisionJob{
		{ID: "plan-other-project", JobType: string(types.JobTypePlan), Status: string(types.JobStatusSuccess),
			ProjectID: "p-data-0002", ProjectName: "data-platform", CreatedAt: base},
		{ID: "deploy-newest", JobType: string(types.JobTypeDeploy), Status: string(types.JobStatusSuccess),
			ProjectID: "p-web-0001", ProjectName: "web", CreatedAt: base.Add(-time.Minute)},
		{ID: "plan-latest", JobType: string(types.JobTypePlan), Status: string(types.JobStatusSuccess),
			ProjectID: "p-web-0001", ProjectName: "web", CreatedAt: base.Add(-time.Hour)},
		{ID: "plan-older", JobType: string(types.JobTypePlan), Status: string(types.JobStatusSuccess),
			ProjectID: "p-web-0001", ProjectName: "web", CreatedAt: base.Add(-2 * time.Hour)},
	}
}

// TestPlanJobToApply_TakesThePlanAndNotTheNewerDeploy is the load-bearing one. `deploy-newest` is
// this project's most recent job; `plan-latest` is its most recent PLAN. An unscoped "latest job"
// resolver returns the first and reports success, and the DEPLOY's id as a plan reference is a
// wrong answer nothing downstream can distinguish from a right one.
func TestPlanJobToApply_TakesThePlanAndNotTheNewerDeploy(t *testing.T) {
	f := &jobsSelectLister{jobs: planRefJobs()}
	got, err := planJobToApply(f, "p-web-0001", "", true)
	if err != nil {
		t.Fatalf("planJobToApply: %v", err)
	}
	if got.ID == "deploy-newest" {
		t.Fatal("resolved the DEPLOY that followed the plan — the --type PLAN narrowing is not applied")
	}
	if got.ID != "plan-latest" {
		t.Errorf("resolved %q, want the project's most recent PLAN job plan-latest", got.ID)
	}
}

// TestPlanJobToApply_StaysInsideTheNamedProject pins the other narrowing. `plan-other-project` is
// the newest PLAN in the org and belongs to somebody else's project; resolving it would queue a
// deploy that fails on a configuration-hash mismatch a long way from its cause.
func TestPlanJobToApply_StaysInsideTheNamedProject(t *testing.T) {
	f := &jobsSelectLister{jobs: planRefJobs()}
	got, err := planJobToApply(f, "p-web-0001", "", true)
	if err != nil {
		t.Fatalf("planJobToApply: %v", err)
	}
	if got.ID == "plan-other-project" {
		t.Fatal("resolved another project's PLAN — the project narrowing is not applied")
	}
}

// TestPlanJobToApply_AnnouncesTheJobItChose pins that the CHOSEN case carries a summary.
// announceResolvedJob prints only when one is set, so an empty summary here is not a cosmetic
// miss — it is the command silently applying a plan the operator never named.
func TestPlanJobToApply_AnnouncesTheJobItChose(t *testing.T) {
	f := &jobsSelectLister{jobs: planRefJobs()}
	got, err := planJobToApply(f, "p-web-0001", "", true)
	if err != nil {
		t.Fatalf("planJobToApply: %v", err)
	}
	if got.Summary == "" {
		t.Fatal("a job the CLI chose must be announced; an empty summary prints nothing")
	}
	// The label is the one `jobs list` and the picker render, so the reader recognises it.
	if want := jobOptionLabel(planRefJobs()[2]); got.Summary != want {
		t.Errorf("summary %q, want the shared job label %q", got.Summary, want)
	}
}

// TestPlanJobToApply_RefusesAPlanThatDidNotSucceed pins the status rule in BOTH halves: the most
// recent PLAN is the answer whatever its status, and a non-SUCCESS one is refused by name rather
// than skipped.
//
// Skipping is the tempting version and it is wrong: `project plan` then `project apply
// --latest-plan` while the plan is still PROCESSING would silently apply `plan-older`, a plan the
// operator never reviewed. That is the handoff this feature removes, one step worse.
func TestPlanJobToApply_RefusesAPlanThatDidNotSucceed(t *testing.T) {
	jobs := planRefJobs()
	jobs[2].Status = string(types.JobStatusProcessing)
	f := &jobsSelectLister{jobs: jobs}

	got, err := planJobToApply(f, "p-web-0001", "", true)
	if err == nil {
		t.Fatalf("a plan that has not succeeded must be refused, resolved %q", got.ID)
	}
	if got.ID == "plan-older" {
		t.Fatal("reached past the running plan to an older one — that applies a plan nobody reviewed")
	}
	for _, want := range []string{"plan-latest", string(types.JobStatusProcessing), "--plan-job-id"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal must name %q so it is actionable: %v", want, err)
		}
	}
}

// TestPlanJobToApply_NoPlanForThisProject pins the empty case: a refusal that says what to run,
// not an empty plan reference that quietly deploys without one.
func TestPlanJobToApply_NoPlanForThisProject(t *testing.T) {
	jobs := planRefJobs()
	f := &jobsSelectLister{jobs: jobs[:2]} // another project's PLAN, and this project's DEPLOY

	got, err := planJobToApply(f, "p-web-0001", "", true)
	if err == nil {
		t.Fatalf("no PLAN for this project must be refused, resolved %q", got.ID)
	}
	if !strings.Contains(err.Error(), "alethia project plan") {
		t.Errorf("the refusal must name the command that produces one: %v", err)
	}
}

// TestPlanJobToApply_TheIDFormIsPassedThroughUnresolved pins that a caller who already holds an
// id still gets it, and pays for no listing call.
func TestPlanJobToApply_TheIDFormIsPassedThroughUnresolved(t *testing.T) {
	f := &jobsSelectLister{jobs: planRefJobs()}
	got, err := planJobToApply(f, "p-web-0001", "job-i-already-have", false)
	if err != nil {
		t.Fatalf("planJobToApply: %v", err)
	}
	if got.ID != "job-i-already-have" {
		t.Errorf("the raw id form is the server's to reject, got %q", got.ID)
	}
	if got.Summary != "" {
		t.Errorf("an id the caller typed must not be announced back at them, got %q", got.Summary)
	}
	if f.calls != 0 {
		t.Errorf("the id form must make no listing call, made %d", f.calls)
	}
}

// TestPlanJobToApply_NeitherFormAttachesNoPlan pins the DEFAULT, which is the common path and is
// deliberately not "resolve the latest plan anyway".
//
// A plan reference is a MODE, not a hint: the runner refuses a deploy whose plan did not succeed
// or whose configuration moved, and the console's build-then-deploy routing is gated on there
// being no plan job. Attaching one to a caller who did not ask changes both.
func TestPlanJobToApply_NeitherFormAttachesNoPlan(t *testing.T) {
	f := &jobsSelectLister{jobs: planRefJobs()}
	got, err := planJobToApply(f, "p-web-0001", "", false)
	if err != nil {
		t.Fatalf("planJobToApply: %v", err)
	}
	if got.ID != "" {
		t.Errorf("no plan flag must attach no plan, got %q", got.ID)
	}
	if f.calls != 0 {
		t.Errorf("the default must make no listing call, made %d", f.calls)
	}
}

// TestPlanJobToApply_RefusesBothFormsOfOnePlan — the same discipline runnerIDFrom and
// projectIDForJob apply: two inputs naming one field is a mistake visible in the flags alone.
func TestPlanJobToApply_RefusesBothFormsOfOnePlan(t *testing.T) {
	f := &jobsSelectLister{jobs: planRefJobs()}
	_, err := planJobToApply(f, "p-web-0001", "job-i-already-have", true)
	if err == nil {
		t.Fatal("--plan-job-id and --latest-plan name the same field; precedence would hide the wrong belief")
	}
	for _, want := range []string{"--plan-job-id", "--latest-plan"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal must name %q: %v", want, err)
		}
	}
	if f.calls != 0 {
		t.Errorf("the mistake is visible in the flags alone; it made %d listing call(s)", f.calls)
	}
}

// TestPlanJobToApply_NeedsAProject pins the guard behind the narrowing. The selector's project
// field matches an id by PREFIX, and every string has the empty string as a prefix — so without
// this refusal `--latest-plan` with no project resolves whatever PLAN ran most recently anywhere
// in the organization.
func TestPlanJobToApply_NeedsAProject(t *testing.T) {
	f := &jobsSelectLister{jobs: planRefJobs()}
	got, err := planJobToApply(f, "", "", true)
	if err == nil {
		t.Fatalf("--latest-plan with no project must be refused, resolved %q", got.ID)
	}
	if got.ID == "plan-other-project" {
		t.Fatal("matched every job in the org — an empty id is a prefix of all of them")
	}
	if !strings.Contains(err.Error(), "--project") {
		t.Errorf("the refusal must name the flag that fixes it: %v", err)
	}
	if f.calls != 0 {
		t.Errorf("the refusal is decidable without the server; it made %d listing call(s)", f.calls)
	}
}

// TestPlanJobToApply_AListingFailureSurfaces pins that an unreachable server is an error and not
// an empty result — "no plan job" and "we could not ask" have different next steps.
func TestPlanJobToApply_AListingFailureSurfaces(t *testing.T) {
	f := &jobsSelectLister{err: errBoom}
	if _, err := planJobToApply(f, "p-web-0001", "", true); err == nil {
		t.Fatal("a listing failure must surface, not resolve to no plan")
	}
}

// --- the commands are wired to the resolvers ---

// TestProjApply_RunnerNameReachesTheQueuedJob is the end-to-end for the second defect: a NAME on
// the command line arrives at the server as the runner's id. `primary` is r1 in the fake control
// plane's runner list.
func TestProjApply_RunnerNameReachesTheQueuedJob(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	if h.run("project", "apply", "--project", "web", "--runner", "primary", "--output", "json") {
		t.Fatal("project apply --runner exited fatally")
	}
	if projectApplyRunnerID != "r1" {
		t.Errorf("--runner primary resolved to %q, want the runner's id r1", projectApplyRunnerID)
	}
	post, ok := s.lastPost()
	if !ok {
		t.Fatal("no job was queued")
	}
	if got := post.Body["assigned_runner_id"]; got != "r1" {
		t.Errorf("the queued job carries assigned_runner_id %v, want r1", got)
	}
}

// TestProjPlan_RunnerNameReachesTheQueuedJob is the same wiring on `project plan`, which is the
// other half of the pair and had the same defect.
func TestProjPlan_RunnerNameReachesTheQueuedJob(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	if h.run("project", "plan", "--project", "web", "--runner", "primary", "--output", "json") {
		t.Fatal("project plan --runner exited fatally")
	}
	if projectPlanRunnerID != "r1" {
		t.Errorf("--runner primary resolved to %q, want the runner's id r1", projectPlanRunnerID)
	}
}

// TestProjApply_UnknownRunnerNameIsFatal pins the refusal arm rather than a pass-through: a name
// nothing matches must stop the command, not queue an unassigned job that looks like success.
func TestProjApply_UnknownRunnerNameIsFatal(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	if !h.run("project", "apply", "--project", "web", "--runner", "no-such-box", "--output", "json") {
		t.Error("an unknown runner name should exit rather than queue an unassigned job")
	}
	if _, ok := s.lastPost(); ok {
		t.Error("a job was queued despite the runner name resolving to nothing")
	}
}

// TestProjPlan_UnknownRunnerNameIsFatal — the same on `plan`.
func TestProjPlan_UnknownRunnerNameIsFatal(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	if !h.run("project", "plan", "--project", "web", "--runner", "no-such-box", "--output", "json") {
		t.Error("an unknown runner name should exit rather than queue an unassigned job")
	}
	if _, ok := s.lastPost(); ok {
		t.Error("a job was queued despite the runner name resolving to nothing")
	}
}

// TestProjApply_RefusesBothPlanFormsThroughTheCommand pins that the resolver's refusal reaches
// the exit code, and that nothing is queued before it does.
func TestProjApply_RefusesBothPlanFormsThroughTheCommand(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	if !h.run("project", "apply", "--project", "web", "--plan-job-id", "j0", "--latest-plan", "--output", "json") {
		t.Error("--plan-job-id with --latest-plan should exit")
	}
	if _, ok := s.lastPost(); ok {
		t.Error("a job was queued despite the plan reference being refused")
	}
}

// TestProjApply_LatestPlanWithNoPlanJobIsFatal drives the resolution through the real command
// against a control plane whose job list is empty, so the refusal is reached from the flag rather
// than from a unit call.
func TestProjApply_LatestPlanWithNoPlanJobIsFatal(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	if !h.run("project", "apply", "--project", "web", "--latest-plan", "--output", "json") {
		t.Error("--latest-plan with no PLAN job should exit rather than deploy without one")
	}
	if _, ok := s.lastPost(); ok {
		t.Error("a job was queued despite --latest-plan resolving to nothing")
	}
}
