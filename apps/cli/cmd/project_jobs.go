// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/routing"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
)

// The three project commands that queue a job — `preview` (a PLAN), `deploy` (a DEPLOY) and
// `destroy` (a DESTROY) — share everything after their own gate: the request, the dry run, the
// queued-job notice, the wait and the result. This file is that shared half, so the three cannot
// come to print a job, wait on one or fail on one in three different ways.

// projectJobClient is what a job-queuing project command asks the control plane.
type projectJobClient interface {
	jobPoller
	orgSlugFetcher
	QueueJobFull(params api.QueueJobParams) (*api.QueueJobResponse, error)
}

// projectJobResolver is what resolving a job command's references reads: the projects, the
// runners and a project's environments.
type projectJobResolver interface {
	projectLister
	runnerLister
	envLister
}

// projectJobInputs is what a job command was given on its command line.
type projectJobInputs struct {
	JobType    string
	ProjectRef string
	ProjectID  string
	RunnerRef  string
	RunnerID   string
	Env        string
}

// resolveProjectJobParams turns a job command's references into the request it queues: the
// project by name or id (asked for on a terminal), the runner by name or id, and the environment
// by name.
//
// The runner is optional. An empty id is the picker's own "Any available" answer, so with nobody
// to ask the job is simply left unassigned; a scripted run is never refused for omitting it.
func resolveProjectJobParams(c projectJobResolver, token string, in projectJobInputs) (api.QueueJobParams, error) {
	params := api.QueueJobParams{JobType: in.JobType}
	var err error
	if params.ConfigurationID, err = projectIDForJob(c, token, in.ProjectRef, in.ProjectID); err != nil {
		return params, err
	}
	if params.AssignedRunnerID, err = runnerIDFrom(c, in.RunnerRef, in.RunnerID, "--runner", "--runner-id"); err != nil {
		return params, err
	}
	if params.AssignedRunnerID == "" && canPromptForm() {
		if params.AssignedRunnerID, err = selectRunner(token, ""); err != nil {
			return params, err
		}
	}
	if params.EnvironmentID, err = resolveEnvironmentID(c, params.ConfigurationID, in.Env); err != nil {
		return params, err
	}
	return params, nil
}

// jobEnvFlagUsage is the help of --env on the three job commands.
const jobEnvFlagUsage = "Target environment, by name (default: the project's default environment)"

// jobRunnerFlags registers the runner reference on a job command.
//
// TWO flags for one field, for the reason jobProjectFlags states about --project / --project-id:
// `--runner-id` is what scripts already pass and keeps working, `--runner` is the one a person
// uses and takes the name. Passing both is refused rather than resolved by precedence — see
// runnerIDFrom.
func jobRunnerFlags(cmd *cobra.Command, ref, id *string) {
	cmd.Flags().StringVar(ref, "runner", "",
		"Runner to run this job on, by NAME or id (asked for on a terminal when omitted; any available runner otherwise)")
	cmd.Flags().StringVar(id, "runner-id", "",
		"Runner id to assign (prefer --runner, which also takes the name)")
}

// projectJobRequest is the request a job command sends, as the dry run reports it. The keys are
// the ones POST /api/jobs reads.
type projectJobRequest struct {
	JobType          string `json:"job_type"`
	ConfigurationID  string `json:"configuration_id"`
	EnvironmentID    string `json:"environment_id,omitempty"`
	AssignedRunnerID string `json:"assigned_runner_id,omitempty"`
	PlanJobID        string `json:"plan_job_id,omitempty"`
	Cascade          bool   `json:"cascade,omitempty"`
}

// projectJobEntry is one job a command queued.
type projectJobEntry struct {
	ID string `json:"id"`
	// Type is the job type that was asked for: PLAN, DEPLOY or DESTROY.
	Type string `json:"type"`
	// Status is the job's status when the command stopped looking at it.
	Status string `json:"status"`
	// Environment names the environment a cascade job destroys. Empty for a single job.
	Environment string `json:"environment,omitempty"`
	// AwaitingApproval reports that the job will not start until a person approves it.
	AwaitingApproval bool `json:"awaiting_approval"`
	// ApprovalURL is the console page to approve it at, when one could be built.
	ApprovalURL string `json:"approval_url,omitempty"`
	// Warnings is what a deploy that finished recorded as warnings (jobWarnings, jobs_get.go): the
	// same list `alethia jobs get` shows. It is always present, and empty for a job that was not
	// waited for or recorded none.
	Warnings []string `json:"warnings"`
}

// projectJobObject is the `object` of a job command's result.
type projectJobObject struct {
	ProjectID     string `json:"project_id"`
	EnvironmentID string `json:"environment_id,omitempty"`
	// Request is what would be sent. It is present only on a dry run.
	Request *projectJobRequest `json:"request,omitempty"`
	// DestroyTree is what a cascading destroy takes with it, in destroy order.
	DestroyTree []api.DestroyTreeNode `json:"destroy_tree,omitempty"`
	// Jobs is every job that was queued, in the order they run. Empty on a dry run.
	Jobs []projectJobEntry `json:"jobs"`
}

