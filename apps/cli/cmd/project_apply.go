// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
)

var (
	projectApplyProjectRef string
	projectApplyProjectID  string
	projectApplyRunnerRef  string
	projectApplyRunnerID   string
	projectApplyPlanJobID  string
	projectApplyLatestPlan bool
	projectApplyEnv        string
	projectApplyWait       waitFlags
	// projectApplyYes is the --yes opt-in: deploy without being asked (and with --no-input).
	projectApplyYes bool
	// projectApplyNoWait is --no-wait: when the deploy needs a person's approval, print where to
	// give it and exit 9 instead of waiting.
	projectApplyNoWait bool
)

// projectDeployLong is the help of `project deploy`. The deprecated `project apply` shows it too.
const projectDeployLong = `Queue a DEPLOY job that creates or updates one environment of a project in your cloud account.

A deploy applies a reviewed plan. Without --plan-job-id or --latest-plan it makes that plan
first: it queues a preview of the environment, waits for it to finish, prints what it would
change, and then asks before it deploys exactly that plan. A preview that does not succeed stops
the command with a non-zero exit, and nothing is deployed. Pass --yes to skip the question,
which a script or an agent must.

To deploy a preview you already read, pass --latest-plan (the project's most recent preview) or
--plan-job-id. The DEPLOY job runs on a runner: add --wait to stay until it finishes, and
--timeout to bound each wait. The job id is in the result either way.

A deploy from the CLI needs a person's approval of the plan it applies. The control plane says
so when the deploy is sent; the command then asks for an approval, prints the console page where
a person approves it and the plan digest that page must show, and waits for the decision before
it queues the deploy. --no-wait (and agent mode) prints the page and exits 9 instead; run the
same deploy with --plan-job-id once the plan is approved. A rejected approval exits 5, an expired
or superseded one 7.

Nothing has to be copied out of another command's output: --project and --runner take a NAME.
--dry-run checks every input and prints the request without sending anything.

To create and deploy a whole project from an alethia.yaml file, use "alethia apply" instead.`

var projectDeployCmd = &cobra.Command{
	Use:   "deploy",
	Short: "Deploy a project environment's infrastructure",
	Long:  projectDeployLong,
	Args:  cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runProjectDeploy(cmd, true); err != nil {
			fail(err)
		}
	},
}

// projectApplyCmd is the old name of `project deploy`, kept so a script written against it still
// runs. It is hidden, says so once on stderr, and keeps the contract it always had: it queues
// without asking. Asking is `project deploy`'s behaviour, and a script that never passed --yes
// must not start failing because the command it calls gained a second name.
var projectApplyCmd = &cobra.Command{
	Use:    "apply",
	Hidden: true,
	Short:  "Deprecated: use `alethia project deploy`",
	Long:   "Deprecated: this is the old name of `alethia project deploy`, which does the same thing.\n\n" + projectDeployLong,
	Args:   cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		renamedCommandNotice("project apply", "project deploy")
		if err := runProjectDeploy(cmd, false); err != nil {
			fail(err)
		}
	},
}

// renamedCommandNotice writes the one stderr line a deprecated command name prints.
func renamedCommandNotice(old, current string) {
	printer.Warn(fmt.Sprintf("`alethia %s` is now `alethia %s`. The old name still works and will be removed in a later release.", old, current))
}

// errDeployRequiresYes is the refusal of a deploy that nobody confirmed and nobody can be asked
// about.
var errDeployRequiresYes = refusal(clierr.CodeConfirmationRequired,
	"alethia project preview",
	"a deploy changes cloud resources and nothing can ask you to confirm it "+
		"(--no-input, stdin is not a terminal, or stderr is redirected): pass --yes to deploy")

// runProjectDeploy resolves and queues one DEPLOY job. confirmFirst is false only for the
// deprecated `project apply` name.
func runProjectDeploy(cmd *cobra.Command, confirmFirst bool) error {
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	client := api.NewClient(token)

	params, err := resolveProjectJobParams(client, token, projectJobInputs{
		JobType:    string(types.JobTypeDeploy),
		ProjectRef: projectApplyProjectRef, ProjectID: projectApplyProjectID,
		RunnerRef: projectApplyRunnerRef, RunnerID: projectApplyRunnerID,
		Env: projectApplyEnv,
	})
	if err != nil {
		return err
	}

	planJob, err := planJobToApply(client, params.ConfigurationID, projectApplyPlanJobID, projectApplyLatestPlan)
	if err != nil {
		return err
	}

	dryRun := cmdmeta.DryRunRequested(cmd)
	asks := confirmFirst && !dryRun && !projectApplyYes
	// Refused before anything is queued: a preview nobody can confirm would be spent for nothing.
	if asks && !canPromptForm() {
		return errDeployRequiresYes
	}

	p := printerFor(cmd)
	switch {
	case planJob.ID == "" && dryRun:
		p.Note("A real run first queues a preview of this environment, waits for it, and deploys that plan.")
	case planJob.ID == "":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
		planJob, err = previewBeforeDeploy(ctx, p, client, params, projectApplyWait.Timeout)
		stop()
		if err != nil {
			return err
		}
	default:
		announceResolvedJob(planJob, "applying")
	}
	params.PlanJobID = planJob.ID

	if asks && !confirm("Deploy this project environment?", deployDescription(params, projectApplyProjectRef, projectApplyEnv)) {
		return nil
	}
	return finishProjectJob(cmd, client, projectJobRun{
		Params: params, Wait: projectApplyWait, DryRun: dryRun,
		Approval: &projectJobApproval{
			Client:    client,
			Operation: api.ApprovalOperationDeploy,
			PlanJobID: func() (string, error) { return params.PlanJobID, nil },
			Wait: approvalWait{
				NoWait:  projectApplyNoWait,
				Timeout: projectApplyWait.Timeout,
				Rerun:   "run " + deployRerun(params, projectApplyProjectRef, projectApplyEnv),
			},
		},
	})
}

// deployRerun is the command that deploys exactly this plan once it is approved: the same project
// and environment, the plan named, and --yes because it was already reviewed.
func deployRerun(params api.QueueJobParams, projectRef, env string) string {
	project := projectRef
	if project == "" {
		project = params.ConfigurationID
	}
	line := "alethia project deploy --project " + project
	if env != "" {
		line += " --env " + env
	}
	return line + " --plan-job-id " + params.PlanJobID + " --yes"
}

// previewBeforeDeploy makes the reviewed plan a deploy applies when the caller named none: it
// queues a PLAN job for the same project, environment and runner as the deploy, waits for it to
// finish (bounded by timeout when it is set), and prints what it would change on stderr. It returns
// the plan to deploy. A plan that does not succeed is an error that names the job, and its class
// is the wait's (failed, timed out, interrupted), so the exit code says which.
func previewBeforeDeploy(ctx context.Context, p *Printer, c projectJobClient, deploy api.QueueJobParams, timeout time.Duration) (jobRef, error) {
	params := deploy
	params.JobType = string(types.JobTypePlan)
	params.PlanJobID = ""
	p.Note("A deploy applies a reviewed plan, so this previews the environment first.")
	resp, err := c.QueueJobFull(params)
	if err != nil {
		return jobRef{}, err
	}
	entries := queuedJobEntries(resp, params.JobType)
	if len(entries) == 0 {
		return jobRef{}, clierr.New(clierr.CodeInternal,
			"the control plane accepted the preview and named no job, so there is no plan to deploy")
	}
	plan := entries[0]
	announceQueuedJob(p, c, &plan)
	job, err := awaitJob(ctx, c, plan.ID, waitOptions{Timeout: timeout, JobType: params.JobType, Progress: p})
	if err != nil {
		return jobRef{}, fmt.Errorf("the preview this deploy would apply (PLAN job %s) did not finish successfully, so nothing was deployed: %w", plan.ID, err)
	}
	writePlanSummary(p, job)
	return jobRef{ID: plan.ID}, nil
}