// projectJobRun is one resolved job command: what to queue and how to follow it.
type projectJobRun struct {
	Params api.QueueJobParams
	Wait   waitFlags
	DryRun bool
	// Tree is the destroy tree a cascade already showed the person, carried into the result.
	Tree []api.DestroyTreeNode
	// Approval makes a DEPLOY or DESTROY approval-aware: nil passes a refusal for want of an
	// approval through unchanged.
	Approval *projectJobApproval
}

// projectJobApproval is how a deploy or a destroy obtains the approval the control plane asks for
// (approve.go): who to ask, which plan the approval covers, and how long to wait for it.
type projectJobApproval struct {
	Client approvalClient
	// Operation is api.ApprovalOperationDeploy or api.ApprovalOperationDestroy.
	Operation string
	// PlanJobID names the plan the approval covers. It is called only once an approval is needed.
	PlanJobID func() (string, error)
	Wait      approvalWait
}

// runProjectJob queues the job a project command resolved, follows it when asked to, and returns
// the result. On a dry run nothing is sent and the result carries the request.
//
// A failed wait returns the result as far as it got together with the error, so the caller can
// still name the job that was queued.
func runProjectJob(ctx context.Context, p *Printer, c projectJobClient, run projectJobRun) (MutationResult, error) {
	obj := projectJobObject{
		ProjectID:     run.Params.ConfigurationID,
		EnvironmentID: run.Params.EnvironmentID,
		DestroyTree:   run.Tree,
		Jobs:          []projectJobEntry{},
	}
	result := MutationResult{
		ID: run.Params.ConfigurationID, Kind: "project", Action: ResultQueued, DryRun: run.DryRun,
	}
	if run.DryRun {
		obj.Request = &projectJobRequest{
			JobType:          run.Params.JobType,
			ConfigurationID:  run.Params.ConfigurationID,
			EnvironmentID:    run.Params.EnvironmentID,
			AssignedRunnerID: run.Params.AssignedRunnerID,
			PlanJobID:        run.Params.PlanJobID,
			Cascade:          run.Params.Cascade,
		}
		result.Object = obj
		return result, nil
	}

	resp, err := queueProjectJob(ctx, p, c, run)
	if err != nil {
		return result, err
	}
	obj.Jobs = queuedJobEntries(resp, run.Params.JobType)
	if len(obj.Jobs) == 0 {
		return result, clierr.New(clierr.CodeInternal,
			"the control plane accepted the request and named no job, so there is nothing to follow")
	}
	for i := range obj.Jobs {
		announceQueuedJob(p, c, &obj.Jobs[i])
	}
	// The target's own job is the last one: a cascade destroys the tenants first.
	target := obj.Jobs[len(obj.Jobs)-1]
	result.Job = &JobRef{ID: target.ID, Type: target.Type}
	result.Object = obj

	if !run.Wait.Wait {
		return result, nil
	}
	for i := range obj.Jobs {
		job, err := awaitJob(ctx, c, obj.Jobs[i].ID, run.Wait.options(obj.Jobs[i].Type, p))
		if err != nil {
			return result, cascadeWaitError(err, obj.Jobs, i, run.Params.ConfigurationID)
		}
		obj.Jobs[i].Status = job.Status
		obj.Jobs[i].AwaitingApproval = false
		// awaitJob has already said them on stderr; the result carries them for a program.
		obj.Jobs[i].Warnings = jobWarnings(job)
	}
	result.Object = obj
	return result, nil
}

// queueProjectJob sends the resolved request. An approval-aware run that the control plane refuses
// for want of a person's approval obtains one and sends the same request again with it.
func queueProjectJob(ctx context.Context, p *Printer, c projectJobClient, run projectJobRun) (*api.QueueJobResponse, error) {
	if run.Approval == nil {
		return c.QueueJobFull(run.Params)
	}
	a := run.Approval
	return queueWithApproval(ctx, p, a.Client, a.Operation, a.PlanJobID, a.Wait,
		func(approvalID string) (*api.QueueJobResponse, error) {
			params := run.Params
			params.ApprovalID = approvalID
			return c.QueueJobFull(params)
		})
}

// queuedJobEntries is every job one request queued, in the order they run. A cascading destroy
// lists them all, the owner last; anything else queued the response's one job.
func queuedJobEntries(resp *api.QueueJobResponse, jobType string) []projectJobEntry {
	if len(resp.CascadeJobs) > 0 {
		entries := make([]projectJobEntry, len(resp.CascadeJobs))
		for i, j := range resp.CascadeJobs {
			entries[i] = projectJobEntry{
				ID: j.JobID, Type: jobType, Status: string(types.JobStatusQueued), Environment: j.Name,
				Warnings: []string{},
			}
		}
		return entries
	}
	if resp.Job == nil {
		return []projectJobEntry{}
	}
	return []projectJobEntry{{ID: resp.Job.ID, Type: jobType, Status: resp.Job.Status, Warnings: []string{}}}
}

// awaitsApproval reports whether a job status means "a person has to approve this before it
// runs". It reads the word rather than one exact value, so the status reads correctly whichever
// spelling the control plane gives the state.
func awaitsApproval(status string) bool {
	return strings.Contains(strings.ToUpper(status), "APPROVAL")
}