// writePlanSummary prints a finished plan on stderr for the person about to confirm it: the job
// card `alethia jobs get` shows (verify verdict and cost estimate included), then how many
// resources it would create, update, replace and delete. Under json nothing is written, because the
// deploy's result is the one document a program reads.
func writePlanSummary(p *Printer, job *api.ProvisionJob) {
	if p.Format == ui.FormatJSON {
		return
	}
	_ = renderJob(p.Err, ui.FormatTable, job)
	if changes := planChangeSummary(job.ExecutionMetadata); changes != "" {
		fmt.Fprintln(p.Err, changes)
	}
}

// planChangeSummary counts the resource changes a plan job recorded
// (execution_metadata.plan_result.resource_changes, tofu's own plan JSON) the way the console's plan
// review counts them: create, update, replace (a delete and a create together) and delete, with
// no-op and read actions left out. It returns "" when the job recorded no plan result.
func planChangeSummary(meta *map[string]interface{}) string {
	if meta == nil {
		return ""
	}
	result, ok := (*meta)["plan_result"].(map[string]interface{})
	if !ok {
		return ""
	}
	changes, ok := result["resource_changes"].([]interface{})
	if !ok {
		return ""
	}
	var create, update, replace, del int
	for _, rc := range changes {
		entry, _ := rc.(map[string]interface{})
		change, _ := entry["change"].(map[string]interface{})
		actions, _ := change["actions"].([]interface{})
		has := map[string]bool{}
		for _, a := range actions {
			if s, ok := a.(string); ok {
				has[s] = true
			}
		}
		switch {
		case has["create"] && has["delete"]:
			replace++
		case has["create"]:
			create++
		case has["update"]:
			update++
		case has["delete"]:
			del++
		}
	}
	return fmt.Sprintf("Plan: %d to create, %d to update, %d to replace, %d to delete.", create, update, replace, del)
}

// deployDescription says what a deploy is about to do, for the confirmation: which project, which
// environment and which reviewed plan.
func deployDescription(params api.QueueJobParams, projectRef, env string) string {
	project := projectRef
	if project == "" {
		project = params.ConfigurationID
	}
	where := "the default environment"
	if env != "" {
		where = "environment " + env
	}
	plan := "It previews the environment first and applies that plan."
	if params.PlanJobID != "" {
		plan = "It applies plan job " + params.PlanJobID + "."
	}
	return fmt.Sprintf("Queues a DEPLOY job for %s of project %s, which creates or changes cloud resources. %s",
		where, project, plan)
}