// announceQueuedJob writes the queued-job notice for one job on stderr. A job that is waiting for
// approval is said to be waiting on a person, with the console page to approve it at, because
// "queued" would read as "about to run" and it is not.
func announceQueuedJob(p *Printer, c orgSlugFetcher, e *projectJobEntry) {
	if !awaitsApproval(e.Status) {
		p.JobQueued(e.Type, e.ID)
		return
	}
	e.AwaitingApproval = true
	e.ApprovalURL = jobConsoleURL(c, e.ID)
	p.Warn(approvalNotice(*e))
}

// approvalNotice is the sentence for a job that waits on a person.
func approvalNotice(e projectJobEntry) string {
	where := "in the console"
	if e.ApprovalURL != "" {
		where = "at " + e.ApprovalURL
	}
	return fmt.Sprintf(
		"%s job %s is waiting for a person to approve it. It does not start until someone approves it %s.",
		e.Type, e.ID, where)
}

// jobConsoleURL is the console page of one job, or empty when the organization it belongs to
// cannot be named. The page is where a job that waits for approval is approved.
func jobConsoleURL(c orgSlugFetcher, jobID string) string {
	slug, err := resolveOrgSlug(c)
	if err != nil {
		return ""
	}
	url, err := routing.Job(WebOrigin(), slug, jobID)
	if err != nil {
		return ""
	}
	return url
}

// cascadeWaitError explains a cascade that stopped part-way. The owner's DESTROY is held by the
// control plane until its tenants are gone, so when a tenant's destroy fails the owner's job does
// not fail: it stays queued. The error says so and names the two ways out. Any other ending — the
// last job, a timeout, an interrupt — is returned as it is.
func cascadeWaitError(err error, jobs []projectJobEntry, failed int, projectID string) error {
	rest := jobs[failed+1:]
	if len(rest) == 0 || clierr.From(err).Class != clierr.ClassOperationFailed {
		return err
	}
	owner := rest[len(rest)-1]
	name := jobs[failed].Environment
	if name == "" {
		name = "job " + jobs[failed].ID
	}
	return fmt.Errorf(
		"the destroy of %s did not succeed (%w). %s's DESTROY (job %s) stays QUEUED and will not start while %s is still placed on its cluster: fix it and destroy %s again (alethia project destroy --project %s --env %s), or cancel the waiting job (alethia jobs cancel %s)",
		name, err, owner.Environment, owner.ID, name, name, projectID, name, owner.ID,
	)
}

// renderProjectJobs writes a job command's result for a person: one line per job.
func renderProjectJobs(w io.Writer, r MutationResult, obj projectJobObject) {
	if r.DryRun {
		fmt.Fprintln(w, ui.MutedStyle.Render(fmt.Sprintf(
			"Would queue a %s job for project %s. Nothing was sent.", obj.Request.JobType, obj.ProjectID)))
		return
	}
	for _, j := range obj.Jobs {
		fmt.Fprintln(w, projectJobLine(j))
	}
}

// projectJobLine is one job as a sentence: what it is, its id, and where it stands.
func projectJobLine(j projectJobEntry) string {
	subject := j.Type + " job " + j.ID
	if j.Environment != "" {
		subject += " (" + j.Environment + ")"
	}
	switch {
	case j.AwaitingApproval:
		return approvalNotice(j)
	case strings.EqualFold(j.Status, jobStatusSuccess):
		return ui.FormatSuccess(subject + " finished")
	}
	return ui.FormatSuccess(subject + " queued")
}

// finishProjectJob is the tail every job command ends on: queue (or dry-run) the resolved job,
// follow it when --wait was given, and print the result. The error it returns is already
// classified; the caller passes it to fail.
func finishProjectJob(cmd *cobra.Command, c projectJobClient, run projectJobRun) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	result, err := runProjectJob(ctx, printer, c, run)
	if err != nil {
		return err
	}
	return printerFor(cmd).Result(result, func(w io.Writer) {
		if obj, ok := result.Object.(projectJobObject); ok {
			renderProjectJobs(w, result, obj)
		}
	})
}

// addProjectWaitFlags registers --wait and --timeout on a job command, with the wording every
// long-running command uses. The project commands keep the -w shorthand they have always had.
func addProjectWaitFlags(cmd *cobra.Command, target *waitFlags) {
	cmd.Flags().BoolVarP(&target.Wait, "wait", "w", false, "Wait for the job to finish")
	cmd.Flags().DurationVar(&target.Timeout, "timeout", 0,
		"With --wait, stop waiting after this long, for example 30m (the job keeps running; exits 12). 0 waits without a limit")
}

// addDryRunFlag registers --dry-run on a command whose dry run is done in the CLI: every input is
// resolved and checked, the request that would be sent is printed, and nothing is sent.
func addDryRunFlag(cmd *cobra.Command) {
	cmd.Flags().Bool(cmdmeta.DryRunFlag, false,
		"Resolve and check every input, print the request that would be sent, and send nothing")
}