// planJobToApply answers "which PLAN job does this deploy apply" from the two inputs that can
// name one: the id a caller already holds, or `--latest-plan`.
//
// It returns a jobRef, so the CHOSEN case carries a summary and the NAMED case does not —
// announceResolvedJob prints one and stays silent about the other. A CLI that picked a job for
// you and did not say which is the failure resolveProjectName records: a silent pass-through
// that reads as success.
//
// An empty ref (neither input given) means "make the plan now": runProjectDeploy then queues a
// preview, waits for it and deploys that one (previewBeforeDeploy). It is deliberately NOT "resolve
// the latest PLAN anyway": the most recent preview may be of an older design, or still running,
// and a deploy applies exactly the plan the person was shown. The control plane refuses a DEPLOY
// that names no plan, or one whose plan is no longer current, so the plan a deploy names is always
// one that was read for it.
//
// THE `--type PLAN` NARROWING IS THE POINT, not a detail. "The project's most recent job" is as
// likely to be the DEPLOY that followed the plan as the plan itself, and applying a DEPLOY job's
// id as a plan reference is a wrong answer the command reports as success. The narrowing is the
// selector spec's own `--type` field, reused rather than re-matched, so it cannot come to
// disagree with what `alethia jobs get --latest --type PLAN` means.
//
// The STATUS is checked and never used to narrow, which is the opposite choice and also
// deliberate. Skipping a non-SUCCESS plan would silently reach PAST the plan the caller just
// queued — `project preview` then `project deploy --latest-plan`, with the plan still PROCESSING,
// would apply an OLDER one — and quietly applying a plan the operator did not review is exactly
// the handoff this removes, one step worse. So the most recent PLAN is the answer, and a refusal
// names it and its status.
func planJobToApply(c jobLister, projectID, id string, latest bool) (jobRef, error) {
	if id != "" && latest {
		return jobRef{}, refusal(clierr.CodeInvalidUsage, "",
			"--plan-job-id and --latest-plan both name the plan to apply: pass one "+
				"(--latest-plan takes the project's most recent PLAN job)")
	}
	if !latest {
		return jobRef{ID: id}, nil
	}
	if projectID == "" {
		// Without a project the narrowing below drops the project field entirely — `set()` keeps
		// only non-empty fields, so `--type PLAN` is the only filter left and the match is every
		// PLAN job in the org. `--latest-plan` would then resolve another project's plan and the
		// deploy would fail on a hash mismatch a long way from the cause.
		return jobRef{}, refusal(clierr.CodeMissingArgument, "alethia project list",
			"--latest-plan needs a project: pass --project (by name or id)")
	}
	sel := jobSelector{jobType: string(types.JobTypePlan), project: projectID}
	matches, err := narrowJobs(c, sel, jobScope{})
	if err != nil {
		return jobRef{}, err
	}
	if len(matches) == 0 {
		return jobRef{}, refusal(clierr.CodeNotFound, "alethia project preview --wait",
			"--latest-plan: no PLAN job for this project in the last %d jobs — "+
				"queue one with `alethia project preview`, or name one with --plan-job-id",
			jobSelectorPageSize)
	}
	plan := matches[0]
	if !strings.EqualFold(plan.Status, string(types.JobStatusSuccess)) {
		return jobRef{}, refusal(clierr.CodeConflict, "alethia jobs get "+plan.ID,
			"--latest-plan: the most recent PLAN job for this project is %s and its status is %s — "+
				"a deploy may only apply a plan that SUCCEEDED, so wait for it or name another with --plan-job-id",
			plan.ID, plan.Status)
	}
	return jobRef{ID: plan.ID, Summary: jobOptionLabel(plan)}, nil
}

// registerDeployFlags registers the flags of `project deploy` on cmd. The deprecated `project
// apply` takes the same ones, bound to the same variables.
func registerDeployFlags(cmd *cobra.Command) {
	jobProjectFlags(cmd, &projectApplyProjectRef, &projectApplyProjectID, "deploy")
	jobRunnerFlags(cmd, &projectApplyRunnerRef, &projectApplyRunnerID)
	cmd.Flags().StringVar(&projectApplyPlanJobID, "plan-job-id", "", "Apply a prior PLAN job, by id (prefer --latest-plan)")
	cmd.Flags().BoolVar(&projectApplyLatestPlan, "latest-plan", false,
		"Apply the project's most recent PLAN job instead of naming one (works with --no-input)")
	cmd.Flags().StringVar(&projectApplyEnv, "env", "", jobEnvFlagUsage)
	addProjectWaitFlags(cmd, &projectApplyWait)
	addDryRunFlag(cmd)
	cmd.Flags().BoolVarP(&projectApplyYes, "yes", "y", false, "Deploy without being asked first (required with --no-input)")
	addApprovalNoWaitFlag(cmd, &projectApplyNoWait)
}

func init() {
	projectCmd.AddCommand(projectDeployCmd)
	projectCmd.AddCommand(projectApplyCmd)
	registerDeployFlags(projectDeployCmd)
	registerDeployFlags(projectApplyCmd)
}
